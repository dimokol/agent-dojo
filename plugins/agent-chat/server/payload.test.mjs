import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createStore } from './store.mjs'
import { createService } from './server.mjs'
import { tools } from './tools.mjs'

function setup(t, outcome = { status: 'accepted', detail: 'fake transport only' }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-chat-payload-'))
  const projectRoot = path.join(dir, 'project'); fs.mkdirSync(projectRoot)
  const root = path.join(dir, 'chats')
  const store = createStore({ root, projectRoot })
  const adapters = { async deliver() { return outcome } }
  const sender = createService({ store, adapters, env: {} })
  const receiver = createService({ store: createStore({ root, projectRoot }), adapters, env: {} })
  t.after(() => { sender.close(); receiver.close(); fs.rmSync(dir, { recursive: true, force: true }) })
  return { store, sender, receiver, join: (service, agent) => service.call('join_room', { room: 'room', agent, session: { id: agent, runtime: 'manual' } }) }
}

test('inbox returns only what a model needs to read and answer a message', async t => {
  const s = setup(t)
  await s.sender.call('create_room', { room: 'room', title: 'Room' })
  await s.join(s.sender, 'Sender'); await s.join(s.receiver, 'Receiver')
  const first = await s.sender.call('post', { room: 'room', from: 'Sender', to: 'Receiver', message: 'one', idempotency_key: 'k1' })
  await s.sender.call('post', { room: 'room', from: 'Sender', to: 'Receiver', message: 'two', reply_to: first.message_id, channel: 'side', fyi: true })
  const inbox = await s.receiver.call('inbox', { room: 'room', agent: 'Receiver' })
  assert.deepEqual(inbox.map(Object.keys), [['message_id', 'ts', 'from', 'to', 'message'],
    ['message_id', 'ts', 'from', 'to', 'channel', 'reply_to', 'message', 'fyi']])
  assert.equal(inbox[0].message_id, first.message_id)
  // The log on disk keeps everything the view leaves out.
  const [stored] = s.store.history({ room: 'room', limit: 1 }).slice(-1)
  assert.ok(stored.from_id && stored.to_id && stored.id)
})

test('history defaults to the last 20 messages, each with its cursor', async t => {
  const s = setup(t)
  await s.sender.call('create_room', { room: 'room', title: 'Room' })
  await s.join(s.sender, 'Sender')
  for (let index = 0; index < 25; index++) await s.sender.call('post', { room: 'room', from: 'Sender', to: 'all', message: `m${index}` })
  const recent = await s.sender.call('history', { room: 'room' })
  assert.deepEqual(recent.map(item => item.message), Array.from({ length: 20 }, (_, index) => `m${index + 5}`))
  assert.deepEqual(recent.map(item => item.cursor), Array.from({ length: 20 }, (_, index) => index + 6))
  assert.equal(recent.some(item => 'from_id' in item || 'audience' in item), false)
  assert.equal((await s.sender.call('history', { room: 'room', limit: 100 })).length, 25)
})

test('a post result explains only the doorbells that were not accepted', async t => {
  const accepted = setup(t)
  await accepted.sender.call('create_room', { room: 'room', title: 'Room' })
  await accepted.join(accepted.sender, 'Sender'); await accepted.join(accepted.receiver, 'Receiver')
  const ok = await accepted.sender.call('post', { room: 'room', from: 'Sender', to: 'Receiver', message: 'hi' })
  assert.deepEqual(ok.delivery, [{ agent: 'Receiver', transport: 'accepted' }])
  const busy = setup(t, { status: 'pending', attempted: false, detail: 'adapter busy' })
  await busy.sender.call('create_room', { room: 'room', title: 'Room' })
  await busy.join(busy.sender, 'Sender'); await busy.join(busy.receiver, 'Receiver')
  const held = await busy.sender.call('post', { room: 'room', from: 'Sender', to: 'Receiver', message: 'hi' })
  assert.deepEqual(held.delivery, [{ agent: 'Receiver', transport: 'pending', detail: 'adapter busy' }])
})

test('the two tools a woken Claude session needs first skip deferred tool search', () => {
  assert.deepEqual(tools.filter(tool => tool._meta?.['anthropic/alwaysLoad'] === true).map(tool => tool.name).sort(), ['inbox', 'post'])
  assert.equal(tools.filter(tool => '_meta' in tool).length, 2)
})

test('a Claude session the server cannot recognise gets a clear error, not a generic failure', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-chat-unrecognised-'))
  const projectRoot = path.join(dir, 'project'); fs.mkdirSync(projectRoot)
  // This test process's parent isn't a native Claude Code install.
  const env = { CLAUDE_CODE_SESSION_ID: '12345678-1234-4234-8234-123456789abc', CLAUDE_CODE_MESSAGING_SOCKET: path.join(dir, 'x.sock') }
  const service = createService({ store: createStore({ root: path.join(dir, 'chats'), projectRoot }), adapters: { async deliver() { return { status: 'accepted' } } }, env })
  t.after(() => { service.close(); fs.rmSync(dir, { recursive: true, force: true }) })
  await service.call('create_room', { room: 'room', title: 'Room' })
  await assert.rejects(service.call('join_room', { room: 'room', agent: 'Me' }), /^Error: Native Claude session not recognised; agent-chat needs the native Claude Code install$/)
  await assert.rejects(service.call('post', { room: 'room', from: 'Me', message: 'hi' }), /Native Claude session not recognised/)
})
