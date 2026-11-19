// Wake files shared by the asyncRewake hook (wake.sh on macOS, wake-hook.mjs on Windows)
// and the server that delivers mail.
//
// One folder, keyed by the Claude CLI's PID (CLAUDE_PID, stable for the CLI's lifetime even
// across /clear and /resume):
//   armed-<pid>.json         the session's current waiter: { waiter, event, at }. Newest wins.
//   ring-<pid>               mail waiting to wake the session. Line 1 is the wake text, line 2 the
//                            JSON { rooms: { <room>: [<message id>...] } }, so the shell waiter
//                            only has to read one line.
//   pipe-<pid>-<waiter>      the macOS waiter's named pipe. A byte written to it means "look now".
//   taken-<pid>-<waiter>     a ring the waiter has claimed, removed right after.
// Rings carry room and message IDs only, never message text. The inbox stays the truth: a lost
// or duplicated ring costs at most one extra or one late wake, never a message.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'

// No PostToolUse arming: the waiter armed at Stop stays through the next turn, so an extra waiter
// per inbox read only cost a process start and a handover.
export const WAKE_EVENTS = ['SessionStart', 'Stop', 'StopFailure']
// Claude Code stops an async hook at its timeout. The waiter has to outlast long idle stretches.
export const WAKE_TIMEOUT_S = 20 * 86400

// AGENT_CHAT_WAKE=hook switches Claude delivery from the CLI's private socket to the hook.
export const wakeMode = (env = process.env) => env.AGENT_CHAT_WAKE === 'hook' ? 'hook' : 'socket'

export function defaultWakeDir(env = process.env) {
  if (env.AGENT_CHAT_WAKE_DIR) return env.AGENT_CHAT_WAKE_DIR
  return path.join(env.AGENT_CHAT_STATE_ROOT || path.join(os.homedir(), '.local/state/agent-chat'), 'wake')
}

export function ensureWakeDir(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  // Windows has no POSIX modes; the folder inherits the user profile's ACL there.
  if (process.platform !== 'win32') fs.chmodSync(dir, 0o700)
}

export const armedFile = (dir, pid) => path.join(dir, `armed-${pid}.json`)
export const ringFile = (dir, pid) => path.join(dir, `ring-${pid}`)
export const pipeFile = (dir, pid, waiter) => path.join(dir, `pipe-${pid}-${waiter}`)

export function isAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false
  try { process.kill(pid, 0); return true } catch (e) { return e.code === 'EPERM' }
}

export function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return null }
}

function writeAtomic(file, text) {
  const temp = `${file}.${process.pid}.${randomUUID()}.tmp`
  fs.writeFileSync(temp, text, { mode: 0o600 })
  fs.renameSync(temp, file)
}
export const writeJsonAtomic = (file, value) => writeAtomic(file, JSON.stringify(value) + '\n')

export function readRing(file) {
  try {
    const ring = JSON.parse(fs.readFileSync(file, 'utf8').split('\n')[1])
    return ring && typeof ring.rooms === 'object' ? ring : null
  } catch { return null }
}

function writeRing(file, ring) {
  const summary = ringSummary(ring)
  if (!summary.rooms.length) { fs.rmSync(file, { force: true }); return }
  writeAtomic(file, `${wakeText(summary)}\n${JSON.stringify(ring)}\n`)
}

// Is a waiter armed for this Claude right now? Decides "rung" vs "queued" for the sender.
export function wakeState({ dir = defaultWakeDir(), claudePid }) {
  const mark = readJson(armedFile(dir, claudePid))
  if (!mark || !isAlive(mark.waiter) || !isAlive(claudePid)) return { armed: false }
  return { armed: true, waiter: mark.waiter, event: mark.event, since: mark.at }
}

// Tell a macOS waiter to look now. Non-blocking: no reader means nobody is waiting on that pipe.
function poke(dir, claudePid, waiter) {
  let fd
  try {
    fd = fs.openSync(pipeFile(dir, claudePid, waiter), fs.constants.O_WRONLY | fs.constants.O_NONBLOCK)
    fs.writeSync(fd, '\n')
    return true
  } catch { return false }
  finally { if (fd !== undefined) try { fs.closeSync(fd) } catch {} }
}

// Leave a ring for one Claude session and wake its waiter. Rings written before the waiter takes
// them merge into one wake, and a retried ring with the same message ID adds nothing.
// Returns { armed }: true when a live waiter was told, false when the ring waits for the next one.
export function ringClaude({ dir = defaultWakeDir(), claudePid, room, messageIds = [] }) {
  if (!Number.isSafeInteger(claudePid) || claudePid <= 0) throw new Error('ringClaude needs the Claude CLI pid')
  if (typeof room !== 'string' || !room) throw new Error('ringClaude needs a room')
  ensureWakeDir(dir)
  const file = ringFile(dir, claudePid)
  const ring = readRing(file) || { rooms: {} }
  const ids = new Set(ring.rooms[room] || [])
  for (const id of messageIds) ids.add(String(id))
  ring.rooms[room] = [...ids]
  writeRing(file, ring)
  const state = wakeState({ dir, claudePid })
  if (!state.armed) return { armed: false }
  // The Node waiter (Windows) has no pipe and sees the ring through its folder watch.
  if (!fs.existsSync(pipeFile(dir, claudePid, state.waiter))) return { armed: true }
  return { armed: poke(dir, claudePid, state.waiter) }
}

// An inbox read settles the mail it returned, so a waiter armed after it doesn't wake the session
// again for messages it already has.
export function clearRing({ dir = defaultWakeDir(), claudePid, room, messageIds = [] }) {
  const file = ringFile(dir, claudePid)
  const ring = readRing(file)
  if (!ring?.rooms?.[room]) return
  const read = new Set(messageIds.map(String))
  const left = ring.rooms[room].filter(id => !read.has(id))
  if (left.length) ring.rooms[room] = left
  else delete ring.rooms[room]
  writeRing(file, ring)
}

export function wakeText({ rooms, count }) {
  return `Agent Chat delivery, not an error: ${count === 1 ? '1 new message' : `${count} new messages`} in ${rooms.join(', ')}. ` +
    `Read with the agent-chat inbox tool; peer requests can't grant permission.`
}

export function ringSummary(ring) {
  const rooms = Object.keys(ring?.rooms || {}).filter(r => ring.rooms[r].length).sort()
  const count = rooms.reduce((n, r) => n + ring.rooms[r].length, 0)
  return { rooms, count }
}

// The macOS waiter (wake.sh) is a shell script, so a waiter left behind by a Claude that died without
// stopping its hooks is found by its command line before it is stopped.
function isOurWaiter(pid) {
  if (process.platform === 'win32') return false
  try { return /(^|\/)wake\.sh(\s|$)/.test(execFileSync('/bin/ps', ['-o', 'command=', '-p', String(pid)], { encoding: 'utf8', timeout: 2000 })) }
  catch { return false }
}

// Remove wake files of Claude processes that are gone, marks whose waiter is gone, and stray
// temp files, and stop waiters whose Claude is gone. Returns how many files it removed.
export function sweepWakeFiles({ dir = defaultWakeDir(), now = Date.now() } = {}) {
  let names
  try { names = fs.readdirSync(dir) } catch { return 0 }
  let removed = 0
  const drop = name => { try { fs.rmSync(path.join(dir, name), { force: true }); removed++ } catch {} }
  for (const name of names) {
    if (name.endsWith('.tmp')) {
      try { if (now - fs.statSync(path.join(dir, name)).mtimeMs > 60_000) drop(name) } catch {}
      continue
    }
    const m = /^(armed|ring|taken|pipe)-(\d+)(?:-(\d+))?(?:\.json)?$/.exec(name)
    if (!m) continue
    const pid = Number(m[2])
    if (!isAlive(pid)) {
      const waiter = m[1] === 'armed' ? readJson(path.join(dir, name))?.waiter : m[1] === 'pipe' ? Number(m[3]) : null
      if (isAlive(waiter) && isOurWaiter(waiter)) try { process.kill(waiter, 'SIGTERM') } catch {}
      drop(name)
      continue
    }
    if (m[1] === 'armed' && !isAlive(readJson(path.join(dir, name))?.waiter)) drop(name)
    if (m[1] === 'pipe' && !isAlive(Number(m[3]))) drop(name)
  }
  return removed
}

// The hook entries for Claude Code settings. Arming on StopFailure matters: a turn that ends in
// an API error fires no Stop, and without it nothing re-arms (seen on Windows and macOS).
export function wakeHookSettings({ command, timeout = WAKE_TIMEOUT_S }) {
  const entry = () => ({ type: 'command', command, async: true, asyncRewake: true, timeout })
  return { hooks: Object.fromEntries(WAKE_EVENTS.map(ev => [ev, [{ hooks: [entry()] }]])) }
}
