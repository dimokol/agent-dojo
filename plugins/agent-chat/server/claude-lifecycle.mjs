import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { processExecutable, trustedClaudeCommand, runningClaudeVersion, processIdentities } from './native-session.mjs'
import { fsyncDir, hasModeBits, modeIs, ownedByMe, WINDOWS, WINDOWS_CLAUDE_ENDPOINT, windowsProcessRows } from './platform.mjs'

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
// 5 s still failed: on 2026-11-06 and 11-10 restored tabs at load 18 to 45 lost git's race and
// stayed unregistered. The hook has 60 s; a slow git now costs start-up time, not the tab.
const GIT_TIMEOUT_MS = 10_000
const HOOK_BOUNDS = { psTimeoutMs: 10_000, lsofTimeoutMs: 5000 }
export const CALL_BOUNDS = { psTimeoutMs: 2000, lsofTimeoutMs: 1500 }
function unavailable(stage) {
  return Object.assign(new Error('Agent-chat Claude lifecycle metadata is unavailable'), { code: 'CHAT_CLAUDE_LIFECYCLE_UNAVAILABLE', ...(stage ? { stage } : {}) })
}
function canonicalDirectory(value, privateMode = false, create = false) {
  if (typeof value !== 'string' || !path.isAbsolute(value) || value.includes('\0')) throw unavailable()
  if (create && !fs.existsSync(value)) fs.mkdirSync(value, { recursive: true, mode: 0o700 })
  const canonical = fs.realpathSync(value)
  const stat = fs.lstatSync(value)
  if (stat.isSymbolicLink() || !stat.isDirectory() || !ownedByMe(stat) ||
      (privateMode ? !modeIs(stat, 0o700) : !!hasModeBits(stat, 0o022))) throw unavailable()
  return canonical
}
// Match the MCP store's Git common-root scope, including nested directories
// and linked worktrees. Timeouts are unknown scope, never a fallback project.
export function lifecycleProjectRoot(cwd, { executor = execFileSync } = {}) {
  const canonical = canonicalDirectory(cwd)
  try {
    // Windows has no fixed git location; Git for Windows puts it on PATH.
    const common = executor(WINDOWS ? 'git' : '/usr/bin/git', ['-C', canonical, 'rev-parse', '--path-format=absolute', '--git-common-dir'], {
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
  // Windows: Claude's messaging endpoint is a named pipe, \\.\pipe\LOCAL\cc-msg-<32 hex> (relay
  // 039), not keyed by PID. Agent-chat never connects to it there (Windows wakes through the
  // hook), so only its shape is checked.
  if (WINDOWS) {
    if (!WINDOWS_CLAUDE_ENDPOINT.test(endpoint)) throw unavailable()
    return endpoint
  }
  if (!fs.lstatSync(endpoint).isSocket()) throw unavailable()
  const canonical = fs.realpathSync(endpoint)
  const expected = path.join(fs.realpathSync('/tmp'), 'cc-socks', `${pid}.sock`)
  if (canonical !== expected) throw unavailable()
  const parent = fs.lstatSync(path.dirname(canonical)), socket = fs.lstatSync(canonical)
  if (!parent.isDirectory() || !ownedByMe(parent) || !modeIs(parent, 0o700) ||
      !socket.isSocket() || !ownedByMe(socket) || !modeIs(socket, 0o600)) throw unavailable()
  return canonical
}
// One bounded ps snapshot, no argv or environment inspection of other processes. ps lists every
// process of every owner, so one that listed nothing failed (a sysctl failure exits 0 with no rows):
// that is unknown, never "no such process".
export function claudeProcessListing({ psTimeoutMs } = HOOK_BOUNDS) {
  if (WINDOWS) {
    let all
    try { all = windowsProcessRows([], { all: true, timeoutMs: psTimeoutMs }) } catch { throw unavailable('process') }
    const rows = new Map(), listed = new Set(all.keys())
    // command is the full image path on Windows, so the install check needs no lsof step.
    for (const row of all.values()) if (row.mine === true && typeof row.start === 'string') {
      rows.set(row.pid, { pid: row.pid, ppid: row.ppid, start: row.start, command: typeof row.image === 'string' ? row.image : row.name })
    }
    if (!listed.size) throw unavailable('process')
    return { rows, listed }
  }
  let output
  try {
    output = execFileSync('/bin/ps', ['-ax', '-o', 'pid=', '-o', 'ppid=', '-o', 'uid=', '-o', 'lstart=', '-o', 'comm='], {
      encoding: 'utf8', timeout: psTimeoutMs, maxBuffer: 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'],
      env: { ...process.env, LC_ALL: 'C', TZ: 'UTC' },
    })
  } catch { throw unavailable('process') }
  const rows = new Map(), listed = new Set()
  for (const line of String(output).split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\w{3} \w{3}\s+\d{1,2} \d{2}:\d{2}:\d{2} \d{4})\s+(.+)$/.exec(line)
    if (!match) continue
    listed.add(Number(match[1]))
    if (Number(match[3]) === process.getuid()) rows.set(Number(match[1]), {
      pid: Number(match[1]), ppid: Number(match[2]), start: match[4], command: match[5],
    })
  }
  if (!listed.size) throw unavailable('process')
  return { rows, listed }
}
const processExists = pid => { try { process.kill(pid, 0); return true } catch (error) { return error.code === 'EPERM' } }
// This user's row for a PID, or null when ps proves it gone or another user's. A PID that still
// exists but that the listing left out makes the listing untrustworthy: unknown.
export function listingLookup(listing) {
  return pid => {
    if (!Number.isSafeInteger(pid) || pid <= 0) return null
    if (listing.rows.has(pid)) return listing.rows.get(pid)
    if (!listing.listed.has(pid) && processExists(pid)) throw unavailable('process')
    return null
  }
}
// The executable a process runs can't change while it keeps its PID and start time, so one lsof per
// process is enough. Only an answer is kept; a failed lsof is asked again next time.
const executables = new Map()
export function claudeExecutable(pid, start, { timeoutMs = CALL_BOUNDS.lsofTimeoutMs } = {}) {
  const key = `${pid}\n${start}`
  if (typeof start === 'string' && executables.has(key)) return executables.get(key)
  const executable = processExecutable(pid, { timeoutMs })
  if (executable !== null && typeof start === 'string') {
    if (executables.size >= 512) executables.clear()
    executables.set(key, executable)
  }
  return executable
}
// lookup: a shared listing's lookup (one ps for many checks); by default a fresh listing.
export function claudeLifecycleAncestors(ppid = process.ppid, { psTimeoutMs, lsofTimeoutMs } = HOOK_BOUNDS, { lookup } = {}) {
  if (!Number.isSafeInteger(ppid) || ppid <= 0) return []
  lookup ??= listingLookup(claudeProcessListing({ psTimeoutMs }))
  const result = []
  let executableResolved = false
  for (let current = ppid, row; result.length < 6 && (row = lookup(current)); current = row.ppid) {
    let command = row.command
    if (command === 'claude') {
      if (executableResolved) break
      executableResolved = true
      command = claudeExecutable(row.pid, row.start, { timeoutMs: lsofTimeoutMs })
      // An lsof that failed proves nothing about this process: unknown, never untrusted.
      if (command === null) throw unavailable('process')
    }
    result.push({ pid: row.pid, start: row.start, trusted: trustedClaudeCommand(command) })
    if (result.at(-1).trusted) { result.at(-1).executable = command; break }
  }
  return result
}
// A hook killed while holding the lock leaves it behind. Holding it takes milliseconds, so one
// older than any hook can run is stale and is taken over once.
const STALE_LOCK_MS = 60_000
function takeLock(lock) {
  try { return fs.openSync(lock, 'wx', 0o600) }
  catch (error) {
    if (error.code !== 'EEXIST') throw error
    const stat = fs.lstatSync(lock)
    if (!stat.isFile() || !ownedByMe(stat) || Date.now() - stat.mtimeMs < STALE_LOCK_MS) throw error
    fs.unlinkSync(lock)
    return fs.openSync(lock, 'wx', 0o600)
  }
}
function registry(stateRoot, session, projectRoot, create) {
  canonicalDirectory(stateRoot, true, create)
  const directory = path.join(stateRoot, 'lifecycle')
  canonicalDirectory(directory, true, create)
  const key = createHash('sha256').update(JSON.stringify([session.clientPid, session.clientStart, session.profileHome, projectRoot])).digest('hex')
  return { directory, file: path.join(directory, `${key}.json`) }
}
const chainOf = record => Array.isArray(record?.clearedFrom) ? record.clearedFrom.filter(id => UUID.test(id ?? '')) : []
function readRecord(file) {
  let stat
  try { stat = fs.lstatSync(file) } catch (error) { if (error.code === 'ENOENT') return null; throw error }
  if (!stat.isFile() || stat.nlink !== 1 || !ownedByMe(stat) || !modeIs(stat, 0o600)) throw unavailable()
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
    try { lockFd = takeLock(`${file}.lock`) } catch { continue }
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
    // A symlinked profile (~/.claude -> ~/.claude-work) is checked at its real
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
    const lockFd = takeLock(lock)
    let temporary
    try {
      const previous = readRecord(file)
      const same = matches(previous, session, canonicalProject, endpoint)
      // A /clear records the conversations it came from, latest first, through earlier /clears
      // whose restore never ran (two quick /clears), so the tab's rooms can follow it. A /resume
      // ends the chain: the rooms of a conversation resumed away from stay with it.
      // A retry of the same /clear (its record was written, a later step failed) keeps the chain.
      const clearedFrom = input.source !== 'clear' || !same ? []
        : previous.conversationId === input.session_id ? (previous.source === 'clear' ? chainOf(previous) : [])
        : [previous.conversationId, ...(previous.source === 'clear' ? chainOf(previous) : [])].filter(id => id !== input.session_id).slice(0, 8)
      const record = { schema: 1, launchId, conversationId: input.session_id, source: input.source,
        profileHome, endpoint, clientPid: parent.pid, clientStart: parent.start, projectRoot: canonicalProject,
        ...(clearedFrom.length ? { clearedFrom } : {}) }
      temporary = path.join(directory, `${randomUUID()}.tmp`)
      const fd = fs.openSync(temporary, 'wx', 0o600)
      try { fs.writeFileSync(fd, JSON.stringify(record)); fs.fsyncSync(fd) } finally { fs.closeSync(fd) }
      fs.renameSync(temporary, file); temporary = undefined
      fsyncDir(directory)
      return { session, conversationId: input.session_id, previousConversationId: same ? previous.conversationId : null,
        source: input.source, clearedFrom }
    } finally {
      fs.closeSync(lockFd); fs.unlinkSync(lock)
      if (temporary) fs.unlinkSync(temporary)
    }
  } catch { throw unavailable(stage) }
}
// Claude Code keeps <profile>/sessions/<pid>.json for each running CLI, naming its current
// conversation. A tab whose start-up registration failed uses it to register later, from its MCP
// server. It is Claude's private file, so this is a fallback only: any doubt returns null.
// clientStart is ps's start time in UTC; Claude writes procStart in the same form. A file left by
// an earlier process that had this PID fails it.
export function currentClaudeConversation(profileHome, clientPid, endpoint, clientStart) {
  try {
    if (!Number.isSafeInteger(clientPid) || clientPid <= 0) return null
    const file = path.join(canonicalDirectory(profileHome), 'sessions', `${clientPid}.json`)
    const stat = fs.lstatSync(file)
    if (!stat.isFile() || !ownedByMe(stat) || hasModeBits(stat, 0o022) || stat.size > 65536) return null
    const row = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (row?.pid !== clientPid || !UUID.test(row.sessionId ?? '')) return null
    const squash = value => String(value).replace(/\s+/g, ' ').trim()
    if (typeof clientStart !== 'string' || typeof row.procStart !== 'string' || squash(row.procStart) !== squash(clientStart)) return null
    if (typeof row.messagingSocketPath === 'string' && typeof endpoint === 'string' &&
        fs.realpathSync(row.messagingSocketPath) !== fs.realpathSync(endpoint)) return null
    return row.sessionId
  } catch { return null }
}
// A failed start leaves a marker and a prompt gate for its launch; any later registration clears them.
// The marker keeps the start's source (claude-session-hook.mjs): a failed /clear is retried as a
// /clear, so the tab keeps its rooms.
const retryMarker = (stateRoot, launch) => path.join(stateRoot, 'lifecycle-failures', `pending-${launch}.json`)
export function pendingRegistrationSource(stateRoot, launch) {
  if (!UUID.test(launch ?? '')) return null
  try {
    const stat = fs.lstatSync(retryMarker(stateRoot, launch))
    if (!stat.isFile() || stat.size > 4096) return null
    return JSON.parse(fs.readFileSync(retryMarker(stateRoot, launch), 'utf8'))?.source === 'clear' ? 'clear' : null
  } catch { return null }
}
export function clearRegistrationRetry(stateRoot, launch) {
  if (!UUID.test(launch ?? '')) return
  for (const file of [retryMarker(stateRoot, launch), path.join(stateRoot, 'notices', `session-${launch}.registration.gate`)])
    try { fs.unlinkSync(file) } catch {}
}
// A background restore that failed leaves a gate, so the prompt hook tells the tab; the next call
// that rejoins its rooms (or a restore that works) removes it.
export const restoreGateFile = (stateRoot, launch) => path.join(stateRoot, 'notices', `session-${launch}.restore.gate`)
export function clearRestoreNotice(stateRoot, launch) {
  if (!UUID.test(launch ?? '')) return
  try { fs.unlinkSync(restoreGateFile(stateRoot, launch)) } catch {}
}
// null is a definite answer: not this CLI process, its socket is gone, or it
// has no record. A check that could not run (ps or lsof failed, a damaged or
// unsafe record) throws, so callers keep mail and membership instead of
// reading a busy machine as a closed tab.
export function resolveClaudeConversation(nativeSession, options) {
  return claudeLifecycleRecord(nativeSession, options)?.conversationId ?? null
}
// What started the tab's current conversation (startup, resume, clear, fork) and, for a /clear,
// the conversations it came from, from the same record.
export function resolveClaudeLifecycleStart(nativeSession, options) {
  const record = claudeLifecycleRecord(nativeSession, options)
  return record ? { source: record.source, clearedFrom: chainOf(record) } : null
}
function claudeLifecycleRecord(nativeSession, {
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
    return matches(record, session, canonicalProject, endpoint) ? record : null
  } catch { throw unavailable('process') }
}
