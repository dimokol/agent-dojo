import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { createStore } from './store.mjs'
import { createService, FAILED } from './server.mjs'

const receipt = (store, agent) => store.pending({ room: 'room', agent, sessionId: agent })[0].delivery

function setup(t, outcome = { status: 'accepted', detail: 'fake transport only' }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-chat-facade-'))
  const projectRoot = path.join(dir, 'project'); fs.mkdirSync(projectRoot)
  const root = path.join(dir, 'chats')
  const store = createStore({ root, projectRoot })
  const calls = []
  const adapters = { async deliver(input) { calls.push(input); return outcome } }
  // A private Codex profile of its own, so Codex metadata tests don't depend on ~/.codex.
  const codexHome = path.join(dir, 'codex'); fs.mkdirSync(codexHome, { mode: 0o700 })
  const env = { AGENT_CHAT_CODEX_HOME: codexHome }
  const first = createService({ store, adapters, env })
  const second = createService({ store: createStore({ root, projectRoot }), adapters, env })
  t.after(() => { first.close(); second.close(); fs.rmSync(dir, { recursive: true, force: true }) })
  const join = (service, agent) => service.call('join_room', { room: 'room', agent,
    session: { id: agent, runtime: 'manual' } })
  return { first, second, store, calls, join, root, projectRoot }
}

test('joined recipient is rung once, retained across restart, explicitly acknowledged', async t => {
  const s = setup(t)
  await s.first.call('create_room', { room: 'room', title: 'Test room' })
  await s.join(s.first, 'Sender'); await s.join(s.second, 'Receiver')
  const result = await s.first.call('post', { room: 'room', from: 'Sender', to: 'Receiver', message: 'review', idempotency_key: 'once' })
  assert.equal(s.calls.length, 1)
  await s.first.call('post', { room: 'room', from: 'Sender', to: 'Receiver', message: 'review', idempotency_key: 'once' })
  assert.equal(s.calls.length, 1)
  const inbox = await s.second.call('inbox', { room: 'room', agent: 'Receiver' })
  assert.deepEqual(inbox.map(item => item.message_id), [result.message_id])
  assert.equal(receipt(s.store, 'Receiver').status, 'notified')
  const restarted = createStore({ root: s.root, projectRoot: s.projectRoot })
  assert.equal(restarted.pending({ room: 'room', agent: 'Receiver', sessionId: 'Receiver' }).length, 1)
  await s.second.call('ack', { room: 'room', agent: 'Receiver', message_ids: [result.message_id] })
  assert.deepEqual(await s.second.call('inbox', { room: 'room', agent: 'Receiver' }), [])
})

test('unjoined and departed sessions never receive native calls', async t => {
  const s = setup(t)
  await s.first.call('create_room', { room: 'room', title: 'Test room' })
  await s.join(s.first, 'Sender')
  await s.first.call('post', { room: 'room', from: 'Sender', to: 'Receiver', message: 'before membership' })
  assert.equal(s.calls.length, 0)
  await s.join(s.second, 'Receiver')
  assert.equal(s.calls.length, 1)
  await s.second.call('leave_room', { room: 'room', agent: 'Receiver' })
  await s.first.call('post', { room: 'room', from: 'Sender', to: 'Receiver', message: 'after departure' })
  assert.equal(s.calls.length, 1)
})

test('uncertain native delivery stays readable and does not rerun itself', async t => {
  const s = setup(t, { status: 'pending', detail: 'socket outcome unknown' })
  await s.first.call('create_room', { room: 'room', title: 'Test room' })
  await s.join(s.first, 'Sender'); await s.join(s.second, 'Receiver')
  await s.first.call('post', { room: 'room', from: 'Sender', to: 'Receiver', message: 'pending' })
  const before = s.calls.length
  await new Promise(resolve => setTimeout(resolve, 100))
  assert.equal(s.calls.length, before)
  const inbox = await s.second.call('inbox', { room: 'room', agent: 'Receiver' })
  assert.equal(inbox.length, 1)
  assert.equal(receipt(s.store, 'Receiver').status, 'notified')
})

test('sender alias belongs to its joined MCP connection', async t => {
  const s = setup(t)
  await s.first.call('create_room', { room: 'room', title: 'Test room' })
  await s.join(s.first, 'Sender')
  await assert.rejects(s.second.call('post', { room: 'room', from: 'Sender', message: 'impersonation' }), /join_room/)
})

test('busy adapter leaves a notification eligible for the next dispatch', async t => {
  const s = setup(t, { status: 'pending', attempted: false, detail: 'adapter busy' })
  await s.first.call('create_room', { room: 'room', title: 'Test room' })
  await s.join(s.first, 'Sender'); await s.join(s.second, 'Receiver')
  await s.first.call('post', { room: 'room', from: 'Sender', to: 'Receiver', message: 'first' })
  assert.equal(s.calls.length, 1)
  assert.equal((await s.second.call('inbox', { room: 'room', agent: 'Receiver' })).length, 1)
  assert.equal(receipt(s.store, 'Receiver').status, 'pending')
  await s.join(s.second, 'Receiver')
  assert.equal(s.calls.length, 2)
})

test('compatibility wait filters recipient and channel while blocked', async t => {
  const s = setup(t)
  await s.first.call('create_room', { room: 'room', title: 'Test room' })
  await s.join(s.second, 'Receiver')
  const waiting = s.second.call('wait', { room: 'room', me: 'Receiver', channel: 'Main', timeout_seconds: 2 }, 1)
  let resolved = false; waiting.then(() => { resolved = true })
  s.store.post({ room: 'room', from: 'Sender', to: 'Other', channel: 'Main', message: 'wrong recipient' })
  s.store.post({ room: 'room', from: 'Sender', to: 'Receiver', channel: 'main', message: 'wrong case' })
  await new Promise(resolve => setTimeout(resolve, 40))
  assert.equal(resolved, false)
  const result = s.store.post({ room: 'room', from: 'Sender', to: 'Receiver', channel: 'Main', message: 'right' })
  const received = await waiting
  assert.equal(received.reason, 'message')
  assert.deepEqual(received.messages.map(item => item.id), [result.message_id])
})

test('known member reads addressed mail from its leave and rejoin gap', async t => {
  const s = setup(t)
  await s.first.call('create_room', { room: 'room', title: 'Test room' })
  await s.join(s.first, 'Sender'); await s.join(s.second, 'Receiver')
  await s.second.call('leave_room', { room: 'room', agent: 'Receiver' })
  const sent = await s.first.call('post', { room: 'room', from: 'Sender', to: 'Receiver', message: 'while left' })
  assert.equal(s.calls.length, 0)
  await s.join(s.second, 'Receiver')
  const inbox = await s.second.call('inbox', { room: 'room', agent: 'Receiver' })
  assert.deepEqual(inbox.map(message => message.message_id), [sent.message_id])
})

test('one outstanding doorbell batches later mail until acknowledgement', async t => {
  const s = setup(t)
  await s.first.call('create_room', { room: 'room', title: 'Test room' })
  await s.join(s.first, 'Sender'); await s.join(s.second, 'Receiver')
  const first = await s.first.call('post', { room: 'room', from: 'Sender', to: 'Receiver', message: 'first' })
  await s.first.call('post', { room: 'room', from: 'Sender', to: 'Receiver', message: 'second' })
  assert.equal(s.calls.length, 1)
  await s.second.call('ack', { room: 'room', agent: 'Receiver', message_ids: [first.message_id] })
  assert.equal(s.calls.length, 2)
})

test('canonical append from another writer rings a joined recipient through the watcher', async t => {
  const s = setup(t)
  await s.first.call('create_room', { room: 'room', title: 'Test room' })
  await s.join(s.second, 'Receiver')
  s.store.post({ room: 'room', from: 'External', to: 'Receiver', message: 'external writer' })
  const deadline = Date.now() + 1500
  while (!s.calls.length && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10))
  assert.equal(s.calls.length, 1)
  assert.equal(s.calls[0].messages[0].message, 'external writer')
})

test('case-variant rooms and broadcast aliases cannot split membership state', async t => {
  const s = setup(t)
  await s.first.call('create_room', { room: 'Room', title: 'Test room' })
  await assert.rejects(s.first.call('create_room', { room: 'room', title: 'Conflicting case' }), /case variant/)
  await assert.rejects(s.first.call('join_room', { room: 'Room', agent: 'ALL', session: { runtime: 'manual', id: 'ALL' } }), /reserved/)
})

test('explicit leave permits a successor to inherit unacknowledged addressed mail', async t => {
  const s = setup(t)
  await s.first.call('create_room', { room: 'room', title: 'Test room' })
  await s.join(s.first, 'Sender'); await s.join(s.second, 'Receiver')
  const sent = await s.first.call('post', { room: 'room', from: 'Sender', to: 'Receiver', message: 'handoff' })
  await s.second.call('leave_room', { room: 'room', agent: 'Receiver' })
  await s.second.call('join_room', { room: 'room', agent: 'Receiver', session: { runtime: 'manual', id: 'Successor' } })
  const inbox = await s.second.call('inbox', { room: 'room', agent: 'Receiver' })
  assert.deepEqual(inbox.map(message => message.message_id), [sent.message_id])
})

test('receipts are scripted after a delivered response and a later client call', async t => {
  const s = setup(t)
  await s.first.call('create_room', { room: 'room', title: 'Test room' })
  await s.join(s.first, 'Sender'); await s.join(s.second, 'Receiver')
  await s.first.call('post', { room: 'room', from: 'Sender', to: 'Receiver', message: 'read automatically' })
  const args = { room: 'room', agent: 'Receiver' }
  const inbox = await s.second.call('inbox', args)
  s.second.written('inbox', args, inbox, 100)
  await s.second.call('list_rooms', {}, 2, undefined, 99)
  assert.equal(s.store.deliveryStatus({ room: 'room', agent: 'Receiver' })[0].status, 'delivered')
  await s.second.call('list_rooms', {}, 3, undefined, 101)
  assert.equal(s.store.deliveryStatus({ room: 'room', agent: 'Receiver' })[0].status, 'received')
  assert.deepEqual(await s.second.call('inbox', args), [])
})

test('consumer close keeps delivered content with its original owner', async t => {
  const s = setup(t)
  await s.first.call('create_room', { room: 'room', title: 'Test room' })
  await s.join(s.first, 'Sender'); await s.join(s.second, 'Receiver')
  await s.first.call('post', { room: 'room', from: 'Sender', to: 'Receiver', message: 'interrupted read' })
  const args = { room: 'room', agent: 'Receiver' }
  const inbox = await s.second.call('inbox', args)
  s.second.written('inbox', args, inbox)
  s.second.close()
  await s.first.call('join_room', { room: 'room', agent: 'Receiver', session: { runtime: 'manual', id: 'Successor' } })
  assert.deepEqual(await s.first.call('inbox', args), [])
  const state=JSON.parse(fs.readFileSync(s.store.statePath,'utf8'))
  assert.equal(Object.values(state.rooms.room.retired_members)[0].deliveries[inbox[0].message_id].status,'delivered')
})

test('mail that arrives after the inbox response rings without another receiver call', async t => {
  const s = setup(t)
  await s.first.call('create_room', { room: 'room', title: 'Test room' })
  await s.join(s.first, 'Sender'); await s.join(s.second, 'Receiver')
  await s.first.call('post', { room: 'room', from: 'Sender', to: 'Receiver', message: 'first' })
  const args = { room: 'room', agent: 'Receiver' }
  const inbox = await s.second.call('inbox', args)
  s.second.written('inbox', args, inbox, 100)
  // Inbox may be the receiver's last call of its turn, so delivered must not hold the gate.
  const later = await s.first.call('post', { room: 'room', from: 'Sender', to: 'Receiver', message: 'after the snapshot' })
  for (let attempt = 0; attempt < 100 && s.calls.length < 2; attempt++) {
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  assert.equal(s.calls.length, 2)
  assert.deepEqual(s.calls[1].messages.map(message => message.id), [later.message_id])
})

test('an active alias cannot be claimed with the same ID through another connection', async t => {
  const s = setup(t)
  await s.first.call('create_room', { room: 'room', title: 'Test room' })
  await s.join(s.first, 'Sender')
  await assert.rejects(s.join(s.second, 'Sender'), /already joined/)
})

test('native Codex metadata rejects blocking wait without shell registration', async t => {
  const s = setup(t)
  const meta = { 'x-codex-turn-metadata': { thread_id: '00000000-0000-4000-8000-000000000001' } }
  await assert.rejects(s.first.call('wait', { room: 'room', me: 'Reader' }, 1, meta), /replaces blocking wait/)
})

test('missing or changed native metadata cannot reuse another actor identity', async t => {
  const s = setup(t)
  const meta = { 'x-codex-turn-metadata': { thread_id: '00000000-0000-4000-8000-000000000001' } }
  await s.first.call('list_rooms', {}, 1, meta)
  await assert.rejects(s.first.call('list_rooms', {}, 2), /metadata required/)
  await assert.rejects(s.first.call('list_rooms', {}, 3, { 'x-codex-turn-metadata': { thread_id: '00000000-0000-4000-8000-000000000002' } }), /session changed/)
})

test('a late delivery callback and stale receipt after departure do not brick the connection', async t => {
  const s = setup(t)
  await s.first.call('create_room', { room: 'room', title: 'Test room' })
  await s.join(s.first, 'Sender'); await s.join(s.second, 'Receiver')
  await s.first.call('post', { room: 'room', from: 'Sender', to: 'Receiver', message: 'race' })
  const args = { room: 'room', agent: 'Receiver' }
  const inbox = await s.second.call('inbox', args)
  s.second.written('inbox', args, inbox, 100)
  s.store.deactivateSession('Receiver')
  assert.equal(s.store.deliveryStatus({ room: 'room', agent: 'Receiver' })[0].status, 'delivered')
  assert.doesNotThrow(() => s.second.written('inbox', args, inbox, 101))
  await s.second.call('list_rooms', {}, 2, undefined, 102)
  await s.join(s.second, 'Receiver')
  assert.equal((await s.second.call('inbox', args)).length, 1)
})

test('damaged metadata permits only a previously bound sender with matching native identity', async t => {
  const s = setup(t)
  const meta = { 'x-codex-turn-metadata': { thread_id: '00000000-0000-4000-8000-000000000001' } }
  await s.first.call('create_room', { room: 'room', title: 'Test room' }, 1, meta)
  await s.first.call('join_room', { room: 'room', agent: 'Sender' }, 2, meta)
  await new Promise(resolve => setImmediate(resolve))
  const original = fs.readFileSync(s.store.statePath)
  try {
    fs.writeFileSync(s.store.statePath, '{damaged')
    const args = { room: 'room', from: 'Sender', to: 'Receiver', message: 'Durable during recovery', idempotency_key: 'recovery' }
    const posted = await s.first.call('post', args, 3, meta)
    assert.equal(posted.delivery[0].transport, 'pending')
    const retried = await s.first.call('post', args, 4, meta)
    assert.equal(retried.message_id, posted.message_id)
    assert.equal(retried.duplicate, true)
    await assert.rejects(s.first.call('post', { ...args, from: 'NewAlias' }, 5, meta), /join_room/)
    await assert.rejects(s.first.call('post', args, 6), /Native identity required/)
    await assert.rejects(s.first.call('post', args, 7, {
      'x-codex-turn-metadata': { thread_id: '00000000-0000-4000-8000-000000000002' },
    }), /Native identity required/)
    assert.equal(fs.readFileSync(s.store.statePath, 'utf8'), '{damaged')
    const rows = fs.readFileSync(path.join(s.store.roomsDir, 'room', 'chat.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line))
    assert.equal(rows.length, 1)
    assert.equal(rows[0].id, posted.message_id)
    assert.equal(rows[0].from, 'Sender')
  } finally {
    fs.writeFileSync(s.store.statePath, original)
  }
})

test('a departed manual connection cannot read receipts or post after its ID is reused', async t => {
  const s=setup(t)
  await s.first.call('create_room',{room:'room',title:'Ownership'})
  const args={room:'room',agent:'Owner',session:{id:'reused-id',runtime:'manual'}}
  await s.first.call('join_room',args)
  s.store.deactivateSession('reused-id')
  await s.second.call('join_room',args)
  await assert.rejects(s.first.call('post',{room:'room',from:'Owner',message:'stale'}),/not joined/)
  await assert.rejects(s.first.call('delivery_status',{room:'room',agent:'Owner'}),/not joined/)
  assert.deepEqual(await s.second.call('delivery_status',{room:'room',agent:'Owner'}),[])
})

test('delivery status requires the caller own current joined alias', async t => {
  const s=setup(t)
  await s.first.call('create_room',{room:'room',title:'Status'})
  await s.join(s.first,'Sender');await s.join(s.second,'Receiver')
  await s.first.call('post',{room:'room',from:'Sender',to:'Receiver',message:'private receipt'})
  await assert.rejects(s.first.call('delivery_status',{room:'room',agent:'Receiver'}),/join_room/)
  assert.equal((await s.second.call('delivery_status',{room:'room',agent:'Receiver'})).length,1)
})

test('stdio errors never echo damaged room JSON snippets or filesystem paths',async t=>{
  const s=setup(t);s.store.materialize();const room=path.join(s.store.roomsDir,'broken')
  fs.mkdirSync(room,{mode:0o700})
  fs.writeFileSync(path.join(room,'room.json'),'{"private":"TEST_ONLY_DO_NOT_ECHO",bad',{mode:0o600})
  const child=spawn(process.execPath,[fileURLToPath(new URL('./server.mjs',import.meta.url))],{cwd:s.projectRoot,env:{...process.env,AGENT_CHAT_ROOT:s.root,AGENT_CHAT_STATE_ROOT:path.join(s.root,'.runtime')},stdio:['pipe','pipe','pipe']})
  t.after(()=>child.kill())
  const output=await new Promise((resolve,reject)=>{
    let stdout='',stderr=''
    const deadline=setTimeout(()=>{child.kill();reject(Error('MCP did not close'))},3000)
    child.stdout.on('data',data=>stdout+=data)
    child.stderr.on('data',data=>stderr+=data)
    child.on('error',reject)
    child.on('close',()=>{clearTimeout(deadline);resolve({stdout,stderr})})
    child.stdin.end(JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'create_room',arguments:{room:'broken',title:'Broken'}}})+'\n')
  })
  assert.doesNotMatch(output.stdout+output.stderr,/TEST_ONLY_DO_NOT_ECHO|SyntaxError|\/Users\/|\/private\//)
  const result=JSON.parse(output.stdout.trim())
  assert.equal(result.result.isError,true)
  assert.equal(result.result.content[0].text,FAILED)
})
