import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createStore } from './store.mjs'
import { createService } from './server.mjs'
import { processIdentity } from './native-session.mjs'
import { ringClaude, ringFile, readRing } from './wake-ring.mjs'

// 2.0.4 hook mode: the inbox read settles the reading tab's wake ring, so the waiter armed after
// the woken turn doesn't wake the session a second time for mail it already read.
const CONV = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', LAUNCH = '11111111-1111-4111-8111-111111111111'
const accepted = { async deliver() { return { status: 'accepted' } } }
const self = processIdentity(process.pid)

function fixture(t) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agent-chat-wake-wiring-')))
  const closers = []
  t.after(() => { for (const close of closers.reverse()) try { close() } catch {} ; fs.rmSync(dir, { recursive: true, force: true }) })
  const stateRoot = path.join(dir, 'state'), profile = path.join(dir, 'profile'), wakeDir = path.join(dir, 'wake')
  for (const folder of [stateRoot, profile]) fs.mkdirSync(folder, { mode: 0o700 })
  const store = createStore({ root: path.join(dir, 'chats'), projectRoot: dir, stateRoot })
  store.createRoom({ room: 'r', title: 'r' })
  const own = service => (closers.push(() => service.close()), service)
  const session = { runtime: 'claude', id: LAUNCH, profileHome: profile, endpoint: '/private/agent-chat-wake.sock',
    clientPid: self.pid, clientStart: self.start, serverPid: self.pid, serverStart: self.start }
  return { store, own, session, wakeDir }
}

async function readWith(t, env) {
  const f = fixture(t)
  env = { ...env, ...(env.AGENT_CHAT_WAKE_DIR === '' ? { AGENT_CHAT_WAKE_DIR: f.wakeDir } : {}) }
  const peer = f.own(createService({ store: f.store, env: {}, adapters: accepted, inferSession: () => null }))
  await peer.call('join_room', { room: 'r', agent: 'Peer', session: { id: 'peer', runtime: 'manual' } })
  const reader = f.own(createService({ store: f.store, env, adapters: accepted, inferSession: () => f.session, resolveConversation: () => CONV }))
  const { agent } = await reader.call('join_room', { room: 'r', agent: 'Reader' })
  const one = await peer.call('post', { room: 'r', from: 'Peer', to: agent, message: 'one' })
  const two = await peer.call('post', { room: 'r', from: 'Peer', to: agent, message: 'two' })
  ringClaude({ dir: f.wakeDir, claudePid: self.pid, room: 'r', messageIds: [one.message_id, two.message_id] })
  ringClaude({ dir: f.wakeDir, claudePid: self.pid, room: 'other', messageIds: ['x1'] })
  const args = { room: 'r', agent }
  reader.written('inbox', args, await reader.call('inbox', args))
  return readRing(ringFile(f.wakeDir, self.pid))
}

test('hook mode: an inbox read clears what it returned from the ring, other rooms stay', async t => {
  const ring = await readWith(t, { AGENT_CHAT_WAKE: 'hook', AGENT_CHAT_WAKE_DIR: '' })
  assert.deepEqual(ring.rooms, { other: ['x1'] })
})

test('socket mode leaves wake files alone', async t => {
  const ring = await readWith(t, { AGENT_CHAT_WAKE_DIR: '' })
  assert.deepEqual(Object.keys(ring.rooms).sort(), ['other', 'r'])
})

test('hook mode skips the Claude version check and never starts the two-turn verifier', async t => {
  const { versionCheckOff, isVerifiedVersion } = await import('./claude-versions.mjs')
  const { scheduleVerification } = await import('./claude-auto-verify.mjs')
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agent-chat-wake-gate-')))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const stateRoot = path.join(dir, 'state'); fs.mkdirSync(stateRoot, { mode: 0o700 })
  const hook = { AGENT_CHAT_WAKE: 'hook', AGENT_CHAT_VERSION_CHECK: 'on' }, socket = { AGENT_CHAT_VERSION_CHECK: 'on' }
  assert.equal(versionCheckOff(hook), true)
  assert.equal(versionCheckOff(socket), false)
  assert.equal(isVerifiedVersion('2.1.999', { stateRoot, env: hook }), true)
  assert.equal(isVerifiedVersion('2.1.999', { stateRoot, env: socket }), false)
  let spawned = 0
  const result = scheduleVerification({ version: '2.1.999', stateRoot, cwd: dir, profileHome: stateRoot },
    { env: hook, spawnWorker: () => { spawned++ }, isVerified: (version, options) => isVerifiedVersion(version, { ...options, env: hook }) })
  assert.equal(result.status, 'already_verified')
  assert.equal(spawned, 0)
})
