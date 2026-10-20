import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createStore } from './store.mjs'
import { createService } from './server.mjs'

const ROOM = 'ring'
const pause = ms => new Promise(resolve => setTimeout(resolve, ms))

function fixture(t, deliver) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-chat-ring-'))
  const projectRoot = path.join(dir, 'project')
  fs.mkdirSync(projectRoot)
  const root = path.join(dir, 'chats')
  const services = []
  const store = createStore({ root, projectRoot })
  const transport = []
  const adapters = {
    async deliver(input) {
      transport.push({ agent: input.agent, ids: input.messages.map(message => message.id) })
      deliver?.(input)
      return { status: 'accepted', attempted: true, detail: 'Scripted notification transport' }
    },
  }
  const service = () => {
    const replica = createService({ store: createStore({ root, projectRoot }), adapters, env: {} })
    services.push(replica)
    return replica
  }
  t.after(() => {
    for (const replica of services) replica.close()
    fs.rmSync(dir, { recursive: true, force: true })
  })
  return { store, transport, service }
}

async function join(service, agent, id = agent) {
  return service.call('join_room', { room: ROOM, agent, session: { id, runtime: 'manual' } })
}

// Scripted actors exercise the real service/store, with fake doorbells. This
// proves the application conversation stops at connection close. Real native
// subscription/unload behavior is checked separately by the SDK audit probes.
test('autonomous replies stop at close, read receipts advance, and a successor rescues pending mail', { timeout: 5000 }, async t => {
  const actors = new Map()
  let handoffs = 0, duplicateWakeFrames = 0, duplicatePosts = 0, callbacksAfterClose = 0
  let finishedResolve, finishedReject
  const finished = new Promise((resolve, reject) => { finishedResolve = resolve; finishedReject = reject })
  const s = fixture(t, input => {
    const actor = actors.get(input.agent)
    if (!actor) return
    // Deliver after controller records the transport result. A duplicate frame
    // carries the exact same IDs and must not create a second reply.
    setImmediate(() => {
      actor.receive(input)
      actor.receive(input)
    })
  })
  const operations = []
  const invoke = async (actor, name, args) => {
    operations.push({ actor: actor.name, name })
    return actor.service.call(name, args)
  }
  for (const name of ['A', 'B']) {
    const actor = { name, service: s.service(), open: true, seen: new Set(), work: Promise.resolve(), callbacks: 0 }
    actor.receive = frame => {
      actor.callbacks++
      if (!actor.open) { callbacksAfterClose++; finishedReject(new Error('Doorbell reached closed actor')); return }
      const ids = frame.messages.map(message => message.id)
      if (ids.every(id => actor.seen.has(id))) { duplicateWakeFrames++; return }
      for (const id of ids) actor.seen.add(id)
      actor.work = actor.work.then(async () => {
        const args = { room: ROOM, agent: name }
        const inbox = await invoke(actor, 'inbox', args)
        actor.service.written('inbox', args, inbox)
        for (const message of inbox) {
          if (++handoffs > 16) throw new Error('Autonomous ring exceeded its test budget')
          assert.ok(['PING', 'PONG'].includes(message.message))
          const reply = {
            room: ROOM, from: name, to: name === 'A' ? 'B' : 'A',
            message: message.message === 'PING' ? 'PONG' : 'PING',
            reply_to: message.message_id, idempotency_key: `reply-${message.message_id}`,
          }
          const posted = await invoke(actor, 'post', reply)
          const retry = await invoke(actor, 'post', reply)
          assert.equal(retry.duplicate, true)
          assert.equal(retry.message_id, posted.message_id)
          duplicatePosts++
          // A finishes exactly one in-flight reply and ends its MCP connection.
          if (name === 'A' && handoffs >= 4) { actor.open = false; actor.service.close() }
          if (name === 'B' && !actors.get('A').open) finishedResolve()
        }
      }).catch(finishedReject)
    }
    actors.set(name, actor)
  }
  await actors.get('A').service.call('create_room', { room: ROOM, title: 'Scripted autonomous ring' })
  await join(actors.get('A').service, 'A')
  await join(actors.get('B').service, 'B')
  await actors.get('A').service.call('post', { room: ROOM, from: 'A', to: 'B', message: 'PING', idempotency_key: 'seed' })
  let deadline
  try {
    await Promise.race([finished, new Promise((_, reject) => {
      deadline = setTimeout(() => reject(new Error('Autonomous ring did not settle')), 3000)
    })])
    await Promise.all([...actors.values()].map(actor => actor.work))
  } finally { clearTimeout(deadline) }

  assert.equal(handoffs, 5)
  assert.equal(duplicatePosts, 5)
  assert.equal(duplicateWakeFrames, 5)
  assert.equal(callbacksAfterClose, 0)
  const history = s.store.history({ room: ROOM })
  assert.equal(history.length, 6)
  for (let index = 1; index < history.length; index++) {
    assert.equal(history[index].reply_to, history[index - 1].message_id)
    assert.notEqual(history[index].message, history[index - 1].message)
  }
  const closed = s.store.memberships().find(member => member.agent === 'A')
  assert.equal(closed.joined, false)
  assert.equal(closed.left_reason, 'session_closed')
  assert.ok(s.store.members({ room: ROOM }).some(member => member.agent === 'B'))
  await assert.rejects(actors.get('A').service.call('post', { room: ROOM, from: 'A', message: 'closed' }), /connection is closed/)
  const receipts = s.store.deliveryStatus({ room: ROOM })
  assert.equal(receipts.filter(row => row.status === 'received').length, 5)
  const pending = receipts.filter(row => row.status === 'pending')
  assert.equal(pending.length, 1)
  assert.equal(pending[0].agent, 'A')
  assert.equal(pending[0].message_id, history.at(-1).message_id)
  assert.equal(pending[0].attempts, 0)
  assert.ok(operations.every(operation => ['inbox', 'post'].includes(operation.name)))

  // Quiet time produces no new actor inference/handling, posts, or delivery.
  const beforeQuiet = { operations: operations.length, deliveries: s.transport.length,
    callbacks: [...actors.values()].map(actor => actor.callbacks), messages: history.length }
  await pause(200)
  assert.deepEqual({ operations: operations.length, deliveries: s.transport.length,
    callbacks: [...actors.values()].map(actor => actor.callbacks), messages: s.store.history({ room: ROOM }).length }, beforeQuiet)

  // The new connection inherits central pending mail without reviving the closed
  // connection or requiring an ack/status tool in the actor conversation.
  actors.delete('A')
  const successor = s.service()
  await join(successor, 'A', 'A-successor')
  const args = { room: ROOM, agent: 'A' }
  const rescued = await successor.call('inbox', args)
  assert.deepEqual(rescued.map(message => message.message_id), [history.at(-1).message_id])
  successor.written('inbox', args, rescued)
  await successor.call('list_rooms')
  assert.deepEqual(await successor.call('inbox', args), [])
  assert.equal(s.store.deliveryStatus({ room: ROOM, agent: 'A' }).find(row => row.message_id === history.at(-1).message_id).status, 'received')
  assert.equal(callbacksAfterClose, 0)
})

test('thirty doorbells per ten minutes cap a still-open actor while retaining further mail', { timeout: 20_000 }, async t => {
  const s = fixture(t)
  const sender = s.service(), receiver = s.service()
  await sender.call('create_room', { room: ROOM, title: 'Delivery budget' })
  await join(sender, 'Sender')
  await join(receiver, 'Receiver')
  const args = { room: ROOM, agent: 'Receiver' }
  for (let index = 0; index < 30; index++) {
    await sender.call('post', { room: ROOM, from: 'Sender', to: 'Receiver', message: `PING ${index}` })
    const inbox = await receiver.call('inbox', args)
    assert.equal(inbox.length, 1)
    receiver.written('inbox', args, inbox)
    // An ordinary next read confirms receipt, without explicit ack/status calls.
    assert.deepEqual(await receiver.call('inbox', args), [])
  }
  assert.equal(s.transport.length, 30)
  const capped = await sender.call('post', { room: ROOM, from: 'Sender', to: 'Receiver', message: 'beyond ring budget' })
  assert.equal(s.transport.length, 30)
  const member = s.store.memberships().find(row => row.agent === 'Receiver')
  assert.equal(member.joined, true)
  assert.equal(member.ring_times.length, 30)
  const pending = await receiver.call('inbox', args)
  assert.deepEqual(pending.map(message => message.message_id), [capped.message_id])
  const [stored] = s.store.pending({ room: ROOM, agent: 'Receiver', sessionId: member.session.id, participantId: member.participant_id })
  assert.equal(stored.delivery.status, 'pending')
  assert.equal(stored.delivery.attempts, 0)
  const beforeQuiet = s.transport.length
  await pause(200)
  assert.equal(s.transport.length, beforeQuiet)
  assert.equal(s.store.history({ room: ROOM }).length, 31)
  assert.equal(s.store.deliveryStatus({ room: ROOM, agent: 'Receiver' }).filter(row => row.status === 'received').length, 30)
})
