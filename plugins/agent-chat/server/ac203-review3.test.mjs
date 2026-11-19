import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createStore } from './store.mjs'
import { createService } from './server.mjs'
import { processIdentity } from './native-session.mjs'
import { claudeEndpoint } from './test-platform.mjs'

// ac203 third review round: mail lost when a participant's rows move to another identity.
// 1. a rename onto a closed name that has a row in a room where this tab's own mail waits,
// 2. /resume back to a conversation whose earlier name got mail while it was cleared,
// 3. a tab renamed before its conversation resolved, 4. a bound alias another tab owns now.
const CONV = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', CONV2 = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const L1 = '11111111-1111-4111-8111-111111111111', L2 = '22222222-2222-4222-8222-222222222222'
const accepted = { async deliver() { return { status: 'accepted' } } }
const self = processIdentity(process.pid)

function fixture(t) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agent-chat-ac203-review3-')))
  const closers = []
  t.after(() => { for (const close of closers.reverse()) try { close() } catch {} ; fs.rmSync(dir, { recursive: true, force: true }) })
  const stateRoot = path.join(dir, 'state'), root = path.join(dir, 'chats')
  fs.mkdirSync(stateRoot, { mode: 0o700 })
  const clock = { shift: 0 }
  const store = createStore({ root, projectRoot: dir, stateRoot, now: () => Date.now() + clock.shift })
  for (const room of ['r1', 'r2']) store.createRoom({ room, title: room })
  const own = service => (closers.push(() => service.close()), service)
  const profile = n => { const p = path.join(dir, 'profile' + n); fs.mkdirSync(p, { recursive: true, mode: 0o700 }); return p }
  const claude = (launch, home) => ({ runtime: 'claude', id: launch, profileHome: home, endpoint: claudeEndpoint('/private/agent-chat-ac203-review3.sock'),
    clientPid: self.pid, clientStart: self.start, serverPid: self.pid, serverStart: self.start })
  const native = (session, conversation) => own(createService({ store, env: {}, adapters: accepted, inferSession: () => session,
    resolveConversation: typeof conversation === 'function' ? conversation : () => conversation }))
  const peer = async (rooms = ['r1', 'r2']) => {
    const service = own(createService({ store, env: {}, adapters: accepted, inferSession: () => null }))
    for (const room of rooms) await service.call('join_room', { room, agent: 'Peer', session: { id: 'peer', runtime: 'manual' } })
    return service
  }
  return { store, clock, profile, claude, native, peer }
}
async function read(service, room, agent) {
  const got = await service.call('inbox', { room, agent })
  service.written('inbox', { room, agent }, got)
  return got.filter(item => item.message).map(item => [item.message, item.maybe_seen ?? null])
}

test('review3 1: renaming onto a closed name that has a row in another room keeps the mail waiting there for this tab', async t => {
  const f = fixture(t), peer = await f.peer()
  const old = f.native(f.claude(L1, f.profile(1)), CONV)
  await old.call('join_room', { room: 'r2', agent: 'Beta' })
  old.close()
  const tab = f.native(f.claude(L2, f.profile(2)), CONV2)
  await tab.call('join_room', { room: 'r1', agent: 'alpha' })
  const posted = await peer.call('post', { room: 'r2', from: 'Peer', to: 'alpha', message: 'to-alpha-in-r2' })
  assert.equal(posted.delivery[0].reason, 'not_in_room')
  await peer.call('post', { room: 'r2', from: 'Peer', message: 'unrelated broadcast' })
  const joined = await tab.call('join_room', { room: 'r2', agent: 'Beta' })
  assert.equal(joined.agent, 'Beta')
  assert.deepEqual(await read(tab, 'r2', 'Beta'), [['to-alpha-in-r2', null]])
})

test('review3 2: after /resume back, mail sent to the resumed conversation\'s earlier name reaches it', async t => {
  const f = fixture(t), peer = await f.peer(['r1'])
  let conversation = CONV
  const tab = f.native(f.claude(L1, f.profile(1)), () => conversation)
  await tab.call('join_room', { room: 'r1', agent: 'Gamma' })
  assert.match((await tab.call('join_room', { room: 'r1', agent: 'Beta' })).note, /renamed from Gamma/)
  conversation = CONV2; await tab.call('list_rooms', {})
  const posted = await peer.call('post', { room: 'r1', from: 'Peer', to: 'Gamma', message: 'to-earlier-name' })
  assert.match(posted.delivery[0].note, /sent to Beta \(renamed from Gamma\)/)
  assert.equal((await tab.call('join_room', { room: 'r1', agent: 'Beta' })).agent, 'Beta')
  conversation = CONV; await tab.call('list_rooms', {})
  assert.deepEqual(await read(tab, 'r1', 'Beta'), [['to-earlier-name', null]])
  const again = await peer.call('post', { room: 'r1', from: 'Peer', to: 'Gamma', message: 'to-earlier-name-2' })
  assert.equal(again.delivery[0].agent, 'Beta')
  assert.deepEqual(await read(tab, 'r1', 'Beta'), [['to-earlier-name-2', null]])
  assert.deepEqual(f.store.unreadReport().recipients.filter(row => row.unread), [])
})

test('review3 3: a tab renamed before its conversation resolved keeps the mail to its earlier name', async t => {
  for (const postBefore of [false, true]) {
    const f = fixture(t), peer = await f.peer(['r1'])
    let conversation = null
    const tab = f.native(f.claude(L1, f.profile(1)), () => conversation)
    await tab.call('join_room', { room: 'r1', agent: 'Beta' })
    assert.match((await tab.call('join_room', { room: 'r1', agent: 'Gamma' })).note, /renamed from Beta/)
    if (postBefore) await peer.call('post', { room: 'r1', from: 'Peer', to: 'Beta', message: 'before-resolve' })
    conversation = CONV
    if (!postBefore) await peer.call('post', { room: 'r1', from: 'Peer', to: 'Beta', message: 'before-resolve' })
    assert.deepEqual(await read(tab, 'r1', 'Gamma'), [['before-resolve', null]], `posted ${postBefore ? 'before' : 'after'} the conversation resolved`)
    const after = await peer.call('post', { room: 'r1', from: 'Peer', to: 'Beta', message: 'after-resolve' })
    assert.equal(after.delivery[0].agent, 'Gamma')
    assert.notEqual(after.delivery[0].reason, 'closed', 'a live tab is never reported closed')
    assert.deepEqual(await read(tab, 'r1', 'Gamma'), [['after-resolve', null]])
    assert.deepEqual(f.store.unreadReport().recipients.filter(row => row.unread), [])
  }
})

test('review3 4: a bound alias another tab owns now is refused with the name this tab posts as, by every room tool', async t => {
  const f = fixture(t), peer = await f.peer(['r1'])
  const S = f.native(f.claude(L1, f.profile(1)), CONV)
  await S.call('join_room', { room: 'r1', agent: 'Alpha' })
  await S.call('join_room', { room: 'r1', agent: 'Beta' })
  const T = f.native(f.claude(L2, f.profile(2)), CONV2)
  f.clock.shift = 8 * 86400000
  await T.call('join_room', { room: 'r1', agent: 'Alpha' })
  const posted = await peer.call('post', { room: 'r1', from: 'Peer', to: 'Alpha', message: 'for T' })
  for (const [tool, args] of [['inbox', { room: 'r1', agent: 'Alpha' }], ['ack', { room: 'r1', agent: 'Alpha', message_ids: [posted.message_id] }],
    ['delivery_status', { room: 'r1', agent: 'Alpha' }], ['retry_delivery', { room: 'r1', agent: 'Alpha', message_ids: [posted.message_id] }]])
    await assert.rejects(S.call(tool, args), { message: 'you post as Beta here; use from: Beta (or join_room with a new name to rename)' }, tool)
  assert.deepEqual(await read(T, 'r1', 'Alpha'), [['for T', null]])
})

// Found by the fuzzer: mail to a name nobody owned gets its recipient only once someone takes the
// name. A session coming back to its old row, whose watermark is past that mail, must still get it.
test('review3 5: mail to a name nobody owned reaches the session that takes it with an old row in the room', async t => {
  const f = fixture(t), peer = await f.peer(['r2'])
  const posted = await peer.call('post', { room: 'r2', from: 'Peer', to: 'Beta', message: 'to-unowned-Beta' })
  assert.equal(posted.delivery[0].reason, 'not_in_room')
  const first = f.native(f.claude(L1, f.profile(1)), CONV)
  await first.call('join_room', { room: 'r2', agent: 'Alpha' })
  await first.call('post', { room: 'r2', from: 'Alpha', message: 'hello' })
  first.close()
  const other = f.native(f.claude(L2, f.profile(1)), CONV2)
  assert.equal((await other.call('join_room', { room: 'r2', agent: 'Alpha' })).agent, 'Alpha')
  other.close()
  const back = f.native(f.claude(L1, f.profile(1)), CONV)
  assert.equal((await back.call('join_room', { room: 'r2', agent: 'Beta' })).agent, 'Beta')
  assert.deepEqual(await read(back, 'r2', 'Beta'), [['to-unowned-Beta', null]])
})

// The reviewer's "by design" case: mail to a closed session's earlier name, after another tab took
// its current name, waits on that closed session. It must read as unread in /unread, under a name.
test('review3 6: mail waiting on a closed session\'s reserved earlier name shows as unread in /unread', async t => {
  const f = fixture(t), peer = await f.peer(['r1'])
  const first = f.native(f.claude(L1, f.profile(1)), CONV)
  await first.call('join_room', { room: 'r1', agent: 'Alpha' })
  await first.call('join_room', { room: 'r1', agent: 'Beta' })
  first.close()
  const other = f.native(f.claude(L2, f.profile(2)), CONV2)
  assert.equal((await other.call('join_room', { room: 'r1', agent: 'Beta' })).agent, 'Beta')
  await peer.call('post', { room: 'r1', from: 'Peer', to: 'Alpha', message: 'to-earlier-name' })
  const report = f.store.unreadReport()
  assert.deepEqual(report.unknown_legacy, [])
  assert.deepEqual(report.recipients.filter(row => row.unread).map(row => [row.name, row.rooms.map(room => [room.room, room.unread])]), [['Beta', [['r1', 1]]]])
})
