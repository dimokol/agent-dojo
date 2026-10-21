import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createStore } from './store.mjs'
import { createController } from './controller.mjs'

function setup(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-chat-controller-'))
  const store = createStore({ root: path.join(root, 'chats'), projectRoot: root })
  store.createRoom({ room: 'room', title: 'Test room' })
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  return store
}

test('an older unattempted callback cannot release a replacement delivery claim', async t => {
  const store = setup(t)
  const session = { id: 'receiver', runtime: 'manual' }
  store.join({ room: 'room', agent: 'Receiver', session })
  store.post({ room: 'room', from: 'Sender', to: 'Receiver', message: 'Review' })
  const pending = []
  const controller = createController({ store, adapters: {
    deliver: () => new Promise(resolve => pending.push(resolve)),
  } })
  const old = controller.dispatch('room')
  store.deactivateSession(session.id)
  store.join({ room: 'room', agent: 'Receiver', session })
  const fresh = controller.dispatch('room')
  const currentClaim = store.deliveryStatus({ room: 'room' })[0].claim_id
  pending[0]({ status: 'pending', attempted: false })
  await old
  const receipt = store.deliveryStatus({ room: 'room' })[0]
  assert.equal(receipt.status, 'dispatching')
  assert.equal(receipt.claim_id, currentClaim)
  await controller.dispatch('room')
  assert.equal(pending.length, 2)
  pending[1]({ status: 'accepted' })
  await fresh
})

test('a blocked recipient does not delay delivery to another recipient', async t => {
  const store = setup(t)
  for (const agent of ['Blocked', 'Fast']) {
    store.join({ room: 'room', agent, session: { id: agent, runtime: 'manual' } })
  }
  store.post({ room: 'room', from: 'Sender', message: 'Review', urgent: true })
  const calls = []
  let release
  const controller = createController({ store, adapters: {
    async deliver(input) {
      calls.push(input.agent)
      if (input.agent === 'Blocked') await new Promise(resolve => { release = resolve })
      return { status: 'accepted' }
    },
  } })
  const dispatch = controller.dispatch('room')
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(calls, ['Blocked', 'Fast'])
  assert.equal(store.deliveryStatus({ room: 'room', agent: 'Fast' })[0].status, 'notified')
  release()
  await dispatch
})

for(const outcome of [{status:'accepted'},{status:'pending'},{status:'pending',attempted:false}])test(`late transport ${JSON.stringify(outcome)} preserves delivered content and permits the next ring`,async t=>{
 const store=setup(t),identity={room:'room',agent:'Receiver',sessionId:'receiver'}
 store.join({room:'room',agent:'Receiver',session:{id:'receiver',runtime:'manual'}})
 const first=store.post({room:'room',from:'Sender',to:'Receiver',message:'first'})
 let release,calls=0
 const controller=createController({store,adapters:{deliver(){calls++;return calls===1?new Promise(resolve=>{release=resolve}):Promise.resolve({status:'accepted'})}}})
 const dispatch=controller.dispatch('room')
 store.updateDelivery({...identity,message_ids:[first.message_id],status:'delivered'})
 release(outcome);await dispatch
 assert.equal(store.deliveryStatus(identity)[0].status,'delivered')
 assert.equal(store.assertMember('room','Receiver','receiver').ring_times.length,1)
 store.post({room:'room',from:'Sender',to:'Receiver',message:'second'})
 await controller.dispatch('room')
 assert.equal(calls,2)
})
