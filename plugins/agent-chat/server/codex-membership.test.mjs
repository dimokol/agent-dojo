import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createStore } from './store.mjs'
import { createService } from './server.mjs'
import { createAdapters } from './adapters.mjs'
import { processIdentity } from './native-session.mjs'

const THREAD = '12345678-1234-1234-1234-123456789abc'
const META = { 'x-codex-turn-metadata': { thread_id: THREAD } }
async function fixture(t) {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'codex-membership-')))
  const profileHome = path.join(directory, 'profile'), projectRoot = path.join(directory, 'project')
  fs.mkdirSync(profileHome, { mode: 0o700 }); fs.mkdirSync(projectRoot)
  const clock = { offset: 0 }
  const options = { root: path.join(directory, 'chats'), projectRoot, now: () => Date.now() + clock.offset }
  const store = createStore(options)
  store.createRoom({ room: 'room', title: 'Native thread membership' })
  const queued = [], presence = { loaded: true, exists: true, unavailable: false }, inspections = []
  const adapters = createAdapters({ control: { async inspect(session) {
    inspections.push(session.id)
    if (presence.unavailable) throw new Error('Native daemon temporarily unavailable')
    return { loaded: presence.loaded, exists: presence.exists, cwd: presence.exists ? projectRoot : null }
  } }, executor: async (_file, args) => {
    if (args[0] === '--version') return { code: 0, stdout: 'codex-cli 0.162.1\n' }
    if (args[0] === 'queue' && args[1] === '--help') return { code: 0, stdout: '--thread --message' }
    if (args[0] === 'queue') { queued.push(args); return { code: 0, stdout: '' } }
    throw new Error('Unexpected native operation')
  } })
  const deadSession = { id: THREAD, runtime: 'codex', profileHome, serverPid: 2147483647, serverStart: 'Thu Oct  1 00:00:00 2026' }
  const services = []
  const service = extra => {
    const current = createService({ store: createStore(options), adapters, env: {}, ...extra })
    services.push(current)
    return current
  }
  t.after(() => { for (const current of services) current.close(); fs.rmSync(directory, { recursive: true, force: true }) })
  const sender = service()
  await sender.call('join_room', { room: 'room', agent: 'Sender', session: { id: 'sender', runtime: 'manual' } })
  const post = message => sender.call('post', { room: 'room', from: 'Sender', to: 'Receiver', message })
  return { store, service, sender, post, deadSession, profileHome, queued, presence, inspections, clock }
}

test('a dead Codex MCP process does not revoke a still-loaded native thread or prevent later delivery', async t => {
  const f = await fixture(t)
  f.store.join({ room: 'room', agent: 'Receiver', session: f.deadSession })
  await f.sender.call('list_rooms')
  assert.equal(f.store.memberships().find(row => row.agent === 'Receiver').joined, true)
  const sent = await f.post('after the receiver MCP process exited')
  assert.equal(f.queued.length, 1)
  assert.equal(f.queued[0][f.queued[0].indexOf('--thread') + 1], THREAD)
  assert.equal(f.store.deliveryStatus({ room: 'room', agent: 'Receiver' }).find(row => row.message_id === sent.message_id).status, 'notified')
  assert.equal(f.store.memberships().find(row => row.agent === 'Receiver').joined, true)
  assert.ok(f.inspections.every(id => id === THREAD))
})

test('closing the Codex MCP connection retains native membership and unread delivery without another receiver call', async t => {
  const f = await fixture(t), self = processIdentity(process.pid)
  let receiverCalls = 0
  const receiver = f.service({ inferSession: () => {
    receiverCalls++
    return { id: THREAD, runtime: 'codex', profileHome: f.profileHome, serverPid: self.pid, serverStart: self.start }
  } })
  await receiver.call('join_room', { room: 'room', agent: 'Receiver' }, 1, META)
  receiver.close()
  assert.equal(f.store.memberships().find(row => row.agent === 'Receiver').joined, true)
  const before = receiverCalls
  await f.post('after the MCP connection closed')
  assert.equal(f.queued.length, 1)
  assert.equal(receiverCalls, before)
  await assert.rejects(receiver.call('list_rooms', {}, 2, META), /connection is closed/)
})

test('temporarily unavailable daemon presence retains membership and pending mail through a later post', async t => {
  const f = await fixture(t)
  f.store.join({ room: 'room', agent: 'Receiver', session: f.deadSession })
  f.presence.unavailable = true
  const first = await f.post('while the daemon restarts')
  assert.equal(f.queued.length, 0)
  assert.equal(f.store.memberships().find(row => row.agent === 'Receiver').joined, true)
  assert.equal(f.store.deliveryStatus({ room: 'room', agent: 'Receiver' }).find(row => row.message_id === first.message_id).status, 'pending')
  f.presence.unavailable = false
  const second = await f.post('daemon available again')
  assert.equal(f.queued.length, 1)
  const text = f.queued[0][f.queued[0].indexOf('--message') + 1]
  assert.ok(text.includes(first.message_id) && text.includes(second.message_id))
})

test('positively absent native thread closes membership while preserving unread mail', async t => {
  const f = await fixture(t)
  f.store.join({ room: 'room', agent: 'Receiver', session: f.deadSession })
  f.presence.loaded = false
  f.presence.exists = false
  const sent = await f.post('native thread positively absent')
  assert.equal(f.queued.length, 0)
  const member = f.store.memberships().find(row => row.agent === 'Receiver')
  assert.equal(member.joined, false)
  assert.equal(member.left_reason, 'session_closed')
  assert.equal(member.deliveries[sent.message_id].status, 'pending')
})

test('explicit Codex leave still disables delivery despite a loaded thread', async t => {
  const f = await fixture(t), self = processIdentity(process.pid)
  const receiver = f.service({ inferSession: () => ({ id: THREAD, runtime: 'codex', profileHome: f.profileHome, serverPid: self.pid, serverStart: self.start }) })
  await receiver.call('join_room', { room: 'room', agent: 'Receiver' }, 1, META)
  await receiver.call('leave_room', { room: 'room', agent: 'Receiver' }, 2, META)
  await f.post('after explicit leave')
  assert.equal(f.queued.length, 0)
  assert.equal(f.store.memberships().find(row => row.agent === 'Receiver').left_reason, 'explicit')
})


// Decided 2026-10-19 (reverses the 10-16 queue-for-resume behaviour): a
// closed Codex tab is not rung. Its thread stays on disk but is not loaded.
test('a closed Codex tab (persisted, not loaded) gets no ring; its mail waits and rings once the thread loads again', async t => {
  const f = await fixture(t)
  f.store.join({ room: 'room', agent: 'Receiver', session: f.deadSession })
  f.presence.loaded = false
  const first = await f.post('while the Codex tab is closed')
  assert.equal(f.queued.length, 0)
  const closed = f.store.memberships().find(row => row.agent === 'Receiver')
  assert.equal(closed.joined, false)
  assert.equal(closed.left_reason, 'session_closed')
  assert.equal(closed.deliveries[first.message_id].status, 'pending')
  f.presence.loaded = true
  const second = await f.post('after the tab reopened')
  assert.equal(f.queued.length, 1)
  const text = f.queued[0][f.queued[0].indexOf('--message') + 1]
  assert.ok(text.includes(first.message_id) && text.includes(second.message_id))
  assert.equal(f.store.memberships().find(row => row.agent === 'Receiver').joined, true)
})

test('members reports a closed Codex tab as closed and not wakeable, before any delivery records it', async t => {
  const f = await fixture(t)
  f.store.join({ room: 'room', agent: 'Receiver', session: f.deadSession })
  f.presence.loaded = false
  const row = (await f.sender.call('members', { room: 'room' })).find(member => member.name === 'Receiver')
  assert.deepEqual([row.status, row.joined, row.wakeable], ['closed', false, false])
  f.presence.unavailable = true
  const unknown = (await f.sender.call('members', { room: 'room' })).find(member => member.name === 'Receiver')
  assert.deepEqual([unknown.status, unknown.wakeable], ['joined', false])
})

// Seen live 2026-10-19: one Codex doorbell from 10-16 never answered, and it
// blocked every later ring to that agent for three days.
test('an unanswered doorbell stops gating new mail after fifteen minutes', async t => {
  const f = await fixture(t)
  f.store.join({ room: 'room', agent: 'Receiver', session: f.deadSession })
  const first = await f.post('rung, never read')
  assert.equal(f.queued.length, 1)
  await f.post('within the window: waits behind the open doorbell')
  assert.equal(f.queued.length, 1)
  f.clock.offset = 15 * 60_000
  const third = await f.post('after the window')
  assert.equal(f.queued.length, 2)
  const text = f.queued[1][f.queued[1].indexOf('--message') + 1]
  assert.ok(text.includes(third.message_id) && !text.includes(first.message_id))
})

test('an ordinary post rearms a known thread wrongly closed by an older MCP-PID check without service restart', async t => {
  const f = await fixture(t)
  // Finish startup recovery before introducing the legacy closed record.
  await new Promise(resolve => setImmediate(resolve))
  f.store.join({ room: 'room', agent: 'Receiver', session: f.deadSession })
  f.store.deactivateSession(THREAD)
  const earlier = f.store.post({ room: 'room', from: 'Sender', to: 'Receiver', message: 'retained from the old connection' })
  const later = await f.post('ordinary post after native daemon reconnect')
  assert.equal(f.queued.length, 1)
  const frame = f.queued[0][f.queued[0].indexOf('--message') + 1]
  assert.ok(frame.includes(earlier.message_id) && frame.includes(later.message_id))
  const member = f.store.memberships().find(row => row.agent === 'Receiver')
  assert.equal(member.joined, true)
  assert.equal(member.session.id, THREAD)
  assert.equal(member.session.serverPid, undefined)
})
