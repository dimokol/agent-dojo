import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { spawn, spawnSync, execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import net from 'node:net'
import { parseHello, HELLO_ENV, startDaemon } from './daemon.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const daemonScript = path.join(here, 'daemon.mjs')
const hasCompiler = spawnSync('cc', ['--version'], { stdio: 'ignore' }).status === 0

test('hello: accepts the bridge fields and only the listed environment keys', () => {
  const ok = parseHello(JSON.stringify({ v: 1, pid: 4242, ppid: 4241, cwd: '/tmp', env: { CLAUDE_CODE_SESSION_ID: 'x', AGENT_CHAT_ROOT: '/r' } }))
  assert.deepEqual(ok, { proc: { pid: 4242, ppid: 4241, cwd: '/tmp' }, env: { CLAUDE_CODE_SESSION_ID: 'x', AGENT_CHAT_ROOT: '/r' } })
  for (const bad of [
    'not json', '{}', JSON.stringify({ v: 2, pid: 5, ppid: 4, cwd: '/tmp' }),
    JSON.stringify({ v: 1, pid: 1, ppid: 0, cwd: '/tmp' }), JSON.stringify({ v: 1, pid: 5, ppid: 4, cwd: 'relative' }),
    JSON.stringify({ v: 1, pid: 5, ppid: 4, cwd: '/tmp', env: { CLAUDE_CODE_MESSAGING_TOKEN: 'secret' } }),
    JSON.stringify({ v: 1, pid: 5, ppid: 4, cwd: '/tmp', env: { CLAUDE_CONFIG_DIR: 7 } }),
  ]) assert.equal(parseHello(bad), null, bad)
  assert.ok(!HELLO_ENV.includes('CLAUDE_CODE_MESSAGING_TOKEN'))
})

// Unix socket paths are limited to 104 bytes on macOS, so the fixture lives under /tmp.
function fixture() {
  const root = fs.mkdtempSync('/tmp/acd-')
  fs.chmodSync(root, 0o700)
  for (const name of ['state', 'chats', 'one', 'two']) fs.mkdirSync(path.join(root, name), { mode: 0o700 })
  for (const name of ['one', 'two']) execFileSync('git', ['init', '-q'], { cwd: path.join(root, name) })
  const bridge = path.join(root, 'agent-chat-bridge')
  execFileSync('cc', ['-O2', '-o', bridge, path.join(here, 'bridge.c')])
  const env = { PATH: process.env.PATH, HOME: process.env.HOME, AGENT_CHAT_ROOT: path.join(root, 'chats'), AGENT_CHAT_STATE_ROOT: path.join(root, 'state'), AGENT_CHAT_DAEMON_IDLE_MS: '1500' }
  const socket = path.join(root, 'state', 'd', 'x.sock')
  return { root, bridge, env, socket, cleanup: () => { daemons(root).forEach(pid => { try { process.kill(pid, 'SIGKILL') } catch {} }); fs.rmSync(root, { recursive: true, force: true }) } }
}
const daemons = root => {
  const out = spawnSync('/bin/ps', ['-axo', 'pid=,args='], { encoding: 'utf8' }).stdout
  return out.split('\n').filter(line => line.includes(daemonScript) && line.includes(root) && !line.includes('agent-chat-bridge')).map(line => Number(line.trim().split(/\s+/)[0]))
}

function client(fx, cwd, extraEnv = {}, script = daemonScript) {
  const child = spawn(fx.bridge, [fx.socket, process.execPath, script], { cwd, env: { ...fx.env, ...extraEnv }, stdio: ['pipe', 'pipe', 'pipe'] })
  let buffer = '', stderr = ''
  const waiting = new Map(), received = []
  child.stdout.on('data', chunk => {
    buffer += chunk
    let index
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index); buffer = buffer.slice(index + 1)
      if (!line.trim()) continue
      const message = JSON.parse(line)
      received.push(message)
      waiting.get(message.id)?.(message); waiting.delete(message.id)
    }
  })
  child.stderr.on('data', chunk => { stderr += chunk })
  let next = 1
  const request = (method, params = {}, id = next++) => new Promise(resolve => {
    waiting.set(id, resolve)
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
  })
  const exited = new Promise(resolve => child.on('exit', code => resolve(code)))
  return { child, request, received, exited, stderr: () => stderr, close: () => { child.stdin.end(); return exited } }
}
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

test('bridge and daemon: tabs in two projects share one daemon and each sees its own project', { skip: !hasCompiler && 'no C compiler' }, async () => {
  const fx = fixture()
  try {
    const one = client(fx, path.join(fx.root, 'one')), two = client(fx, path.join(fx.root, 'two'))
    const [a, b] = await Promise.all([one.request('initialize', { protocolVersion: '2025-06-18' }), two.request('initialize', { protocolVersion: '2025-06-18' })])
    assert.match(a.result.instructions, /^Project one\./)
    assert.match(b.result.instructions, /^Project two\./)
    assert.equal((await one.request('tools/list')).result.tools.length > 5, true)
    assert.deepEqual(await one.request('tools/call', { name: 'list_rooms', arguments: {} }), { jsonrpc: '2.0', id: 3, result: { content: [{ type: 'text', text: '[]' }] } })
    assert.equal(daemons(fx.root).length, 1)
    assert.equal(fs.statSync(fx.socket).mode & 0o777, 0o600)
    assert.equal(await one.close(), 0); assert.equal(await two.close(), 0)
    // The last connection gone, the daemon exits after its idle time and removes the socket.
    await sleep(2500)
    assert.equal(daemons(fx.root).length, 0)
    assert.equal(fs.existsSync(fx.socket), false)
  } finally { fx.cleanup() }
})

test('bridge and daemon: a killed daemon is replaced and the tab keeps working', { skip: !hasCompiler && 'no C compiler' }, async () => {
  const fx = fixture()
  try {
    const tab = client(fx, path.join(fx.root, 'one'))
    assert.deepEqual((await tab.request('ping')).result, {})
    const [first] = daemons(fx.root)
    process.kill(first, 'SIGKILL')
    await sleep(200)
    assert.deepEqual((await tab.request('ping')).result, {})
    const now = daemons(fx.root)
    assert.equal(now.length, 1); assert.notEqual(now[0], first)
    assert.equal(await tab.close(), 0)
  } finally { fx.cleanup() }
})

test('bridge and daemon: the tab environment reaches its service, and a start-up refusal reaches stderr', { skip: !hasCompiler && 'no C compiler' }, async () => {
  const fx = fixture()
  try {
    // A Claude session ID with no native parent: the service refuses with the native message,
    // which only happens when the tab's own environment reached it.
    const tab = client(fx, path.join(fx.root, 'one'), { CLAUDE_CODE_SESSION_ID: '00000000-0000-4000-8000-000000000000', CLAUDE_CODE_MESSAGING_SOCKET: '/tmp/none.sock' })
    const reply = await tab.request('tools/call', { name: 'join_room', arguments: { room: 'r1', agent: 'a1' } })
    assert.equal(reply.result.isError, true)
    assert.match(reply.result.content[0].text, /^Native Claude session not recognised/)
    await tab.close()
    // A legacy override fails this tab's start, as it fails server.mjs, and the text says why.
    const legacy = client(fx, path.join(fx.root, 'one'), { AGENT_CHAT_PROJECT: 'old' })
    assert.equal(await legacy.exited, 1)
    assert.match(legacy.stderr(), /Agent-chat 2 has no AGENT_CHAT_PROJECT/)
  } finally { fx.cleanup() }
})

test('daemon: a connection reset by a killed bridge still closes its service', async () => {
  const root = fs.mkdtempSync('/tmp/acd-'); fs.chmodSync(root, 0o700)
  for (const name of ['state', 'chats', 'proj']) fs.mkdirSync(path.join(root, name), { mode: 0o700 })
  execFileSync('git', ['init', '-q'], { cwd: path.join(root, 'proj') })
  const socketPath = path.join(root, 'state', 'd', 'x.sock')
  const daemon = startDaemon(socketPath, { idleMs: 60_000, exit: () => {} }), sockets = []
  try {
    await new Promise(resolve => daemon.server.once('listening', resolve))
    const serverSide = []
    daemon.server.on('connection', socket => serverSide.push(socket))
    const hello = JSON.stringify({ v: 1, pid: process.pid, ppid: process.ppid, cwd: path.join(root, 'proj'), env: { AGENT_CHAT_ROOT: path.join(root, 'chats'), AGENT_CHAT_STATE_ROOT: path.join(root, 'state') } })
    const open = async () => {
      const socket = await new Promise(resolve => { const c = net.createConnection(socketPath, () => resolve(c)) })
      sockets.push(socket)
      let buffer = ''; const replies = []; let wake = null
      socket.on('data', chunk => { buffer += chunk; let i; while ((i = buffer.indexOf('\n')) >= 0) { replies.push(JSON.parse(buffer.slice(0, i))); buffer = buffer.slice(i + 1); wake?.() } })
      const next = () => replies.length ? Promise.resolve(replies.shift()) : new Promise(resolve => { wake = () => { wake = null; resolve(replies.shift()) } })
      socket.write(hello + '\n')
      assert.deepEqual(await next(), { ok: true })
      const call = (id, name, args) => { socket.write(JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } }) + '\n'); return next() }
      return { socket, call }
    }
    const first = await open()
    await first.call(0, 'create_room', { room: 'r', title: 'r' })
    const joined = await first.call(1, 'join_room', { room: 'r', agent: 'm1', session: { id: '11111111-1111-4111-8111-111111111111', runtime: 'manual' } })
    assert.equal(joined.result.isError, undefined, JSON.stringify(joined))
    // A reset (a killed bridge, ECONNRESET) destroys the daemon's side with an error and no end:
    // readline never reports it, only the socket's close does.
    serverSide[0].destroy(Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }))
    await sleep(300)
    const second = await open()
    const members = JSON.parse((await second.call(2, 'members', { room: 'r' })).result.content[0].text)
    assert.equal(members.find(row => row.name === 'm1').joined, false)
    second.socket.end()
  } finally { sockets.forEach(socket => socket.destroy()); daemon.stop('test'); fs.rmSync(root, { recursive: true, force: true }) }
})

// A stand-in daemon: answers ping, and exits without answering a call named crash.
const CRASHING_DAEMON = `
import net from 'node:net'; import fs from 'node:fs'; import path from 'node:path'; import readline from 'node:readline'
const socketPath = process.argv[2]
fs.mkdirSync(path.dirname(socketPath), { recursive: true, mode: 0o700 }); fs.rmSync(socketPath, { force: true })
net.createServer(socket => {
  let hello = true
  readline.createInterface({ input: socket }).on('line', line => {
    if (hello) { hello = false; return socket.write('{"ok":true}\\n') }
    const message = JSON.parse(line)
    if (message.method === 'crash') process.exit(1)
    if (message.id !== undefined) socket.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: {} }) + '\\n')
  })
}).listen(socketPath)
`

test('bridge: a call the daemon never answered because it died gets an error, and only that call', { skip: !hasCompiler && 'no C compiler' }, async () => {
  const fx = fixture()
  const script = path.join(fx.root, 'crashing-daemon.mjs')
  fs.writeFileSync(script, CRASHING_DAEMON)
  try {
    const tab = client(fx, path.join(fx.root, 'one'), {}, script)
    assert.deepEqual((await tab.request('ping')).result, {})
    // The id is a string with an escaped quote, and the params carry ids of their own.
    const lost = await tab.request('crash', { id: 99, session: { id: 'x' } }, 'a"b')
    assert.equal(lost.id, 'a"b')
    assert.equal(lost.error.code, -32603)
    assert.match(lost.error.message, /restarted before answering/)
    assert.deepEqual((await tab.request('ping', {}, 7)).result, {})
    assert.equal(tab.received.filter(message => message.error).length, 1)
    assert.equal(await tab.close(), 0)
  } finally { fx.cleanup() }
})

test('hook wake settings pass from the tab to the daemon, and bridge-core.h lists the same keys', () => {
  const env = { AGENT_CHAT_WAKE: 'hook', AGENT_CHAT_WAKE_DIR: '/w' }
  assert.deepEqual(parseHello(JSON.stringify({ v: 1, pid: 4242, ppid: 4241, cwd: '/tmp', env })).env, env)
  const listed = /HELLO_ENV\[\] = \{([^}]*)\}/.exec(fs.readFileSync(new URL('./bridge-core.h', import.meta.url), 'utf8'))[1]
  assert.deepEqual([...listed.matchAll(/"([A-Z_]+)"/g)].map(m => m[1]), HELLO_ENV)
})
