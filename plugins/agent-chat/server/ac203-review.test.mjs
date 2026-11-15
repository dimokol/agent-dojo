import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createStore } from './store.mjs'
import { createService, ALLOWED_ERROR } from './server.mjs'
import { processIdentity } from './native-session.mjs'

// ac203 review round: bugs an independent reviewer found by running the code.
// 1. /clear (and /resume) inside one MCP process, 2. one loose room blocking a takeover,
// 3. mail to a renamed session's old name, 4. receipts written by 2.0.2, 5. a guessed post `from`.
const CONV = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', CONV2 = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const L1 = '11111111-1111-4111-8111-111111111111', L2 = '22222222-2222-4222-8222-222222222222'
const accepted = { async deliver() { return { status: 'accepted' } } }
const self = processIdentity(process.pid)

function fixture(t) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agent-chat-ac203-review-')))
  const closers = []
  t.after(() => { for (const close of closers.reverse()) try { close() } catch {} ; fs.rmSync(dir, { recursive: true, force: true }) })
  const stateRoot = path.join(dir, 'state'), root = path.join(dir, 'chats'), profile = path.join(dir, 'profile')
  fs.mkdirSync(stateRoot, { mode: 0o700 }); fs.mkdirSync(profile, { mode: 0o700 })
  const store = createStore({ root, projectRoot: dir, stateRoot })
  store.createRoom({ room: 'r', title: 'r' })
  const own = service => (closers.push(() => service.close()), service)
  const claude = (extra = {}) => ({ runtime: 'claude', id: L1, profileHome: profile, endpoint: '/private/agent-chat-ac203-review.sock',
    clientPid: self.pid, clientStart: self.start, serverPid: self.pid, serverStart: self.start, ...extra })
  const native = (session, conversation, extra = {}) => own(createService({ store, env: {}, adapters: accepted, inferSession: () => session,
    resolveConversation: typeof conversation === 'function' ? conversation : () => conversation, ...extra }))
  const manual = () => own(createService({ store, env: {}, adapters: accepted, inferSession: () => null }))
  const peer = async (room = 'r') => {
    const service = manual()
    await service.call('join_room', { room, agent: 'Peer', session: { id: 'peer', runtime: 'manual' } })
    return service
  }
  return { dir, stateRoot, profile, store, own, claude, native, manual, peer }
}
const receipt = (f, id) => f.store.memberships().filter(m => m.deliveries[id]).map(m => ({ agent: m.agent, joined: m.joined, status: m.deliveries[id].status, maybe_seen: m.deliveries[id].maybe_seen }))
async function readOnce(service, args) {
  const got = await service.call('inbox', args)
  service.written('inbox', args, got)
  return got
}
// Claude keeps <profile>/projects/<launch folder, every other character a dash>/<conversation>.jsonl.
function transcriptWithInbox(f, conversation, messageId) {
  const dir = path.join(f.profile, 'projects', f.dir.replace(/[^A-Za-z0-9]/g, '-'))
  fs.mkdirSync(dir, { recursive: true })
  const lines = [
    { type: 'assistant', sessionId: conversation, message: { role: 'assistant', content: [{ type: 'tool_use', id: 'tu1', name: 'mcp__plugin_agent-chat_agent-chat__inbox', input: { room: 'r', agent: 'Reader' } }] } },
    { type: 'user', sessionId: conversation, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu1', content: [{ type: 'text', text: JSON.stringify([{ message_id: messageId, from: 'Peer', to: 'Reader', message: 'pre-clear' }]) }] }] } },
  ]
  fs.writeFileSync(path.join(dir, `${conversation}.jsonl`), lines.map(line => JSON.stringify(line)).join('\n') + '\n')
}

// 1. Claude Code keeps the MCP server across /clear: only the conversation changes.
test('review 1: after /clear in the same MCP process, mail the old conversation read is not confirmed; the tab keeps its name and gets it marked', async t => {
  const f = fixture(t), peer = await f.peer()
  let conversation = CONV
  const tab = f.native(f.claude(), () => conversation)
  await tab.call('join_room', { room: 'r', agent: 'Reader' })
  const sent = await peer.call('post', { room: 'r', from: 'Peer', to: 'Reader', message: 'pre-clear' })
  await readOnce(tab, { room: 'r', agent: 'Reader' })
  conversation = CONV2
  // Any call after /clear: it must not confirm what the earlier conversation read.
  await tab.call('list_rooms', {})
  assert.deepEqual(receipt(f, sent.message_id).map(row => row.status), ['delivered'], 'the old conversation\'s read stays unconfirmed')
  const joined = await tab.call('join_room', { room: 'r', agent: 'Reader' })
  assert.equal(joined.agent, 'Reader')
  const again = await tab.call('inbox', { room: 'r', agent: 'Reader' })
  const same = again.filter(m => m.message_id === sent.message_id)
  assert.equal(same.length, 1, 'mail is never lost')
  assert.equal(same[0].maybe_seen, true)
})

test('review 1: after /clear an auto-joining post under the tab\'s name takes the name over', async t => {
  const f = fixture(t), peer = await f.peer()
  let conversation = CONV
  const tab = f.native(f.claude(), () => conversation)
  await tab.call('join_room', { room: 'r', agent: 'Reader' })
  const sent = await peer.call('post', { room: 'r', from: 'Peer', to: 'Reader', message: 'pre-clear' })
  await readOnce(tab, { room: 'r', agent: 'Reader' })
  conversation = CONV2
  const posted = await tab.call('post', { room: 'r', from: 'Reader', to: 'Peer', message: 'back' })
  assert.equal(f.store.history({ room: 'r' }).find(m => m.id === posted.message_id).from, 'Reader')
  const again = await tab.call('inbox', { room: 'r', agent: 'Reader' })
  assert.equal(again.find(m => m.message_id === sent.message_id)?.maybe_seen, true)
})

for (const shown of [true, false]) test(`review 1: /clear then /resume back in the same process: the resumed conversation's transcript decides (${shown ? 'shown' : 'not shown'})`, async t => {
  const f = fixture(t), peer = await f.peer()
  let conversation = CONV
  const tab = f.native(f.claude(), () => conversation)
  await tab.call('join_room', { room: 'r', agent: 'Reader' })
  const sent = await peer.call('post', { room: 'r', from: 'Peer', to: 'Reader', message: 'pre-clear' })
  await readOnce(tab, { room: 'r', agent: 'Reader' })
  conversation = CONV2
  await tab.call('list_rooms', {})
  if (shown) transcriptWithInbox(f, CONV, sent.message_id)
  conversation = CONV
  const again = await tab.call('inbox', { room: 'r', agent: 'Reader' })
  if (shown) {
    assert.ok(!again.some(m => m.message_id === sent.message_id))
    assert.equal(receipt(f, sent.message_id)[0].status, 'received')
  } else assert.equal(again.find(m => m.message_id === sent.message_id)?.maybe_seen, true)
})

test('review 1: a conversation open in two tabs: one tab\'s /clear hands the rooms to the other, and never closes rows the other holds', async t => {
  const f = fixture(t), peer = await f.peer()
  const other = processIdentity(process.ppid)
  let conversationA = CONV
  const a = f.native(f.claude(), () => conversationA)
  await a.call('join_room', { room: 'r', agent: 'Reader' })
  // Tab B (another live client) opened the same conversation; A still holds its rooms.
  const b = f.native(f.claude({ id: L2, clientPid: other.pid, clientStart: other.start }), CONV)
  await b.call('list_rooms', {})
  assert.equal(f.store.members({ room: 'r' }).find(m => m.agent === 'Reader').session.clientPid, self.pid)
  conversationA = CONV2
  await a.call('list_rooms', {})
  await b.call('list_rooms', {})
  const held = f.store.members({ room: 'r' }).find(m => m.agent === 'Reader')
  assert.equal(held?.session.clientPid, other.pid, 'B takes the rooms once A moved to another conversation')
  await peer.call('post', { room: 'r', from: 'Peer', to: 'Reader', message: 'to b' })
  assert.deepEqual((await b.call('inbox', { room: 'r', agent: 'Reader' })).map(m => m.message), ['to b'])
  // A switching again leaves B's rows alone.
  conversationA = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
  await a.call('list_rooms', {})
  assert.equal(f.store.members({ room: 'r' }).find(m => m.agent === 'Reader')?.session.clientPid, other.pid)
})

// 2. A loose room's log can't be read; that must not block taking over a closed name elsewhere.
test('review 2: one loose room does not block taking over a closed name; its mail follows when the room is readable', async t => {
  const f = fixture(t)
  f.store.createRoom({ room: 'bad', title: 'bad' })
  const a = f.manual(), b = f.manual(), c = f.manual()
  for (const room of ['r', 'bad']) {
    await a.call('join_room', { room, agent: 'A', session: { id: 'a', runtime: 'manual' } })
    await b.call('join_room', { room, agent: 'B', session: { id: 'b', runtime: 'manual' } })
  }
  const sent = await a.call('post', { room: 'bad', from: 'A', to: 'B', message: 'in bad' })
  b.close()
  const badDir = path.join(f.store.dir, 'rooms', 'bad')
  fs.chmodSync(badDir, 0o755)
  const joined = await c.call('join_room', { room: 'r', agent: 'B', session: { id: 'c', runtime: 'manual' } })
  assert.equal(joined.agent, 'B')
  fs.chmodSync(badDir, 0o700)
  await c.call('join_room', { room: 'bad', agent: 'B', session: { id: 'c', runtime: 'manual' } })
  assert.deepEqual((await c.call('inbox', { room: 'bad', agent: 'B' })).map(m => m.message_id), [sent.message_id])
})

// 3. Mail to a renamed session's old name reaches it under its new name.
test('review 3: mail to a renamed session\'s old name is not reported as not_in_room', async t => {
  const f = fixture(t), peer = await f.peer()
  const tab = f.native(f.claude(), CONV)
  await tab.call('join_room', { room: 'r', agent: 'Alpha' })
  const renamed = await tab.call('join_room', { room: 'r', agent: 'Beta' })
  assert.match(renamed.note, /renamed from Alpha/)
  const posted = await peer.call('post', { room: 'r', from: 'Peer', to: 'Alpha', message: 'to the old name' })
  assert.ok(!posted.delivery.some(row => row.agent === 'Alpha' && row.state === 'held'), JSON.stringify(posted.delivery))
  const row = posted.delivery.find(entry => entry.agent === 'Beta')
  assert.ok(row, JSON.stringify(posted.delivery))
  assert.match(row.note, /renamed from Alpha/)
})

// 4. 2.0.2 kept every transport outcome as status notified plus an error text.
for (const [label, error, sender, receiver] of [
  ['uncertain write', 'Socket write uncertain; retain messages.', { state: 'held', reason: 'write_uncertain' }, { state: 'held', reason: 'write_uncertain' }],
  ['successful ring', 'The tab was rung and reads its inbox on its next turn. Nothing else to do; a reply wakes you.', { state: 'rung' }, {}],
]) test(`review 4: a 2.0.2 receipt (${label}) reads the 2.0.3 way, with no legacy error field`, async t => {
  const f = fixture(t)
  const a = f.manual(); await a.call('join_room', { room: 'r', agent: 'A', session: { id: 'a', runtime: 'manual' } })
  const b = f.manual(); await b.call('join_room', { room: 'r', agent: 'B', session: { id: 'b', runtime: 'manual' } })
  const sent = await a.call('post', { room: 'r', from: 'A', to: 'B', message: 'x' })
  const disk = JSON.parse(fs.readFileSync(f.store.statePath, 'utf8'))
  const rec = disk.rooms.r.members.B.deliveries[sent.message_id]
  Object.assign(rec, { status: 'notified', error }); delete rec.state; delete rec.reason; delete rec.detail
  fs.writeFileSync(f.store.statePath, JSON.stringify(disk))
  const rows = await a.call('delivery_status', { room: 'r', agent: 'A' })
  assert.deepEqual(rows.find(entry => entry.sent).recipients, [{ agent: 'B', ...sender, read_state: 'unread' }])
  const own = (await b.call('delivery_status', { room: 'r', agent: 'B' })).find(entry => entry.message_id === sent.message_id)
  assert.equal(own.error, undefined, JSON.stringify(own))
  assert.equal(own.state, receiver.state); assert.equal(own.reason, receiver.reason)
  assert.equal(JSON.parse(fs.readFileSync(f.store.statePath, 'utf8')).rooms.r.members.B.deliveries[sent.message_id].error, error, 'disk is not rewritten')
})

// 5. A post's from names a session only on first contact.
test('review 5: an auto-joining post with a different from does not rename a named session; it says which name to use', async t => {
  const f = fixture(t)
  const tab = f.native(f.claude(), CONV)
  await tab.call('join_room', { room: 'r', agent: 'Helper' })
  const refused = 'you post as Helper here; use from: Helper (or join_room with a new name to rename)'
  await assert.rejects(tab.call('post', { room: 'fresh', from: 'claude', message: 'hi' }), { message: refused })
  assert.match(refused, ALLOWED_ERROR, 'the refusal reaches the client word for word')
  assert.deepEqual(f.store.memberships().map(m => [m.room, m.agent]), [['r', 'Helper']])
  const posted = await tab.call('post', { room: 'fresh', from: 'Helper', message: 'hi' })
  assert.equal(f.store.history({ room: 'fresh' }).find(m => m.id === posted.message_id).from, 'Helper')
})
