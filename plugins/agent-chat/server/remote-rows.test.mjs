import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createStore } from './store.mjs'
import { createService } from './server.mjs'

// Mail to a name another device holds in a shared room: the post result must not promise a
// wake when that device reports the name not joined (the live tab of that name may sit in
// another project, where this room can't reach it).
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-chat-remote-rows-'))
  const store = createStore({ root: path.join(dir, 'chats'), projectRoot: dir })
  store.adoptSharedRoom({ room: 'bridge', title: 'bridge', project: 'example.com/owner/repo' })
  store.setRemoteMember('bridge', { alias: 'live-peer', device: 'pc', device_name: 'pc', participant: 'p1', joined: true, runtime: 'claude' })
  store.setRemoteMember('bridge', { alias: 'gone-peer', device: 'pc', device_name: 'pc', participant: 'p2', joined: false, runtime: 'claude' })
  const sync = { addProject: async () => 'example.com/owner/repo', reserve: async () => {}, outlook: () => ({ state: 'sent', detail: 'pc is online; it wakes when the hub hands it over' }) }
  const service = createService({ store, sync, adapters: { async deliver() { return { status: 'accepted' } } }, env: {} })
  // Close before the folder goes, or close writes into a removed folder.
  t.after(() => { service.close(); fs.rmSync(dir, { recursive: true, force: true }) })
  return { store, service }
}

test('direct mail to a remote name its device reports not joined reads held/closed, not sent', async t => {
  const { service } = fixture(t)
  await service.call('join_room', { room: 'bridge', agent: 'Sender', session: { id: 'Sender', runtime: 'manual' } })
  const gone = await service.call('post', { room: 'bridge', from: 'Sender', to: 'gone-peer', message: 'install please' })
  assert.deepEqual(gone.delivery, [{ agent: 'gone-peer', device: 'pc', state: 'held', reason: 'closed',
    detail: 'Not joined in this room on pc (its tab closed, or it now runs in another project); the mail waits until that name is back in this room.' }])
  assert.equal(gone.note, undefined)
  const live = await service.call('post', { room: 'bridge', from: 'Sender', to: 'live-peer', message: 'ping' })
  assert.deepEqual(live.delivery, [{ agent: 'live-peer', device: 'pc', state: 'sent', detail: 'pc is online; it wakes when the hub hands it over' }])
})
