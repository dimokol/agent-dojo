import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createStore } from './store.mjs'
import { createService } from './server.mjs'

function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agent-chat-dismiss-')))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const store = createStore({ root: path.join(root, 'chats'), stateRoot: path.join(root, 'state'), projectRoot: root })
  store.createRoom({ room: 'room', title: 'Dismiss room' })
  store.createRoom({ room: 'other', title: 'Other room' })
  const join = (agent, room = 'room') => store.join({ room, agent, session: { runtime: 'manual', id: agent.toLowerCase() } })
  const operator = join('Operator')
  const caller = { room: 'room', agent: 'Operator', sessionId: 'operator', participantId: operator.participant_id }
  const send = (to, message = `to ${to}`) => store.post({ room: 'room', from: 'Operator', to, message, sessionId: 'operator' })
  const open = name => store.unreadReport().recipients.find(row => row.name === name)
  return { root, store, join, caller, send, open }
}

test('dismissing a closed recipient\'s mail marks it handled and keeps the room log', t => {
  const f = fixture(t)
  f.join('Closed'); f.store.deactivateSession('closed')
  const sent = f.send('Closed')
  assert.equal(f.open('Closed').unread, 1)
  assert.equal(f.store.unreadReport().orphans.count, 1)
  const before = f.store.history({ room: 'room' })
  assert.deepEqual(f.store.dismiss({ ...f.caller, recipient: 'Closed' }), { room: 'room', recipient: 'Closed', dismissed: 1, message_ids: [sent.message_id] })
  assert.equal(f.open('Closed'), undefined)
  assert.equal(f.store.unreadReport().orphans.count, 0)
  assert.deepEqual(f.store.history({ room: 'room' }), before)
  const receipt = f.store.memberships().find(row => row.agent === 'Closed').deliveries[sent.message_id]
  assert.equal(receipt.status, 'handled')
  assert.equal(receipt.dismissed.by, f.caller.participantId)
})

test('a dismissed message to a name nobody holds never reaches a later owner of that name', t => {
  const f = fixture(t)
  f.send('Nobody')
  assert.equal(f.open('Nobody').status, 'never_joined')
  assert.equal(f.store.dismiss({ ...f.caller, recipient: 'Nobody' }).dismissed, 1)
  assert.equal(f.open('Nobody'), undefined)
  const later = f.join('Nobody')
  assert.deepEqual(f.store.pending({ room: 'room', agent: 'Nobody', sessionId: 'nobody', participantId: later.participant_id }), [])
})

test('mail to a participant with no row in this room stays dismissed when it joins the room', t => {
  const f = fixture(t)
  f.join('Elsewhere', 'other'); f.store.deactivateSession('elsewhere')
  f.send('Elsewhere')
  assert.equal(f.open('Elsewhere').rooms[0].status, 'never_joined')
  assert.equal(f.store.dismiss({ ...f.caller, recipient: 'Elsewhere' }).dismissed, 1)
  const rejoined = f.join('Elsewhere')
  assert.deepEqual(f.store.pending({ room: 'room', agent: 'Elsewhere', sessionId: 'elsewhere', participantId: rejoined.participant_id }), [])
  assert.equal(f.open('Elsewhere'), undefined)
})

test('a recipient joined anywhere in the project reads its own mail and cannot be dismissed', t => {
  const f = fixture(t)
  f.join('Live', 'other')
  f.send('Live')
  assert.throws(() => f.store.dismiss({ ...f.caller, recipient: 'Live' }), /recipient is joined; it reads its own mail/)
  assert.equal(f.open('Live').unread, 1)
})

test('named message ids must all be open for that recipient, or nothing changes', t => {
  const f = fixture(t)
  f.join('Closed'); f.store.deactivateSession('closed')
  const kept = f.send('Closed', 'first'), other = f.send('Someone')
  assert.throws(() => f.store.dismiss({ ...f.caller, recipient: 'Closed', message_ids: [kept.message_id, other.message_id] }), /message not open for this recipient/)
  assert.equal(f.open('Closed').unread, 1)
  assert.equal(f.store.dismiss({ ...f.caller, recipient: 'Closed', message_ids: [kept.message_id] }).dismissed, 1)
})

test('only a joined caller can dismiss, through the dismiss tool', async t => {
  const f = fixture(t)
  f.join('Closed'); f.store.deactivateSession('closed')
  f.send('Closed')
  assert.throws(() => f.store.dismiss({ ...f.caller, sessionId: 'someone-else', recipient: 'Closed' }), /session is not joined as this agent/)
  const service = createService({ store: f.store, env: {}, adapters: { async deliver() { return { attempted: false, status: 'pending' } } } })
  try {
    await service.call('join_room', { room: 'room', agent: 'Clerk', session: { runtime: 'manual', id: 'clerk' } })
    assert.equal((await service.call('dismiss', { room: 'room', agent: 'Clerk', recipient: 'Closed' })).dismissed, 1)
  } finally { service.close() }
})

// Found in review 2026-10-19: adoption built pending receipts from the log
// and handed dismissed mail to the newcomer.
test('a session that takes over a closed name does not inherit mail dismissed for it', t => {
  const f = fixture(t)
  f.join('Elsewhere', 'other'); f.store.deactivateSession('elsewhere')
  f.send('Elsewhere')
  assert.equal(f.store.dismiss({ ...f.caller, recipient: 'Elsewhere' }).dismissed, 1)
  const successor = f.store.join({ room: 'room', agent: 'Elsewhere', session: { runtime: 'manual', id: 'successor' } })
  assert.notEqual(successor.participant_id, f.store.participants().find(row => row.previous_name === 'Elsewhere')?.id)
  assert.deepEqual(f.store.pending({ room: 'room', agent: 'Elsewhere', sessionId: 'successor', participantId: successor.participant_id }), [])
  assert.equal(f.store.unreadReport().orphans.count, 0)
})
