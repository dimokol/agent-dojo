import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createStore } from './store.mjs'
import { createService } from './server.mjs'

// Direct mail to a live session, in a room it hasn't joined: the sender is told, and /unread
// says "not in room" rather than calling the recipient closed.
test('mail to a live session in a room it has not joined is reported as not in room', async t => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agent-chat-not-in-room-')))
  const projectRoot = path.join(dir, 'project'); fs.mkdirSync(projectRoot)
  const store = createStore({ root: path.join(dir, 'chats'), projectRoot })
  const adapters = { async deliver() { return { attempted: false, status: 'unsupported', detail: 'Manual session requires explicit history/wait retrieval.' } } }
  const alice = createService({ store, adapters, env: {} }), bob = createService({ store: createStore({ root: path.join(dir, 'chats'), projectRoot }), adapters, env: {} })
  t.after(() => { alice.close(); bob.close(); fs.rmSync(dir, { recursive: true, force: true }) })
  await alice.call('create_room', { room: 'a', title: 'a' }); await alice.call('create_room', { room: 'b', title: 'b' })
  await alice.call('join_room', { room: 'a', agent: 'alice', session: { id: 'alice', runtime: 'manual' } })
  await alice.call('join_room', { room: 'b', agent: 'alice', session: { id: 'alice', runtime: 'manual' } })
  await bob.call('join_room', { room: 'a', agent: 'bob', session: { id: 'bob', runtime: 'manual' } })
  const posted = await alice.call('post', { room: 'b', from: 'alice', to: 'bob', message: 'over here' })
  assert.deepEqual(posted.delivery, [{ agent: 'bob', transport: 'pending', detail: 'Not in this room now (closed, left or never joined); the mail waits until that name is back in it.' }])
  const report = await alice.call('unread', {})
  const row = report.recipients.find(entry => entry.name === 'bob')
  assert.equal(row.rooms.find(entry => entry.room === 'b').status, 'not_in_room')
  assert.equal(report.orphans?.count ?? 0, 0)
  // A recipient that left (or closed) gets the same row, with words that fit it too.
  await bob.call('leave_room', { room: 'a', agent: 'bob' })
  const left = await alice.call('post', { room: 'a', from: 'alice', to: 'bob', message: 'still there?' })
  assert.deepEqual(left.delivery, [{ agent: 'bob', transport: 'pending', detail: 'Not in this room now (closed, left or never joined); the mail waits until that name is back in it.' }])
})
