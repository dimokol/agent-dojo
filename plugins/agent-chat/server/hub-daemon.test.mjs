// The hub through the real shared daemon and bridge: two devices on one Mac (two state roots, two
// daemons), paired with one hub. Proves the daemon starts sync for a paired state root and that a
// shared room and its mail cross between the two daemons.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { spawn, spawnSync, execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { socketOnly } from './test-platform.mjs'
import { serveHub, createInvite } from './hub.mjs'
import { pair } from './device.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const daemonScript = path.join(here, 'daemon.mjs')
const hasCompiler = spawnSync('cc', ['--version'], { stdio: 'ignore' }).status === 0
const skip = socketOnly.skip || (!hasCompiler && 'no C compiler')

function client(bridge, socket, cwd, env) {
  const child = spawn(bridge, [socket, process.execPath, daemonScript], { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] })
  let buffer = '', next = 1
  const waiting = new Map()
  child.stdout.on('data', chunk => {
    buffer += chunk
    let index
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index); buffer = buffer.slice(index + 1)
      if (!line.trim()) continue
      const message = JSON.parse(line)
      waiting.get(message.id)?.(message); waiting.delete(message.id)
    }
  })
  const request = (method, params = {}) => new Promise(resolve => { const id = next++; waiting.set(id, resolve); child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n') })
  const call = async (name, args) => {
    const answer = await request('tools/call', { name, arguments: args })
    const text = answer.result?.content?.[0]?.text
    if (answer.result?.isError) throw new Error(text)
    return JSON.parse(text)
  }
  return { child, request, call, close: () => { child.stdin.end(); return new Promise(resolve => child.on('exit', resolve)) } }
}
const until = async (check, what, ms = 15_000) => {
  const end = Date.now() + ms
  for (;;) { const value = await check(); if (value) return value; if (Date.now() > end) throw new Error(`timed out waiting for ${what}`); await new Promise(r => setTimeout(r, 100)) }
}

test('two daemons on one Mac, each its own device, share a room through the hub', { skip, timeout: 60_000 }, async t => {
  // Unix socket paths are limited to 104 bytes on macOS, so the fixture lives under /tmp.
  const root = fs.mkdtempSync('/tmp/ach-')
  fs.chmodSync(root, 0o700)
  const bridge = path.join(root, 'agent-chat-bridge')
  execFileSync('cc', ['-O2', '-o', bridge, path.join(here, 'bridge.c')])
  const hubDir = path.join(root, 'hub')
  const hub = serveHub({ dir: hubDir, listen: [{ host: '127.0.0.1', port: 0 }] })
  const [{ port }] = await hub.ready
  const clients = []
  t.after(async () => {
    for (const c of clients) await c.close()
    await hub.close()
    const out = spawnSync('/bin/ps', ['-axo', 'pid=,args='], { encoding: 'utf8' }).stdout
    for (const line of out.split('\n')) if (line.includes(daemonScript) && line.includes(root)) try { process.kill(Number(line.trim().split(/\s+/)[0]), 'SIGKILL') } catch {}
    fs.rmSync(root, { recursive: true, force: true })
  })
  const device = {}
  for (const name of ['a', 'b']) {
    const dir = path.join(root, name), project = path.join(dir, 'project'), state = path.join(dir, 'state'), chats = path.join(dir, 'chats')
    for (const folder of [dir, project, state, chats]) fs.mkdirSync(folder, { mode: 0o700 })
    execFileSync('git', ['init', '-q'], { cwd: project })
    execFileSync('git', ['remote', 'add', 'origin', name === 'a' ? 'git@example.com:team/proj.git' : 'https://example.com/team/proj'], { cwd: project })
    await pair(state, createInvite(hubDir, { address: `127.0.0.1:${port}` }), { name })
    const env = { PATH: process.env.PATH, HOME: process.env.HOME, AGENT_CHAT_ROOT: chats, AGENT_CHAT_STATE_ROOT: state, AGENT_CHAT_DAEMON_IDLE_MS: '1500' }
    const c = client(bridge, path.join(state, 'd', 'x.sock'), project, env)
    clients.push(c)
    await c.request('initialize', { protocolVersion: '2025-06-18' })
    device[name] = c
  }
  const { a, b } = device
  assert.deepEqual(await a.call('create_room', { room: 'bridge', title: 'Bridge', shared: true }), { room: 'bridge', title: 'Bridge', shared: true })
  await until(async () => (await b.call('list_rooms', {})).some(row => row.room === 'bridge' && row.shared), 'the room on b')
  await a.call('join_room', { room: 'bridge', agent: 'alice', session: { id: 'alice-1', runtime: 'manual' } })
  await b.call('join_room', { room: 'bridge', agent: 'bob', session: { id: 'bob-1', runtime: 'manual' } })
  await until(async () => (await a.call('members', { room: 'bridge' })).some(row => row.name === 'bob' && row.device === 'b'), 'bob on a')
  await a.call('post', { room: 'bridge', from: 'alice', to: 'bob', message: 'PING' })
  const got = await until(async () => (await b.call('inbox', { room: 'bridge', agent: 'bob' })).find(m => m.message === 'PING'), 'PING on b')
  assert.equal(got.from, 'alice')
  await assert.rejects(b.call('join_room', { room: 'bridge', agent: 'alice', session: { id: 'alice-2', runtime: 'manual' } }), /held in shared room bridge by a session on a/)
})
