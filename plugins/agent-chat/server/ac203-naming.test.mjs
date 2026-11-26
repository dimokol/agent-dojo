import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createStore } from './store.mjs'
import { createService } from './server.mjs'
import { processIdentity } from './native-session.mjs'
import { participantId } from './participant-identity.mjs'
import { nameFiles, readNameRecord, privateDirectory, writeIfChanged } from './notice-files.mjs'
import { statuslineName } from './statusline-name.mjs'

// ac203 naming + dismiss: the join name beats the native title, an explicit /name beats both,
// a different later join renames the session, and dismiss never needs or makes a membership.
const LAUNCH = '11111111-1111-4111-8111-111111111111', CONV = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const accepted = { deliver: async () => ({ status: 'accepted' }) }
function fixture(t, { label = 'review-ui' } = {}) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agent-chat-ac203-naming-')))
  const closers = []
  t.after(() => { for (const close of closers.reverse()) try { close() } catch {} ; fs.rmSync(dir, { recursive: true, force: true }) })
  const stateRoot = path.join(dir, 'state'), root = path.join(dir, 'chats'), profile = path.join(dir, 'profile')
  fs.mkdirSync(stateRoot, { mode: 0o700 }); fs.mkdirSync(profile, { mode: 0o700 })
  const store = createStore({ root, projectRoot: dir, stateRoot })
  store.createRoom({ room: 'setup', title: 'Setup' }); store.createRoom({ room: 'other', title: 'Other' })
  const claude = { id: LAUNCH, conversationId: CONV, runtime: 'claude', profileHome: profile }
  // The ccstatusline widget's cache of Claude's own session title.
  if (label) {
    privateDirectory(path.join(stateRoot, 'names'), true)
    writeIfChanged(nameFiles(stateRoot, participantId(claude)).native, JSON.stringify({ schema: 1, label }) + '\n')
  }
  const own = service => (closers.push(() => service.close()), service)
  const native = () => {
    const self = processIdentity(process.pid)
    const session = { runtime: 'claude', id: LAUNCH, profileHome: profile, clientPid: self.pid, clientStart: self.start, serverPid: self.pid, serverStart: self.start }
    return own(createService({ store, env: {}, adapters: accepted, inferSession: () => session, resolveConversation: () => CONV }))
  }
  const manual = () => own(createService({ store, env: {}, adapters: accepted, inferSession: () => null }))
  return { dir, stateRoot, profile, store, claude, native, manual }
}
const roomsOf = (f, name) => f.store.memberships().filter(member => member.agent === name).map(member => member.room).sort()

test('join_room: the requested name wins over the native title, with no note when it is honoured', async t => {
  const f = fixture(t), service = f.native()
  const joined = await service.call('join_room', { room: 'setup', agent: 'Helper' })
  assert.equal(joined.agent, 'Helper')
  assert.equal(joined.requested, undefined)
  assert.equal(joined.note, undefined)
})

test('join_room: a later join under a different name renames the session in every room and reserves the old name', async t => {
  const f = fixture(t, { label: null }), service = f.native()
  await service.call('join_room', { room: 'setup', agent: 'Helper' })
  const joined = await service.call('join_room', { room: 'other', agent: 'Rd' })
  assert.equal(joined.agent, 'Rd')
  assert.equal(joined.requested, undefined, 'the requested name was honoured')
  assert.match(joined.note, /renamed from Helper/)
  assert.deepEqual(roomsOf(f, 'Rd'), ['other', 'setup'])
  assert.deepEqual(roomsOf(f, 'Helper'), [])
  const stranger = f.manual()
  await assert.rejects(stranger.call('join_room', { room: 'setup', agent: 'Helper', session: { runtime: 'manual', id: 'stranger' } }), /reserved for its previous owner/)
  // The statusline widget shows the current name.
  assert.equal(readNameRecord(f.stateRoot, participantId(f.claude)).name, 'Rd')
  assert.equal(statuslineName({ session_id: CONV, session_name: 'some title' }, { stateRoot: f.stateRoot, env: { CLAUDE_CONFIG_DIR: f.profile } }), 'Rd')
})

test('join_room: re-joining under the current name or an earlier own name causes no churn', async t => {
  const f = fixture(t, { label: null }), service = f.native()
  await service.call('join_room', { room: 'setup', agent: 'Helper' })
  await service.call('join_room', { room: 'other', agent: 'Rd' })
  const same = await service.call('join_room', { room: 'setup', agent: 'Rd' })
  assert.deepEqual([same.agent, same.requested, same.note], ['Rd', undefined, undefined])
  f.store.createRoom({ room: 'third', title: 'Third' })
  const earlier = await service.call('join_room', { room: 'third', agent: 'Helper' })
  assert.equal(earlier.agent, 'Rd')
  assert.equal(earlier.requested, 'Helper')
  assert.match(earlier.note, /Helper is an earlier name of this session/)
  assert.deepEqual(roomsOf(f, 'Rd'), ['other', 'setup', 'third'])
})

test('join_room: a /name name is kept over a different join name, and the result says so', async t => {
  const f = fixture(t, { label: null }), service = f.native()
  await service.call('join_room', { room: 'setup', agent: 'Helper' })
  await service.call('rename_session', { name: 'Chosen' })
  const joined = await service.call('join_room', { room: 'other', agent: 'Helper' })
  assert.equal(joined.agent, 'Chosen')
  assert.equal(joined.requested, 'Helper')
  assert.match(joined.note, /kept your \/name name Chosen; you asked for Helper/)
  assert.equal(f.store.canonicalSessionName(f.claude).source, 'explicit')
})

test('a post that auto-joins uses its from name over the title, and never renames a named session', async t => {
  const f = fixture(t), service = f.native()
  const posted = await service.call('post', { room: 'fresh', from: 'Poster', fyi: true, message: 'auto join' })
  assert.equal(f.store.history({ room: 'fresh' })[0].from, 'Poster')
  assert.equal(posted.requested, undefined)
  // Lead's decision (2.0.3 review): a later post's from no longer renames; join_room does.
  await assert.rejects(service.call('post', { room: 'newer', from: 'Writer', fyi: true, message: 'auto join two' }),
    { message: 'you post as Poster here; use from: Poster (or join_room with a new name to rename)' })
  assert.deepEqual(roomsOf(f, 'Poster'), ['fresh'])
  await service.call('post', { room: 'newer', from: 'Poster', fyi: true, message: 'auto join two' })
  assert.equal(f.store.history({ room: 'newer' })[0].from, 'Poster')
  assert.deepEqual(roomsOf(f, 'Poster'), ['fresh', 'newer'])
})

test('a first-use room tool that joins implicitly still takes the native title', async t => {
  const f = fixture(t), service = f.native()
  assert.deepEqual(await service.call('inbox', { room: 'setup', agent: 'Helper' }), [])
  assert.deepEqual(roomsOf(f, 'review-ui'), ['setup'])
})

test('a Codex or manual session also renames on a later join under a different name', async t => {
  const f = fixture(t, { label: null }), service = f.manual()
  const session = { runtime: 'manual', id: 'm1' }
  await service.call('join_room', { room: 'setup', agent: 'One', session })
  const joined = await service.call('join_room', { room: 'other', agent: 'Two', session })
  assert.equal(joined.agent, 'Two')
  assert.match(joined.note, /renamed from One/)
  assert.deepEqual(roomsOf(f, 'Two'), ['other', 'setup'])
})

// dismiss: no join needed, and never a join as a side effect.
function seedDismiss(f) {
  f.store.createRoom({ room: 'r', title: 'r' })
  f.store.join({ room: 'r', agent: 'Peer', session: { id: 'peer', runtime: 'manual' } })
  f.store.join({ room: 'r', agent: 'Closed', session: { id: 'closed', runtime: 'manual' } })
  f.store.deactivateSession('closed')
  f.store.post({ room: 'r', from: 'Peer', to: 'Closed', message: 'stale', sessionId: 'peer' })
}
const openFor = (f, name) => f.store.unreadReport().recipients.find(row => row.name === name)
const inRoom = (f, name) => f.store.members({ room: 'r' }).some(member => member.agent === name)

test('dismiss: a native session never in the room dismisses without being joined to it', async t => {
  const f = fixture(t, { label: null }); seedDismiss(f)
  const service = f.native()
  const { agent } = await service.call('join_room', { room: 'setup', agent: 'Clerk' })
  const result = await service.call('dismiss', { room: 'r', agent, recipient: 'Closed' })
  assert.equal(result.dismissed, 1)
  assert.equal(openFor(f, 'Closed'), undefined)
  assert.equal(inRoom(f, agent), false, 'dismiss joined the caller to the room')
  assert.equal(f.store.memberships().some(member => member.room === 'r' && member.participant_id === participantId(f.claude)), false)
  const receipt = f.store.memberships().find(row => row.agent === 'Closed').deliveries[result.message_ids[0]]
  assert.deepEqual([receipt.dismissed.by, receipt.dismissed.by_name], [participantId(f.claude), 'Clerk'])
})

test('dismiss: a native session that never joined anything in the project can dismiss and stays unjoined', async t => {
  const f = fixture(t, { label: null }); seedDismiss(f)
  const service = f.native()
  assert.equal((await service.call('dismiss', { room: 'r', agent: 'Clerk', recipient: 'Closed' })).dismissed, 1)
  assert.equal(f.store.memberships().some(member => member.participant_id === participantId(f.claude)), false)
  assert.equal(f.store.canonicalSessionName(f.claude), null, 'dismiss registered a name')
  // The dismissal record from an unregistered caller is valid state; a later read works.
  assert.equal(openFor(f, 'Closed'), undefined)
})

test('dismiss: a native session that left the room can dismiss', async t => {
  const f = fixture(t, { label: null }); seedDismiss(f)
  const service = f.native()
  const { agent } = await service.call('join_room', { room: 'r', agent: 'Clerk' })
  await service.call('leave_room', { room: 'r', agent })
  assert.equal((await service.call('dismiss', { room: 'r', agent, recipient: 'Closed' })).dismissed, 1)
  assert.equal(inRoom(f, agent), false)
})

test('dismiss: a manual client joined elsewhere can dismiss in a room it is not in', async t => {
  const f = fixture(t, { label: null }); seedDismiss(f)
  const service = f.manual()
  await service.call('join_room', { room: 'setup', agent: 'Clerk', session: { id: 'clerk', runtime: 'manual' } })
  assert.equal((await service.call('dismiss', { room: 'r', agent: 'Clerk', recipient: 'Closed' })).dismissed, 1)
  assert.equal(inRoom(f, 'Clerk'), false)
})

test('dismiss: a live recipient and a missing room are still refused', async t => {
  const f = fixture(t, { label: null }); seedDismiss(f)
  const service = f.native()
  await assert.rejects(service.call('dismiss', { room: 'r', agent: 'Clerk', recipient: 'Peer' }), /recipient is joined; it reads its own mail/)
  await assert.rejects(service.call('dismiss', { room: 'nowhere', agent: 'Clerk', recipient: 'Closed' }), /room does not exist/)
})

// Follow-up: a named session joining under a name someone else holds.
function seedOwners(f) {
  f.store.join({ room: 'setup', agent: 'Peer', session: { id: 'peer', runtime: 'manual' } })
  f.store.join({ room: 'setup', agent: 'Old', session: { id: 'old', runtime: 'manual' } })
  f.store.join({ room: 'other', agent: 'Old', session: { id: 'old', runtime: 'manual' } })
  f.store.join({ room: 'other', agent: 'Peer', session: { id: 'peer', runtime: 'manual' } })
  f.store.join({ room: 'setup', agent: 'Busy', session: { id: 'busy', runtime: 'manual' } })
  f.store.deactivateSession('old')
  f.store.post({ room: 'setup', from: 'Peer', to: 'Old', message: 'old in setup', sessionId: 'peer' })
  f.store.post({ room: 'other', from: 'Peer', to: 'Old', message: 'old in other', sessionId: 'peer' })
}

test('(a) a named session joining under a closed session\'s name takes it over and reserves its own old name', async t => {
  const f = fixture(t, { label: null }); seedOwners(f)
  const service = f.native()
  await service.call('join_room', { room: 'setup', agent: 'Helper' })
  const joined = await service.call('join_room', { room: 'other', agent: 'Old' })
  assert.equal(joined.agent, 'Old')
  assert.equal(joined.requested, undefined)
  assert.match(joined.note, /renamed from Helper/)
  const mine = f.store.memberships().filter(member => member.participant_id === participantId(f.claude))
  assert.deepEqual(mine.map(member => [member.room, member.agent, member.joined]).sort(), [['other', 'Old', true], ['setup', 'Old', true]])
  assert.deepEqual((await service.call('inbox', { room: 'other', agent: 'Old' })).map(row => row.message), ['old in other'])
  assert.deepEqual((await service.call('inbox', { room: 'setup', agent: 'Old' })).map(row => row.message), ['old in setup'])
  const stranger = f.manual()
  await assert.rejects(stranger.call('join_room', { room: 'setup', agent: 'Helper', session: { runtime: 'manual', id: 'stranger' } }), /reserved for its previous owner/)
})

test('(b) a named session joining under a live session\'s name keeps its name and says why', async t => {
  const f = fixture(t, { label: null }); seedOwners(f)
  const service = f.native()
  await service.call('join_room', { room: 'other', agent: 'Helper' })
  const joined = await service.call('join_room', { room: 'setup', agent: 'Busy' })
  assert.equal(joined.agent, 'Helper')
  assert.equal(joined.requested, 'Busy')
  assert.match(joined.note, /kept Helper; Busy belongs to another live session/)
  assert.deepEqual(roomsOf(f, 'Busy'), ['setup'])
})

test('(b) a named session joining under a name reserved for another session keeps its name and says why', async t => {
  const f = fixture(t, { label: null }); seedOwners(f)
  f.store.renameSession({ room: 'setup', agent: 'Peer', sessionId: 'peer', name: 'Peer2' })
  const service = f.native()
  await service.call('join_room', { room: 'other', agent: 'Helper' })
  const joined = await service.call('join_room', { room: 'setup', agent: 'Peer' })
  assert.deepEqual([joined.agent, joined.requested], ['Helper', 'Peer'])
  assert.match(joined.note, /kept Helper; Peer is reserved for its previous owner/)
})

test('(c) an unnamed session asking for a live session\'s name is refused in plain words', async t => {
  const f = fixture(t, { label: null }); seedOwners(f)
  const service = f.native()
  await assert.rejects(service.call('join_room', { room: 'setup', agent: 'Busy' }), /^Error: Busy belongs to another live session; join under another name$/)
  assert.equal(f.store.canonicalSessionName(f.claude), null)
})

test('join_room: names whose lowercase is a prototype key (Constructor, ToString) join, rename and read without damage', async t => {
  const f = fixture(t, { label: null }), service = f.native()
  await assert.rejects(service.call('join_room', { room: 'setup', agent: 'constructor' }), /invalid agent/)
  assert.equal((await service.call('join_room', { room: 'setup', agent: 'Constructor' })).agent, 'Constructor')
  const renamed = await service.call('join_room', { room: 'other', agent: 'ToString' })
  assert.equal(renamed.agent, 'ToString')
  assert.match(renamed.note, /renamed from Constructor/)
  assert.equal((await service.call('join_room', { room: 'setup', agent: 'Constructor' })).agent, 'ToString', 'an earlier own name is kept, no churn')
  const other = f.manual()
  await other.call('join_room', { room: 'setup', agent: 'ValueOf', session: { runtime: 'manual', id: 'm1' } })
  await other.call('post', { room: 'setup', from: 'ValueOf', to: 'ToString', message: 'hi' })
  const inbox = await service.call('inbox', { room: 'setup', agent: 'ToString' })
  assert.equal(inbox.filter(m => m.message_id).length, 1)
  await other.call('unread', {})
  await other.call('list_rooms', {})
})
