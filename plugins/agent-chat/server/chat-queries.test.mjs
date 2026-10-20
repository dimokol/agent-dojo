import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { validState } from './store-schema.mjs'
import { members, unreadReport, formatAge } from './chat-queries.mjs'

const NOW = Date.parse('2026-10-16T12:00:00Z'), H = 3600000
const iso = ms => new Date(ms).toISOString()
const pid = name => createHash('sha256').update(name).digest('hex')
const id = { ann: pid('ann'), bob: pid('bob'), cat: pid('cat'), dan: pid('dan'), eve: pid('eve'), fay: pid('fay') }
const receipt = (status, at) => ({ status, attempts: 1, updated: iso(at) })
const session = (runtime, n) => runtime === 'manual' ? { id: `conn-${n}`, runtime } :
  { id: `0000000${n}-0000-4000-8000-000000000000`, runtime, profileHome: '/fixture/profile' }
function row(agent, runtime, n, { joined = true, left_reason, deliveries = {} } = {}) {
  return { agent, participant_id: id[agent.toLowerCase()], owner_since: NOW - 100 * H, session: session(runtime, n), joined,
    ...(left_reason ? { left_reason } : {}), after_cursor: 0, received_cursor: 0, ring_times: [], deliveries }
}
function message(cursor, mid, from, to, at, extra = {}) {
  return { id: mid, message_id: mid, cursor, ts: iso(at), from, from_id: id[from.toLowerCase()] ?? null, to,
    ...(to === 'all' ? {} : { to_id: id[to.toLowerCase()] ?? null }), channel: 'main', reply_to: null, message: 'secret body', ...extra }
}
// One project, two rooms: live, closed, explicitly left, placeholder and unowned recipients.
function fixture() {
  const setup = [
    message(1, 'm1', 'Bob', 'Ann', NOW - 2 * H),
    message(2, 'm2', 'Bob', 'Cat', NOW - 30 * H),
    message(3, 'm3', 'Bob', 'all', NOW - 5 * H, { audience: [id.ann] }),
    message(4, 'm4', 'Bob', 'Dan', NOW - 6 * H),
    message(5, 'm5', 'Bob', 'Dan', NOW - 7 * H),
    message(6, 'm6', 'Bob', 'Ghost', NOW - 50 * H),
    message(7, 'm7', 'Bob', 'Ann', NOW - 8 * H),
    message(8, 'm8', 'Bob', 'Ann', NOW - 9 * H, { to_id: undefined }),
    message(9, 'm9', 'Ann', 'Bob', NOW - 30 * 60000, { fyi: true }),
  ]
  delete setup[7].to_id
  const design = [message(1, 'm10', 'Eve', 'Ann', NOW - 3 * H)]
  const state = {
    version: 1, read_index: 1, ring_times: [],
    participants: Object.fromEntries(['Ann', 'Bob', 'Cat', 'Dan', 'Eve', 'Fay'].map(name => [id[name.toLowerCase()], { id: id[name.toLowerCase()], name, owner_since: NOW - 100 * H, source: 'agent' }])),
    nameOwners: Object.fromEntries(['Ann', 'Bob', 'Cat', 'Dan', 'Eve', 'Fay'].map(name => [name.toLowerCase(), { participant_id: id[name.toLowerCase()], owner_since: NOW - 100 * H }])),
    rooms: {
      setup: { routed_cursor: 9, legacy_recipients: { m8: id.ann }, members: {
        Ann: row('Ann', 'claude', 1, { deliveries: { m1: receipt('pending', NOW - 2 * H), m3: receipt('delivered', NOW - H), m7: receipt('received', NOW - 3 * H) } }),
        Bob: row('Bob', 'codex', 2, { deliveries: { m9: receipt('pending', NOW - 30 * 60000) } }),
        Cat: row('Cat', 'claude', 3, { joined: false, left_reason: 'session_closed', deliveries: { m2: receipt('notified', NOW - 29 * H) } }),
        Dan: row('Dan', 'manual', 4, { joined: false, left_reason: 'explicit', deliveries: { m4: receipt('delivered', NOW - 5 * H), m5: receipt('pending', NOW - 7 * H) } }),
        Fay: row('Fay', 'claude', 6, { joined: false }),
      } },
      design: { routed_cursor: 1, members: { Eve: row('Eve', 'claude', 5) } },
    },
  }
  const records = { setup, design }
  return { state, records: room => { if (!records[room]) throw Error('malformed canonical log'); return records[room] } }
}

test('fixture states match the persisted store schema', () => {
  assert.equal(validState(fixture().state), true)
})

test('members report canonical name, runtime, wakeable now and last seen, read-only', () => {
  const { state, records } = fixture(), before = JSON.stringify(state)
  const live = member => { if (member.agent === 'Bob') throw Error('presence unknown'); return true }
  const rows = members(state, 'setup', NOW, live, records)
  assert.deepEqual(rows.map(r => [r.name, r.runtime, r.status, r.wakeable]), [
    ['Ann', 'claude', 'joined', true], ['Bob', 'codex', 'joined', false],
    ['Cat', 'claude', 'closed', false], ['Dan', 'manual', 'left', false]])
  const ann = rows[0]
  assert.equal(ann.participant_id, id.ann)
  assert.equal(ann.last_seen, iso(NOW - 30 * 60000), 'own post is newer than the delivered receipt')
  assert.equal(ann.last_seen_age, '30m')
  assert.equal(rows[1].last_seen, iso(NOW - 2 * H), 'a sender without receipts is seen by its posts')
  assert.equal(rows[2].last_seen, null)
  assert.equal(JSON.stringify(state), before)
  assert.equal(JSON.stringify(rows).includes('secret body'), false)
})

test('manual sessions are never wakeable and an unknown room has no members', () => {
  const { state } = fixture()
  state.rooms.setup.members.Dan.joined = true
  delete state.rooms.setup.members.Dan.left_reason
  const rows = members(state, 'setup', NOW, () => true)
  assert.equal(rows.find(r => r.name === 'Dan').wakeable, false)
  assert.equal(rows.find(r => r.name === 'Ann').last_seen, iso(NOW - H), 'receipts alone without records')
  assert.deepEqual(members(state, 'missing', NOW, () => true), [])
})

test('unread report groups unread and delivered mail by recipient with ages and statuses', () => {
  const { state, records } = fixture(), before = JSON.stringify(state)
  const report = unreadReport(state, NOW, records)
  assert.deepEqual(report.recipients.map(r => [r.name, r.status, r.unread, r.delivered, r.oldest_age]), [
    ['Ann', 'joined', 2, 1, '5h'],
    ['Bob', 'joined', 1, 0, '30m'],
    ['Cat', 'closed', 1, 0, '1d'],
    ['Dan', 'left', 1, 1, '7h'],
    ['Ghost', 'never_joined', 1, 0, '2d']])
  const ann = report.recipients[0]
  assert.deepEqual(ann.rooms.map(r => [r.room, r.status, r.unread, r.delivered]), [['design', 'never_joined', 1, 0], ['setup', 'joined', 1, 1]])
  assert.equal(ann.oldest_at, iso(NOW - 5 * H))
  assert.equal(report.recipients[4].participant_id, null)
  assert.deepEqual(report.unknown_legacy, [{ name: 'Ann', participant_id: id.ann, room: 'setup', count: 1, oldest_at: iso(NOW - 9 * H), oldest_age: '9h' }])
  // Orphans: unread direct mail whose recipient is not joined in that room.
  assert.deepEqual(report.orphans, { count: 4, oldest_at: iso(NOW - 50 * H), oldest_age: '2d' })
  assert.deepEqual(report.damaged_rooms, [])
  assert.equal(JSON.stringify(state), before)
  assert.equal(JSON.stringify(report).includes('secret body'), false)
})

test('a damaged room log is listed, never guessed empty', () => {
  const { state, records } = fixture()
  state.rooms.broken = { routed_cursor: 0, members: {} }
  assert.deepEqual(unreadReport(state, NOW, records).damaged_rooms, ['broken'])
})

test('a real store closing a session yields a closed recipient and an orphan', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-queries-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  return import('./store.mjs').then(({ createStore }) => {
    const store = createStore({ root: path.join(dir, 'chats'), projectRoot: dir })
    store.createRoom({ room: 'one', title: 'one' })
    store.join({ room: 'one', agent: 'Reader', session: { id: 'reader', runtime: 'manual' } })
    store.post({ room: 'one', from: 'Writer', to: 'Reader', message: 'hello' })
    store.post({ room: 'one', from: 'Writer', to: 'Nobody', message: 'stray' })
    store.deactivateSession('reader')
    const state = JSON.parse(fs.readFileSync(store.statePath, 'utf8'))
    const report = unreadReport(state, Date.now(), room => store.history({ room, limit: 10000 }))
    assert.deepEqual(report.recipients.map(r => [r.name, r.status, r.unread]), [['Nobody', 'never_joined', 1], ['Reader', 'closed', 1]])
    assert.equal(report.orphans.count, 2)
  })
})

test('ages read as minutes, hours and days', () => {
  assert.deepEqual([20000, 5 * 60000, 3 * H, 30 * H, 75 * H].map(formatAge), ['<1m', '5m', '3h', '1d', '3d'])
  assert.equal(formatAge(Number.NaN), null)
})
