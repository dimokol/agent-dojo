import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { execFileSync } from 'node:child_process'
import { normalizeOrigin, cleanRemoteText, encodeInvite, decodeInvite, PROTOCOL, PROTOCOL_HEADER, newKeyPair, privateKeyFrom, signHeaders, requestBytes } from './hub-protocol.mjs'
import { serveHub, createInvite } from './hub.mjs'
import { pair, loadDevice, deviceRequest } from './device.mjs'
import { createSync } from './sync.mjs'
import { createStore } from './store.mjs'
import { createService } from './server.mjs'

const until = async (check, what, ms = 10_000) => {
  const end = Date.now() + ms
  for (;;) {
    const value = await check()
    if (value) return value
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`)
    await new Promise(resolve => setTimeout(resolve, 50))
  }
}
const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { stdio: 'ignore' })

async function startHub(dir, port = 0) {
  const running = serveHub({ dir, listen: [{ host: '127.0.0.1', port }] })
  const [address] = await running.ready
  return { running, port: address.port }
}

// Two devices of one project (same origin written two ways), each with its own chat root and state
// root, paired with one hub on a random local port.
async function world(t, { syncOn = true } = {}) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agent-chat-hub-')))
  const hubDir = path.join(base, 'hub')
  // Cleanup is registered before anything starts, so a setup that throws part way leaves no hub or
  // engine running. Engines a test starts later stop here too, before the folder goes: Windows can't
  // remove files a running engine holds open, and an engine left running keeps the process alive.
  let hub = null
  const devices = {}, engines = []
  t.after(async () => {
    for (const engine of engines) await engine.stop()
    for (const d of Object.values(devices)) d.service.close()
    await hub?.running.close()
    fs.rmSync(base, { recursive: true, force: true, maxRetries: 5 })
  })
  hub = await startHub(hubDir)
  const origins = { mac: 'git@github.com:Dimokol/agent-dojo.git', pc: 'https://github.com/dimokol/agent-dojo' }
  for (const name of ['mac', 'pc']) {
    const dir = path.join(base, name)
    fs.mkdirSync(dir, { mode: 0o700 })
    const projectRoot = path.join(dir, 'project')
    fs.mkdirSync(projectRoot)
    git(projectRoot, 'init', '-q'); git(projectRoot, 'remote', 'add', 'origin', origins[name])
    const stateRoot = path.join(dir, 'state'), chatRoot = path.join(dir, 'chats')
    fs.mkdirSync(stateRoot, { mode: 0o700 })
    await pair(stateRoot, createInvite(hubDir, { address: `127.0.0.1:${hub.port}` }), { name })
    const store = createStore({ root: chatRoot, projectRoot, stateRoot })
    const sync = syncOn ? createSync({ stateRoot, chatRoot, drainWaitS: 1, retryMs: 100 }) : null
    if (sync) engines.push(sync)
    if (sync) { sync.start(); await sync.addProject(store.projectRoot, store) }
    const transport = []
    const adapters = { async deliver(input) { transport.push({ agent: input.agent, ids: input.messages.map(m => m.id), texts: input.messages.map(m => m.message) }); return { status: 'accepted', attempted: true, detail: 'scripted' } } }
    const service = createService({ store, sync, adapters, env: {} })
    devices[name] = { dir, projectRoot, stateRoot, chatRoot, store, sync, service, transport, adapters }
  }
  return { base, hubDir, devices, own: engine => (engines.push(engine), engine), get hub() { return hub }, async restartHub() { hub = await startHub(hubDir, hub.port); return hub }, async stopHub() { await hub.running.close() } }
}
const join = (d, agent, room = 'bridge') => d.service.call('join_room', { room, agent, session: { id: `${agent}-session`, runtime: 'manual' } })
const outbox = d => { try { return fs.readdirSync(path.join(d.stateRoot, 'sync', 'outbox')).filter(n => n.endsWith('.json')) } catch { return [] } }

test('origin URLs match across spellings, and remote text loses hidden characters', () => {
  for (const url of ['git@github.com:Dimokol/Agent-Dojo.git', 'https://github.com/dimokol/agent-dojo', 'ssh://git@github.com:22/dimokol/agent-dojo.git', 'https://user@github.com/dimokol/agent-dojo/'])
    assert.equal(normalizeOrigin(url), 'github.com/dimokol/agent-dojo')
  assert.equal(normalizeOrigin(''), null)
  assert.equal(cleanRemoteText('a‮b​c\x1b[31md\x07e<system-reminder>x</system-reminder>\n\tok'), 'abcde‹system-reminder>x‹/system-reminder>\n\tok')
  const { publicKey } = newKeyPair()
  const code = encodeInvite({ address: 'h:1', hubKey: publicKey, secret: 's', expires: Date.now() + 1000 })
  assert.equal(decodeInvite(code).address, 'h:1')
  assert.throws(() => decodeInvite(code, Date.now() + 2000), /expired/)
  assert.throws(() => decodeInvite('nope'), /not an agent-chat invite/)
})

test('pairing is single use; unknown devices, bad signatures, replays and other protocol versions are refused', async t => {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agent-chat-hub-')))
  t.after(() => fs.rmSync(base, { recursive: true, force: true }))
  const hubDir = path.join(base, 'hub')
  const { running, port } = await startHub(hubDir)
  t.after(() => running.close())
  const code = createInvite(hubDir, { address: `127.0.0.1:${port}` })
  const a = path.join(base, 'a'), b = path.join(base, 'b')
  fs.mkdirSync(a, { mode: 0o700 }); fs.mkdirSync(b, { mode: 0o700 })
  await pair(a, code, { name: 'a' })
  await assert.rejects(pair(b, code, { name: 'b' }), /unknown, used or expired/)
  const device = loadDevice(a)
  assert.ok((await deviceRequest(device, 'GET', '/v1/drain?cursor=0&wait=0')).head >= 0)

  const raw = (headers, pathname = '/v1/drain?cursor=0&wait=0') => new Promise((resolve, reject) => {
    const request = http.request({ host: '127.0.0.1', port, path: pathname, method: 'GET', headers }, response => { response.resume(); response.on('end', () => resolve(response.statusCode)) })
    request.on('error', reject); request.end()
  })
  const signed = (key, id, pathname = '/v1/drain?cursor=0&wait=0') => ({ [PROTOCOL_HEADER]: PROTOCOL, ...signHeaders(key, id, ({ time, nonce }) => requestBytes({ method: 'GET', path: pathname, time, nonce, body: '' })) })
  const stranger = privateKeyFrom(newKeyPair().privateKey)
  assert.equal(await raw(signed(stranger, 'd-000000000000')), 401, 'unknown device')
  assert.equal(await raw(signed(stranger, device.id)), 401, 'signature from another key')
  const once = signed(device.privateKey, device.id)
  assert.equal(await raw(once), 200)
  assert.equal(await raw(once), 401, 'replayed request')
  assert.equal(await raw({ ...signed(device.privateKey, device.id), [PROTOCOL_HEADER]: '0' }), 426, 'protocol mismatch')
  // A request target URL can't parse, and an oversized body, get answers, not a crash.
  assert.equal(await raw({}, '//'), 400)
  const big = await new Promise((resolve, reject) => {
    const request = http.request({ host: '127.0.0.1', port, path: '/v1/messages', method: 'POST', headers: { [PROTOCOL_HEADER]: PROTOCOL } }, response => { response.resume(); response.on('end', () => resolve(response.statusCode)) })
    request.on('error', reject); request.end('x'.repeat(1_100_000))
  })
  assert.equal(big, 413)
  assert.equal(await raw(signed(device.privateKey, device.id)), 200, 'still serving')
  const audit = fs.readFileSync(path.join(hubDir, 'audit.log'), 'utf8')
  assert.match(audit, /unknown\(d-000000000000\)/)
  assert.doesNotMatch(audit, /acinv1\./, 'no invite secrets in the audit log')
})

test('a shared room made on one device reaches the other, mail crosses both ways and wakes the idle side', { timeout: 30_000 }, async t => {
  const w = await world(t)
  const { mac, pc } = w.devices
  const made = await mac.service.call('create_room', { room: 'bridge', title: 'Bridge', shared: true })
  assert.deepEqual(made, { room: 'bridge', title: 'Bridge', shared: true })
  await until(() => pc.store.listRooms().find(row => row.room === 'bridge' && row.shared), 'the room on the pc')
  await join(mac, 'alice'); await join(pc, 'bob')
  await until(() => mac.store.remoteMembers('bridge').some(row => row.alias === 'bob' && row.device_name === 'pc' && row.joined), 'bob seen on the mac')

  const posted = await mac.service.call('post', { room: 'bridge', from: 'alice', to: 'bob', message: 'PING' })
  assert.equal(posted.delivery.find(row => row.agent === 'bob')?.device, 'pc')
  await until(() => pc.transport.some(frame => frame.agent === 'bob' && frame.texts.includes('PING')), 'bob woken on the pc')
  await until(() => !outbox(mac).length, 'mac outbox emptied on the hub ack')

  const inbox = await pc.service.call('inbox', { room: 'bridge', agent: 'bob' })
  assert.equal(inbox[0].message, 'PING'); assert.equal(inbox[0].from, 'alice')
  await pc.service.call('post', { room: 'bridge', from: 'bob', to: 'alice', message: 'PONG' })
  await until(() => mac.transport.some(frame => frame.agent === 'alice' && frame.texts.includes('PONG')), 'alice woken on the mac')
  // A broadcast crosses too, and waits in the inbox without waking, as a local one does.
  await pc.service.call('post', { room: 'bridge', from: 'bob', to: 'all', fyi: true, message: 'NOTE' })
  await until(async () => (await mac.service.call('inbox', { room: 'bridge', agent: 'alice' })).some(m => m.message === 'NOTE'), 'the broadcast in alice\'s inbox')
  assert.ok(!mac.transport.some(frame => frame.texts.includes('NOTE')))

  const members = await mac.service.call('members', { room: 'bridge' })
  assert.deepEqual(members.map(row => [row.name, row.device]).sort(), [['alice', 'mac'], ['bob', 'pc']])
  // Each message is in each device's log exactly once.
  for (const d of [mac, pc]) assert.deepEqual(d.store.history({ room: 'bridge' }).map(r => r.message), ['PING', 'PONG', 'NOTE'])
  // The pc's copy keeps no local unread entry for mail addressed to the mac's session.
  assert.ok(!JSON.stringify(pc.store.unreadReport()).includes('alice'))
})

test('the hub refuses a name another device holds in a shared room, and the join is undone', { timeout: 30_000 }, async t => {
  const w = await world(t)
  const { mac, pc } = w.devices
  await mac.service.call('create_room', { room: 'bridge', title: 'Bridge', shared: true })
  await until(() => pc.store.sharedRoom('bridge'), 'the room on the pc')
  await join(mac, 'alice')
  await assert.rejects(join(pc, 'alice'), /held in shared room bridge by a session on mac/)
  assert.ok(!pc.store.members({ room: 'bridge' }).some(row => row.agent === 'alice'))
  await assert.rejects(pc.service.call('create_room', { room: 'bridge', title: 'Again', shared: true }), /already exists/)
})

test('posts wait in the outbox while the hub is down and arrive once after it returns, across engine restarts', { timeout: 40_000 }, async t => {
  const w = await world(t)
  const { mac, pc } = w.devices
  await mac.service.call('create_room', { room: 'bridge', title: 'Bridge', shared: true })
  await until(() => pc.store.sharedRoom('bridge'), 'the room on the pc')
  await join(mac, 'alice'); await join(pc, 'bob')
  await until(() => mac.store.remoteMembers('bridge').some(row => row.alias === 'bob'), 'bob seen on the mac')

  await w.stopHub()
  await until(() => mac.sync.hubDown, 'the mac noticing the hub is gone')
  const posted = await mac.service.call('post', { room: 'bridge', from: 'alice', to: 'bob', message: 'while asleep' })
  assert.equal(posted.delivery.find(row => row.agent === 'bob')?.state, 'queued')
  assert.equal(outbox(mac).length, 1)
  // The mac's engine restarts while the hub is away: the outbox is on disk, not in memory.
  await mac.sync.stop()
  const again = w.own(createSync({ stateRoot: mac.stateRoot, chatRoot: mac.chatRoot, drainWaitS: 1, retryMs: 100 }))
  again.start(); await again.addProject(mac.store.projectRoot, mac.store)
  await w.restartHub()
  await until(() => pc.transport.some(frame => frame.texts.includes('while asleep')), 'the queued post on the pc', 20_000)
  await until(() => !outbox(mac).length, 'mac outbox emptied')
  // The pc's engine restarts from its stored cursor and imports nothing twice.
  await pc.sync.stop()
  const pcAgain = w.own(createSync({ stateRoot: pc.stateRoot, chatRoot: pc.chatRoot, drainWaitS: 1, retryMs: 100 }))
  pcAgain.start(); await pcAgain.addProject(pc.store.projectRoot, pc.store)
  await until(() => pcAgain.cursor > 0, 'pc engine running')
  await new Promise(resolve => setTimeout(resolve, 1500))
  assert.equal(pc.store.history({ room: 'bridge' }).filter(r => r.message === 'while asleep').length, 1)
})

test('red check: without the receiving engine nothing crosses, and a shared room needs a pairing', { timeout: 20_000 }, async t => {
  const w = await world(t)
  const { mac, pc } = w.devices
  await mac.service.call('create_room', { room: 'bridge', title: 'Bridge', shared: true })
  await until(() => pc.store.sharedRoom('bridge'), 'the room on the pc')
  await join(mac, 'alice'); await join(pc, 'bob')
  await until(() => mac.store.remoteMembers('bridge').some(row => row.alias === 'bob'), 'bob seen on the mac')
  await pc.sync.stop()
  await mac.service.call('post', { room: 'bridge', from: 'alice', to: 'bob', message: 'nobody pulls this' })
  await until(() => !outbox(mac).length, 'the hub storing it')
  await new Promise(resolve => setTimeout(resolve, 1500))
  assert.equal(pc.store.history({ room: 'bridge' }).length, 0)
  assert.equal(pc.transport.length, 0)

  const lone = await world(t, { syncOn: false })
  await assert.rejects(lone.devices.mac.service.call('create_room', { room: 'bridge', title: 'Bridge', shared: true }), /need this machine paired/)
  // Every file sync writes stays under the device's own state root.
  for (const name of ['mac', 'pc']) assert.ok(fs.existsSync(path.join(w.devices[name].stateRoot, 'sync', 'device.json')))
})

test('a tab open before its machine was paired picks the pairing up on its next shared-room call', async t => {
  const w = await world(t, { syncOn: false })
  const { mac, pc } = w.devices
  // Stands in for syncFor: nothing before the pairing, the engine after it.
  let paired = false, engine = null
  const find = () => paired ? (engine ??= w.own(createSync({ stateRoot: mac.stateRoot, chatRoot: mac.chatRoot, drainWaitS: 1, retryMs: 100 })), engine.start(), engine) : null
  const service = createService({ store: mac.store, sync: find, adapters: mac.adapters, env: {} })
  t.after(() => service.close())
  await assert.rejects(service.call('create_room', { room: 'late', title: 'Late', shared: true }), /need this machine paired/)
  paired = true
  assert.deepEqual(await service.call('create_room', { room: 'late', title: 'Late', shared: true }), { room: 'late', title: 'Late', shared: true })
  await until(() => mac.store.sharedRoom('late'), 'room made locally by the engine')
  // The other device's engine starts after the room exists and gets it from the hub.
  const pcEngine = w.own(createSync({ stateRoot: pc.stateRoot, chatRoot: pc.chatRoot, drainWaitS: 1, retryMs: 100 }))
  pcEngine.start(); await pcEngine.addProject(pc.store.projectRoot, pc.store)
  await until(() => pc.store.sharedRoom('late'), 'room reached the pc')
})
