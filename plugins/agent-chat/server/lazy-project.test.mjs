import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createStore } from './store.mjs'
import { createService } from './server.mjs'

function fixture(t) {
  const temp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agent-chat-lazy-')))
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }))
  const projectRoot = path.join(temp, 'scratch'); fs.mkdirSync(projectRoot)
  const root = path.join(temp, 'chats'), stateRoot = path.join(temp, 'state'); fs.mkdirSync(stateRoot, { mode: 0o700 })
  const traces = () => [...(fs.existsSync(root) ? fs.readdirSync(root) : []).filter(name => name !== '.runtime'),
    ...(fs.existsSync(path.join(stateRoot, 'projects')) ? fs.readdirSync(path.join(stateRoot, 'projects')) : [])]
  return { options: { root, projectRoot, stateRoot }, traces }
}

test('a session that never uses a room leaves no project folder or private state', async t => {
  const f = fixture(t)
  const store = createStore(f.options)
  const service = createService({ store, adapters: { async deliver() { return { status: 'accepted' } } }, env: {} })
  assert.deepEqual(await service.call('list_rooms'), [])
  assert.deepEqual(await service.call('unread'), store.unreadReport())
  assert.deepEqual(store.memberships(), [])
  assert.deepEqual(store.history({ room: 'nothing' }), [])
  store.deactivateSession('nobody', {})
  await assert.rejects(service.call('join_room', { room: 'nothing', agent: 'Me', session: { id: 'me', runtime: 'manual' } }), /room does not exist/)
  await new Promise(resolve => setImmediate(resolve))
  service.close()
  assert.deepEqual(f.traces(), [])
  assert.equal(store.materialized, false)
})

test('the first room creates the project, and a store started earlier sees it', async t => {
  const f = fixture(t)
  const early = createStore(f.options), late = createStore(f.options)
  late.createRoom({ room: 'plan', title: 'Plan' })
  assert.equal(f.traces().length, 2)
  assert.deepEqual(early.listRooms().map(row => row.room), ['plan'])
  assert.equal(early.materialized, true)
  assert.equal(early.roomsDir, late.roomsDir)
})

test('a server started before its project existed starts watching once a call creates it', async t => {
  const f = fixture(t)
  const rung = []
  const adapters = { async deliver(input) { rung.push(input.agent); return { status: 'accepted' } } }
  const reader = createService({ store: createStore(f.options), adapters, env: {} })
  const writer = createStore(f.options)
  writer.createRoom({ room: 'plan', title: 'Plan' })
  await reader.call('join_room', { room: 'plan', agent: 'Reader', session: { id: 'reader', runtime: 'manual' } })
  // Let the start-up dispatch finish, so only the reader's own watcher can notice the append and ring.
  await new Promise(resolve => setTimeout(resolve, 100))
  writer.post({ room: 'plan', from: 'Writer', to: 'Reader', message: 'look' })
  for (let index = 0; index < 50 && !rung.length; index++) await new Promise(resolve => setTimeout(resolve, 20))
  reader.close()
  assert.deepEqual(rung, ['Reader'])
})

test('a guessed folder another project claims meanwhile is never read', async t => {
  const f = fixture(t)
  const other = path.join(path.dirname(f.options.projectRoot), 'elsewhere', 'scratch'); fs.mkdirSync(other, { recursive: true })
  const mine = createStore(f.options), theirs = createStore({ ...f.options, projectRoot: other })
  theirs.post({ room: 'plan', from: 'Them', to: 'all', message: 'not yours' })
  assert.deepEqual(mine.history({ room: 'plan' }), [])
  assert.deepEqual(mine.listRooms(), [])
  assert.notEqual(mine.project, theirs.project)
  assert.equal(mine.materialized, false)
})

test('a create_room refused for its name leaves no trace', async t => {
  const f = fixture(t)
  const store = createStore(f.options)
  assert.throws(() => store.createRoom({ room: 'bad name', title: 'Bad' }), /invalid room/)
  assert.deepEqual(f.traces(), [])
})
