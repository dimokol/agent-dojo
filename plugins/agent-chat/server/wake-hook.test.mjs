import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { ringClaude, wakeState, sweepWakeFiles, wakeHookSettings, wakeText } from './wake-ring.mjs'

const HOOK = fileURLToPath(new URL('./wake-hook.mjs', import.meta.url))
const sleep = ms => new Promise(r => setTimeout(r, ms))

function tempDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'agent-chat-wake-')) }
// A stand-in for the Claude CLI: any live process gives the hook a PID to watch.
function fakeClaude() {
  const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1e6)'], { stdio: 'ignore' })
  return child
}
function runHook(dir, claudePid, { event = 'Stop', env = {} } = {}) {
  const child = spawn(process.execPath, [HOOK], {
    env: { ...process.env, AGENT_CHAT_WAKE_DIR: dir, CLAUDE_PID: claudePid === undefined ? '' : String(claudePid), CLAUDE_CODE_ENTRYPOINT: 'cli', ...env },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  child.stdin.end(JSON.stringify({ hook_event_name: event, session_id: 'test-session' }))
  let stderr = ''
  child.stderr.on('data', d => { stderr += d })
  const exited = new Promise(res => child.on('exit', code => res({ code, stderr })))
  return { child, exited }
}
async function untilArmed(dir, claudePid, ms = 3000) {
  const end = Date.now() + ms
  while (Date.now() < end) { if (wakeState({ dir, claudePid }).armed) return true; await sleep(25) }
  return false
}
const within = (p, ms) => Promise.race([p, sleep(ms).then(() => 'timeout')])

test('a ring wakes the armed hook: exit 2, wake text on stderr, ring consumed', async t => {
  const dir = tempDir(), claude = fakeClaude()
  t.after(() => { claude.kill(); fs.rmSync(dir, { recursive: true, force: true }) })
  const { exited } = runHook(dir, claude.pid)
  assert.equal(await untilArmed(dir, claude.pid), true)
  ringClaude({ dir, claudePid: claude.pid, room: 'dev', messageIds: ['m1', 'm2'] })
  const r = await within(exited, 3000)
  assert.notEqual(r, 'timeout')
  assert.equal(r.code, 2)
  assert.match(r.stderr, /Agent Chat/)
  assert.match(r.stderr, /nothing failed/i)
  assert.match(r.stderr, /2 new messages/)
  assert.match(r.stderr, /dev/)
  assert.deepEqual(fs.readdirSync(dir).filter(f => f.startsWith('ring-')), [])
})

test('wake text carries room ids and a count, never message bodies', () => {
  const text = wakeText({ rooms: ['dev', 'ops'], count: 3 })
  assert.match(text, /3 new messages/)
  assert.match(text, /dev, ops/)
  assert.equal(wakeText({ rooms: ['dev'], count: 1 }).includes('1 new message '), true)
})

test('with no ring the hook keeps waiting, and exits 0 once its Claude is gone', async t => {
  const dir = tempDir(), claude = fakeClaude()
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const { exited } = runHook(dir, claude.pid)
  assert.equal(await untilArmed(dir, claude.pid), true)
  assert.equal(await within(exited, 800), 'timeout')
  claude.kill()
  const r = await within(exited, 5000)
  assert.notEqual(r, 'timeout')
  assert.equal(r.code, 0)
  assert.equal(wakeState({ dir, claudePid: claude.pid }).armed, false)
})

test('one waiter per session: a newer hook takes over and the older exits 0', async t => {
  const dir = tempDir(), claude = fakeClaude()
  t.after(() => { claude.kill(); fs.rmSync(dir, { recursive: true, force: true }) })
  const a = runHook(dir, claude.pid, { event: 'SessionStart' })
  assert.equal(await untilArmed(dir, claude.pid), true)
  const b = runHook(dir, claude.pid, { event: 'Stop' })
  const ra = await within(a.exited, 3000)
  assert.notEqual(ra, 'timeout')
  assert.equal(ra.code, 0)
  assert.equal(wakeState({ dir, claudePid: claude.pid }).event, 'Stop')
  ringClaude({ dir, claudePid: claude.pid, room: 'dev', messageIds: ['m1'] })
  const rb = await within(b.exited, 3000)
  assert.equal(rb.code, 2)
})

test('mail that arrived during a turn wakes the next waiter at once', async t => {
  const dir = tempDir(), claude = fakeClaude()
  t.after(() => { claude.kill(); fs.rmSync(dir, { recursive: true, force: true }) })
  const outlook = ringClaude({ dir, claudePid: claude.pid, room: 'dev', messageIds: ['m1'] })
  assert.equal(outlook.armed, false)
  const { exited } = runHook(dir, claude.pid)
  const r = await within(exited, 3000)
  assert.notEqual(r, 'timeout')
  assert.equal(r.code, 2)
})

test('rings before the hook takes them merge into one wake with the total count', async t => {
  const dir = tempDir(), claude = fakeClaude()
  t.after(() => { claude.kill(); fs.rmSync(dir, { recursive: true, force: true }) })
  ringClaude({ dir, claudePid: claude.pid, room: 'dev', messageIds: ['m1'] })
  ringClaude({ dir, claudePid: claude.pid, room: 'ops', messageIds: ['m2', 'm3'] })
  ringClaude({ dir, claudePid: claude.pid, room: 'dev', messageIds: ['m1'] }) // a retried ring
  const r = await within(runHook(dir, claude.pid).exited, 3000)
  assert.equal(r.code, 2)
  assert.match(r.stderr, /3 new messages/)
  assert.match(r.stderr, /dev, ops/)
})

test('the sender learns whether the session will wake now', async t => {
  const dir = tempDir(), claude = fakeClaude()
  t.after(() => { claude.kill(); fs.rmSync(dir, { recursive: true, force: true }) })
  const { exited } = runHook(dir, claude.pid)
  assert.equal(await untilArmed(dir, claude.pid), true)
  assert.equal(ringClaude({ dir, claudePid: claude.pid, room: 'dev', messageIds: ['m1'] }).armed, true)
  await within(exited, 3000)
})

test('non-interactive runs and a missing CLAUDE_PID leave at once without arming', async t => {
  const dir = tempDir(), claude = fakeClaude()
  t.after(() => { claude.kill(); fs.rmSync(dir, { recursive: true, force: true }) })
  for (const env of [{ CLAUDE_CODE_ENTRYPOINT: 'sdk-cli' }, { CLAUDE_CODE_SESSION_ATTENDED: '0' }]) {
    const r = await within(runHook(dir, claude.pid, { env }).exited, 3000)
    assert.equal(r.code, 0)
  }
  const r = await within(runHook(dir, undefined).exited, 3000)
  assert.equal(r.code, 0)
  assert.deepEqual(fs.readdirSync(dir).filter(f => f.startsWith('armed-')), [])
})

test('the sweep removes files of Claude processes that are gone and keeps live ones', async t => {
  const dir = tempDir(), live = fakeClaude(), gone = fakeClaude()
  t.after(() => { live.kill(); fs.rmSync(dir, { recursive: true, force: true }) })
  const goneExit = new Promise(r => gone.on('exit', r))
  ringClaude({ dir, claudePid: live.pid, room: 'dev', messageIds: ['m1'] })
  ringClaude({ dir, claudePid: gone.pid, room: 'dev', messageIds: ['m1'] })
  gone.kill(); await goneExit
  const removed = sweepWakeFiles({ dir })
  assert.equal(removed, 1)
  assert.deepEqual(fs.readdirSync(dir).filter(f => f.startsWith('ring-')), [`ring-${live.pid}.json`])
})

test('hook settings: async rewake on SessionStart, Stop, StopFailure and after an inbox read', () => {
  const s = wakeHookSettings({ command: 'node "/x/wake-hook.mjs"' })
  for (const ev of ['SessionStart', 'Stop', 'StopFailure', 'PostToolUse']) {
    const h = s.hooks[ev][0].hooks[0]
    assert.equal(h.async, true, ev)
    assert.equal(h.asyncRewake, true, ev)
    assert.equal(h.command, 'node "/x/wake-hook.mjs"')
  }
  assert.equal(s.hooks.PostToolUse[0].matcher, 'mcp__agent-chat__inbox|mcp__agent_chat__inbox')
})
