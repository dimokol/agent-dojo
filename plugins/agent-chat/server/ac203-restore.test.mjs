// A background restore that fails used to be visible only in lifecycle-failures/: no gate, so the
// prompt hook never ran and the tab never heard. Now the tab gets one line at its next prompt until
// a later agent-chat call rejoins its rooms.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { createStore } from './store.mjs'
import { createService } from './server.mjs'
import { pruneHousekeeping } from './notice-files.mjs'
import { claudeEndpoint } from './test-platform.mjs'

const HOOK = path.join(path.dirname(fileURLToPath(import.meta.url)), 'claude-session-hook.mjs')
const LAUNCH = '00000000-0000-4000-8000-00000000aa01', CONV = '00000000-0000-4000-8000-00000000aa02'
const LINE = "agent-chat couldn't rejoin your rooms; your next chat call retries"
const clean = () => Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('CLAUDE_CODE_') && !k.startsWith('AGENT_CHAT_')))
const fixture = t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ac203-restore-')))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const dirs = { state: path.join(root, 'state'), chats: path.join(root, 'chats'), profile: path.join(root, 'profile'), project: path.join(root, 'p') }
  for (const d of Object.values(dirs)) fs.mkdirSync(d, { mode: 0o700 })
  const env = { ...clean(), AGENT_CHAT_STATE_ROOT: dirs.state, AGENT_CHAT_ROOT: dirs.chats, CLAUDE_CONFIG_DIR: dirs.profile, CLAUDE_CODE_SESSION_ID: LAUNCH }
  const gate = path.join(dirs.state, 'notices', `session-${LAUNCH}.restore.gate`)
  const prompt = () => {
    const run = spawnSync(process.execPath, [HOOK, '--flags'], { env, input: JSON.stringify({ session_id: CONV, cwd: dirs.project, hook_event_name: 'UserPromptSubmit' }), encoding: 'utf8', timeout: 30_000 })
    try { return JSON.parse(run.stdout || '{}').systemMessage ?? '' } catch { return '' }
  }
  // The restore fails: the recorded profile folder is gone, so the session fails validation (no ps runs).
  const failRestore = () => {
    const tasks = path.join(dirs.state, 'hook-tasks'); fs.mkdirSync(tasks, { recursive: true, mode: 0o700 })
    const task = path.join(tasks, '11111111-1111-4111-8111-111111111111.json')
    fs.writeFileSync(task, JSON.stringify({ projectRoot: dirs.project, observation: { source: 'resume', conversationId: CONV,
      session: { runtime: 'claude', id: LAUNCH, conversationId: CONV, lifecycle: true, profileHome: path.join(root, 'gone-profile'), endpoint: claudeEndpoint('/private/x.sock'), clientPid: 1, clientStart: 'x' } } }), { mode: 0o600 })
    return spawnSync(process.execPath, [HOOK, '--work', task], { env, encoding: 'utf8', timeout: 30_000 })
  }
  return { root, ...dirs, env, gate, prompt, failRestore }
}

test('a failed background restore leaves a prompt gate, and the next prompt says so in one line', t => {
  const f = fixture(t)
  assert.equal(f.failRestore().status, 0)
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.state, 'lifecycle-failures', 'latest.json'), 'utf8')).stage, 'restore')
  assert.ok(fs.existsSync(f.gate), 'no gate: the prompt hook (prompt.sh globs session-<launch>*.gate) never runs')
  const said = f.prompt()
  assert.equal(said.split('\n').filter(line => line === LINE).length, 1, JSON.stringify(said))
})

test('the line goes away once a later agent-chat call from that tab succeeds', async t => {
  const f = fixture(t)
  f.failRestore()
  assert.ok(f.prompt().includes(LINE))
  const store = createStore({ root: f.chats, stateRoot: f.state, projectRoot: f.project })
  const session = { runtime: 'claude', id: LAUNCH, profileHome: f.profile, endpoint: claudeEndpoint('/private/agent-chat-restore.sock'), clientPid: process.pid, clientStart: 'Mon Jan  1 00:00:00 2024', serverPid: process.pid, serverStart: 'Mon Jan  1 00:00:00 2024' }
  const svc = createService({ store, env: { CLAUDE_CODE_SESSION_ID: LAUNCH }, adapters: { async deliver() { return { status: 'accepted' } } }, inferSession: () => session, resolveConversation: () => CONV })
  t.after(() => svc.close())
  await svc.call('list_rooms')
  assert.equal(fs.existsSync(f.gate), false)
  assert.ok(!f.prompt().includes(LINE))
})

test('a failed call does not clear the line', async t => {
  const f = fixture(t)
  f.failRestore()
  const store = createStore({ root: f.chats, stateRoot: f.state, projectRoot: f.project })
  const svc = createService({ store, env: { CLAUDE_CODE_SESSION_ID: LAUNCH }, adapters: {}, inferSession: () => { throw Object.assign(new Error('busy'), { code: 'CHAT_PRESENCE_UNAVAILABLE' }) } })
  t.after(() => svc.close())
  await assert.rejects(svc.call('list_rooms'))
  assert.ok(fs.existsSync(f.gate))
})

test('housekeeping drops a restore gate left by a tab that closed long ago', t => {
  const f = fixture(t)
  fs.mkdirSync(path.dirname(f.gate), { recursive: true, mode: 0o700 }); fs.writeFileSync(f.gate, '', { mode: 0o600 })
  assert.equal(pruneHousekeeping(f.state, { now: Date.now() + 8 * 86_400_000 }), 1)
  assert.equal(fs.existsSync(f.gate), false)
})
