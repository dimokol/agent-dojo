import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createStore } from './store.mjs'
import { createService } from './server.mjs'
import { processIdentity } from './native-session.mjs'

// ac203 second review round: bugs a second reviewer found by running the code.
// 1. a tab that joined before its conversation registered, 2. /resume back to a conversation whose
// name the cleared one took, 3. 2.0.0/2.0.1 receipts, 4. mail parked in a room unreadable during a
// takeover, 5. mail to a closed session's old name, 6. a binding under an old name.
const CONV = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', CONV2 = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const L1 = '11111111-1111-4111-8111-111111111111', L2 = '22222222-2222-4222-8222-222222222222'
const accepted = { async deliver() { return { status: 'accepted' } } }
const self = processIdentity(process.pid)

function fixture(t, { now } = {}) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agent-chat-ac203-review2-')))
  const closers = []
  t.after(() => { for (const close of closers.reverse()) try { close() } catch {} ; fs.rmSync(dir, { recursive: true, force: true }) })
  const stateRoot = path.join(dir, 'state'), root = path.join(dir, 'chats')
  fs.mkdirSync(stateRoot, { mode: 0o700 })
  const store = createStore({ root, projectRoot: dir, stateRoot, ...(now ? { now } : {}) })
  store.createRoom({ room: 'r', title: 'r' })
  const own = service => (closers.push(() => service.close()), service)
  const profile = n => { const p = path.join(dir, 'profile' + n); fs.mkdirSync(p, { recursive: true, mode: 0o700 }); return p }
  const claude = (launch, home) => ({ runtime: 'claude', id: launch, profileHome: home, endpoint: '/private/agent-chat-ac203-review2.sock',
    clientPid: self.pid, clientStart: self.start, serverPid: self.pid, serverStart: self.start })
  const native = (session, conversation) => own(createService({ store, env: {}, adapters: accepted, inferSession: () => session,
    resolveConversation: typeof conversation === 'function' ? conversation : () => conversation }))
  const manual = () => own(createService({ store, env: {}, adapters: accepted, inferSession: () => null }))
  const peer = async (room = 'r') => {
    const service = manual()
    await service.call('join_room', { room, agent: 'Peer', session: { id: 'peer', runtime: 'manual' } })
    return service
  }
  return { dir, store, own, profile, claude, native, manual, peer }
}
async function read(service, room, agent) {
  const got = await service.call('inbox', { room, agent })
  service.written('inbox', { room, agent }, got)
  return got.filter(item => item.message).map(item => [item.message, item.maybe_seen ?? null])
}
const rowsOf = (f, room = 'r') => f.store.memberships().filter(m => m.room === room).map(m => ({ agent: m.agent, joined: m.joined, left: m.left_reason ?? null, conversation: m.session.conversationId ?? null }))
const unread = f => f.store.unreadReport().recipients.map(r => [r.name, r.unread, r.delivered, r.status])
// Claude keeps <profile>/projects/<launch folder, every other character a dash>/<conversation>.jsonl.
function transcriptWithInbox(f, home, conversation, ids) {
  const dir = path.join(home, 'projects', f.dir.replace(/[^A-Za-z0-9]/g, '-'))
  fs.mkdirSync(dir, { recursive: true })
  const lines = [
    { type: 'assistant', sessionId: conversation, message: { role: 'assistant', content: [{ type: 'tool_use', id: 'tu1', name: 'mcp__plugin_agent-chat_agent-chat__inbox', input: { room: 'r', agent: 'Reader' } }] } },
    { type: 'user', sessionId: conversation, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu1', content: [{ type: 'text', text: JSON.stringify(ids.map(id => ({ message_id: id }))) }] }] } },
  ]
  fs.writeFileSync(path.join(dir, `${conversation}.jsonl`), lines.map(line => JSON.stringify(line)).join('\n') + '\n')
}

// 1. The join came before Claude registered the conversation: the row has no conversation id yet.
test('review2 1: a tab that joined before its conversation registered keeps its rooms once it resolves', async t => {
  const f = fixture(t), peer = await f.peer()
  let conversation = null
  const tab = f.native(f.claude(L1, f.profile(1)), () => conversation)
  assert.equal((await tab.call('join_room', { room: 'r', agent: 'Reader' })).agent, 'Reader')
  await peer.call('post', { room: 'r', from: 'Peer', to: 'Reader', message: 'm1' })
  assert.deepEqual(await read(tab, 'r', 'Reader'), [['m1', null]])
  conversation = CONV
  assert.deepEqual(await read(tab, 'r', 'Reader'), [], 'the same conversation read m1; it is not lost and not shown again')
  assert.deepEqual(rowsOf(f).find(row => row.agent === 'Reader'), { agent: 'Reader', joined: true, left: null, conversation: CONV })
  const m2 = await peer.call('post', { room: 'r', from: 'Peer', to: 'Reader', message: 'm2' })
  assert.deepEqual(m2.delivery, [{ agent: 'Reader', state: 'queued' }])
  assert.deepEqual(await read(tab, 'r', 'Reader'), [['m2', null]])
})

// Reversed 2026-11-15 (user's call): a /clear used to leave these rows closed; it now keeps the
// tab in them on its new conversation (ac203-clear.test.mjs).
test('review2 1: a late registration through the lifecycle restore (resume or /clear) keeps the rows joined before it', async t => {
  for (const source of ['resume', 'clear']) {
    const f = fixture(t), home = f.profile(1)
    f.store.join({ room: 'r', agent: 'Reader', session: f.claude(L1, home) })
    const result = f.store.restoreClaude({ session: { ...f.claude(L1, home), conversationId: CONV }, source, ...(source === 'clear' ? { previousConversationId: L1 } : {}) }, () => true)
    assert.deepEqual(result.restored, [{ room: 'r', agent: 'Reader' }])
    assert.deepEqual(rowsOf(f), [{ agent: 'Reader', joined: true, left: null, conversation: CONV }])
  }
})

// 2. Switching conversations is symmetric: the conversation switched to takes back what it held.
test('review2 2: /resume back after the cleared conversation took the name: rooms and name come back without a join', async t => {
  const f = fixture(t), peer = await f.peer()
  let conversation = CONV
  const tab = f.native(f.claude(L1, f.profile(1)), () => conversation)
  await tab.call('join_room', { room: 'r', agent: 'Reader' })
  await peer.call('post', { room: 'r', from: 'Peer', to: 'Reader', message: 'read-before' })
  await read(tab, 'r', 'Reader')
  await peer.call('post', { room: 'r', from: 'Peer', to: 'Reader', message: 'unread-before' })
  conversation = CONV2
  await tab.call('post', { room: 'r', from: 'Reader', message: 'hi after clear' })
  conversation = CONV
  await tab.call('list_rooms', {})
  assert.deepEqual(rowsOf(f).filter(row => row.agent === 'Reader'), [{ agent: 'Reader', joined: true, left: null, conversation: CONV }])
  assert.deepEqual(await read(tab, 'r', 'Reader'), [['read-before', true], ['unread-before', null]])
  const after = await peer.call('post', { room: 'r', from: 'Peer', to: 'Reader', message: 'after-resume' })
  assert.deepEqual(after.delivery, [{ agent: 'Reader', state: 'queued' }])
  assert.deepEqual(await read(tab, 'r', 'Reader'), [['after-resume', null]])
  assert.deepEqual(unread(f).filter(row => row[0] === 'Reader'), [['Reader', 0, 1, 'joined']], 'the first two are confirmed by the later read')
})

test('review2 2: the lifecycle restore of a /resume back takes the name back from the conversation it left', async t => {
  const f = fixture(t); await f.peer()
  const home = f.profile(1)
  let conversation = CONV
  const tab = f.native(f.claude(L1, home), () => conversation)
  await tab.call('join_room', { room: 'r', agent: 'Reader' })
  conversation = CONV2
  await tab.call('join_room', { room: 'r', agent: 'Reader' })
  const result = f.store.restoreClaude({ session: { ...f.claude(L1, home), conversationId: CONV }, source: 'resume', previousConversationId: CONV2 }, () => true)
  assert.deepEqual(result, { restored: [{ room: 'r', agent: 'Reader' }], conflicts: [] })
  assert.deepEqual(rowsOf(f).filter(row => row.agent === 'Reader'), [{ agent: 'Reader', joined: true, left: null, conversation: CONV }])
})

for (const shown of [true, false]) test(`review2 2: mail moved back on a switch follows the transcript rule (${shown ? 'shown' : 'not shown'})`, async t => {
  const f = fixture(t), peer = await f.peer()
  const home = f.profile(1)
  let conversation = CONV
  const tab = f.native(f.claude(L1, home), () => conversation)
  await tab.call('join_room', { room: 'r', agent: 'Reader' })
  const sent = await peer.call('post', { room: 'r', from: 'Peer', to: 'Reader', message: 'pre-clear' })
  await read(tab, 'r', 'Reader')
  if (shown) transcriptWithInbox(f, home, CONV, [sent.message_id])
  conversation = CONV2
  await tab.call('join_room', { room: 'r', agent: 'Reader' })
  conversation = CONV
  const again = await read(tab, 'r', 'Reader')
  assert.deepEqual(again, shown ? [] : [['pre-clear', true]])
})

test('review2 2: repeated switches hand the rooms back and forth, one row per name', async t => {
  const f = fixture(t), peer = await f.peer()
  let conversation = CONV
  const tab = f.native(f.claude(L1, f.profile(1)), () => conversation)
  await tab.call('join_room', { room: 'r', agent: 'Reader' })
  conversation = CONV2
  await tab.call('join_room', { room: 'r', agent: 'Reader' })
  for (const [i, next] of [CONV, CONV2, CONV, CONV2].entries()) {
    conversation = next
    await tab.call('list_rooms', {})
    assert.deepEqual(rowsOf(f).filter(row => row.agent === 'Reader'), [{ agent: 'Reader', joined: true, left: null, conversation: next }], `switch ${i}`)
    const posted = await peer.call('post', { room: 'r', from: 'Peer', to: 'Reader', message: 'm' + i })
    assert.deepEqual(posted.delivery, [{ agent: 'Reader', state: 'queued' }], `switch ${i}`)
    assert.ok((await read(tab, 'r', 'Reader')).some(([message, marked]) => message === 'm' + i && marked === null), `switch ${i}`)
  }
  assert.deepEqual(f.store.members({ room: 'r' }).map(m => m.agent).sort(), ['Peer', 'Reader'])
  assert.deepEqual(unread(f).filter(row => row[0] === 'Reader').length, 1)
})

// 3. 2.0.0 and 2.0.1 stored a successful ring as notified with this text.
test('review2 3: a 2.0.0/2.0.1 successful ring receipt reads as rung', async t => {
  const f = fixture(t)
  const a = f.manual(); await a.call('join_room', { room: 'r', agent: 'A', session: { id: 'a', runtime: 'manual' } })
  const b = f.manual(); await b.call('join_room', { room: 'r', agent: 'B', session: { id: 'b', runtime: 'manual' } })
  const sent = await a.call('post', { room: 'r', from: 'A', to: 'B', message: 'x' })
  const disk = JSON.parse(fs.readFileSync(f.store.statePath, 'utf8'))
  const rec = disk.rooms.r.members.B.deliveries[sent.message_id]
  Object.assign(rec, { status: 'notified', error: 'Peer frame written; receiver policy and receipt unconfirmed. Await agent_chat acknowledgement.' })
  delete rec.state; delete rec.reason; delete rec.detail
  fs.writeFileSync(f.store.statePath, JSON.stringify(disk))
  const rows = await a.call('delivery_status', { room: 'r', agent: 'A' })
  assert.deepEqual(rows.find(entry => entry.sent).recipients, [{ agent: 'B', state: 'rung', read_state: 'unread' }])
})

// 4. Mail in a room whose log could not be read during a takeover follows the name's owner at
// takeover time, whatever either side is called later.
for (const variant of ['plain', 'old owner returns renamed', 'new owner renames']) test(`review2 4: mail parked in an unreadable room during a takeover reaches the name's new owner (${variant})`, async t => {
  const f = fixture(t)
  f.store.createRoom({ room: 'bad', title: 'bad' })
  const peer = f.manual(), homeA = f.profile(1)
  let a = f.native(f.claude(L1, homeA), CONV)
  for (const room of ['r', 'bad']) {
    await peer.call('join_room', { room, agent: 'Peer', session: { id: 'peer', runtime: 'manual' } })
    await a.call('join_room', { room, agent: 'Alpha' })
  }
  await peer.call('post', { room: 'bad', from: 'Peer', to: 'Alpha', message: 'bad-read' })
  await read(a, 'bad', 'Alpha')
  await peer.call('post', { room: 'bad', from: 'Peer', to: 'Alpha', message: 'bad-unread' })
  a.close()
  const badDir = path.join(f.store.dir, 'rooms', 'bad')
  fs.chmodSync(badDir, 0o755)
  const b = f.native(f.claude(L2, f.profile(2)), CONV2)
  assert.equal((await b.call('join_room', { room: 'r', agent: 'Alpha' })).agent, 'Alpha')
  if (variant === 'old owner returns renamed') {
    a = f.native(f.claude(L1, homeA), CONV)
    assert.equal((await a.call('join_room', { room: 'r', agent: 'Alpha2' })).agent, 'Alpha2')
  }
  const name = variant === 'new owner renames' ? 'Bravo' : 'Alpha'
  if (name === 'Bravo') assert.equal((await b.call('join_room', { room: 'r', agent: 'Bravo' })).agent, 'Bravo')
  fs.chmodSync(badDir, 0o700)
  await read(b, 'r', name)
  if (variant === 'old owner returns renamed') {
    await a.call('join_room', { room: 'bad', agent: 'Alpha2' })
    assert.deepEqual(await read(a, 'bad', 'Alpha2'), [], 'mail to Alpha stays with the name')
  }
  await b.call('join_room', { room: 'bad', agent: name })
  assert.deepEqual(await read(b, 'bad', name), [['bad-read', true], ['bad-unread', null]])
  const rows = unread(f).filter(row => row[0] !== 'Peer')
  assert.deepEqual(rows.filter(row => row[1] > 0), [], JSON.stringify(rows))
  assert.equal(new Set(rows.map(row => row[0])).size, rows.length, JSON.stringify(rows))
})

// 5. Mail to a renamed session's old name while that session is closed.
test('review2 5: mail to a closed session\'s old name is shown under its current name with the renamed note', async t => {
  const f = fixture(t), peer = await f.peer()
  const tab = f.native(f.claude(L1, f.profile(1)), CONV)
  await tab.call('join_room', { room: 'r', agent: 'Alpha' })
  await tab.call('join_room', { room: 'r', agent: 'Beta' })
  tab.close()
  const posted = await peer.call('post', { room: 'r', from: 'Peer', to: 'Alpha', message: 'to the old name' })
  assert.deepEqual(posted.delivery, [{ agent: 'Beta', state: 'held', reason: 'closed', detail: 'Its tab closed; the mail waits until that name is back in this room.', note: 'sent to Beta (renamed from Alpha)' }])
})

// 6. The binding a tab kept under its old name.
test('review2 6: a bound old name another session took no longer posts as this tab; one nobody took posts with a note', async t => {
  let shift = 0
  const f = fixture(t, { now: () => Date.now() + shift }), peer = await f.peer()
  const s = f.native(f.claude(L1, f.profile(1)), CONV)
  await s.call('join_room', { room: 'r', agent: 'Alpha' })
  await s.call('join_room', { room: 'r', agent: 'Beta' })
  const own = await s.call('post', { room: 'r', from: 'Alpha', message: 'own earlier name' })
  assert.equal(f.store.history({ room: 'r' }).find(m => m.id === own.message_id).from, 'Beta')
  assert.match(own.name_note ?? '', /Beta/)
  const other = f.native(f.claude(L2, f.profile(2)), CONV2)
  shift = 8 * 86400000
  assert.equal((await other.call('join_room', { room: 'r', agent: 'Alpha' })).agent, 'Alpha')
  await assert.rejects(s.call('post', { room: 'r', from: 'Alpha', message: 'x' }), { message: 'you post as Beta here; use from: Beta (or join_room with a new name to rename)' })
  assert.ok(!f.store.history({ room: 'r' }).some(m => m.message === 'x'))
  const ok = await s.call('post', { room: 'r', from: 'Beta', message: 'y' })
  assert.equal(f.store.history({ room: 'r' }).find(m => m.id === ok.message_id).from, 'Beta')
  const toAlpha = await peer.call('post', { room: 'r', from: 'Peer', to: 'Alpha', message: 'for new alpha' })
  assert.deepEqual(toAlpha.delivery, [{ agent: 'Alpha', state: 'queued' }])
})
