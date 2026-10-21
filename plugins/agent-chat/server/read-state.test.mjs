import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { createStore } from './store.mjs'

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-chat-read-state-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  let clock = Date.parse('2026-10-01T00:00:00Z')
  const options = { root: path.join(dir, 'chats'), projectRoot: dir, now: () => clock }
  const store = createStore(options)
  store.createRoom({ room: 'room', title: 'Read state' })
  const join = (agent, target = store) => target.join({ room: 'room', agent, session: { id: agent, runtime: 'manual' } })
  const set = (agent, ids, status, target = store) => target.updateDelivery({ room: 'room', agent, sessionId: agent, message_ids: ids, status })
  const log = path.join(store.roomsDir, 'room', 'chat.jsonl')
  const appendRaw = rows => fs.appendFileSync(log, rows.map(row => JSON.stringify({ ts: new Date(clock).toISOString(), channel: 'main', reply_to: null, ...row }) + '\n').join(''), { mode: 0o600 })
  return { options, store, join, set, appendRaw, advance: days => { clock += days * 86400000 } }
}
const states = (store, id) => store.readStates({ room: 'room', message_id: id }).map(row => [row.agent, row.read_state])
const tick = store => store.post({ room: 'room', from: 'Sender', to: 'Nobody', message: 'tick' })

test('read state is tracked per recipient, never as one global bit', t => {
  const f = fixture(t)
  for (const agent of ['Ann', 'Bob', 'Cat']) f.join(agent)
  const sent = f.store.post({ room: 'room', from: 'Sender', message: 'standup', urgent: true })
  assert.deepEqual(states(f.store, sent.message_id), [['Ann', 'unread'], ['Bob', 'unread'], ['Cat', 'unread']])
  f.store.claim({ room: 'room', agent: 'Ann', sessionId: 'Ann', message_ids: [sent.message_id] })
  f.set('Bob', [sent.message_id], 'delivered'); f.set('Cat', [sent.message_id], 'acked')
  assert.deepEqual(states(f.store, sent.message_id), [['Ann', 'unread'], ['Bob', 'delivered'], ['Cat', 'received']])
  f.set('Ann', [sent.message_id], 'failed'); f.set('Bob', [sent.message_id], 'received'); f.set('Cat', [sent.message_id], 'handled')
  assert.deepEqual(states(f.store, sent.message_id), [['Ann', 'unread'], ['Bob', 'received'], ['Cat', 'handled']])
  assert.deepEqual(f.store.deliveryStatus({ room: 'room' }).map(row => [row.agent, row.read_state]), [['Ann', 'unread'], ['Bob', 'received'], ['Cat', 'handled']])
  const stray = f.store.post({ room: 'room', from: 'Sender', to: 'Nobody', message: 'no owner yet' })
  assert.deepEqual(f.store.readStates({ room: 'room', message_id: stray.message_id }).map(row => [row.agent, row.participant_id, row.read_state]), [['Nobody', null, 'unread']])
})

test('legacy records without proof report unknown_legacy, never a guessed received', t => {
  const f = fixture(t)
  f.join('Reader')
  const [pruned, kept, open] = ['pruned', 'kept', 'open'].map(message => f.store.post({ room: 'room', from: 'Sender', to: 'Reader', message }))
  f.set('Reader', [pruned.message_id, kept.message_id], 'received')
  // Rebuild the shape an older writer left: an audience-free broadcast already
  // routed without a receipt, and a received receipt dropped by count pruning.
  f.appendRaw([{ id: 'legacy-broadcast', from: 'Old', to: 'all', message: 'old broadcast' }])
  const state = JSON.parse(fs.readFileSync(f.store.statePath, 'utf8'))
  const reader = state.rooms.room.members.Reader
  delete state.read_index; delete reader.legacy_cursor
  delete reader.deliveries[pruned.message_id]
  reader.received_cursor = 2
  state.rooms.room.routed_cursor = 4
  fs.writeFileSync(f.store.statePath, JSON.stringify(state))
  const restarted = createStore(f.options)
  assert.deepEqual(states(restarted, pruned.message_id), [['Reader', 'unknown_legacy']])
  assert.deepEqual(states(restarted, kept.message_id), [['Reader', 'received']])
  assert.deepEqual(states(restarted, open.message_id), [['Reader', 'unread']])
  assert.deepEqual(states(restarted, 'legacy-broadcast'), [['Reader', 'unknown_legacy']])
  // Mail after the upgrade carries proof, even after its entry is compacted.
  const fresh = restarted.post({ room: 'room', from: 'Sender', to: 'Reader', message: 'fresh' })
  f.set('Reader', [fresh.message_id], 'received', restarted)
  f.advance(8); tick(restarted)
  assert.equal(restarted.memberships()[0].deliveries[fresh.message_id], undefined)
  assert.deepEqual(states(restarted, fresh.message_id), [['Reader', 'received']])
  assert.deepEqual(states(restarted, kept.message_id), [['Reader', 'received']])
  assert.deepEqual(states(restarted, pruned.message_id), [['Reader', 'unknown_legacy']])
})

test('compaction folds old received and handled entries into a watermark and keeps open entries as exceptions', t => {
  const f = fixture(t)
  f.join('Reader')
  const identity = { room: 'room', agent: 'Reader', sessionId: 'Reader' }
  const send = message => f.store.post({ room: 'room', from: 'Sender', to: 'Reader', message })
  const [unread, received, delivered, handled] = ['unread', 'received', 'delivered', 'handled'].map(send)
  // An audience-free broadcast's receipt is its only evidence of who got it.
  f.appendRaw([{ id: 'no-audience', from: 'Old', to: 'all', message: 'legacy format' }])
  f.set('Reader', [received.message_id, 'no-audience'], 'received')
  f.set('Reader', [delivered.message_id], 'delivered')
  f.set('Reader', [handled.message_id], 'handled')
  f.advance(8)
  const recent = send('recent')
  f.set('Reader', [recent.message_id], 'received')
  const member = f.store.memberships()[0]
  assert.deepEqual(Object.keys(member.deliveries).sort(), [unread.message_id, delivered.message_id, 'no-audience', recent.message_id].sort())
  assert.ok(member.received_cursor >= recent.cursor)
  const read = message => states(f.store, message.message_id ?? message)[0][1]
  assert.deepEqual([unread, received, delivered, handled, 'no-audience', recent].map(read), ['unread', 'received', 'delivered', 'received', 'received', 'received'])
  // Unread and delivered entries are kept however old they get.
  f.advance(400); tick(f.store)
  assert.deepEqual(Object.keys(f.store.memberships()[0].deliveries).sort(), [unread.message_id, delivered.message_id, 'no-audience'].sort())
  // Compacted mail is never offered again after a rejoin.
  f.store.deactivateSession('Reader'); f.join('Reader')
  assert.deepEqual(f.store.pending(identity).map(message => message.message), ['unread', 'delivered'])
})

test('state size after 5,000 messages with mixed states stays proportional to the open entries', t => {
  const f = fixture(t)
  const reader = f.join('Reader'), other = f.join('Other')
  const rows = Array.from({ length: 5000 }, (_, index) => {
    const base = { id: randomUUID(), from: 'Sender', from_id: null, message: `message ${index}` }
    if (index % 10 === 9) return { ...base, to: 'all', to_id: null, audience: [reader.participant_id, other.participant_id] }
    if (index % 7 === 3) return { ...base, to: 'Other', to_id: other.participant_id }
    return { ...base, to: 'Reader', to_id: reader.participant_id }
  })
  f.appendRaw(rows)
  const mine = rows.filter(row => row.to !== 'Other')
  const theirs = rows.filter(row => row.to !== 'Reader')
  const groups = { pending: [], delivered: [], received: [], acked: [], handled: [] }
  mine.forEach((row, index) => groups[index % 50 === 0 ? 'pending' : index % 50 === 1 ? 'delivered' : ['received', 'acked', 'handled'][index % 3]].push(row.id))
  for (const status of ['delivered', 'received', 'acked', 'handled']) f.set('Reader', groups[status], status)
  f.set('Other', theirs.filter((_, index) => index % 4).map(row => row.id), 'received')
  f.advance(8); tick(f.store)
  const open = { Reader: groups.pending.length + groups.delivered.length, Other: theirs.filter((_, index) => !(index % 4)).length }
  const members = Object.fromEntries(f.store.memberships().map(member => [member.agent, member]))
  assert.equal(Object.keys(members.Reader.deliveries).length, open.Reader)
  assert.equal(Object.keys(members.Other.deliveries).length, open.Other)
  const size = fs.statSync(f.store.statePath).size
  assert.ok(size < (open.Reader + open.Other) * 160 + 8192, `state is ${size} bytes for ${open.Reader + open.Other} open entries`)
  assert.equal(states(f.store, groups.handled[7])[0][1], 'received')
  assert.equal(states(f.store, groups.pending[3])[0][1], 'unread')
})
