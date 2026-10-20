import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

function presenceUnavailable() {
  return Object.assign(new Error('Agent-chat process presence is unavailable; retry later'), { code: 'CHAT_PRESENCE_UNAVAILABLE' })
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// One ps snapshot covers a reconciliation pass. Invalid/dead PIDs never reach
// ps; chunks keep argv/output bounded for an unusually large membership set.
export function processIdentities(pids, { executor = execFileSync, signal = process.kill, timeoutMs = 1000 } = {}) {
  // A PID exists when the signal check succeeds, or fails with EPERM (another owner). ESRCH means
  // gone; anything else (a PID no process can have) is treated as absent.
  const exists = pid => { try { signal(pid, 0); return true } catch (error) { return error.code === 'EPERM' } }
  const candidates = [...new Set(pids)].filter(pid => Number.isSafeInteger(pid) && pid > 0 && exists(pid))
  const result = new Map()
  for (let offset = 0; offset < candidates.length; offset += 256) {
    const batch = candidates.slice(offset, offset + 256)
    let output
    try {
      output = executor('/bin/ps', ['-p', batch.join(','), '-o', 'pid=', '-o', 'uid=', '-o', 'lstart='], {
        env: { ...process.env, LC_ALL: 'C', TZ: 'UTC' },
        encoding: 'utf8', timeout: timeoutMs, maxBuffer: 32 * 1024, stdio: ['ignore', 'pipe', 'ignore'],
      })
    } catch (error) {
      if (error.status !== 1) throw presenceUnavailable()
      output = error.stdout || ''
    }
    const listed = new Set()
    for (const line of String(output).split('\n')) {
      const match = /^\s*(\d+)\s+(\d+)\s+(\w{3} \w{3}\s+\d{1,2} \d{2}:\d{2}:\d{2} \d{4})\s*$/.exec(line)
      if (!match) continue
      const pid = Number(match[1]); listed.add(pid)
      if (Number(match[2]) === process.getuid() && batch.includes(pid)) result.set(pid, { pid, start: match[3] })
    }
    // ps exits 1 when a PID vanished, but also on failure, and a failed sysctl exits 0 with no rows.
    // ps lists every existing PID of any owner, so one it left out must be gone by now.
    if (batch.some(pid => !listed.has(pid) && exists(pid))) throw presenceUnavailable()
  }
  return result
}

export function processIdentity(pid) {
  return processIdentities([pid]).get(pid) ?? null
}

export function isProcessLive(identity) {
  return !!identity && typeof identity.start === 'string' &&
    processIdentity(identity.pid)?.start === identity.start
}

// comm excludes CLI arguments, which can contain private prompt or MCP data.
function processCommand(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null
  try {
    process.kill(pid, 0)
    const output = execFileSync('/bin/ps', ['-p', String(pid), '-o', 'uid=', '-o', 'comm='], {
      env: { ...process.env, LC_ALL: 'C', TZ: 'UTC' },
      encoding: 'utf8', timeout: 1000, maxBuffer: 4096, stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
    const match = /^(\d+)\s+([^\n\0]+)$/.exec(output)
    return match && Number(match[1]) === process.getuid() ? match[2] : null
  } catch { return null }
}

// On macOS comm can be shortened to a title. The first txt mapping identifies
// the executable without reading argv or accepting a caller-chosen process name.
export function processExecutable(pid, { timeoutMs = 1000 } = {}) {
  try {
    const output = execFileSync('/usr/sbin/lsof', ['-a', '-p', String(pid), '-d', 'txt', '-F', 'pn'], {
      encoding: 'utf8', timeout: timeoutMs, maxBuffer: 32 * 1024, stdio: ['ignore', 'pipe', 'ignore'],
      env: { ...process.env, LC_ALL: 'C', TZ: 'UTC' },
    })
    const lines = output.split('\n')
    if (lines[0] !== `p${pid}`) return null
    return lines.find(line => line.startsWith('n'))?.slice(1) ?? null
  } catch { return null }
}

// The version a running Claude was started with, read from its mapped
// executable in the versions directory. The alias path follows updates, so it
// says nothing about a tab started earlier and never counts.
// Where a Codex CLI is looked for, in order: the standalone installer, then Homebrew and
// /usr/local. A fixed list, never a path from an MCP message or a session registration.
// resolve: the binary a link points at now, rather than the link, which follows updates.
export function codexBinary(home = os.homedir(), { resolve = true } = {}) {
  const candidates = [path.join(home, '.local', 'bin', 'codex'), '/opt/homebrew/bin/codex', '/usr/local/bin/codex']
  for (const candidate of candidates) { try { const real = fs.realpathSync(candidate); return resolve ? real : candidate } catch {} }
  return candidates[0]
}
export function runningClaudeVersion(executable) {
  if (typeof executable !== 'string' || path.dirname(executable) !== path.join(os.homedir(), '.local/share/claude/versions')) return undefined
  const version = path.basename(executable)
  return /^\d+\.\d+\.\d+$/.test(version) ? version : undefined
}

export function trustedClaudeCommand(command) {
  if (typeof command !== 'string' || !path.isAbsolute(command) || command.includes('\0') || path.normalize(command) !== command) return false
  const installation = path.join(os.homedir(), '.local/share/claude')
  const versions = path.join(installation, 'versions')
  const alias = path.join(os.homedir(), '.local/bin/claude')
  if (command !== alias && path.dirname(command) !== versions) return false
  try {
    const canonical = fs.realpathSync(command)
    if (path.dirname(canonical) !== versions || !/^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/.test(path.basename(canonical))) return false
    for (const directory of [installation, versions]) {
      const stat = fs.lstatSync(directory)
      if (!stat.isDirectory() || stat.uid !== process.getuid() || stat.mode & 0o022) return false
    }
    const stat = fs.lstatSync(canonical)
    return stat.isFile() && stat.uid === process.getuid() && !(stat.mode & 0o022) && !!(stat.mode & 0o111)
  } catch { return false }
}

function profile(value) {
  if (typeof value !== 'string' || !path.isAbsolute(value) || value.includes('\0')) return null
  try {
    const canonical = fs.realpathSync(value)
    const stat = fs.statSync(canonical)
    return stat.isDirectory() && stat.uid === process.getuid() && !(stat.mode & 0o022) ? canonical : null
  } catch { return null }
}

// This returns private runtime facts. MCP responses must never expose these fields.
export function inferNativeSession(meta, env = process.env, { pid = process.pid, ppid = process.ppid, getCommand = processCommand, getExecutable = processExecutable, expectedPredicate = trustedClaudeCommand } = {}) {
  let turn = meta?.['x-codex-turn-metadata']
  if (turn !== undefined) {
    if (typeof turn === 'string') {
      try { turn = JSON.parse(turn) } catch { return null }
    }
    if (!turn || typeof turn !== 'object' || Array.isArray(turn) || !UUID.test(turn.thread_id ?? '')) return null
    const profileHome = profile(env.AGENT_CHAT_CODEX_HOME || env.CODEX_HOME || path.join(os.homedir(), '.codex'))
    const server = processIdentity(pid)
    if (!profileHome || !server) return null
    return { id: turn.thread_id, runtime: 'codex', profileHome, serverPid: server.pid, serverStart: server.start }
  }
  if (!UUID.test(env.CLAUDE_CODE_SESSION_ID ?? '') || !env.CLAUDE_CODE_MESSAGING_SOCKET) return null
  const profileHome = profile(env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'))
  const identities = processIdentities([pid, ppid])
  const parent = identities.get(ppid)
  const server = identities.get(pid)
  const socketPath = env.CLAUDE_CODE_MESSAGING_SOCKET
  let isClaudeParent = false, executable
  try {
    const command = parent && getCommand(ppid)
    executable = command === 'claude' ? getExecutable(ppid) : command
    isClaudeParent = !!parent && expectedPredicate(executable) === true
  } catch { return null }
  if (!profileHome || !parent || !server || !isClaudeParent || typeof socketPath !== 'string' || !path.isAbsolute(socketPath) || socketPath.includes('\0')) return null
  const claudeVersion = runningClaudeVersion(executable)
  return {
    id: env.CLAUDE_CODE_SESSION_ID, runtime: 'claude', profileHome,
    endpoint: socketPath, clientPid: parent.pid, clientStart: parent.start,
    serverPid: server.pid, serverStart: server.start, ...(claudeVersion ? { claudeVersion } : {}),
  }
}
