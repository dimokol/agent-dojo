import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn, execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { createStore } from './store.mjs'
import { createService } from './server.mjs'

// The messages a user sees while setting agent-chat up, seen live on PR #6.
const SERVER = fileURLToPath(new URL('./server.mjs', import.meta.url))
const HOOK = fileURLToPath(new URL('./claude-session-hook.mjs', import.meta.url))
const META = { 'x-codex-turn-metadata': { thread_id: '12345678-1234-4234-8234-123456789abc' } }

function folder(t) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agent-chat-setup-')))
  const projectRoot = path.join(dir, 'project'); fs.mkdirSync(projectRoot)
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  return { dir, projectRoot }
}

function serve(t, { cwd, env, input = '' }) {
  const child = spawn(process.execPath, [SERVER], { cwd, env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'] })
  t.after(() => child.kill())
  return new Promise((resolve, reject) => {
    let stdout = '', stderr = ''
    const deadline = setTimeout(() => { child.kill(); reject(Error('server did not close')) }, 5000)
    child.stdout.on('data', data => stdout += data)
    child.stderr.on('data', data => stderr += data)
    child.on('error', reject)
    child.on('close', code => { clearTimeout(deadline); resolve({ code, stdout, stderr }) })
    child.stdin.end(input)
  })
}

test('a native session joining a room that does not exist yet creates it, as posting does', async t => {
  const { dir, projectRoot } = folder(t)
  const profileHome = path.join(dir, 'codex'); fs.mkdirSync(profileHome, { mode: 0o700 })
  const store = createStore({ root: path.join(dir, 'chats'), projectRoot })
  const service = createService({ store, adapters: { async deliver() { return { status: 'accepted' } } }, env: { AGENT_CHAT_CODEX_HOME: profileHome } })
  t.after(() => service.close())
  const joined = await service.call('join_room', { room: 'search-api', agent: 'api' }, 1, META)
  assert.equal(joined.room, 'search-api')
  assert.deepEqual(store.listRooms().map(room => room.room), ['search-api'])
  // A second join of the same room doesn't fail on the room it just made.
  await service.call('join_room', { room: 'search-api', agent: 'api' }, 2, META)
  // A bad alias fails before any room is made.
  await assert.rejects(service.call('join_room', { room: 'typo-room', agent: 'all' }, 3, META), /reserved/)
  assert.deepEqual(store.listRooms().map(room => room.room), ['search-api'])
  // Manual clients still need an existing room.
  const manual = createService({ store: createStore({ root: path.join(dir, 'chats'), projectRoot }), adapters: { async deliver() { return { status: 'accepted' } } }, env: {} })
  t.after(() => manual.close())
  await assert.rejects(manual.call('join_room', { room: 'typo', agent: 'Me', session: { id: 'me', runtime: 'manual' } }), /room does not exist/)
})

test('Codex with a profile folder the server cannot use is told about AGENT_CHAT_CODEX_HOME', async t => {
  const { dir, projectRoot } = folder(t)
  const call = { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'join_room', arguments: { room: 'room', agent: 'cx' }, _meta: META } }
  const output = await serve(t, { cwd: projectRoot, input: JSON.stringify(call) + '\n', env: {
    AGENT_CHAT_ROOT: path.join(dir, 'chats'), AGENT_CHAT_STATE_ROOT: path.join(dir, 'state'),
    AGENT_CHAT_CODEX_HOME: path.join(dir, 'no-such-profile'), CLAUDE_CODE_SESSION_ID: '' } })
  const result = JSON.parse(output.stdout.trim())
  assert.equal(result.result.isError, true)
  assert.match(result.result.content[0].text, /^Native Codex session not recognised; .*AGENT_CHAT_CODEX_HOME in the mcp_servers\.agent_chat\.env table of config\.toml$/)
})

test('a chat folder other users can read is named, at start or at the first call', async t => {
  const { dir, projectRoot } = folder(t)
  const root = path.join(dir, 'chats'); fs.mkdirSync(root, { mode: 0o755 }); fs.chmodSync(root, 0o755)
  const env = { AGENT_CHAT_ROOT: root, AGENT_CHAT_STATE_ROOT: path.join(dir, 'state') }
  // No project folder yet: the server starts, and the first call that needs one says why it can't.
  const call = { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'create_room', arguments: { room: 'room', title: 'room' } } }
  const lazy = await serve(t, { cwd: projectRoot, env, input: JSON.stringify(call) + '\n' })
  assert.equal(JSON.parse(lazy.stdout.trim()).result.content[0].text, 'unsafe directory ownership or permissions')
  // Once the project has rooms, the server stops at start and names the folder.
  fs.chmodSync(root, 0o700)
  createStore({ root, projectRoot, stateRoot: env.AGENT_CHAT_STATE_ROOT }).createRoom({ room: 'room', title: 'room' })
  fs.chmodSync(root, 0o755)
  const output = await serve(t, { cwd: projectRoot, env })
  assert.equal(output.code, 1)
  assert.equal(output.stderr, `Agent-chat won't use ${root}: other users can read it, or it isn't a folder you own. Run chmod 700 on it, then reconnect agent-chat in /mcp.\n`)
})

test('Claude says at start that the chat folder is unsafe, and stays quiet when it is fine', t => {
  const { dir } = folder(t)
  const root = path.join(dir, 'chats'); fs.mkdirSync(root, { mode: 0o700 })
  const start = () => JSON.parse(execFileSync(process.execPath, [HOOK], { input: '{}', encoding: 'utf8', timeout: 5000,
    env: { ...process.env, AGENT_CHAT_ROOT: root, AGENT_CHAT_STATE_ROOT: path.join(dir, 'state'), AGENT_CHAT_VERIFY_CHILD: '' } }) || '{}')
  assert.doesNotMatch(start().systemMessage ?? '', /won't use/)
  fs.chmodSync(root, 0o755)
  assert.ok(start().systemMessage.includes(`Agent-chat won't use ${root}: other users can read it, or it isn't a folder you own. Run chmod 700 on it, then reconnect agent-chat in /mcp.`))
  // chmod can't fix a link, so it gets its own advice.
  fs.chmodSync(root, 0o700); fs.renameSync(root, root + '-real'); fs.symlinkSync(root + '-real', root)
  assert.ok(start().systemMessage.includes(`Agent-chat won't use ${root}: it's a link or not a folder.`))
})

test('Codex is told about AGENT_CHAT_CODEX_HOME when its thread is not in the profile in use', async t => {
  const { dir, projectRoot } = folder(t)
  const profileHome = path.join(dir, 'codex'); fs.mkdirSync(profileHome, { mode: 0o700 })
  const join = async (inspect, room) => {
    const service = createService({ store: createStore({ root: path.join(dir, 'chats'), projectRoot }), env: { AGENT_CHAT_CODEX_HOME: profileHome },
      adapters: { async deliver() { return { status: 'accepted' } }, inspect } })
    t.after(() => service.close())
    return service.call('join_room', { room, agent: 'cx' }, 1, META)
  }
  // A running app-server that doesn't know the thread: the wrong profile.
  await assert.rejects(join(async () => ({ loaded: false, exists: false, cwd: null }), 'one'), /this thread is not in the Codex profile agent-chat is using\. Set AGENT_CHAT_CODEX_HOME/)
  // A stopped app-server (codex exec runs without one), an unreachable one, or a known thread: join.
  for (const [room, inspect] of [['two', async () => ({ loaded: false, exists: null, cwd: null, stopped: true })],
    ['three', async () => { throw new Error('Native daemon unavailable') }], ['four', async () => ({ loaded: true, exists: true, cwd: projectRoot })]])
    assert.equal((await join(inspect, room)).room, room)
})
