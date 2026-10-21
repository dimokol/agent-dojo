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
import { createAdapters } from './adapters.mjs'
import { createNativeControl } from './native-control.mjs'
import { inferNativeSession, processExecutable, processIdentity, runningClaudeVersion } from './native-session.mjs'
import { observeClaudeLifecycle, resolveClaudeConversation, pruneClaudeLifecycle } from './claude-lifecycle.mjs'
import { registrationFailureLine } from './claude-session-hook.mjs'
import { sessionUnreadLine } from './notices.mjs'
import { isVerifiedVersion } from './claude-versions.mjs'

// Each test reproduces one finding from the review of PR #6 and fails without its fix.
const SERVER = fileURLToPath(new URL('./server.mjs', import.meta.url))
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

test('M5: a second tab on the same conversation does not take the rooms from a live first tab', async t => {
  const dir = temp(t, 'm5'), profile = path.join(dir, 'profile'); fs.mkdirSync(profile, { mode: 0o700 })
  const [clientA, serverA, clientB] = [await sleeper(t), await sleeper(t), await sleeper(t)], self = processIdentity(process.pid)
  const tab = (n, client, server) => ({ runtime: 'claude', id: UUID(n), profileHome: profile, endpoint: `/private/tab${n}.sock`,
    clientPid: client.pid, clientStart: client.start, serverPid: server.pid, serverStart: server.start })
  const options = { root: path.join(dir, 'chats'), stateRoot: path.join(dir, 'state'), projectRoot: dir }
  createStore(options).createRoom({ room: 'room', title: 'room' })
  const service = session => {
    const current = createService({ store: createStore(options), env: {}, adapters: { async deliver() { return { attempted: false, status: 'pending' } } },
      inferSession: () => session, resolveConversation: () => UUID(99), claudeVerified: () => true })
    return current
  }
  const a = service(tab(1, clientA, serverA)), b = service(tab(2, clientB, self))
  await a.call('join_room', { room: 'room', agent: 'PM' })
  await b.call('list_rooms', {})
  const member = createStore(options).memberships().find(row => row.agent === 'PM')
  a.close(); b.close()
  assert.equal(member.session.endpoint, '/private/tab1.sock')
})

test('M6: a delivery cancelled at the deadline before it sent anything stays pending', async t => {
  const dir = temp(t, 'm6'), profileHome = path.join(dir, 'profile'); fs.mkdirSync(profileHome, { mode: 0o700 })
  const store = createStore({ root: path.join(dir, 'chats'), projectRoot: dir }); store.createRoom({ room: 'room', title: 'room' })
  const threads = { A: 'aaaaaaaa-1234-4234-8234-123456789abc', B: 'bbbbbbbb-1234-4234-8234-123456789abc', C: 'cccccccc-1234-4234-8234-123456789abc' }
  for (const [agent, id] of Object.entries(threads)) store.join({ room: 'room', agent, session: { id, runtime: 'codex', profileHome } })
  const adapters = createAdapters({ timeoutMs: 1000, maxConcurrent: 2, control: { async inspect() { return { loaded: true, exists: true, cwd: dir } } },
    executor: async (_file, args) => {
      if (args[0] === '--version') return { code: 0, stdout: 'codex-cli 0.163.0\n' }
      if (args[1] === '--help') return { code: 0, stdout: '--thread --message' }
      await new Promise(resolve => setTimeout(resolve, 700)); return { code: 0, stdout: '' }
    } })
  const controller = createController({ store, adapters, dispatchTimeoutMs: 500 })
  for (const agent of Object.keys(threads)) store.post({ room: 'room', from: 'Sender', to: agent, message: `for ${agent}` })
  await controller.dispatch('room')
  await new Promise(resolve => setTimeout(resolve, 1500))
  assert.notEqual(store.deliveryStatus({ room: 'room', agent: 'C' })[0].status, 'notified')
})

test('M9: a git that times out once does not bind a linked worktree to the wrong project', async t => {
  const dir = temp(t, 'm9'), main = path.join(dir, 'main'), worktree = path.join(dir, 'wt'), bin = path.join(dir, 'bin')
  const git = (...args) => execFileSync('/usr/bin/git', args, { stdio: 'ignore' })
  fs.mkdirSync(main); git('-C', main, 'init', '-q'); git('-C', main, '-c', 'user.email=t@example.com', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init')
  git('-C', main, 'worktree', 'add', '-q', worktree)
  fs.mkdirSync(bin); fs.writeFileSync(path.join(bin, 'git'), '#!/bin/sh\nif [ ! -e "$SLOW_MARK" ]; then : > "$SLOW_MARK"; sleep 4; fi\nexec /usr/bin/git "$@"\n', { mode: 0o755 })
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, SLOW_MARK: path.join(dir, 'mark'), AGENT_CHAT_ROOT: path.join(dir, 'chats'), AGENT_CHAT_STATE_ROOT: path.join(dir, 'state') }
  for (const name of Object.keys(env)) if (/^(CLAUDE|CODEX)/.test(name)) delete env[name]
  const child = spawn(process.execPath, [SERVER], { cwd: worktree, env, stdio: ['pipe', 'pipe', 'ignore'] })
  t.after(() => child.kill())
  const reply = await new Promise(resolve => { let out = ''; child.stdout.on('data', data => { out += data; if (out.includes('\n')) resolve(JSON.parse(out.split('\n')[0])) }) ; child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }) + '\n') })
  assert.match(reply.result.instructions, /^Project main\./)
})

test('L1: an lsof that timed out is a retryable error, not an untrusted install', t => {
  const dir = temp(t, 'l1'); fs.chmodSync(dir, 0o700)
  const env = { CLAUDE_CODE_SESSION_ID: UUID(1), CLAUDE_CODE_MESSAGING_SOCKET: '/private/tmp/x.sock', CLAUDE_CONFIG_DIR: dir }
  assert.throws(() => inferNativeSession(undefined, env, { getCommand: () => 'claude', getExecutable: () => null }), /^Error: Native Claude session check timed out; retry$/)
})

test('L2: a failed registration after /clear says the earlier conversation keeps ringing', () => {
  const line = registrationFailureLine('process', 'clear')
  assert.doesNotMatch(line, /join_room again/)
  assert.match(line, /conversation before \/clear, and that conversation's rooms keep ringing here/)
  // A fork is a new process with no earlier record (round 2, R10).
  for (const source of ['startup', 'fork']) assert.match(registrationFailureLine('process', source), /need join_room again/)
})

test('L3: a lock left by a killed hook is taken over once it is stale', async t => {
  const dir = temp(t, 'l3'), profile = path.join(dir, 'profile'), project = path.join(dir, 'project'), stateRoot = path.join(dir, 'state')
  fs.mkdirSync(profile, { mode: 0o700 }); fs.mkdirSync(project)
  const client = await sleeper(t), endpoint = '/private/tmp/agent-chat-l3.sock'
  const env = { CLAUDE_CONFIG_DIR: profile, CLAUDE_CODE_SESSION_ID: UUID(1), CLAUDE_CODE_MESSAGING_SOCKET: endpoint }
  const facts = { stateRoot, projectRoot: project, scope: () => project, validateSocket: value => value, ancestors: () => [{ pid: client.pid, start: client.start, trusted: true }] }
  const start = (id, source) => observeClaudeLifecycle({ session_id: id, source, hook_event_name: 'SessionStart', cwd: project }, env, facts)
  start(UUID(11), 'startup')
  const directory = path.join(stateRoot, 'lifecycle'), record = fs.readdirSync(directory).find(name => name.endsWith('.json'))
  const lock = path.join(directory, `${record}.lock`), old = new Date(Date.now() - 120_000)
  fs.writeFileSync(lock, '', { mode: 0o600 }); fs.utimesSync(lock, old, old)
  start(UUID(12), 'clear')
  const session = { runtime: 'claude', profileHome: profile, clientPid: client.pid, clientStart: client.start, endpoint }
  assert.equal(resolveClaudeConversation(session, { stateRoot, projectRoot: project, ancestors: facts.ancestors, validateSocket: facts.validateSocket }), UUID(12))
  assert.equal(fs.existsSync(lock), false)
  // A fresh lock still means another hook is working: no takeover.
  fs.writeFileSync(lock, '', { mode: 0o600 })
  assert.throws(() => start(UUID(13), 'clear'))
  fs.unlinkSync(lock)
  assert.equal(typeof pruneClaudeLifecycle({ stateRoot }), 'number')
})

test('L4: a prerelease Claude build is a known version, and with the check off nothing pauses', async t => {
  // A prerelease reads as unknown (round 2, R1): records and the gate take plain x.y.z only.
  assert.equal(runningClaudeVersion(path.join(os.homedir(), '.local/share/claude/versions/2.1.300-beta')), undefined)
  const adapters = createAdapters({ requireProcessIdentity: false, verifiedClaudeVersion: version => isVerifiedVersion(version, { env: {} }),
    executor: async () => ({ code: 0, stdout: 'not a version line\n' }) })
  const result = await adapters.deliver({ session: { id: UUID(1), runtime: 'claude' }, messages: [{ id: 'm1', message: 'x' }], room: 'room', project: 'p', agent: 'a', projectRoot: '/' })
  assert.doesNotMatch(result.detail, /paused/)
})

test('L5: a stopped Codex daemon is recognised by its error number, not its English text', async t => {
  const dir = temp(t, 'l5'); fs.chmodSync(dir, 0o700)
  const control = createNativeControl({ executor: async () => { throw Object.assign(new Error('exit 1'), { stderr: 'Error: Datei oder Verzeichnis nicht gefunden (os error 2)\n' }) } })
  assert.deepEqual(await control.profileThreads(dir), [])
})

test('M4: lsof is looked up in the places macOS and Linux keep it', () => {
  assert.equal(processExecutable(process.pid, { candidates: ['/nonexistent/lsof'] }), null)
  assert.equal(processExecutable(process.pid, { candidates: ['/nonexistent/lsof', '/usr/sbin/lsof', '/usr/bin/lsof'] }), fs.realpathSync(process.execPath))
})

test('N1: wake-ups paused by a failed version check say how to check again', async t => {
  const stateRoot = temp(t, 'n1'), directory = path.join(stateRoot, 'verification'); fs.mkdirSync(directory)
  fs.writeFileSync(path.join(directory, '2.1.306.json'), JSON.stringify({ schema: 1, version: '2.1.306', status: 'failed' }))
  const adapters = createAdapters({ requireProcessIdentity: false, stateRoot, verifiedClaudeVersion: () => false })
  const result = await adapters.deliver({ session: { id: UUID(1), runtime: 'claude', claudeVersion: '2.1.306' }, messages: [{ id: 'm1', message: 'x' }], room: 'room', project: 'p', agent: 'a', projectRoot: '/' })
  assert.match(result.detail, /^Claude wake-ups paused: version 2\.1\.306 failed its check; .*verify-claude\.mjs --run/)
})

test('L6: notices that keep failing are reported once on stderr, and mail still goes through', t => {
  const dir = temp(t, 'l6'), stateRoot = path.join(dir, 'state')
  const store = createStore({ root: path.join(dir, 'chats'), projectRoot: dir, stateRoot })
  store.createRoom({ room: 'room', title: 'room' })
  fs.mkdirSync(path.join(stateRoot, 'notices'), { recursive: true }); fs.chmodSync(path.join(stateRoot, 'notices'), 0o755)
  const written = [], real = process.stderr.write
  process.stderr.write = text => { written.push(String(text)); return true }
  try {
    store.join({ room: 'room', agent: 'a', session: { id: 'a', runtime: 'manual' } })
    store.post({ room: 'room', from: 'a', message: 'one', sessionId: 'a' })
    store.post({ room: 'room', from: 'a', message: 'two', sessionId: 'a' })
  } finally { process.stderr.write = real }
  assert.equal(written.length, 1)
  assert.match(written[0], /^Agent-chat could not update its unread notices or name cache \(unsafe notice directory\); mail and inboxes are unaffected/)
  assert.equal(store.history({ room: 'room' }).length, 2)
})

test('L7: state made under a linked spelling of the chat root survives the upgrade', t => {
  const dir = temp(t, 'l7'), project = path.join(dir, 'project'), stateRoot = path.join(dir, 'state')
  fs.mkdirSync(project); fs.mkdirSync(path.join(dir, 'real')); fs.symlinkSync(path.join(dir, 'real'), path.join(dir, 'link'))
  const linked = path.join(dir, 'link', 'chats')
  const first = createStore({ root: linked, projectRoot: project, stateRoot })
  first.createRoom({ room: 'room', title: 'room' })
  first.join({ room: 'room', agent: 'bob', session: { id: 'bob', runtime: 'manual' } })
  first.join({ room: 'room', agent: 'ann', session: { id: 'ann', runtime: 'manual' } })
  first.post({ room: 'room', from: 'ann', to: 'bob', message: 'kept', sessionId: 'ann' })
  // Put the state where the code before the fix kept it: keyed by the root as given.
  const key = root => crypto.createHash('sha256').update(root + '\n' + fs.realpathSync(project)).digest('hex').slice(0, 24)
  const projects = path.join(stateRoot, 'projects'), resolved = key(path.join(dir, 'real', 'chats'))
  fs.renameSync(path.join(projects, resolved), path.join(projects, key(linked)))
  const upgraded = createStore({ root: linked, projectRoot: project, stateRoot })
  assert.deepEqual(upgraded.pending({ room: 'room', agent: 'bob', sessionId: 'bob' }).map(message => message.message), ['kept'])
  assert.deepEqual(fs.readdirSync(projects), [resolved])
})

test('L11: one conversation joined in two projects keeps both projects\' unread line', t => {
  const dir = temp(t, 'l11'), stateRoot = path.join(dir, 'state'), root = path.join(dir, 'chats'), profileHome = path.join(dir, 'profile')
  const projectA = path.join(dir, 'a'), projectB = path.join(dir, 'b')
  for (const folder of [projectA, projectB]) fs.mkdirSync(folder)
  fs.mkdirSync(profileHome, { mode: 0o700 })
  const claude = { id: UUID(3), runtime: 'claude', profileHome, conversationId: UUID(3) }
  const a = createStore({ root, projectRoot: projectA, stateRoot }), b = createStore({ root, projectRoot: projectB, stateRoot })
  a.createRoom({ room: 'ra', title: 'ra' }); a.join({ room: 'ra', agent: 'x', session: claude })
  const sender = a.join({ room: 'ra', agent: 'm', session: { id: 'm', runtime: 'manual' } })
  a.post({ room: 'ra', from: 'm', to: 'x', message: 'for x', sessionId: 'm', participantId: sender.participant_id })
  b.createRoom({ room: 'rb', title: 'rb' }); b.join({ room: 'rb', agent: 'x', session: claude })
  assert.equal(sessionUnreadLine({ stateRoot, profileHome, conversationId: UUID(3) }), 'agent-chat: 1 unread in ra')
})
