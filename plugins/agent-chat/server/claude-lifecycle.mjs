import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { processExecutable, trustedClaudeCommand, runningClaudeVersion, processIdentities } from './native-session.mjs'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const DEFAULT_STATE = path.join(os.homedir(), '.local/state/agent-chat')
// fork opens a new conversation, so it follows the /clear rule: its own record,
// nothing inherited, the old conversation's bindings end. compact keeps the
// conversation and its hook never registers.
const SOURCE = new Set(['startup', 'resume', 'clear', 'fork', 'compact'])
// The hook's checks run while many tabs may be starting at once (a terminal
// restore, a conductor). 150-200 ms bounds failed 8 of 12 parallel
// registrations on 2026-10-19, and at load average 60+ one ps call took over
// a second. They still fail closed; they only stop failing under load. The
// MCP server re-checks on every call and blocks while it does, so it keeps
// short bounds: a timeout there reads as unknown and keeps mail and membership.
const GIT_TIMEOUT_MS = 5000
const HOOK_BOUNDS = { psTimeoutMs: 10_000, lsofTimeoutMs: 5000 }, CALL_BOUNDS = { psTimeoutMs: 2000, lsofTimeoutMs: 1500 }
function unavailable(stage) {
  return Object.assign(new Error('Agent-chat Claude lifecycle metadata is unavailable'), { code: 'CHAT_CLAUDE_LIFECYCLE_UNAVAILABLE', ...(stage ? { stage } : {}) })
}
function canonicalDirectory(value, privateMode = false, create = false) {
  if (typeof value !== 'string' || !path.isAbsolute(value) || value.includes('\0')) throw unavailable()
  if (create && !fs.existsSync(value)) fs.mkdirSync(value, { recursive: true, mode: 0o700 })
  const canonical = fs.realpathSync(value)
  const stat = fs.lstatSync(value)
  if (stat.isSymbolicLink() || !stat.isDirectory() || stat.uid !== process.getuid() ||
      (privateMode ? (stat.mode & 0o777) !== 0o700 : !!(stat.mode & 0o022))) throw unavailable()
  return canonical
}
// Match the MCP store's Git common-root scope, including nested directories
// and linked worktrees. Timeouts are unknown scope, never a fallback project.
export function lifecycleProjectRoot(cwd, { executor = execFileSync } = {}) {
  const canonical = canonicalDirectory(cwd)
  try {
    const common = executor('/usr/bin/git', ['-C', canonical, 'rev-parse', '--path-format=absolute', '--git-common-dir'], {
      encoding: 'utf8', timeout: GIT_TIMEOUT_MS, maxBuffer: 4096, stdio: ['ignore', 'pipe', 'ignore'],
      env: { ...process.env, LC_ALL: 'C', TZ: 'UTC' },
    }).trim()
    if (!path.isAbsolute(common)) throw unavailable()
    return path.basename(common) === '.git' ? canonicalDirectory(path.dirname(common)) : canonical
  } catch (error) {
    if ([1, 128].includes(error.status) && !error.signal && !error.killed) return canonical
    throw unavailable()
  }
}
export function validateClaudeLifecycleSocket(endpoint, pid) {
  if (typeof endpoint !== 'string' || !path.isAbsolute(endpoint) || endpoint.includes('\0')) throw unavailable()
  if (!fs.lstatSync(endpoint).isSocket()) throw unavailable()
  const canonical = fs.realpathSync(endpoint)
  const expected = path.join(fs.realpathSync('/tmp'), 'cc-socks', `${pid}.sock`)
  if (canonical !== expected) throw unavailable()
  const parent = fs.lstatSync(path.dirname(canonical)), socket = fs.lstatSync(canonical)
  if (!parent.isDirectory() || parent.uid !== process.getuid() || (parent.mode & 0o777) !== 0o700 ||
      !socket.isSocket() || socket.uid !== process.getuid() || (socket.mode & 0o777) !== 0o600) throw unavailable()
  return canonical
}
// One bounded ps snapshot, no argv or environment inspection of other processes.
export function claudeLifecycleAncestors(ppid = process.ppid, { psTimeoutMs, lsofTimeoutMs } = HOOK_BOUNDS) {
  if (!Number.isSafeInteger(ppid) || ppid <= 0) return []
  const output = execFileSync('/bin/ps', ['-ax', '-o', 'pid=', '-o', 'ppid=', '-o', 'uid=', '-o', 'lstart=', '-o', 'comm='], {
    encoding: 'utf8', timeout: psTimeoutMs, maxBuffer: 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'],
    env: { ...process.env, LC_ALL: 'C', TZ: 'UTC' },
  })
  const rows = new Map()
  for (const line of output.split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\w{3} \w{3}\s+\d{1,2} \d{2}:\d{2}:\d{2} \d{4})\s+(.+)$/.exec(line)
    if (match && Number(match[3]) === process.getuid()) rows.set(Number(match[1]), {
      pid: Number(match[1]), ppid: Number(match[2]), start: match[4], command: match[5],
    })
  }
  const result = []
  let executableResolved = false
  for (let current = ppid; result.length < 6 && rows.has(current); current = rows.get(current).ppid) {
    const row = rows.get(current)
    let command = row.command
    if (command === 'claude') {
      if (executableResolved) break
      executableResolved = true
      command = processExecutable(row.pid, { timeoutMs: lsofTimeoutMs })
      // An lsof that failed proves nothing about this process: unknown, never untrusted.
      if (command === null) throw unavailable('process')
    }
    result.push({ pid: row.pid, start: row.start, trusted: trustedClaudeCommand(command) })
    if (result.at(-1).trusted) { result.at(-1).executable = command; break }
  }
  return result
}
function registry(stateRoot, session, projectRoot, create) {
  canonicalDirectory(stateRoot, true, create)
  const directory = path.join(stateRoot, 'lifecycle')
  canonicalDirectory(directory, true, create)
  const key = createHash('sha256').update(JSON.stringify([session.clientPid, session.clientStart, session.profileHome, projectRoot])).digest('hex')
  return { directory, file: path.join(directory, `${key}.json`) }
}
function readRecord(file) {
  let stat
  try { stat = fs.lstatSync(file) } catch (error) { if (error.code === 'ENOENT') return null; throw error }
  if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid() || (stat.mode & 0o777) !== 0o600) throw unavailable()
  const value = JSON.parse(fs.readFileSync(file, 'utf8'))
  if (value?.schema !== 1 || !UUID.test(value.launchId || '') || !UUID.test(value.conversationId || '') || !SOURCE.has(value.source) ||
      !Number.isSafeInteger(value.clientPid) || typeof value.clientStart !== 'string' || !value.clientStart ||
      ![value.profileHome, value.projectRoot, value.endpoint].every(item => typeof item === 'string' && path.isAbsolute(item))) throw unavailable()
  return value
}
// A record outlives its tab, and every Claude start writes one. Records of tabs that have
// exited are removed so the registry stays the size of the open-tab set. Only positive evidence
// removes one: its PID is gone (ESRCH) or now has another start time. A process check that cannot
// run throws before anything is removed; a busy (locked) or damaged record is left alone.
export function pruneClaudeLifecycle({ stateRoot = DEFAULT_STATE, signal = process.kill,
  identities = pids => processIdentities(pids, { signal, timeoutMs: 5000 }) } = {}) {
  const gone = pid => { try { signal(pid, 0); return false } catch (error) { return error.code === 'ESRCH' } }
  const directory = path.join(stateRoot, 'lifecycle')
  let names
  try { names = fs.readdirSync(directory) } catch (error) { if (error.code === 'ENOENT') return 0; throw error }
  const records = []
  for (const name of names.filter(name => /^[0-9a-f]{64}\.json$/.test(name))) {
    const file = path.join(directory, name)
    try { const record = readRecord(file); if (record) records.push({ file, record }) } catch {}
  }
  const live = identities(records.map(({ record }) => record.clientPid))
  let removed = 0
  for (const { file, record } of records) {
    const seen = live.get(record.clientPid)
    if (seen?.start === record.clientStart || (!seen && !gone(record.clientPid))) continue
    let lockFd
    try { lockFd = fs.openSync(`${file}.lock`, 'wx', 0o600) } catch { continue }
    try {
      const current = readRecord(file)
      if (current?.clientPid === record.clientPid && current.clientStart === record.clientStart) { fs.unlinkSync(file); removed++ }
    } catch {} finally { fs.closeSync(lockFd); fs.unlinkSync(`${file}.lock`) }
  }
  return removed
}
// The CLI process (pid, birth, private socket) is the identity. launchId is informational: after an
// in-CLI /resume, hooks see the resumed id while the MCP server keeps the id it was spawned with.
function matches(record, session, projectRoot, endpoint) {
  return record?.clientPid === session.clientPid && record.clientStart === session.clientStart &&
    record.profileHome === session.profileHome && record.projectRoot === projectRoot && record.endpoint === endpoint
}
// Hooks pass their actual ppid. No input JSON PID is accepted as identity.
export function observeClaudeLifecycle(input, env = process.env, {
  stateRoot = DEFAULT_STATE, projectRoot = input?.cwd, ppid = process.ppid,
  ancestors = claudeLifecycleAncestors, validateSocket = validateClaudeLifecycleSocket,
  scope = lifecycleProjectRoot,
} = {}) {
  if (env.AGENT_CHAT_VERIFY_CHILD === '1') return null
  // The failing step is kept (never the error text) so the hook can say what failed.
  let stage = 'input'
  try {
    if (!UUID.test(input?.session_id || '') || !SOURCE.has(input.source) || input.hook_event_name !== 'SessionStart') throw unavailable()
    stage = 'project'
    const canonicalProject = canonicalDirectory(projectRoot)
    if (scope(input.cwd) !== canonicalProject) throw unavailable()
    // A symlinked profile (~/.claude -> ~/.claude-dimo) is checked at its real
    // path, the same canonical path the MCP server records.
    stage = 'profile'
    const profileHome = canonicalDirectory(fs.realpathSync(env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude')))
    stage = 'process'
    const parent = ancestors(ppid).find(row => row.trusted)
    // ps answered and no ancestor is a native Claude Code install: an npm, Homebrew or IDE copy.
    if (!parent) { stage = 'install'; throw unavailable() }
    stage = 'socket'
    const endpoint = validateSocket(env.CLAUDE_CODE_MESSAGING_SOCKET, parent.pid)
    stage = 'input'
    const launchId = env.CLAUDE_CODE_SESSION_ID || input.session_id
    if (!UUID.test(launchId)) throw unavailable()
    stage = 'record'
    const claudeVersion = runningClaudeVersion(parent.executable)
    const session = { id: launchId, conversationId: input.session_id, runtime: 'claude', lifecycle: true, profileHome, endpoint, clientPid: parent.pid, clientStart: parent.start, ...(claudeVersion ? { claudeVersion } : {}) }
    const { directory, file } = registry(stateRoot, session, canonicalProject, true)
    // Nonblocking lock. An overlapping hook fails closed instead of waiting on
    // the store's long SQLite mutex or guessing at a stale lock owner.
    const lock = `${file}.lock`
    const lockFd = fs.openSync(lock, 'wx', 0o600)
    let temporary
    try {
      const previous = readRecord(file)
      const record = { schema: 1, launchId, conversationId: input.session_id, source: input.source,
        profileHome, endpoint, clientPid: parent.pid, clientStart: parent.start, projectRoot: canonicalProject }
      temporary = path.join(directory, `${randomUUID()}.tmp`)
      const fd = fs.openSync(temporary, 'wx', 0o600)
      try { fs.writeFileSync(fd, JSON.stringify(record)); fs.fsyncSync(fd) } finally { fs.closeSync(fd) }
      fs.renameSync(temporary, file); temporary = undefined
      const dirFd = fs.openSync(directory, 'r')
      try { fs.fsyncSync(dirFd) } finally { fs.closeSync(dirFd) }
      return { session, conversationId: input.session_id, previousConversationId:
        matches(previous, session, canonicalProject, endpoint) ? previous.conversationId : null, source: input.source }
    } finally {
      fs.closeSync(lockFd); fs.unlinkSync(lock)
      if (temporary) fs.unlinkSync(temporary)
    }
  } catch { throw unavailable(stage) }
}
// null is a definite answer: not this CLI process, its socket is gone, or it
// has no record. A check that could not run (ps or lsof failed, a damaged or
// unsafe record) throws, so callers keep mail and membership instead of
// reading a busy machine as a closed tab.
export function resolveClaudeConversation(nativeSession, {
  stateRoot = DEFAULT_STATE, projectRoot, ancestors = pid => claudeLifecycleAncestors(pid, CALL_BOUNDS),
  validateSocket = validateClaudeLifecycleSocket,
} = {}) {
  if (nativeSession?.runtime !== 'claude') return null
  try {
    const profileHome = canonicalDirectory(nativeSession.profileHome)
    const canonicalProject = canonicalDirectory(projectRoot)
    const parent = ancestors(nativeSession.clientPid)[0]
    if (!parent?.trusted || parent.pid !== nativeSession.clientPid || parent.start !== nativeSession.clientStart) return null
    const session = { ...nativeSession, profileHome }
    let endpoint
    try { endpoint = validateSocket(session.endpoint, session.clientPid) } catch { return null }
    if (!fs.existsSync(path.join(stateRoot, 'lifecycle'))) return null
    const { file } = registry(stateRoot, session, canonicalProject, false)
    const record = readRecord(file)
    return matches(record, session, canonicalProject, endpoint) ? record.conversationId : null
  } catch { throw unavailable('process') }
}
