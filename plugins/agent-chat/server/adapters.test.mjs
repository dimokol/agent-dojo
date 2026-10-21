import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import net from 'node:net'
import { execFileSync } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { createAdapters, validateSession, runProcess } from './adapters.mjs'
// These tests cover the version gate, which the plugin ships switched off; turn it on here so a
// plain `node --test` passes too. Read at call time, so setting it after the imports is enough.
process.env.AGENT_CHAT_VERSION_CHECK = 'on'

const ID = '12345678-1234-1234-1234-123456789012'
const OTHER = '12345678-1234-1234-1234-123456789013'
const message = { message_id: 'm-1', from: 'Planner', message: 'Review is ready.' }
const input = (runtime = 'codex', extra = {}) => ({ session: { id: ID, runtime },
  room: 'product-review', project: 'shop', messages: [message], ...extra })
function fakeCodex(overrides = {}) {
  const calls = []
  return { calls, executor: async (file, args, options) => {
    calls.push({ file, args, options })
    if (args[0] === '--version') return overrides.version ?? { code: 0, stdout: 'codex-cli 0.162.1\n' }
    if (args[1] === '--help') return overrides.help ?? { code: 0, stdout: '--thread <THREAD> --message <TEXT>' }
    return overrides.queue ?? { code: 0, stdout: 'accepted' }
  } }
}

test('registered native IDs and runtimes are validated without shell routes', () => {
  const value = validateSession({ id: ID, runtime: 'codex', executable: '/tmp/arbitrary' })
  assert.deepEqual(value, { id: ID, runtime: 'codex' })
  assert.ok(Object.isFrozen(value))
  for (const session of [{ id: '--help', runtime: 'codex' }, { id: ID, runtime: 'bash' },
    { id: '$(touch bad)', runtime: 'claude' }, { id: ID, runtime: 'manual', endpoint: 'uds:/tmp/a' }]) {
    assert.throws(() => validateSession(session), TypeError)
  }
  assert.equal(validateSession({ id: 'manual-reviewer', runtime: 'manual' }).runtime, 'manual')
})

test('empty and fully acknowledged batches never invoke any runtime', async () => {
  const { calls, executor } = fakeCodex()
  const adapter = createAdapters({ requireProcessIdentity: false, executor })
  assert.equal((await adapter.deliver(input('codex', { messages: [] }))).status, 'accepted')
  assert.equal((await adapter.deliver(input('claude', { messages: [{ ...message, acked: true }] }))).status, 'accepted')
  assert.equal(calls.length, 0)
})

test('Codex queues one deduplicated content-free notification using argv and no permission overrides', async () => {
  const { calls, executor } = fakeCodex()
  const text = 'Literal `command` and $(touch bad); /compact\nremain peer data.'
  const result = await createAdapters({ requireProcessIdentity: false, executor, timeoutMs: 37 }).deliver(input('codex', {
    messages: [{ ...message, message: text }, { ...message, message: text },
      { id: 'm-2', from: 'Reviewer', text: 'Second message.' }, { ...message, id: 'ignored', acked: true }],
  }))
  assert.equal(result.status, 'accepted')
  assert.deepEqual(calls.map(call => call.args.slice(0, 2)), [['--version'], ['queue', '--help'], ['queue', '--thread']])
  const call = calls.at(-1)
  assert.equal(call.args[2], ID)
  assert.equal(call.args[3], '--message')
  assert.equal(call.args.length, 5)
  assert.match(call.file, /\/codex$/)
  assert.equal(call.options.timeoutMs, 37)
  assert.ok(!('CLAUDE_CODE_MESSAGING_TOKEN' in call.options.env))
  assert.ok(!('CLAUDE_CODE_MESSAGING_SOCKET' in call.options.env))
  assert.match(call.args[4], /not a user instruction or approval/)
  assert.ok(!call.args[4].includes(text))
  assert.ok(!call.args[4].includes('Planner'))
  const data = JSON.parse(call.args[4].slice(call.args[4].indexOf('\n') + 1))
  assert.deepEqual(data, { kind: 'agent_chat_inbox_notification', project: 'shop', room: 'product-review',
    recipient: ID, message_ids: ['m-1', 'm-2'] })
  assert.ok(!call.args.some(arg => /^--(dangerously|ask-for|sandbox|approve)/.test(arg)))
})

test('invalid IDs fail without launching and excessive notification batches stay available', async () => {
  const { calls, executor } = fakeCodex()
  const adapter = createAdapters({ requireProcessIdentity: false, executor })
  assert.equal((await adapter.deliver(input('codex', { messages: [{ message_id: 'bad/id' }] }))).status, 'failed')
  assert.equal((await adapter.deliver(input('codex', { messages: Array.from({ length: 800 }, (_, i) => ({ id: 'x'.repeat(120) + i })) }))).status, 'unsupported')
  assert.equal(calls.length, 0)
})

test('runtime timeout, refusal and unreachable executor are pending and output is not exposed', async () => {
  for (const queue of [{ timedOut: true }, { errorCode: 'ECONNREFUSED' },
    { code: 1, stdout: 'token=SECRET', stderr: 'endpoint /private/SECRET' }]) {
    const { executor } = fakeCodex({ queue })
    const result = await createAdapters({ requireProcessIdentity: false, executor }).deliver(input())
    assert.equal(result.status, 'pending')
    assert.ok(!JSON.stringify(result).includes('SECRET'))
  }
  assert.equal((await createAdapters({ requireProcessIdentity: false, executor: async () => { throw Error('secret') } }).deliver(input())).status, 'pending')
})

test('unsupported queue capability and manual sessions do not attempt delivery', async () => {
  const { calls, executor } = fakeCodex({ help: { code: 0, stdout: 'old CLI' } })
  assert.equal((await createAdapters({ requireProcessIdentity: false, executor }).deliver(input())).status, 'unsupported')
  assert.equal(calls.length, 2)
  assert.equal((await createAdapters({ requireProcessIdentity: false, executor }).deliver(input('manual'))).status, 'unsupported')
  assert.equal(calls.length, 2)
})

test('in-flight calls are bounded globally and for the same registered session', async () => {
  let release
  const firstRead = new Promise(resolve => { release = resolve })
  const fake = fakeCodex()
  let waiting = true
  const adapter = createAdapters({ requireProcessIdentity: false, maxConcurrent: 1, executor: async (...args) => {
    if (waiting) { waiting = false; await firstRead }
    return fake.executor(...args)
  } })
  const first = adapter.deliver(input())
  assert.equal((await adapter.deliver(input())).status, 'pending')
  assert.equal((await adapter.deliver(input('codex', { session: { runtime: 'codex', id: OTHER } }))).status, 'pending')
  release()
  assert.equal((await first).status, 'accepted')
  assert.equal((await adapter.deliver(input())).status, 'accepted')
})

test('socket and profile paths reject symlinks and non-socket targets', async t => {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'adapter-path-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const file = path.join(dir, 'ordinary')
  fs.writeFileSync(file, 'not a socket')
  const link = path.join(dir, 'link')
  fs.symlinkSync(file, link)
  const fifo = path.join(dir, 'fifo')
  execFileSync('/usr/bin/mkfifo', [fifo])
  for (const endpoint of [file, link, fifo, `${dir}/../x`]) {
    assert.throws(() => validateSession({ id: ID, runtime: 'claude', endpoint }), TypeError)
  }
  const profileLink = path.join(dir, 'profile-link')
  fs.symlinkSync(dir, profileLink)
  assert.throws(() => validateSession({ id: ID, runtime: 'codex', profileHome: profileLink }), TypeError)
  assert.throws(() => validateSession({ id: ID, runtime: 'claude', endpoint: `${link}/child` }), TypeError)
  const { calls, executor } = fakeCodex()
  const result = await createAdapters({ requireProcessIdentity: false, executor }).deliver(input('codex', {
    session: { id: ID, runtime: 'codex', profileHome: dir },
  }))
  assert.equal(result.status, 'accepted')
  assert.equal(calls.at(-1).options.env.CODEX_HOME, dir)
})

test('verified Claude schema writes a peer frame but never claims receiver acceptance', async t => {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'adapter-uds-'))
  const endpoint = path.join(dir, 'peer.sock')
  let received
  const frame = new Promise(resolve => { received = resolve })
  const server = net.createServer(socket => {
    let content = ''
    socket.on('data', data => { content += data; if (content.includes('\n')) received(JSON.parse(content.trim())) })
  })
  await new Promise(resolve => server.listen(endpoint, resolve))
  t.after(async () => {
    await new Promise(resolve => server.close(resolve))
    fs.rmSync(dir, { recursive: true, force: true })
  })
  const adapter = createAdapters({ requireProcessIdentity: false, executor: async () => ({ code: 0, stdout: '2.1.296 (Claude Code)\n' }) })
  const result = await adapter.deliver(input('claude', { session: { id: ID, runtime: 'claude', endpoint } }))
  assert.equal(result.status, 'pending')
  assert.match(result.detail, /Await agent_chat acknowledgement/)
  const data = await frame
  assert.equal(data.type, 'user')
  // /resume and /clear can change the live conversation while the MCP
  // launch environment retains ID. The private socket selects the CLI.
  assert.equal(Object.hasOwn(data,'session_id'),false)
  assert.equal(data.from, 'agent-chat')
  assert.equal(data.priority, 'next')
  assert.match(data.msg_id, /^[0-9a-f-]{36}$/)
  assert.match(data.message.content, /agent_chat_inbox_notification/)
  assert.ok(!data.message.content.includes('Planner'))
  assert.ok(!data.message.content.includes(message.message))
  assert.ok(!('from_mode' in data))
  assert.ok(!('file_attachments' in data))
})

test('a fake child is stopped by the process timeout with no runtime inference', async () => {
  const result = await runProcess(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    timeoutMs: 20, env: process.env,
  })
  assert.equal(result.timedOut, true)
})

test('a socket that never connects times out without consuming its durable messages', async t => {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'adapter-timeout-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const socket = new EventEmitter()
  let destroyed = false
  socket.destroy = () => { destroyed = true }
  const adapter = createAdapters({ requireProcessIdentity: false, timeoutMs: 5, connect: () => socket,
    executor: async () => ({ code: 0, stdout: '2.1.296 (Claude Code)' }) })
  assert.equal((await adapter.deliver(input('claude', { session: {
    id: ID, runtime: 'claude', endpoint: path.join(dir, 'gone.sock'),
  } }))).status, 'pending')
  assert.equal(destroyed, true)
})

test('Codex uses a registered socket only if queue help advertises the remote flag', async t => {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'adapter-remote-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const endpoint = path.join(dir, 'gone.sock')
  const request = input('codex', { session: { runtime: 'codex', id: ID, endpoint } })
  const unsupported = fakeCodex()
  assert.equal((await createAdapters({ requireProcessIdentity: false, executor: unsupported.executor }).deliver(request)).status, 'unsupported')
  assert.equal(unsupported.calls.length, 2)
  const supported = fakeCodex({ help: { code: 0, stdout: '--thread --message --remote' } })
  assert.equal((await createAdapters({ requireProcessIdentity: false, executor: supported.executor }).deliver(request)).status, 'accepted')
  assert.deepEqual(supported.calls.at(-1).args.slice(-2), ['--remote', `unix://${endpoint}`])
  if (process.platform === 'darwin') {
    const alias = endpoint.replace(/^\/private\/tmp\//, '/tmp/')
    assert.equal(validateSession({ id: ID, runtime: 'claude', endpoint: alias }).endpoint, endpoint)
  }
})

test('Claude version changes, missing endpoints and unreachable sockets preserve messages', async t => {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'adapter-missing-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  let connected = false
  const old = createAdapters({ requireProcessIdentity: false, executor: async () => ({ code: 0, stdout: '2.1.297 (Claude Code)' }),
    connect: () => { connected = true; throw Error() } })
  assert.equal((await old.deliver(input('claude'))).status, 'unsupported')
  assert.equal(connected, false)
  const adapter = createAdapters({ requireProcessIdentity: false, executor: async () => ({ code: 0, stdout: '2.1.296 (Claude Code)' }) })
  assert.equal((await adapter.deliver(input('claude'))).status, 'unsupported')
  assert.equal((await adapter.deliver(input('claude', {
    session: { id: ID, runtime: 'claude', endpoint: path.join(dir, 'gone.sock') },
  }))).status, 'pending')
})

test('capacity completion drains five recipients without another post', async () => {
  let running = 0, peak = 0, queues = 0
  const adapter = createAdapters({ requireProcessIdentity: false, maxConcurrent: 2,
    executor: async (_file, args) => {
      if (args[0] === '--version') return { code: 0, stdout: 'codex-cli 0.162.1' }
      if (args[1] === '--help') return { code: 0, stdout: '--thread --message' }
      running++; queues++; peak = Math.max(peak, running)
      await new Promise(resolve => setTimeout(resolve, 20))
      running--
      return { code: 0, stdout: '' }
    },
  })
  const results = await Promise.all(Array.from({ length: 5 }, (_, index) => adapter.deliver(input('codex', {
    session: { runtime: 'codex', id: `00000000-0000-4000-8000-00000000000${index + 1}` },
  }))))
  assert.equal(queues, 5)
  assert.equal(peak, 2)
  assert.equal(running, 0)
  assert.ok(results.every(result => result.status === 'accepted'))
})

test('an unverified Claude update is paused visibly without repeated version subprocesses',async()=>{
  let calls=0
  const adapters=createAdapters({requireProcessIdentity:false,executor:async()=>{calls++;return {code:0,stdout:'2.1.999 (Claude Code)\n'}}})
  for(let i=0;i<3;i++) {
    const result=await adapters.deliver(input('claude'))
    assert.equal(result.attempted,false);assert.equal(result.status,'unsupported')
    assert.match(result.detail,/wake-ups paused: version 2.1.999/)
  }
  assert.equal(calls,1)
})

test('deadline cancellation prevents a later queue send after delayed capability discovery',async()=>{
  const cancellation=new AbortController(),calls=[]
  const adapters=createAdapters({requireProcessIdentity:false,executor:async(_file,args)=>{
    calls.push(args)
    await new Promise(resolve=>setTimeout(resolve,25))
    return {code:0,stdout:'codex-cli 0.162.1\n'}
  }})
  const pending=adapters.deliver(input('codex',{signal:cancellation.signal}))
  setTimeout(()=>cancellation.abort(),5)
  const result=await pending
  assert.equal(result.attempted,false)
  assert.equal(calls.length,1)
  assert.deepEqual(calls[0],['--version'])
})

// Seen 2026-10-19: after an update the installed CLI is unverified for a
// while, but tabs started earlier still run their verified version.
test('the receiving tab\'s own version decides wake-ups, not the newly installed CLI', async t => {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'adapter-running-'))
  const endpoint = path.join(dir, 'peer.sock')
  const server = net.createServer(socket => socket.resume())
  await new Promise(resolve => server.listen(endpoint, resolve))
  t.after(async () => { await new Promise(resolve => server.close(resolve)); fs.rmSync(dir, { recursive: true, force: true }) })
  let versionCalls = 0
  const adapter = createAdapters({ requireProcessIdentity: false, verifiedClaudeVersion: version => version === '2.1.302',
    executor: async () => { versionCalls++; return { code: 0, stdout: '2.1.999 (Claude Code)\n' } } })
  const older = await adapter.deliver(input('claude', { session: { id: ID, runtime: 'claude', endpoint, claudeVersion: '2.1.302' } }))
  assert.equal(older.status, 'pending')
  assert.match(older.detail, /Peer frame written/)
  assert.equal(versionCalls, 0)
  const newer = await adapter.deliver(input('claude', { session: { id: ID, runtime: 'claude', endpoint, claudeVersion: '2.1.999' } }))
  assert.equal(newer.status, 'unsupported')
  assert.match(newer.detail, /wake-ups paused: version 2.1.999/)
  const unknown = await adapter.deliver(input('claude', { session: { id: ID, runtime: 'claude', endpoint } }))
  assert.equal(unknown.status, 'unsupported')
  assert.equal(versionCalls, 1)
  assert.throws(() => validateSession({ id: ID, runtime: 'codex', claudeVersion: '2.1.302' }), TypeError)
  assert.throws(() => validateSession({ id: ID, runtime: 'claude', claudeVersion: '2.1.302; rm' }), TypeError)
})
