import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createStore } from './store.mjs'
import { createController } from './controller.mjs'
import { createService } from './server.mjs'
import { createAdapters } from './adapters.mjs'
import { tools } from './tools.mjs'

const THREAD = '12345678-1234-1234-1234-123456789abc'
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-chat-wake-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const options = { root: path.join(dir, 'chats'), projectRoot: dir }
  const store = createStore(options)
  store.createRoom({ room: 'room', title: 'Wake policy' })
  const rings = []
  const adapters = { async deliver(input) { rings.push(input); return { status: 'accepted' } } }
  const join = (agent, target = store, extra = {}) => target.join({ room: 'room', agent, session: { id: agent, runtime: 'manual' }, ...extra })
  return { options, store, rings, adapters, join, controller: createController({ store, adapters }) }
}
const canonical = store => fs.readFileSync(path.join(store.roomsDir, 'room', 'chat.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line))
const rung = rings => rings.map(ring => [ring.agent, ring.messages.map(message => message.id)])
const post = (store, args) => store.post({ room: 'room', from: 'Sender', ...args })

test('post takes optional fyi and urgent booleans, each described in one plain sentence', async t => {
  const schema = tools.find(tool => tool.name === 'post').inputSchema
  for (const name of ['fyi', 'urgent']) {
    assert.equal(schema.properties[name].type, 'boolean')
    assert.match(schema.properties[name].description, /^[A-Z][^.!?]+\.$/)
    assert.ok(!schema.required.includes(name))
  }
  const f = fixture(t)
  const service = createService({ store: f.store, adapters: f.adapters, env: {} })
  try {
    await service.call('join_room', { room: 'room', agent: 'Sender', session: { id: 'Sender', runtime: 'manual' } })
    for (const controls of [{ fyi: true }, { to: 'all', fyi: true }, { to: 'Reader', urgent: true }, { to: 'Reader', fyi: 'yes' }, { urgent: 1 }]) {
      await assert.rejects(service.call('post', { room: 'room', from: 'Sender', message: 'controls', ...controls }), /invalid wake controls/)
    }
  } finally { service.close() }
  assert.equal(f.store.history({ room: 'room' }).length, 0)
})

test('the wake policy is stored on the canonical message and an idempotent retry cannot change it', t => {
  const f = fixture(t)
  post(f.store, { to: 'Reader', message: 'note', idempotency_key: 'k1', fyi: true })
  post(f.store, { message: 'all hands', idempotency_key: 'k2', urgent: true })
  post(f.store, { to: 'Reader', message: 'default', fyi: false })
  const written = canonical(f.store)
  assert.deepEqual(written.map(({ fyi, urgent }) => [fyi, urgent]), [[true, undefined], [undefined, true], [undefined, undefined]])
  const restarted = createStore(f.options)
  assert.throws(() => post(restarted, { to: 'Reader', message: 'note', idempotency_key: 'k1' }), /idempotency key reused/)
  assert.throws(() => post(restarted, { message: 'all hands', idempotency_key: 'k2' }), /idempotency key reused/)
  assert.equal(post(restarted, { to: 'Reader', message: 'note', idempotency_key: 'k1', fyi: true }).duplicate, true)
  // The damaged-metadata fallback writes and deduplicates under the same contract.
  fs.writeFileSync(f.store.statePath, '{damaged')
  f.store.postCanonicalOnly({ room: 'room', from: 'Sender', to: 'Reader', message: 'later', idempotency_key: 'k3', fyi: true })
  assert.throws(() => f.store.postCanonicalOnly({ room: 'room', from: 'Sender', to: 'Reader', message: 'later', idempotency_key: 'k3' }), /idempotency key reused/)
  assert.equal(canonical(f.store).at(-1).fyi, true)
  assert.deepEqual(canonical(f.store).slice(0, 3), written)
})

test('a broadcast records its audience at post time, so a crash before metadata cannot add later joiners', async t => {
  const f = fixture(t)
  const reader = f.join('Reader'); f.join('Leaver'); f.join('Sender')
  f.store.leave({ room: 'room', agent: 'Leaver', sessionId: 'Leaver' })
  const saved = fs.readFileSync(f.store.statePath)
  const sent = post(f.store, { message: 'standup', urgent: true })
  // Crash after the canonical append, before the metadata write.
  fs.writeFileSync(f.store.statePath, saved)
  const restarted = createStore(f.options)
  f.join('Leaver', restarted)
  f.join('Late', restarted, { after_cursor: 0 })
  assert.deepEqual(canonical(f.store).at(-1).audience, [reader.participant_id])
  const inbox = agent => restarted.pending({ room: 'room', agent, sessionId: agent }).map(message => message.id)
  assert.deepEqual([inbox('Reader'), inbox('Leaver'), inbox('Late')], [[sent.message_id], [], []])
  const controller = createController({ store: restarted, adapters: f.adapters })
  await controller.dispatch('room')
  assert.deepEqual(rung(f.rings), [['Reader', [sent.message_id]]])
  // Damaged metadata cannot name an audience, so that broadcast is routed later but never rings.
  restarted.updateDelivery({ room: 'room', agent: 'Reader', sessionId: 'Reader', message_ids: [sent.message_id], status: 'delivered' })
  const repaired = fs.readFileSync(restarted.statePath)
  fs.writeFileSync(restarted.statePath, '{damaged')
  const blind = restarted.postCanonicalOnly({ room: 'room', from: 'Sender', message: 'during repair', urgent: true })
  fs.writeFileSync(restarted.statePath, repaired)
  await controller.dispatch('room')
  assert.equal(f.rings.length, 1)
  assert.ok(inbox('Reader').includes(blind.message_id))
})

test('direct mail wakes; FYI mail and plain broadcasts wait; urgent broadcasts wake their audience', async t => {
  const f = fixture(t)
  for (const agent of ['Reader', 'Other']) f.join(agent)
  const direct = post(f.store, { to: 'Other', message: 'direct' })
  await f.controller.dispatch('room')
  post(f.store, { to: 'Reader', message: 'fyi', fyi: true })
  post(f.store, { message: 'plain broadcast' })
  await f.controller.dispatch('room')
  assert.deepEqual(rung(f.rings), [['Other', [direct.message_id]]])
  const urgent = post(f.store, { message: 'urgent', urgent: true })
  await f.controller.dispatch('room')
  // Other still holds an unread doorbell, so only Reader rings now (B1).
  assert.deepEqual(rung(f.rings).slice(1), [['Reader', [urgent.message_id]]])
  const status = agent => Object.fromEntries(f.store.pending({ room: 'room', agent, sessionId: agent }).map(message => [message.message, message.delivery.status]))
  assert.deepEqual(status('Reader'), { fyi: 'pending', 'plain broadcast': 'pending', urgent: 'notified' })
  assert.deepEqual(status('Other'), { direct: 'notified', 'plain broadcast': 'pending', urgent: 'pending' })
  f.store.updateDelivery({ room: 'room', agent: 'Other', sessionId: 'Other', message_ids: [direct.message_id], status: 'delivered' })
  await f.controller.dispatch('room')
  assert.deepEqual(rung(f.rings).slice(2), [['Other', [urgent.message_id]]])
})

test('restart, replay and explicit retry never turn an FYI into a ring', async t => {
  const f = fixture(t)
  f.join('Reader')
  const identity = { room: 'room', agent: 'Reader', sessionId: 'Reader' }
  const saved = fs.readFileSync(f.store.statePath)
  const note = post(f.store, { to: 'Reader', message: 'fyi', fyi: true })
  fs.writeFileSync(f.store.statePath, saved)
  const restarted = createStore(f.options)
  const controller = createController({ store: restarted, adapters: f.adapters })
  await controller.dispatch('room')
  restarted.deactivateSession('Reader')
  f.join('Reader', restarted, { after_cursor: 0 })
  await controller.dispatch('room')
  restarted.leave(identity)
  f.join('Reader', restarted)
  await controller.dispatch('room')
  await controller.retry(identity, [note.message_id])
  assert.deepEqual(restarted.claim({ ...identity, message_ids: [note.message_id] }), [])
  assert.equal(f.rings.length, 0)
  assert.deepEqual(restarted.pending(identity).map(message => [message.id, message.delivery.status, message.delivery.attempts]), [[note.message_id, 'pending', 0]])
})

test('the next real wake notification counts waiting FYI mail by ID only, never peer text', async t => {
  const f = fixture(t)
  f.join('Reader')
  const quiet = [post(f.store, { to: 'Reader', message: 'SECRET-FYI-TEXT', fyi: true }), post(f.store, { message: 'SECRET-BROADCAST-TEXT' })]
  await f.controller.dispatch('room')
  assert.equal(f.rings.length, 0)
  const wake = post(f.store, { to: 'Reader', message: 'please review' })
  await f.controller.dispatch('room')
  assert.deepEqual(rung(f.rings), [['Reader', [wake.message_id]]])
  assert.deepEqual(f.rings[0].fyi, { count: 2, message_ids: quiet.map(item => item.message_id) })
  const queued = []
  const adapter = createAdapters({ requireProcessIdentity: false, executor: async (_file, args) => {
    if (args[0] === '--version') return { code: 0, stdout: 'codex-cli 0.162.1\n' }
    if (args[1] === '--help') return { code: 0, stdout: '--thread --message' }
    queued.push(args); return { code: 0, stdout: '' }
  } })
  assert.equal((await adapter.deliver({ ...f.rings[0], session: { id: THREAD, runtime: 'codex' } })).status, 'accepted')
  const text = queued[0][queued[0].indexOf('--message') + 1]
  const frame = JSON.parse(text.split('\n').at(-1))
  assert.deepEqual([frame.message_ids, frame.fyi_waiting, frame.fyi_message_ids], [[wake.message_id], 2, quiet.map(item => item.message_id)])
  assert.doesNotMatch(text, /SECRET-/)
  // Once inbox has returned the quiet mail it no longer counts as waiting.
  f.store.updateDelivery({ room: 'room', agent: 'Reader', sessionId: 'Reader', message_ids: [...quiet, wake].map(item => item.message_id), status: 'delivered' })
  post(f.store, { to: 'Reader', message: 'second' })
  await f.controller.dispatch('room')
  assert.equal(f.rings.length, 2)
  assert.equal(f.rings[1].fyi, undefined)
})
