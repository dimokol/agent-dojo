import test from 'node:test'
import { distribution } from './distribution.mjs'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { participantId } from './participant-identity.mjs'
import { createStore } from './store.mjs'
import { claudeParticipantId, nameFiles } from './notice-files.mjs'
import { computeNotices, syncNotices, syncNameCache, readNativeLabel, sessionUnreadLine, projectOrphanLine, dailyOrphanLine, projectNoticeId, noticeDirectory } from './notices.mjs'
import { unreadReport } from './chat-queries.mjs'

const NOW = Date.parse('2026-10-16T12:00:00Z'), H = 3600000
const iso = ms => new Date(ms).toISOString()
const PROFILE = '/fixture/claude-profile'
const L1 = '11111111-1111-4111-8111-111111111111', C1 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const L2 = '22222222-2222-4222-8222-222222222222', C2 = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const ann = claudeParticipantId(PROFILE, C1), cat = claudeParticipantId(PROFILE, C2), bob = 'b'.repeat(64)
const receipt = (status, at = NOW - H) => ({ status, attempts: 0, updated: iso(at) })
const claude = (launch, conversation) => ({ id: launch, conversationId: conversation, runtime: 'claude', profileHome: PROFILE })
const row = (agent, participant_id, session, deliveries, joined = true, left_reason) =>
  ({ agent, participant_id, owner_since: 1, session, joined, ...(left_reason ? { left_reason } : {}), after_cursor: 0, received_cursor: 0, ring_times: [], deliveries })
const record = (cursor, id, from, to, at) => ({ id, message_id: id, cursor, ts: iso(at), from, to, to_id: { Ann: ann, Bob: bob, Cat: cat }[to], channel: 'main', message: 'body' })
function fixture() {
  const state = {
    version: 1, read_index: 1,
    participants: { [ann]: { id: ann, name: 'Ann', owner_since: 1, source: 'explicit' }, [bob]: { id: bob, name: 'Bob', owner_since: 1, source: 'agent' }, [cat]: { id: cat, name: 'Cat', owner_since: 1, source: 'native' } },
    nameOwners: { ann: { participant_id: ann, owner_since: 1 }, bob: { participant_id: bob, owner_since: 1 }, cat: { participant_id: cat, owner_since: 1 } },
    rooms: {
      setup: { routed_cursor: 4, members: {
        Ann: row('Ann', ann, claude(L1, C1), { m1: receipt('pending'), m2: receipt('delivered') }),
        Bob: row('Bob', bob, { id: 'c0dec0de-0000-4000-8000-000000000000', runtime: 'codex', profileHome: '/fixture/codex' }, { m4: receipt('pending') }),
        Cat: row('Cat', cat, claude(L2, C2), { m5: receipt('pending', NOW - 30 * H) }, false, 'session_closed'),
      } },
      design: { routed_cursor: 1, members: { Ann: row('Ann', ann, claude(L1, C1), { m3: receipt('notified') }) } },
    },
  }
  const logs = {
    setup: [record(1, 'm1', 'Bob', 'Ann', NOW - H), record(2, 'm2', 'Bob', 'Ann', NOW - H), record(3, 'm4', 'Ann', 'Bob', NOW - H), record(4, 'm5', 'Bob', 'Cat', NOW - 30 * H)],
    design: [record(1, 'm3', 'Bob', 'Ann', NOW - 2 * H)],
  }
  return { state, records: room => logs[room] }
}
function root(t) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agent-chat-notices-')))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const stateRoot = path.join(dir, 'state'); fs.mkdirSync(stateRoot, { mode: 0o700 })
  return { dir, stateRoot }
}
const mode = file => fs.statSync(file).mode & 0o777
const stamp = file => { const s = fs.statSync(file); return [s.ino, s.mtimeMs] }

test('notices list Claude sessions with unread in joined rooms, their gates and project orphans', () => {
  const { state, records } = fixture()
  const notices = computeNotices(state, NOW, records)
  assert.deepEqual([...notices.participants.keys()], [ann])
  assert.deepEqual(JSON.parse(notices.participants.get(ann)).rooms, [{ room: 'design', count: 1 }, { room: 'setup', count: 1 }])
  assert.deepEqual([...notices.gates].sort(), [L1, C1].sort(), 'launch and conversation ids both gate the prompt hook')
  assert.deepEqual([...notices.knownGates].sort(), [L1, C1, L2, C2].sort())
  assert.deepEqual(JSON.parse(notices.orphans), { schema: 1, count: 1, oldest_at: iso(NOW - 30 * H) })
})

test('sync writes private files atomically, only on change, and removes cleared ones', t => {
  const { stateRoot } = root(t), { state, records } = fixture(), projectId = 'a'.repeat(24)
  const dir = noticeDirectory(stateRoot), unread = path.join(dir, `${ann}.${projectId}.unread`), gate = path.join(dir, `session-${L1}.${projectId}.gate`), orphans = path.join(dir, `project-${projectId}.orphans`)
  // A gate in the name used before notices were per project is dropped like a cleared one.
  fs.mkdirSync(dir, { mode: 0o700 }); fs.writeFileSync(path.join(dir, `session-${L2}.gate`), '', { mode: 0o600 })
  assert.deepEqual(syncNotices({ stateRoot, projectId, state, now: NOW, records }), { written: 4, removed: 1 })
  assert.equal(mode(dir), 0o700)
  for (const file of [unread, gate, path.join(dir, `session-${C1}.${projectId}.gate`), orphans]) assert.equal(mode(file), 0o600)
  assert.equal(fs.existsSync(path.join(dir, `session-${L2}.gate`)), false, 'a closed session loses its gate')
  const before = [unread, gate, orphans].map(stamp)
  assert.deepEqual(syncNotices({ stateRoot, projectId, state, now: NOW + H, records }), { written: 0, removed: 0 })
  assert.deepEqual([unread, gate, orphans].map(stamp), before, 'unchanged content is never rewritten')
  state.rooms.design.members.Ann.deliveries.m3.status = 'delivered'
  syncNotices({ stateRoot, projectId, state, now: NOW, records })
  assert.notEqual(stamp(unread)[0], before[0][0], 'changed content is replaced by rename')
  assert.deepEqual(fs.readdirSync(dir).filter(name => name.endsWith('.tmp')), [])
  state.rooms.setup.members.Ann.deliveries.m1.status = 'received'
  state.rooms.setup.members.Cat.deliveries.m5.status = 'received'
  assert.deepEqual(syncNotices({ stateRoot, projectId, state, now: NOW, records }), { written: 0, removed: 4 })
  assert.deepEqual(fs.readdirSync(dir), [])
})

test('an unsafe notice directory is reported and nothing is written', t => {
  const { stateRoot } = root(t), { state, records } = fixture()
  fs.mkdirSync(noticeDirectory(stateRoot), { mode: 0o755 }); fs.chmodSync(noticeDirectory(stateRoot), 0o755)
  const result = syncNotices({ stateRoot, projectId: 'p', state, now: NOW, records })
  assert.match(result.error, /unsafe/)
  assert.deepEqual(fs.readdirSync(noticeDirectory(stateRoot)), [])
})

test('readers return the one-line texts and never echo damaged content', t => {
  const { stateRoot } = root(t), { state, records } = fixture()
  syncNotices({ stateRoot, projectId: 'proj', state, now: NOW, records })
  assert.equal(sessionUnreadLine({ stateRoot, profileHome: PROFILE, conversationId: C1 }), 'agent-chat: 2 unread in design (1), setup (1)')
  assert.equal(sessionUnreadLine({ stateRoot, profileHome: PROFILE, conversationId: C2 }), null)
  assert.equal(projectOrphanLine({ stateRoot, projectId: 'proj', now: NOW + 18 * H }), `agent-chat: 1 unread message to closed sessions, oldest 2d; to review, run ${distribution.unreadCommand} or ask the agent to call agent-chat's unread tool`)
  state.rooms.design.members.Ann.deliveries.m3.status = 'received'
  state.rooms.setup.members.Cat.deliveries.m6 = receipt('pending'); records('setup').push(record(5, 'm6', 'Bob', 'Cat', NOW - H))
  syncNotices({ stateRoot, projectId: 'proj', state, now: NOW, records })
  assert.equal(sessionUnreadLine({ stateRoot, profileHome: PROFILE, conversationId: C1 }), 'agent-chat: 1 unread in setup')
  assert.equal(projectOrphanLine({ stateRoot, projectId: 'proj', now: NOW }), `agent-chat: 2 unread messages to closed sessions, oldest 1d; to review, run ${distribution.unreadCommand} or ask the agent to call agent-chat's unread tool`)
  const file = path.join(noticeDirectory(stateRoot), `${ann}.proj.unread`)
  fs.writeFileSync(file, '{"schema":1,"rooms":[{"room":"\\u001b[31mSECRET","count":1}]}')
  assert.equal(sessionUnreadLine({ stateRoot, profileHome: PROFILE, conversationId: C1 }), null)
  fs.writeFileSync(file, '{"schema":1,"rooms":[{"room":"setup","count":1}]}'); fs.chmodSync(file, 0o644)
  assert.equal(sessionUnreadLine({ stateRoot, profileHome: PROFILE, conversationId: C1 }), null, 'a readable-by-others file is not trusted')
  assert.equal(sessionUnreadLine({ stateRoot, profileHome: PROFILE, conversationId: '../x' }), null)
  assert.equal(projectOrphanLine({ stateRoot: path.join(stateRoot, 'absent'), projectId: 'proj', now: NOW }), null)
})

test('notice keys match the store project directory and participant identity', t => {
  const { dir } = root(t), project = path.join(dir, 'project'), chats = path.join(dir, 'chats'); fs.mkdirSync(project)
  const store = createStore({ root: chats, projectRoot: project, stateRoot: path.join(dir, 'state') })
  assert.equal(projectNoticeId(chats, project), path.basename(path.dirname(store.statePath)))
  assert.equal(claudeParticipantId(PROFILE, C1), participantId(claude(L1, C1)))
})

test('the name cache keeps canonical Claude names current and reads the widget native label', t => {
  const { stateRoot } = root(t), { state } = fixture()
  assert.deepEqual(syncNameCache({ stateRoot, state }), { written: 2, removed: 0 })
  assert.deepEqual(JSON.parse(fs.readFileSync(nameFiles(stateRoot, ann).name, 'utf8')), { schema: 1, name: 'Ann', source: 'explicit' })
  assert.equal(fs.existsSync(nameFiles(stateRoot, bob).name), false, 'only Claude sessions have a statusline')
  assert.equal(mode(nameFiles(stateRoot, cat).name), 0o600)
  const before = stamp(nameFiles(stateRoot, ann).name)
  assert.deepEqual(syncNameCache({ stateRoot, state }), { written: 0, removed: 0 })
  assert.deepEqual(stamp(nameFiles(stateRoot, ann).name), before)
  state.participants[cat].name = null
  assert.deepEqual(syncNameCache({ stateRoot, state }), { written: 0, removed: 1 })
  assert.equal(readNativeLabel(stateRoot, ann), null)
  fs.writeFileSync(nameFiles(stateRoot, ann).native, JSON.stringify({ schema: 1, label: 'review-ui' }), { mode: 0o600 })
  assert.equal(readNativeLabel(stateRoot, ann), 'review-ui')
  fs.writeFileSync(nameFiles(stateRoot, ann).native, JSON.stringify({ schema: 1, label: 'bad label' }), { mode: 0o600 })
  assert.equal(readNativeLabel(stateRoot, ann), null)
})

test('the orphan startup line shows at most once a day per project; the flag and /unread keep everything', t => {
  const { stateRoot } = root(t), { state, records } = fixture()
  for (const projectId of ['proj', 'other']) syncNotices({ stateRoot, projectId, state, now: NOW, records })
  const line = (now, projectId = 'proj') => dailyOrphanLine({ stateRoot, projectId, now })
  assert.equal(line(NOW), `agent-chat: 1 unread message to closed sessions, oldest 1d; to review, run ${distribution.unreadCommand} or ask the agent to call agent-chat's unread tool`)
  assert.equal(line(NOW + H), null)
  assert.equal(line(NOW + 23 * H), null)
  assert.match(line(NOW + H, 'other'), /closed sessions/, 'each project keeps its own day')
  assert.match(line(NOW + 24 * H), /closed sessions/)
  assert.equal(line(NOW + 25 * H), null)
  const marker = path.join(stateRoot, 'shown', 'orphans-proj')
  assert.equal(mode(marker), 0o600); assert.equal(mode(path.dirname(marker)), 0o700)
  fs.writeFileSync(marker, 'damaged')
  assert.match(line(NOW + 26 * H), /closed sessions/, 'an unreadable marker never hides the line')
  assert.match(projectOrphanLine({ stateRoot, projectId: 'proj', now: NOW }), /closed sessions/)
  assert.equal(unreadReport(state, NOW, records).orphans.count, 1)
})
