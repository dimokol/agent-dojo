import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { createStore } from './store.mjs'

// Review regressions for package C: the canonical-only fallback, routing
// versus compaction, and recipients resolved after their mail was routed.
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-chat-c-regressions-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  let clock = Date.parse('2026-10-01T00:00:00Z'), reads = 0, hook = null
  // A transaction reads the clock at several points. A hook fired on the n-th
  // read runs inside that transaction, the way another process's write would.
  const now = () => { reads++; if (hook?.at === reads) { const { run } = hook; hook = null; run() } return clock }
  const options = { root: path.join(dir, 'chats'), projectRoot: dir, now }
  const store = createStore(options)
  store.createRoom({ room: 'room', title: 'Regressions' })
  return {
    options, store,
    log: path.join(store.roomsDir, 'room', 'chat.jsonl'),
    join: agent => store.join({ room: 'room', agent, session: { id: agent, runtime: 'manual' } }),
    arm: (offset, run) => { hook = { at: reads + offset, run } },
    disarm: () => { hook = null },
    advance: days => { clock += days * 86400000 },
  }
}
const inbox = (store, agent, sessionId = agent) => store.pending({ room: 'room', agent, sessionId }).map(message => message.message)
const roomState = store => JSON.parse(fs.readFileSync(store.statePath, 'utf8')).rooms.room
const states = (store, id) => store.readStates({ room: 'room', message_id: id }).map(row => [row.agent, row.read_state])
const rawLine = (from, to, message) => JSON.stringify({ id: randomUUID(), ts: new Date().toISOString(), from, to, channel: 'main', reply_to: null, message })

test('canonical-only idempotent posts work in a room whose records carry from_id, and still deduplicate', t => {
  const f = fixture(t)
  for (const agent of ['Reader', 'Sender']) f.join(agent)
  const bound = { room: 'room', from: 'Sender', to: 'Reader', message: 'bound', idempotency_key: 'bound' }
  const first = f.store.post({ ...bound, sessionId: 'Sender' })
  assert.ok(JSON.parse(fs.readFileSync(f.log, 'utf8').trim()).from_id, 'precondition: the bound post records from_id')
  const saved = fs.readFileSync(f.store.statePath, 'utf8')
  fs.writeFileSync(f.store.statePath, '{damaged')
  const recovery = { room: 'room', from: 'Sender', to: 'Reader', message: 'recovery', idempotency_key: 'recovery' }
  const sent = f.store.postCanonicalOnly(recovery)
  assert.equal(sent.duplicate, undefined)
  // Without state the sender name is the only identity, for either kind of record.
  assert.deepEqual([f.store.postCanonicalOnly(recovery)].map(r => [r.duplicate, r.message_id]), [[true, sent.message_id]])
  assert.deepEqual([f.store.postCanonicalOnly(bound)].map(r => [r.duplicate, r.message_id]), [[true, first.message_id]])
  assert.throws(() => f.store.postCanonicalOnly({ ...bound, message: 'changed' }), /idempotency key reused/)
  assert.notEqual(f.store.postCanonicalOnly({ ...bound, from: 'Other' }).message_id, first.message_id)
  assert.equal(fs.readFileSync(f.store.statePath, 'utf8'), '{damaged')
  // After repair the bound path matches the canonical-only record by name.
  fs.writeFileSync(f.store.statePath, saved)
  const repaired = createStore(f.options)
  assert.deepEqual([repaired.post({ ...recovery, sessionId: 'Sender' })].map(r => [r.duplicate, r.message_id]), [[true, sent.message_id]])
})

test('a canonical-only append landing between routing and compaction still reaches the inbox', t => {
  const f = fixture(t)
  for (const agent of ['Reader', 'Sender']) f.join(agent)
  // A second process holds the room lock only, never the state lock.
  const other = createStore({ ...f.options, now: Date.now })
  const first = f.store.post({ room: 'room', from: 'Sender', to: 'Reader', message: 'first', sessionId: 'Sender' })
  let windows = 0
  for (let offset = 1; ; offset++) {
    let late
    f.arm(offset, () => { late = other.postCanonicalOnly({ room: 'room', from: 'Sender', to: 'Reader', message: `late ${offset}` }) })
    // Any state-changing transaction routes, runs its callback, then compacts.
    f.store.updateDelivery({ room: 'room', agent: 'Reader', sessionId: 'Reader', message_ids: [first.message_id], status: offset % 2 ? 'delivered' : 'pending' })
    f.disarm()
    if (!late) break
    windows++
    const rs = roomState(f.store)
    assert.ok(rs.members.Reader.received_cursor <= rs.routed_cursor, `clock read ${offset}: watermark ${rs.members.Reader.received_cursor} passed routed ${rs.routed_cursor}`)
    assert.ok(inbox(f.store, 'Reader').includes(`late ${offset}`), `clock read ${offset}: late mail lost`)
  }
  assert.ok(windows > 2, 'the hook reached past routing into the transaction')
})

test('a canonical line still being written during routing is routed once it completes', t => {
  const f = fixture(t)
  for (const agent of ['Reader', 'Sender']) f.join(agent)
  const first = f.store.post({ room: 'room', from: 'Sender', to: 'Reader', message: 'first', sessionId: 'Sender' })
  let windows = 0
  for (let offset = 1; ; offset++) {
    // The writer has the line on disk but not its newline yet, so routing fails for the room.
    fs.appendFileSync(f.log, rawLine('Sender', 'Reader', `partial ${offset}`))
    let finished = false
    f.arm(offset, () => { fs.appendFileSync(f.log, '\n'); finished = true })
    f.store.updateDelivery({ room: 'room', agent: 'Reader', sessionId: 'Reader', message_ids: [first.message_id], status: offset % 2 ? 'delivered' : 'pending' })
    f.disarm()
    if (!finished) { fs.appendFileSync(f.log, '\n'); break }
    windows++
    const rs = roomState(f.store)
    assert.ok(rs.members.Reader.received_cursor <= rs.routed_cursor, `clock read ${offset}: watermark ${rs.members.Reader.received_cursor} passed routed ${rs.routed_cursor}`)
    assert.ok(inbox(f.store, 'Reader').includes(`partial ${offset}`), `clock read ${offset}: completed line lost`)
  }
  assert.ok(windows > 2, 'the hook reached past routing into the transaction')
})

test('direct mail to an unowned name reaches an existing session that later renames to it', t => {
  const f = fixture(t)
  for (const agent of ['Temp', 'Sender']) f.join(agent)
  const mail = f.store.post({ room: 'room', from: 'Sender', to: 'reviewer', message: 'please review', sessionId: 'Sender' })
  // The watermark passes mail with no owner yet; a later owner must still get it.
  assert.ok(roomState(f.store).members.Temp.received_cursor >= mail.cursor, 'precondition: watermark already past the mail')
  f.store.renameSession({ room: 'room', agent: 'Temp', sessionId: 'Temp', name: 'reviewer' })
  const identity = { room: 'room', agent: 'reviewer', sessionId: 'Temp' }
  assert.deepEqual(inbox(f.store, 'reviewer', 'Temp'), ['please review'])
  assert.deepEqual(states(f.store, mail.message_id), [['reviewer', 'unread']])
  assert.deepEqual(f.store.claim({ ...identity, message_ids: [mail.message_id] }), [mail.message_id])
  f.store.updateDelivery({ ...identity, message_ids: [mail.message_id], status: 'received' })
  // Once received it is never offered again, also after the compaction age.
  f.advance(2); f.store.post({ room: 'room', from: 'Sender', to: 'Nobody', message: 'tick' })
  assert.deepEqual(inbox(f.store, 'reviewer', 'Temp'), [])
  assert.deepEqual(states(f.store, mail.message_id), [['reviewer', 'received']])
})

test('upgrading older state never turns received legacy mail back into unread', t => {
  const f = fixture(t)
  // Older writers left records without sender or recipient ids and pruned
  // received receipts into received_cursor. The upgrade resolves every
  // recipient at once; that must not enqueue the mail again.
  fs.appendFileSync(f.log, ['one', 'two', 'three'].map(message => rawLine('Sender', 'Reader', message) + '\n').join(''), { mode: 0o600 })
  const reader = { agent: 'Reader', session: { id: 'Reader', runtime: 'manual' }, joined: true, after_cursor: 0, deliveries: {}, received_cursor: 3, ring_times: [] }
  fs.writeFileSync(f.store.statePath, JSON.stringify({ version: 1, rooms: { room: { routed_cursor: 3, members: { Reader: reader } } } }))
  const upgraded = createStore(f.options)
  assert.deepEqual(inbox(upgraded, 'Reader'), [])
  const later = upgraded.postCanonicalOnly({ room: 'room', from: 'Sender', to: 'Reader', message: 'after upgrade' })
  assert.deepEqual(inbox(upgraded, 'Reader'), ['after upgrade'])
  assert.deepEqual(states(upgraded, later.message_id), [['Reader', 'unread']])
})
