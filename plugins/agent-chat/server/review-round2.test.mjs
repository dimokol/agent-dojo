import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawn, execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { createStore } from './store.mjs'
import { createService } from './server.mjs'
import { createController } from './controller.mjs'
import { createAdapters, validateSession } from './adapters.mjs'
import { inferNativeSession, processIdentity, runningClaudeVersion } from './native-session.mjs'
import { projectNoticeId } from './notices.mjs'

// The second round of review on PR #6: each test fails without its fix.
const SERVER = fileURLToPath(new URL('./server.mjs', import.meta.url))
const HOOK = fileURLToPath(new URL('./claude-session-hook.mjs', import.meta.url))
const UUID = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`

function temp(t, tag) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `agent-chat-${tag}-`)))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  return dir
}
async function sleeper(t) {
  const child = spawn('sleep', ['60'], { stdio: 'ignore' })
  t.after(() => child.kill())
  for (let i = 0; i < 50 && !processIdentity(child.pid); i++) await new Promise(resolve => setTimeout(resolve, 20))
  return processIdentity(child.pid)
}
const quiet = { async deliver() { return { attempted: false, status: 'pending' } } }

test('R1: a tab running a prerelease Claude build still makes a valid session', () => {
  const claudeVersion = runningClaudeVersion(path.join(os.homedir(), '.local/share/claude/versions/2.1.300-beta'))
  assert.doesNotThrow(() => validateSession({ runtime: 'claude', id: UUID(1), ...(claudeVersion ? { claudeVersion } : {}) }))
})

test('R2: a log that is briefly missing does not bring received mail back', t => {
  const dir = temp(t, 'r2'), project = path.join(dir, 'repo'); fs.mkdirSync(project)
  let clock = Date.now()
  const store = createStore({ root: path.join(dir, 'chats'), projectRoot: project, now: () => clock })
  const as = id => ({ id, runtime: 'test', endpoint: 'test-only' })
  store.createRoom({ room: 'r', title: 'r' })
  store.join({ room: 'r', agent: 'alice', session: as('a') }); store.join({ room: 'r', agent: 'bob', session: as('b') })
  for (let i = 0; i < 3; i++) store.post({ room: 'r', from: 'alice', to: i === 2 ? 'all' : 'bob', message: `old ${i}`, sessionId: 'a' })
  const ids = store.pending({ room: 'r', agent: 'bob', sessionId: 'b' }).map(message => message.id)
  store.updateDelivery({ room: 'r', agent: 'bob', sessionId: 'b', message_ids: ids, status: 'received' })
  clock += 40 * 86400000
  store.post({ room: 'r', from: 'bob', to: 'alice', message: 'tick', sessionId: 'b' })
  const log = path.join(store.dir, 'rooms/r/chat.jsonl')
  fs.renameSync(log, log + '.away'); store.listRooms(); fs.renameSync(log + '.away', log)
  assert.deepEqual(store.pending({ room: 'r', agent: 'bob', sessionId: 'b' }), [])
})

test('R3: with no lsof installed a session is not native, and the chat still works', () => {
  const dir = fs.realpathSync(os.tmpdir())
  const env = { CLAUDE_CODE_SESSION_ID: UUID(1), CLAUDE_CODE_MESSAGING_SOCKET: '/private/tmp/x.sock', CLAUDE_CONFIG_DIR: dir }
  assert.equal(inferNativeSession(undefined, env, { getCommand: () => 'claude', getExecutable: () => null, hasLsof: () => false }), null)
})

test('R4: a post from the second tab does not take the rooms from a live first tab', async t => {
  const dir = temp(t, 'r4'), profile = path.join(dir, 'profile'); fs.mkdirSync(profile, { mode: 0o700 })
  const [clientA, serverA, clientB] = [await sleeper(t), await sleeper(t), await sleeper(t)], self = processIdentity(process.pid)
  const tab = (n, client, server) => ({ runtime: 'claude', id: UUID(n), profileHome: profile, endpoint: `/private/tab${n}.sock`,
    clientPid: client.pid, clientStart: client.start, serverPid: server.pid, serverStart: server.start })
  const options = { root: path.join(dir, 'chats'), stateRoot: path.join(dir, 'state'), projectRoot: dir }
  createStore(options).createRoom({ room: 'room', title: 'room' })
  const service = session => createService({ store: createStore(options), env: {}, adapters: quiet, inferSession: () => session, resolveConversation: () => UUID(99), claudeVerified: () => true })
  const a = service(tab(1, clientA, serverA)), b = service(tab(2, clientB, self))
  try {
    await a.call('join_room', { room: 'room', agent: 'PM' })
    await assert.rejects(b.call('post', { room: 'room', from: 'PM', to: 'all', message: 'hi' }), /open in another live tab that holds its rooms; call join_room here/)
    assert.equal(createStore(options).memberships().find(row => row.agent === 'PM').session.endpoint, '/private/tab1.sock')
    assert.deepEqual(await a.call('inbox', { room: 'room', agent: 'PM' }), [])
  } finally { a.close(); b.close() }
})

test('R5: a delivery cancelled during a slow presence check that never sent stays pending', async t => {
  const dir = temp(t, 'r5'), profileHome = path.join(dir, 'p'); fs.mkdirSync(profileHome, { mode: 0o700 })
  const store = createStore({ root: path.join(dir, 'chats'), projectRoot: dir }); store.createRoom({ room: 'room', title: 'room' })
  store.join({ room: 'room', agent: 'C', session: { id: 'cccccccc-1234-4234-8234-123456789abc', runtime: 'codex', profileHome } })
  let inspections = 0, sent = 0
  const adapters = createAdapters({ timeoutMs: 1000,
    control: { async inspect() { if (++inspections === 2) await new Promise(resolve => setTimeout(resolve, 1500)); return { loaded: true, exists: true, cwd: dir } } },
    executor: async (_file, args) => {
      if (args[0] === '--version') { await new Promise(resolve => setTimeout(resolve, 250)); return { code: 0, stdout: 'codex-cli 0.163.0\n' } }
      if (args[1] === '--help') return { code: 0, stdout: '--thread --message' }
      sent++; return { code: 0, stdout: '' }
    } })
  const controller = createController({ store, adapters, dispatchTimeoutMs: 400 })
  store.post({ room: 'room', from: 'S', to: 'C', message: 'x' })
  await controller.dispatch('room')
  assert.equal(sent, 0)
  assert.notEqual(store.deliveryStatus({ room: 'room', agent: 'C' })[0].status, 'notified')
})

test('R6: after the one-time move, the hook names the folder the store uses', t => {
  const dir = temp(t, 'r6'), project = path.join(dir, 'project'), stateRoot = path.join(dir, 'state')
  fs.mkdirSync(project); fs.mkdirSync(path.join(dir, 'real')); fs.symlinkSync(path.join(dir, 'real'), path.join(dir, 'link'))
  const linked = path.join(dir, 'link', 'chats'), real = path.join(dir, 'real', 'chats')
  const key = root => crypto.createHash('sha256').update(root + '\n' + fs.realpathSync(project)).digest('hex').slice(0, 24)
  createStore({ root: linked, projectRoot: project, stateRoot }).createRoom({ room: 'room', title: 'room' })
  const projects = path.join(stateRoot, 'projects')
  fs.renameSync(path.join(projects, key(real)), path.join(projects, key(linked)))
  const upgraded = createStore({ root: linked, projectRoot: project, stateRoot })
  assert.deepEqual(fs.readdirSync(projects), [key(real)])
  assert.equal(path.basename(path.dirname(upgraded.statePath)), projectNoticeId(linked, project))
})

test('R7: a stored post never comes back as failed when the not-in-room check throws', async t => {
  const dir = temp(t, 'r7'), project = path.join(dir, 'project'); fs.mkdirSync(project)
  const real = createStore({ root: path.join(dir, 'chats'), projectRoot: project })
  real.createRoom({ room: 'room', title: 'room' })
  // members() fails only once the post is stored, as a damaged state file would.
  let stored = false
  const store = new Proxy(real, { get(target, name) {
    if (name === 'post') return args => { const result = target.post(args); stored = true; return result }
    if (name === 'members' && stored) return () => { throw new Error('boom') }
    const value = target[name]; return typeof value === 'function' ? value.bind(target) : value
  } })
  const service = createService({ store, env: {}, adapters: quiet })
  try {
    await service.call('join_room', { room: 'room', agent: 'a', session: { id: 'a', runtime: 'manual' } })
    const posted = await service.call('post', { room: 'room', from: 'a', to: 'b', message: 'kept' })
    assert.equal(posted.cursor, 1)
    assert.deepEqual(posted.delivery.map(row => row.transport), ['pending'])
  } finally { service.close() }
})

test('R8: more fixable errors reach a manual client word for word', async t => {
  const dir = temp(t, 'r8'), project = path.join(dir, 'project'); fs.mkdirSync(project)
  const env = { ...process.env, AGENT_CHAT_ROOT: path.join(dir, 'chats'), AGENT_CHAT_STATE_ROOT: path.join(dir, 'state') }
  for (const name of Object.keys(env)) if (/^(CLAUDE|CODEX)/.test(name)) delete env[name]
  const calls = [
    ['create_room', { room: 'Room', title: 'Room' }],
    ['create_room', { room: 'room', title: 'room' }],
    ['join_room', { room: 'Room', agent: 'me', session: { id: 'me', runtime: 'bogus' } }],
    ['join_room', { room: 'Room', agent: 'me', session: { id: 'not a name!', runtime: 'manual' } }],
    ['join_room', { room: 'Room', agent: 'me', session: { id: 'me', runtime: 'manual' } }],
    ['ack', { room: 'Room', agent: 'me', message_ids: [] }],
  ]
  // One call at a time: the server answers concurrent calls in any order.
  const child = spawn(process.execPath, [SERVER], { cwd: project, env, stdio: ['pipe', 'pipe', 'ignore'] })
  t.after(() => child.kill())
  let buffer = '', waiting
  child.stdout.on('data', data => { buffer += data; const end = buffer.indexOf('\n'); if (end >= 0) { const line = buffer.slice(0, end); buffer = buffer.slice(end + 1); waiting(JSON.parse(line).result) } })
  const errors = []
  for (const [index, [name, args]] of calls.entries()) {
    const result = await new Promise(resolve => { waiting = resolve; child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: index + 1, method: 'tools/call', params: { name, arguments: args } }) + '\n') })
    if (result.isError) errors.push(result.content[0].text)
  }
  child.stdin.end()
  assert.deepEqual(errors, ['room case variant conflicts with Room', 'Unsupported runtime', 'Invalid registered session ID', 'message_ids required'])
})

test('R9: a native join refused for its name leaves no room behind', async t => {
  const dir = temp(t, 'r9'), profileHome = path.join(dir, 'codex'), project = path.join(dir, 'project')
  fs.mkdirSync(profileHome, { mode: 0o700 }); fs.mkdirSync(project)
  const options = { root: path.join(dir, 'chats'), projectRoot: project }
  const store = createStore(options); store.createRoom({ room: 'other', title: 'other' })
  store.join({ room: 'other', agent: 'taken', session: { id: 'someone', runtime: 'manual' } })
  const service = createService({ store: createStore(options), env: { AGENT_CHAT_CODEX_HOME: profileHome }, adapters: quiet })
  try {
    await assert.rejects(service.call('join_room', { room: 'typo-room', agent: 'taken' }, 1, { 'x-codex-turn-metadata': { thread_id: '12345678-1234-4234-8234-123456789abc' } }), /name is owned/)
    assert.deepEqual(store.listRooms().map(room => room.room), ['other'])
  } finally { service.close() }
})

test('R10: a /clear whose project check fails still says the earlier rooms keep ringing', t => {
  const dir = temp(t, 'r10')
  const input = JSON.stringify({ session_id: UUID(2), source: 'clear', hook_event_name: 'SessionStart', cwd: path.join(dir, 'missing') })
  const env = { ...process.env, AGENT_CHAT_STATE_ROOT: path.join(dir, 'state'), AGENT_CHAT_ROOT: path.join(dir, 'chats'), CLAUDE_CODE_SESSION_ID: UUID(1), AGENT_CHAT_VERIFY_CHILD: '' }
  const output = JSON.parse(execFileSync(process.execPath, [HOOK], { input, env, encoding: 'utf8', timeout: 20000 }))
  assert.match(output.systemMessage, /conversation before \/clear, and that conversation's rooms keep ringing here/)
})
