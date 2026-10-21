import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { once } from 'node:events'
import { createNativeControl, validateControlSocket } from './native-control.mjs'
import { codexBinary } from './native-session.mjs'

const require = createRequire(import.meta.url)
// Pre-install review may inject an audited copy explicitly. Production never
// reads this test-only environment variable; normal tests use the locked copy.
// The release keeps node_modules beside the code; the plugin keeps it one folder up.
const dependency = process.env.AGENT_CHAT_TEST_WS || ['./node_modules/ws/index.js', '../node_modules/ws/index.js'].map(name => fileURLToPath(new URL(name, import.meta.url))).find(file => fs.existsSync(file)) || ''
if (!path.isAbsolute(dependency) || !fs.existsSync(dependency)) throw Error('Install the locked local ws dependency before running native tests')
const { WebSocket, WebSocketServer } = require(dependency)
const ID = '12345678-1234-1234-1234-123456789abc'

async function fixture(t, handler, { alias = true } = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(fs.realpathSync('/tmp'), 'ac-native-')))
  const home = path.join(root, 'home')
  const privateDir = path.join(root, 'private')
  const aliasParent = path.join(home, 'app-server-control')
  fs.mkdirSync(aliasParent, { recursive: true, mode: 0o700 })
  fs.mkdirSync(privateDir, { mode: 0o700 })
  const socketPath = path.join(alias ? privateDir : aliasParent, 'app-server-control.sock')
  const advertised = path.join(aliasParent, 'app-server-control.sock')
  const server = http.createServer()
  const wss = new WebSocketServer({ server, perMessageDeflate: false })
  const messages = []
  wss.on('connection', client => client.on('message', data => {
    const message = JSON.parse(data.toString())
    messages.push(message)
    handler(client, message)
  }))
  server.listen(socketPath)
  await once(server, 'listening')
  fs.chmodSync(socketPath, 0o600)
  if (alias) fs.symlinkSync(socketPath, advertised)
  t.after(async () => {
    for (const client of wss.clients) client.terminate()
    await new Promise(resolve => wss.close(resolve))
    await new Promise(resolve => server.close(resolve))
    fs.rmSync(root, { recursive: true, force: true })
  })
  const calls = []
  const executor = async (file, args, options) => {
    calls.push({ file, args, options })
    return { stdout: JSON.stringify({ status: 'running', socketPath: advertised, authToken: 'do-not-use' }) }
  }
  return {
    session: { id: ID, runtime: 'codex', profileHome: home },
    control: createNativeControl({ WebSocket, timeoutMs: 400, executor }),
    messages, calls, socketPath, advertised, home,
  }
}

function response(client, request, result) {
  if (request.id !== undefined) client.send(JSON.stringify({ id: request.id, result }))
}

function standard(client, request) {
  if (request.method === 'initialize') response(client, request, {})
  if (request.method === 'thread/loaded/list') response(client, request, { data: [ID], nextCursor: null })
  if (request.method === 'thread/read') response(client, request, { thread: { id: ID, cwd: '/project', turns: ['private'] } })
}

test('private UDS alias, initialize, loaded list, and metadata read use only allowed RPCs', async t => {
  const f = await fixture(t, standard)
  assert.equal(await f.control.loaded(f.session), true)
  assert.deepEqual(await f.control.read(f.session), { id: ID, cwd: '/project' })
  assert.deepEqual(f.messages.map(m => m.method), ['initialize', 'initialized', 'thread/loaded/list', 'initialize', 'initialized', 'thread/read'])
  assert.deepEqual(f.messages[2].params, {})
  assert.deepEqual(f.messages[5].params, { threadId: ID, includeTurns: false })
  assert.deepEqual(f.calls[0].args, ['app-server', 'daemon', 'version'])
  assert.equal(f.calls[0].options.env.CODEX_HOME, fs.realpathSync(f.home))
  assert.equal(f.calls[0].file, codexBinary(os.homedir(), { resolve: false }))
  assert.equal(validateControlSocket(f.home, f.advertised), f.socketPath)
})

test('direct socket is supported and absence is false', async t => {
  const f = await fixture(t, (client, request) => {
    response(client, request, request.method === 'initialize' ? {} : { data: [], nextCursor: null })
  }, { alias: false })
  assert.equal(await f.control.loaded(f.session), false)
})

test('unmatched replies and notifications do not fulfill the request', async t => {
  const f = await fixture(t, (client, request) => {
    client.send(JSON.stringify({ id: 999, result: { data: [ID] } }))
    client.send(JSON.stringify({ method: 'thread/status/changed', params: {} }))
    standard(client, request)
  })
  assert.equal(await f.control.loaded(f.session), true)
})

test('bounded RPC silence rejects and terminates its socket', async t => {
  const f = await fixture(t, () => {})
  const started = Date.now()
  await assert.rejects(f.control.loaded(f.session), /connection failed/)
  assert.ok(Date.now() - started < 1500)
})

test('errors, malformed responses, oversized frames, binary frames, and wrong thread metadata reject', async t => {
  for (const kind of ['error', 'json', 'oversized', 'binary', 'thread', 'pagination']) {
    await t.test(kind, async t => {
      const f = await fixture(t, (client, request) => {
        if (request.method === 'initialize') { response(client, request, {}); return }
        if (request.id === undefined) return
        if (kind === 'error') client.send(JSON.stringify({ id: request.id, error: { message: 'private detail' } }))
        if (kind === 'json') client.send('{')
        if (kind === 'oversized') client.send('x'.repeat(128 * 1024 + 1))
        if (kind === 'binary') client.send(Buffer.from('{}'))
        if (kind === 'thread') response(client, request, { thread: { id: 'wrong', cwd: '/project' } })
        if (kind === 'pagination') response(client, request, { data: [ID], nextCursor: 'opaque' })
      })
      await assert.rejects(kind === 'thread' ? f.control.read(f.session) : f.control.loaded(f.session))
    })
  }
})

test('only the owned profile alias and private socket are authorized', async t => {
  const f = await fixture(t, standard)
  for (const endpoint of ['ws://localhost:1234', f.socketPath, '/elsewhere.sock']) {
    assert.throws(() => validateControlSocket(f.home, endpoint), /Unexpected/)
  }
  fs.chmodSync(f.socketPath, 0o666)
  assert.throws(() => validateControlSocket(f.home, f.advertised), /not private/)
  fs.chmodSync(f.socketPath, 0o600)
  fs.chmodSync(path.dirname(f.advertised), 0o755)
  assert.throws(() => validateControlSocket(f.home, f.advertised), /not private/)
})

test('failed and unexpected daemon discovery cannot initiate a control connection', async t => {
  const f = await fixture(t, standard)
  for (const stdout of ['bad', '{}', JSON.stringify({ status: 'running', socketPath: 'ws://localhost:9999' })]) {
    const control = createNativeControl({ WebSocket, executor: async () => ({ stdout }) })
    await assert.rejects(control.loaded(f.session))
  }
  const failed = createNativeControl({ WebSocket, executor: async () => { throw new Error('private token') } })
  await assert.rejects(failed.loaded(f.session), { message: 'Native daemon unavailable' })
  assert.equal(f.messages.length, 0)
  await assert.rejects(f.control.loaded({ ...f.session, runtime: 'manual' }), /Invalid native session/)
})


test('discovery strips Claude messaging credentials and socket routing', async t => {
  const f = await fixture(t, standard)
  const previous = Object.fromEntries(['CLAUDE_CODE_MESSAGING_TOKEN', 'CLAUDE_CODE_MESSAGING_SOCKET'].map(key => [key, process.env[key]]))
  t.after(() => { for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  } })
  process.env.CLAUDE_CODE_MESSAGING_TOKEN = 'isolated-test-token'
  process.env.CLAUDE_CODE_MESSAGING_SOCKET = '/isolated/claude.sock'
  assert.equal(await f.control.loaded(f.session), true)
  assert.equal(Object.hasOwn(f.calls[0].options.env, 'CLAUDE_CODE_MESSAGING_TOKEN'), false)
  assert.equal(Object.hasOwn(f.calls[0].options.env, 'CLAUDE_CODE_MESSAGING_SOCKET'), false)
  assert.equal(f.calls[0].options.env.CODEX_HOME, f.home)
})

test('socket privacy is rechecked immediately before WebSocket construction', async t => {
  const f = await fixture(t, standard)
  const actualNow = Date.now
  let clockReads = 0, constructions = 0
  t.mock.method(Date, 'now', () => {
    if (++clockReads === 2) fs.chmodSync(f.socketPath, 0o666)
    return actualNow()
  })
  const control = createNativeControl({
    WebSocket: class { constructor() { constructions++ } },
    timeoutMs: 400,
    executor: async () => ({ stdout: JSON.stringify({ status: 'running', socketPath: f.advertised }) }),
  })
  await assert.rejects(control.loaded(f.session), /connection failed/)
  assert.equal(constructions, 0)
  assert.equal(f.messages.length, 0)
})


test('inspect uses one discovery and metadata-only reads to distinguish unloaded from gone', async t => {
  const f = await fixture(t, standard)
  assert.deepEqual(await f.control.inspect(f.session), { loaded: true, exists: true, cwd: '/project' })
  assert.equal(f.calls.length, 1)
  assert.deepEqual(f.messages.map(message => message.method), ['initialize', 'initialized', 'thread/loaded/list', 'thread/read'])
  const absent = await fixture(t, (client, request) => {
    if (request.method === 'thread/read') {
      client.send(JSON.stringify({ id: request.id, error: { code: -32600, message: `thread not loaded: ${ID}` } })); return
    }
    response(client, request, request.method === 'initialize' ? {} : { data: [], nextCursor: null })
  })
  assert.deepEqual(await absent.control.inspect(absent.session), { loaded: false, exists: false, cwd: null })
  assert.equal(absent.calls.length, 1)
  assert.deepEqual(absent.messages.map(message => message.method), ['initialize', 'initialized', 'thread/loaded/list', 'thread/read'])
})

test('production WebSocket resolution fails closed when the exact local dependency is missing', async t => {
  const f = await fixture(t, standard)
  const localEntry = dependency
  const actualRealpath = fs.realpathSync
  const inspected = []
  t.mock.method(fs, 'realpathSync', (entry, ...args) => {
    if (entry === localEntry) { inspected.push(entry); throw Object.assign(new Error('missing local dependency'), { code: 'ENOENT' }) }
    return actualRealpath(entry, ...args)
  })
  const control = createNativeControl({ executor: async () => ({ stdout: JSON.stringify({ status: 'running', socketPath: f.advertised }) }) })
  await assert.rejects(control.inspect(f.session), error => error.code === 'CHAT_NATIVE_WS_UNAVAILABLE')
  assert.deepEqual(inspected, [localEntry])
  assert.equal(f.messages.length, 0)
})


test('brief profile discovery cache never caches thread presence and expires without a timer', async t => {
  const f = await fixture(t, standard)
  let now = Date.now()
  t.mock.method(Date, 'now', () => now)
  assert.equal(await f.control.loaded(f.session), true)
  assert.deepEqual(await f.control.read(f.session), { id: ID, cwd: '/project' })
  assert.deepEqual(await f.control.inspect(f.session), { loaded: true, exists: true, cwd: '/project' })
  assert.equal(f.calls.length, 1)
  assert.equal(f.messages.filter(message => message.method === 'initialize').length, 3)
  assert.equal(f.messages.filter(message => message.method === 'thread/loaded/list').length, 2)
  now += 251
  assert.equal(await f.control.loaded(f.session), true)
  assert.equal(f.calls.length, 2)
  assert.equal(f.messages.filter(message => message.method === 'thread/loaded/list').length, 3)
})

test('profile turn inventory reads status only and excludes prompts and turns',async t=>{
 const f=await fixture(t,(client,request)=>{
  if(request.method==='initialize')response(client,request,{})
  if(request.method==='thread/loaded/list')response(client,request,{data:[ID],nextCursor:null})
  if(request.method==='thread/read')response(client,request,{thread:{id:ID,status:{type:'active',activeFlags:['waitingOnApproval']},turns:['private'],preview:'private'}})
 })
 assert.deepEqual(await f.control.profileThreads(f.home),[{id:ID,status:{type:'active'}}])
 assert.deepEqual(f.messages.map(m=>m.method),['initialize','initialized','thread/loaded/list','thread/read'])
 assert.deepEqual(f.messages.at(-1).params,{threadId:ID,includeTurns:false})
})
test('profile inventory fails closed on unknown status and paginated presence',async t=>{
 for(const kind of ['unknown','pagination'])await t.test(kind,async t=>{
  const f=await fixture(t,(client,request)=>{
   if(request.method==='initialize')response(client,request,{})
   if(request.method==='thread/loaded/list')response(client,request,{data:[ID],nextCursor:kind==='pagination'?'more':null})
   if(request.method==='thread/read')response(client,request,{thread:{id:ID,status:{type:'unverified'}}})
  })
  await assert.rejects(f.control.profileThreads(f.home),/Invalid/)
 })
})
test('a stopped daemon means no open tab: inspect reads not loaded, an unknown failure still throws',async t=>{
 const home=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'ac-stopped-inspect-'));t.after(()=>fs.rmSync(home,{recursive:true,force:true}))
 const session={runtime:'codex',id:ID,profileHome:home}
 const stopped=createNativeControl({executor:async()=>{throw Object.assign(Error('discovery'),{stderr:'Error: failed to connect\n\nCaused by:\n    No such file or directory (os error 2)\n'})}})
 assert.deepEqual(await stopped.inspect(session),{loaded:false,exists:null,cwd:null,stopped:true})
 const unknown=createNativeControl({executor:async()=>{throw Object.assign(Error('discovery'),{stderr:'Permission denied'})}})
 await assert.rejects(unknown.inspect(session),/unavailable/)
})
test('stopped profile requires exact ENOENT discovery and absent alias',async t=>{
 const home=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'ac-stopped-'));t.after(()=>fs.rmSync(home,{recursive:true,force:true}))
 const stopped=createNativeControl({executor:async()=>{throw Object.assign(Error('discovery'),{stderr:'Error: failed to connect\n\nCaused by:\n    No such file or directory (os error 2)\n'})}})
 assert.deepEqual(await stopped.profileThreads(home),[])
 const unknown=createNativeControl({executor:async()=>{throw Object.assign(Error('discovery'),{stderr:'Permission denied'})}})
 await assert.rejects(unknown.profileThreads(home),/unavailable/)
})


test('inspect finds persisted unloaded threads without a native load or subscription request', async t => {
  const f = await fixture(t, (client, request) => {
    if (request.method === 'thread/loaded/list') response(client, request, { data: [], nextCursor: null })
    else standard(client, request)
  })
  assert.deepEqual(await f.control.inspect(f.session), { loaded: false, exists: true, cwd: '/project' })
  assert.deepEqual(f.messages.map(message => message.method), ['initialize', 'initialized', 'thread/loaded/list', 'thread/read'])
  assert.deepEqual(f.messages.at(-1).params, { threadId: ID, includeTurns: false })
})

test('storage errors and another thread missing never count as positive absence', async t => {
  for (const error of [
    { code: -32603, message: `thread not loaded: ${ID}` },
    { code: -32600, message: 'thread not loaded: another-thread' },
    { code: -32603, message: 'failed to read thread: private path' },
    { code: -32600, message: 'Server is draining; retry after reconnecting' },
  ]) {
    const f = await fixture(t, (client, request) => {
      if (request.method === 'thread/read') client.send(JSON.stringify({ id: request.id, error }))
      else if (request.method === 'thread/loaded/list') response(client, request, { data: [], nextCursor: null })
      else standard(client, request)
    })
    await assert.rejects(f.control.inspect(f.session), rejected => rejected.code !== 'CHAT_NATIVE_THREAD_GONE' && rejected.message === 'Native control RPC failed')
  }
})
