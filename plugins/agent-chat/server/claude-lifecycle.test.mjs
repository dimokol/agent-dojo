import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import net from 'node:net'
import { once } from 'node:events'
import { execFileSync } from 'node:child_process'
import { observeClaudeLifecycle, resolveClaudeConversation, validateClaudeLifecycleSocket, claudeLifecycleAncestors, lifecycleProjectRoot, pruneClaudeLifecycle } from './claude-lifecycle.mjs'
const LAUNCH = '12345678-1234-1234-1234-123456789abc'
const RESUMED = '22345678-1234-1234-1234-123456789abc'
const CLEAR = '32345678-1234-1234-1234-123456789abc'
const damaged = error => error.code === 'CHAT_CLAUDE_LIFECYCLE_UNAVAILABLE' && error.message === 'Agent-chat Claude lifecycle metadata is unavailable'
function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'claude-lifecycle-')))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const profile = path.join(root, 'profile'), project = path.join(root, 'project'), stateRoot = path.join(root, 'state')
  fs.mkdirSync(profile, { mode: 0o700 }); fs.mkdirSync(project, { mode: 0o700 })
  const parent = { pid: process.pid, start: 'Thu Oct 15 15:00:00 2026', trusted: true }
  const env = { CLAUDE_CONFIG_DIR: profile, CLAUDE_CODE_SESSION_ID: LAUNCH, CLAUDE_CODE_MESSAGING_SOCKET: '/private/test-native.sock' }
  const options = { stateRoot, projectRoot: project, scope: () => project, ancestors: () => [{ pid: 100, start: 'wrapper', trusted: false }, parent], validateSocket: endpoint => endpoint }
  const resolveOptions = { ...options, ancestors: () => [parent] }
  const input = { hook_event_name: 'SessionStart', source: 'startup', session_id: LAUNCH, cwd: project }
  return { root, profile, project, stateRoot, parent, env, options, resolveOptions, input }
}

test('startup, native resume and clear record real conversation separately from stable launch identity', t => {
  const f = fixture(t)
  const first = observeClaudeLifecycle(f.input, f.env, f.options)
  assert.equal(first.session.id, LAUNCH)
  assert.equal(first.session.conversationId, LAUNCH)
  assert.equal(first.session.lifecycle, true)
  assert.equal(first.previousConversationId, null)
  assert.equal(resolveClaudeConversation(first.session, f.resolveOptions), LAUNCH)
  const resumed = observeClaudeLifecycle({ ...f.input, source: 'resume', session_id: RESUMED }, f.env, f.options)
  assert.equal(resumed.session.id, LAUNCH)
  assert.equal(resumed.session.conversationId, RESUMED)
  assert.equal(resumed.previousConversationId, LAUNCH)
  assert.equal(resolveClaudeConversation(first.session, f.resolveOptions), RESUMED)
  const cleared = observeClaudeLifecycle({ ...f.input, source: 'clear', session_id: CLEAR }, f.env, f.options)
  assert.equal(cleared.previousConversationId, RESUMED)
  assert.equal(resolveClaudeConversation(first.session, f.resolveOptions), CLEAR)
  const file = path.join(f.stateRoot, 'lifecycle', fs.readdirSync(path.join(f.stateRoot, 'lifecycle'))[0])
  assert.equal(fs.statSync(file).mode & 0o777, 0o600)
  assert.equal(fs.statSync(path.dirname(file)).mode & 0o777, 0o700)
})

test('cross-profile, project, socket and PID generation cannot borrow mappings', t => {
  const f = fixture(t), { session } = observeClaudeLifecycle(f.input, f.env, f.options)
  const other = path.join(f.root, 'other'); fs.mkdirSync(other, { mode: 0o700 })
  for (const changed of [{ clientStart: 'new process birth' }, { clientPid: process.pid + 1 }, { profileHome: other },
    { endpoint: '/other.sock' }, { runtime: 'codex' }]) {
    assert.equal(resolveClaudeConversation({ ...session, ...changed }, f.resolveOptions), null)
  }
  assert.equal(resolveClaudeConversation(session, { ...f.resolveOptions, projectRoot: other }), null)
  assert.equal(resolveClaudeConversation(session, { ...f.resolveOptions, ancestors: () => [{ ...f.parent, trusted: false }] }), null)
  assert.equal(resolveClaudeConversation(session, { ...f.resolveOptions, ancestors: () => [{ ...f.parent, start: 'reused PID' }] }), null)
})

test('hook input PID never authorizes ancestry and recursive verification children never write', t => {
  const f = fixture(t)
  assert.equal(observeClaudeLifecycle(f.input, { ...f.env, AGENT_CHAT_VERIFY_CHILD: '1' }, f.options), null)
  assert.equal(fs.existsSync(f.stateRoot), false)
  assert.throws(() => observeClaudeLifecycle({ ...f.input, pid: process.pid, parent_pid: process.pid }, f.env,
    { ...f.options, ancestors: () => [] }), damaged)
  for (const input of [{ ...f.input, session_id: '../wrong' }, { ...f.input, source: 'unknown' }, { ...f.input, hook_event_name: 'PostToolUse' }]) {
    assert.throws(() => observeClaudeLifecycle(input, f.env, f.options), damaged)
  }
})

test('unsafe, corrupted and busy metadata fail closed without replacing it', t => {
  const f = fixture(t), { session } = observeClaudeLifecycle(f.input, f.env, f.options)
  const dir = path.join(f.stateRoot, 'lifecycle'), file = path.join(dir, fs.readdirSync(dir)[0])
  const valid = fs.readFileSync(file, 'utf8')
  fs.writeFileSync(`${file}.lock`, 'owned competing hook', { mode: 0o600 })
  const began = performance.now()
  assert.throws(() => observeClaudeLifecycle(f.input, f.env, f.options), damaged)
  assert.ok(performance.now() - began < 100)
  assert.equal(fs.readFileSync(file, 'utf8'), valid)
  fs.unlinkSync(`${file}.lock`)
  // A damaged or unsafe record is unknown, never a definite "not this conversation".
  fs.writeFileSync(file, '{bad')
  assert.throws(() => resolveClaudeConversation(session, f.resolveOptions), damaged)
  assert.throws(() => observeClaudeLifecycle(f.input, f.env, f.options), damaged)
  assert.equal(fs.readFileSync(file, 'utf8'), '{bad')
  fs.writeFileSync(file, valid); fs.chmodSync(file, 0o644)
  assert.throws(() => resolveClaudeConversation(session, f.resolveOptions), damaged)
})

test('socket validation requires actual owned PID socket with private parent and mode', async t => {
  // Use the current process's unused name only. Never replace another CLI socket.
  const directory = path.join(fs.realpathSync('/tmp'), 'cc-socks')
  if (!fs.existsSync(directory)) fs.mkdirSync(directory, { mode: 0o700 })
  const endpoint = path.join(directory, `${process.pid}.sock`)
  assert.equal(fs.existsSync(endpoint), false)
  const server = net.createServer()
  server.listen(endpoint); await once(server, 'listening'); fs.chmodSync(endpoint, 0o600)
  t.after(async () => { await new Promise(resolve => server.close(resolve)) })
  assert.equal(validateClaudeLifecycleSocket(endpoint, process.pid), endpoint)
  assert.throws(() => validateClaudeLifecycleSocket(endpoint, process.pid + 1), damaged)
  fs.chmodSync(endpoint, 0o666)
  assert.throws(() => validateClaudeLifecycleSocket(endpoint, process.pid), damaged)
})

test('bounded ancestor inspection refuses impossible PID and Node executable', () => {
  assert.deepEqual(claudeLifecycleAncestors(-1), [])
  const began = performance.now()
  const rows = claudeLifecycleAncestors(process.pid)
  assert.equal(rows[0].pid, process.pid)
  assert.equal(rows[0].trusted, false)
  assert.ok(performance.now() - began < 1000)
})


test('nested directories and linked worktrees resolve to the same canonical common-root scope', t => {
  const f = fixture(t)
  execFileSync('/usr/bin/git', ['init', '-q', f.project])
  execFileSync('/usr/bin/git', ['-C', f.project, '-c', 'user.name=Lifecycle Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--allow-empty', '-qm', 'fixture'])
  const nested = path.join(f.project, 'nested'); fs.mkdirSync(nested)
  const worktree = path.join(f.root, 'worktree')
  execFileSync('/usr/bin/git', ['-C', f.project, 'worktree', 'add', '--detach', '-q', worktree])
  assert.equal(lifecycleProjectRoot(nested), f.project)
  assert.equal(lifecycleProjectRoot(worktree), f.project)
  const first = observeClaudeLifecycle({ ...f.input, cwd: nested }, f.env, {...f.options,scope:lifecycleProjectRoot})
  const resumed = observeClaudeLifecycle({ ...f.input, source: 'resume', cwd: worktree, session_id: RESUMED }, f.env, {...f.options,scope:lifecycleProjectRoot})
  assert.equal(resumed.previousConversationId, LAUNCH)
  assert.equal(resolveClaudeConversation(first.session, f.resolveOptions), RESUMED)
})

test('Git scope timeout fails closed while confirmed non-Git directories retain their own scope', t => {
  const f = fixture(t)
  for (const status of [1, 128]) assert.equal(lifecycleProjectRoot(f.project, { executor() {
    throw Object.assign(new Error('not a git repository'), { status })
  } }), f.project)
  for (const failure of [{ code: 'ETIMEDOUT', killed: true }, { status: 2 }, { status: 128, signal: 'SIGTERM' }]) {
    assert.throws(() => lifecycleProjectRoot(f.project, { executor() { throw Object.assign(new Error('scope unavailable'), failure) } }), damaged)
  }
  assert.throws(() => observeClaudeLifecycle(f.input, f.env, { ...f.options, scope: () => f.profile }), damaged)
})

test('fork is a lifecycle source with the /clear rule: a new conversation that inherits no rooms', async t => {
  const f = fixture(t)
  const first = observeClaudeLifecycle(f.input, f.env, f.options)
  const forked = observeClaudeLifecycle({ ...f.input, source: 'fork', session_id: CLEAR }, f.env, f.options)
  assert.equal(forked.source, 'fork')
  assert.equal(forked.previousConversationId, LAUNCH)
  assert.equal(resolveClaudeConversation(first.session, f.resolveOptions), CLEAR, 'the recorded fork stays readable')
  const { createStore } = await import('./store.mjs')
  const store = createStore({ root: path.join(f.root, 'chats'), projectRoot: f.project, stateRoot: f.stateRoot })
  store.createRoom({ room: 'room', title: 'Room' })
  store.join({ room: 'room', agent: 'Original', session: first.session })
  assert.deepEqual(store.restoreClaude(forked, () => true).restored, [])
  assert.deepEqual(store.memberships().map(row => [row.agent, row.joined, row.left_reason]), [['Original', false, 'conversation_changed']])
})

test('an in-CLI /resume resolves for the MCP server even though hooks now see the resumed id', t => {
  // Claude exports the current conversation id to later hooks, while the MCP server keeps the
  // id it was spawned with. The CLI process (pid, birth, socket) is the identity both share.
  const f = fixture(t)
  const mcp = observeClaudeLifecycle(f.input, f.env, f.options).session
  observeClaudeLifecycle({ ...f.input, source: 'resume', session_id: RESUMED }, { ...f.env, CLAUDE_CODE_SESSION_ID: RESUMED }, f.options)
  assert.equal(mcp.id, LAUNCH)
  assert.equal(resolveClaudeConversation(mcp, f.resolveOptions), RESUMED)
})

// ~/.claude is a symlink to ~/.claude-work here, so a plain `claude` start
// never registered while the MCP server accepted the same profile.
test('a symlinked profile registers at its real path, the same one the MCP server records', t => {
  const f = fixture(t)
  const alias = path.join(f.root, 'alias'); fs.symlinkSync(f.profile, alias)
  const { session } = observeClaudeLifecycle(f.input, { ...f.env, CLAUDE_CONFIG_DIR: alias }, f.options)
  assert.equal(session.profileHome, f.profile)
  assert.equal(resolveClaudeConversation(session, f.resolveOptions), LAUNCH)
})

test('a failed registration names the step that failed, never its error text', t => {
  const f = fixture(t)
  const stage = (input, env, options) => { try { observeClaudeLifecycle(input, env, options) } catch (error) { assert.ok(damaged(error)); return error.stage } }
  assert.equal(stage({ ...f.input, session_id: 'nope' }, f.env, f.options), 'input')
  assert.equal(stage(f.input, f.env, { ...f.options, scope: () => '/elsewhere' }), 'project')
  assert.equal(stage(f.input, { ...f.env, CLAUDE_CONFIG_DIR: path.join(f.root, 'missing') }, f.options), 'profile')
  // No native Claude Code among the ancestors is its own step; a ps that failed is the process check.
  assert.equal(stage(f.input, f.env, { ...f.options, ancestors: () => [{ pid: 100, start: 'wrapper', trusted: false }] }), 'install')
  assert.equal(stage(f.input, f.env, { ...f.options, ancestors: () => { throw Object.assign(new Error('ps timed out'), { stage: 'process' }) } }), 'process')
  assert.equal(stage(f.input, f.env, { ...f.options, validateSocket: () => { throw new Error('private path') } }), 'socket')
})

test('registration records the version the tab itself runs', t => {
  const f = fixture(t)
  const executable = path.join(os.homedir(), '.local/share/claude/versions/2.1.302')
  const { session } = observeClaudeLifecycle(f.input, f.env, { ...f.options, ancestors: () => [{ ...f.parent, executable }] })
  assert.equal(session.claudeVersion, '2.1.302')
})

test('the Git scope check allows seconds, not milliseconds, before failing closed', t => {
  const f = fixture(t)
  let timeout
  lifecycleProjectRoot(f.project, { executor: (_file, _args, options) => { timeout = options.timeout; return path.join(f.project, '.git') + '\n' } })
  assert.ok(timeout >= 2000)
})

// Under load lsof can fail; that must not read as a closed or foreign tab.
test('a process check that could not run is unknown, never a definite mismatch', t => {
  const f = fixture(t), { session } = observeClaudeLifecycle(f.input, f.env, f.options)
  assert.throws(() => resolveClaudeConversation(session, { ...f.resolveOptions, ancestors: () => { throw new Error('ps timed out') } }), damaged)
  assert.equal(resolveClaudeConversation(session, { ...f.resolveOptions, ancestors: () => [] }), null)
  assert.equal(resolveClaudeConversation(session, { ...f.resolveOptions, validateSocket: () => { throw new Error('socket gone') } }), null)
  assert.equal(resolveClaudeConversation(session, { ...f.resolveOptions, stateRoot: path.join(f.root, 'no-state') }), null)
})

test('records of closed tabs are pruned; open, busy, damaged and unknown ones are kept', t => {
  const f = fixture(t), dir = path.join(f.stateRoot, 'lifecycle')
  const tab = (pid, start) => observeClaudeLifecycle(f.input, f.env, { ...f.options, ancestors: () => [{ pid, start, trusted: true }] })
  const open = tab(101, 'Thu Oct 15 15:00:00 2026')
  tab(102, 'Thu Oct 15 15:01:00 2026'); tab(103, 'Thu Oct 15 15:02:00 2026'); tab(104, 'Thu Oct  1 15:03:00 2026'); tab(105, 'Thu Oct 15 15:05:00 2026')
  const fileFor = pid => fs.readdirSync(dir).filter(name => name.endsWith('.json')).map(name => path.join(dir, name))
    .find(file => { try { return JSON.parse(fs.readFileSync(file, 'utf8')).clientPid === pid } catch { return false } })
  fs.writeFileSync(`${fileFor(104)}.lock`, 'a hook is writing', { mode: 0o600 })
  const damagedFile = path.join(dir, `${'f'.repeat(64)}.json`)
  fs.writeFileSync(damagedFile, '{bad', { mode: 0o600 })
  // 101 is open; 102 and 104 are gone (104 mid-write); 103 is a reused PID with a new start time;
  // 105 still exists but ps left it out, which proves nothing.
  const live = new Map([[101, { pid: 101, start: 'Thu Oct 15 15:00:00 2026' }], [103, { pid: 103, start: 'Fri Oct 16 09:00:00 2026' }]])
  const signal = pid => { if ([102, 104].includes(pid)) throw Object.assign(new Error('gone'), { code: 'ESRCH' }) }
  assert.equal(pruneClaudeLifecycle({ stateRoot: f.stateRoot, identities: () => live, signal }), 2)
  assert.ok(fileFor(101)); assert.equal(fileFor(102), undefined); assert.equal(fileFor(103), undefined)
  assert.ok(fileFor(104)); assert.ok(fileFor(105)); assert.ok(fs.existsSync(damagedFile))
  assert.equal(resolveClaudeConversation(open.session, { ...f.resolveOptions, ancestors: () => [{ pid: 101, start: 'Thu Oct 15 15:00:00 2026', trusted: true }] }), LAUNCH)
  // A process check that cannot run is unknown: nothing is removed.
  fs.unlinkSync(`${fileFor(104)}.lock`)
  assert.throws(() => pruneClaudeLifecycle({ stateRoot: f.stateRoot, identities: () => { throw new Error('ps unavailable') }, signal }))
  assert.ok(fileFor(104))
  assert.equal(pruneClaudeLifecycle({ stateRoot: path.join(f.root, 'no-state'), identities: () => live, signal }), 0)
})
