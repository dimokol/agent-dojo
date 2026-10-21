import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createStore } from './store.mjs'
import { createService } from './server.mjs'
import { tools } from './tools.mjs'
import { processIdentity } from './native-session.mjs'
import { participantId } from './participant-identity.mjs'
import { nameFiles, readNameRecord, privateDirectory, writeIfChanged } from './notice-files.mjs'
import { noticeDirectory, projectNoticeId, sessionGateFile } from './notices.mjs'

// Package D wiring: store writes refresh notices and names, and the server
// exposes members, unread, default Claude names and a self-bound rename.
const LAUNCH = '11111111-1111-4111-8111-111111111111', CONV = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
function fixture(t) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agent-chat-d-wiring-')))
  // Services close before their store directory goes away.
  const closers = []
  t.after(() => { for (const close of closers.reverse()) close(); fs.rmSync(dir, { recursive: true, force: true }) })
  const stateRoot = path.join(dir, 'state'), root = path.join(dir, 'chats'), profile = path.join(dir, 'profile')
  fs.mkdirSync(stateRoot, { mode: 0o700 }); fs.mkdirSync(profile, { mode: 0o700 })
  const store = createStore({ root, projectRoot: dir, stateRoot })
  store.createRoom({ room: 'setup', title: 'Setup' })
  const claude = { id: LAUNCH, conversationId: CONV, runtime: 'claude', profileHome: profile }
  return { dir, stateRoot, root, profile, store, claude, closers }
}
const unreadFile = (f, id) => path.join(noticeDirectory(f.stateRoot), `${id}.${projectNoticeId(f.root, f.dir)}.unread`)
const accepted = { deliver: async () => ({ status: 'accepted' }) }
function nativeService(f, extra = {}) {
  const self = processIdentity(process.pid)
  const session = { runtime: 'claude', id: LAUNCH, profileHome: f.profile, clientPid: self.pid, clientStart: self.start, serverPid: self.pid, serverStart: self.start }
  const service = createService({ store: f.store, env: {}, adapters: accepted, inferSession: () => session, resolveConversation: () => CONV, ...extra })
  f.closers.push(() => service.close())
  return service
}

test('store writes keep the session notice, gates and canonical name cache current', t => {
  const f = fixture(t), ann = participantId(f.claude)
  f.store.join({ room: 'setup', agent: 'Ann', session: f.claude })
  f.store.join({ room: 'setup', agent: 'Bob', session: { id: 'Bob', runtime: 'manual' } })
  assert.deepEqual(readNameRecord(f.stateRoot, ann), { schema: 1, name: 'Ann', source: 'agent' })
  const sent = f.store.post({ room: 'setup', from: 'Bob', to: 'Ann', message: 'hi' })
  assert.deepEqual(JSON.parse(fs.readFileSync(unreadFile(f, ann), 'utf8')).rooms, [{ room: 'setup', count: 1 }])
  for (const id of [LAUNCH, CONV]) assert.ok(fs.existsSync(sessionGateFile(f.stateRoot, id, projectNoticeId(f.root, f.dir))), id)
  f.store.updateDelivery({ room: 'setup', agent: 'Ann', sessionId: LAUNCH, message_ids: [sent.message_id], status: 'delivered' })
  assert.equal(fs.existsSync(unreadFile(f, ann)), false)
  assert.equal(fs.existsSync(sessionGateFile(f.stateRoot, CONV, projectNoticeId(f.root, f.dir))), false)
  f.store.renameSession({ room: 'setup', agent: 'Ann', sessionId: LAUNCH, name: 'Annie', source: 'explicit' })
  assert.deepEqual(readNameRecord(f.stateRoot, ann), { schema: 1, name: 'Annie', source: 'explicit' })
})

test('mail to a closed session raises the project orphan flag; a notice failure never blocks mail', t => {
  const f = fixture(t)
  f.store.join({ room: 'setup', agent: 'Ann', session: f.claude })
  f.store.join({ room: 'setup', agent: 'Bob', session: { id: 'Bob', runtime: 'manual' } })
  f.store.deactivateSession(LAUNCH)
  f.store.post({ room: 'setup', from: 'Bob', to: 'Ann', message: 'while closed' })
  const orphans = path.join(noticeDirectory(f.stateRoot), `project-${projectNoticeId(f.root, f.dir)}.orphans`)
  assert.equal(JSON.parse(fs.readFileSync(orphans, 'utf8')).count, 1)
  fs.chmodSync(noticeDirectory(f.stateRoot), 0o755)
  assert.ok(f.store.post({ room: 'setup', from: 'Bob', to: 'Ann', message: 'still durable' }).message_id)
  assert.equal(f.store.history({ room: 'setup' }).length, 2)
})

test('store member and unread reports read under the lock; members() keeps joined rows only', t => {
  const f = fixture(t)
  f.store.join({ room: 'setup', agent: 'Ann', session: f.claude })
  f.store.join({ room: 'setup', agent: 'Bob', session: { id: 'Bob', runtime: 'manual' } })
  f.store.join({ room: 'setup', agent: 'Cat', session: { id: 'cat', runtime: 'codex' } })
  f.store.post({ room: 'setup', from: 'Bob', to: 'Ann', message: 'hi' })
  f.store.deactivateSession('cat')
  const rows = f.store.memberReport({ room: 'setup', isLive: member => member.agent !== 'Bob' })
  assert.deepEqual(rows.map(row => [row.name, row.runtime, row.status, row.wakeable]),
    [['Ann', 'claude', 'joined', true], ['Bob', 'manual', 'joined', false], ['Cat', 'codex', 'closed', false]])
  assert.deepEqual(f.store.members({ room: 'setup' }).map(member => member.agent).sort(), ['Ann', 'Bob'])
  assert.deepEqual(f.store.unreadReport().recipients.map(row => [row.name, row.status, row.unread]), [['Ann', 'joined', 1]])
  assert.throws(() => f.store.memberReport({ room: '../x', isLive: () => true }), /invalid room/)
})

test('members and unread tools are listed with one plain sentence; rename_session needs only a name', () => {
  const find = name => tools.find(tool => tool.name === name)
  assert.deepEqual(find('members').inputSchema.required, ['room'])
  assert.deepEqual(find('unread').inputSchema.properties, {})
  for (const name of ['members', 'unread']) assert.match(find(name).description, /^[A-Z][^.]*\.$/)
  assert.deepEqual(find('rename_session').inputSchema.required, ['name'])
})

test('members tool awaits presence and the Claude version check before a synchronous report', async t => {
  const f = fixture(t)
  f.store.join({ room: 'setup', agent: 'Ann', session: f.claude })
  f.store.join({ room: 'setup', agent: 'Cat', session: { id: 'cat', runtime: 'codex' } })
  f.store.join({ room: 'setup', agent: 'Dan', session: { id: 'dan', runtime: 'codex' } })
  const seen = []
  let verified = false
  const adapters = { ...accepted, async alive(session) {
    seen.push(session.id)
    await new Promise(resolve => setImmediate(resolve))
    if (session.id === 'dan') throw Error('presence unknown')
    return true
  } }
  const service = createService({ store: f.store, env: {}, adapters, claudeVerified: () => verified })
  f.closers.push(() => service.close())
  const wakeable = async () => Object.fromEntries((await service.call('members', { room: 'setup' })).map(row => [row.name, row.wakeable]))
  assert.deepEqual(await wakeable(), { Ann: false, Cat: true, Dan: false })
  verified = true
  assert.deepEqual(await wakeable(), { Ann: true, Cat: true, Dan: false })
  assert.ok(['cat', 'dan', LAUNCH].every(id => seen.includes(id)))
})

test('unread tool returns the project report without reading or adopting mail', async t => {
  const f = fixture(t)
  f.store.join({ room: 'setup', agent: 'Bob', session: { id: 'Bob', runtime: 'manual' } })
  f.store.post({ room: 'setup', from: 'Bob', to: 'Nobody', message: 'unowned' })
  const service = createService({ store: f.store, env: {}, adapters: accepted })
  f.closers.push(() => service.close())
  const before = fs.readFileSync(f.store.statePath, 'utf8')
  const report = await service.call('unread', {})
  assert.deepEqual(report.recipients.map(row => [row.name, row.status, row.unread]), [['Nobody', 'never_joined', 1]])
  assert.deepEqual(report, f.store.unreadReport())
  assert.equal(fs.readFileSync(f.store.statePath, 'utf8'), before)
})

test('rename_session without room and agent renames the caller after a resume; the explicit form still works', async t => {
  const f = fixture(t)
  const first = nativeService(f)
  await first.call('join_room', { room: 'setup', agent: 'Reader' })
  first.close()
  assert.equal(f.store.memberships()[0].joined, false)
  const resumed = nativeService(f)
  const renamed = await resumed.call('rename_session', { name: 'Renamed' })
  assert.deepEqual([renamed.name, renamed.source, renamed.previous_name], ['Renamed', 'explicit', 'Reader'])
  assert.equal((await resumed.call('rename_session', { room: 'setup', agent: 'Renamed', name: 'Again' })).name, 'Again')
  const stranger = createService({ store: f.store, env: {}, adapters: accepted })
  f.closers.push(() => stranger.close())
  await assert.rejects(stranger.call('rename_session', { name: 'Stolen' }), /join_room/)
  await assert.rejects(resumed.call('rename_session', { room: 'setup', name: 'Half' }), /invalid rename_session/)
})

test('a Claude session takes its cached native label over the agent suggestion; an explicit name beats both', async t => {
  const f = fixture(t), id = participantId(f.claude)
  privateDirectory(path.join(f.stateRoot, 'names'), true)
  writeIfChanged(nameFiles(f.stateRoot, id).native, JSON.stringify({ schema: 1, label: 'review-ui' }) + '\n')
  const service = nativeService(f)
  const joined = await service.call('join_room', { room: 'setup', agent: 'Helper' })
  assert.equal(joined.agent, 'review-ui')
  assert.deepEqual(await service.call('inbox', { room: 'setup', agent: 'Helper' }), [], 'the suggested alias still names this session on its connection')
  await service.call('rename_session', { name: 'Chosen' })
  f.store.createRoom({ room: 'other', title: 'Other' })
  assert.equal((await service.call('join_room', { room: 'other', agent: 'Helper' })).agent, 'Chosen')
  const posted = await service.call('post', { room: 'fresh', from: 'Helper', message: 'auto join' })
  assert.equal(f.store.history({ room: 'fresh' })[0].from, 'Chosen')
  assert.ok(posted.message_id)
})

test('without a native label the suggestion stays verbatim, and an exact closed name is still taken over', async t => {
  const f = fixture(t)
  f.store.join({ room: 'setup', agent: 'Old', session: { id: 'old', runtime: 'manual' } })
  f.store.join({ room: 'setup', agent: 'Bob', session: { id: 'Bob', runtime: 'manual' } })
  f.store.post({ room: 'setup', from: 'Bob', to: 'Old', message: 'for whoever takes Old' })
  f.store.deactivateSession('old')
  const id = participantId(f.claude)
  privateDirectory(path.join(f.stateRoot, 'names'), true)
  writeIfChanged(nameFiles(f.stateRoot, id).native, JSON.stringify({ schema: 1, label: 'review-ui' }) + '\n')
  const service = nativeService(f)
  assert.equal((await service.call('join_room', { room: 'setup', agent: 'Old' })).agent, 'Old')
  assert.deepEqual((await service.call('inbox', { room: 'setup', agent: 'Old' })).map(row => row.message), ['for whoever takes Old'])
  const g = fixture(t), plain = nativeService(g)
  assert.equal((await plain.call('join_room', { room: 'setup', agent: 'Helper' })).agent, 'Helper')
})
