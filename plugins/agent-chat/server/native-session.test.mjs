import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { inferNativeSession, processIdentities, processIdentity, isProcessLive, trustedClaudeCommand } from './native-session.mjs'

const ID = '12345678-1234-1234-1234-123456789abc'
function fixture(t) {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ac-profile-')))
  t.after(() => fs.rmSync(home, { recursive: true, force: true }))
  return home
}

test('native process birth stamp survives locale differences and detects mismatch', () => {
  const identity = processIdentity(process.pid)
  assert.equal(identity.pid, process.pid)
  assert.match(identity.start, /^\w{3} \w{3}\s+\d{1,2} \d{2}:\d{2}:\d{2} \d{4}$/)
  assert.equal(isProcessLive(identity), true)
  assert.equal(isProcessLive({ ...identity, start: 'different birth' }), false)
  assert.equal(processIdentity(-1), null)
  assert.equal(processIdentity('1'), null)
  assert.equal(isProcessLive({ pid: -1, start: 'x' }), false)
  assert.equal(isProcessLive(null), false)
  assert.equal(processIdentity(2147483647), null)
  assert.equal(isProcessLive({ pid: 2147483647, start: identity.start }), false)
})

test('Codex per-call metadata is authoritative as object or JSON string', t => {
  const home = fixture(t)
  const env = { AGENT_CHAT_CODEX_HOME: home, CODEX_THREAD_ID: 'wrong' }
  for (const metadata of [{ thread_id: ID }, JSON.stringify({ thread_id: ID })]) {
    const session = inferNativeSession({ 'x-codex-turn-metadata': metadata }, env)
    assert.equal(session.id, ID)
    assert.equal(session.runtime, 'codex')
    assert.equal(session.profileHome, home)
    assert.equal(session.serverPid, process.pid)
    assert.equal(isProcessLive({ pid: session.serverPid, start: session.serverStart }), true)
  }
  assert.equal(inferNativeSession({}, env), null)
})

test('invalid Codex metadata never falls through to a Claude identity', t => {
  const home = fixture(t)
  const env = { AGENT_CHAT_CODEX_HOME: home, CLAUDE_CONFIG_DIR: home, CLAUDE_CODE_SESSION_ID: ID, CLAUDE_CODE_MESSAGING_SOCKET: '/private/socket' }
  for (const value of ['{', 'null', [], { thread_id: '../x' }, { thread_id: 3 }, null]) {
    assert.equal(inferNativeSession({ 'x-codex-turn-metadata': value }, env), null)
  }
})

test('Claude identity retains the actual parent PID and native socket', t => {
  const home = fixture(t)
  const env = { CLAUDE_CONFIG_DIR: home, CLAUDE_CODE_SESSION_ID: ID, CLAUDE_CODE_MESSAGING_SOCKET: '/private/native.sock' }
  const session = inferNativeSession({}, env, { ppid: process.pid, getCommand: () => 'fixture-claude', expectedPredicate: value => value === 'fixture-claude' })
  assert.equal(session.clientPid, process.pid)
  assert.equal(session.clientStart, processIdentity(process.pid).start)
  assert.equal(session.endpoint, '/private/native.sock')
  assert.equal(session.profileHome, home)
  assert.equal(session.runtime, 'claude')
  assert.equal(session.serverPid, process.pid)
  assert.equal(session.serverStart, processIdentity(process.pid).start)
  assert.equal(inferNativeSession({}, { ...env, CLAUDE_CODE_MESSAGING_SOCKET: '' }), null)
  assert.equal(inferNativeSession({}, env, { ppid: -1 }), null)
})

test('missing, writable, relative profiles and invalid endpoints refuse native identity', t => {
  const home = fixture(t)
  const meta = { 'x-codex-turn-metadata': { thread_id: ID } }
  assert.equal(inferNativeSession(meta, { AGENT_CHAT_CODEX_HOME: path.join(home, 'missing') }), null)
  assert.equal(inferNativeSession(meta, { AGENT_CHAT_CODEX_HOME: 'relative' }), null)
  fs.chmodSync(home, 0o777)
  assert.equal(inferNativeSession(meta, { AGENT_CHAT_CODEX_HOME: home }), null)
  fs.chmodSync(home, 0o700)
  assert.equal(inferNativeSession({}, { CLAUDE_CONFIG_DIR: home, CLAUDE_CODE_SESSION_ID: ID, CLAUDE_CODE_MESSAGING_SOCKET: 'ws://localhost' }), null)
})


test('Claude inference refuses a live Node parent and unknown command without fixture injection', t => {
  const home = fixture(t)
  const env = { CLAUDE_CONFIG_DIR: home, CLAUDE_CODE_SESSION_ID: ID, CLAUDE_CODE_MESSAGING_SOCKET: '/private/native.sock' }
  assert.equal(inferNativeSession({}, env, { ppid: process.pid }), null)
  for (const command of ['node', '/tmp/claude', '/usr/local/bin/claude', 'claude --prompt private', null]) {
    assert.equal(inferNativeSession({}, env, { ppid: process.pid, getCommand: () => command }), null)
  }
  assert.equal(inferNativeSession({}, env, { ppid: process.pid, getCommand: () => { throw new Error('command unavailable') } }), null)
  assert.equal(inferNativeSession({}, env, { ppid: process.pid, getCommand: () => 'claude', expectedPredicate: () => false }), null)
  const fixtureSession = inferNativeSession({}, env, { ppid: process.pid,
    getCommand: () => 'isolated-test-parent', expectedPredicate: value => value === 'isolated-test-parent' })
  assert.equal(fixtureSession.clientPid, process.pid)
})

test('trusted Claude command policy accepts owned installation paths and refuses a bare title', () => {
  assert.equal(trustedClaudeCommand('claude'), false)
  assert.equal(trustedClaudeCommand('/tmp/claude'), false)
  assert.equal(trustedClaudeCommand('/tmp/2.1.296'), false)
  assert.equal(trustedClaudeCommand('node'), false)
  assert.equal(trustedClaudeCommand(null), false)
  const alias = path.join(os.homedir(), '.local/bin/claude')
  let installed
  try { installed = fs.realpathSync(alias) } catch { installed = null }
  if (installed) {
    assert.equal(trustedClaudeCommand(alias), true)
    assert.equal(trustedClaudeCommand(installed), true)
  } else assert.equal(trustedClaudeCommand(alias), false)
  assert.equal(trustedClaudeCommand(path.join(os.homedir(), '.local/share/claude/versions/missing')), false)
})


test('batch snapshot deduplicates live PIDs, rejects dead PIDs before ps, and preserves birth stamps', () => {
  const expected = processIdentity(process.pid)
  let calls = 0
  const snapshot = processIdentities([process.pid, process.ppid, process.pid, -1, '1', 2147483647], {
    executor(file, args, options) {
      calls++
      assert.equal(file, '/bin/ps')
      assert.equal(args[1], `${process.pid},${process.ppid}`)
      assert.deepEqual(args.slice(2), ['-o', 'pid=', '-o', 'uid=', '-o', 'lstart='])
      assert.equal(options.env.LC_ALL, 'C')
      assert.equal(options.env.TZ, 'UTC')
      return execFileSync(file, args, options)
    },
  })
  assert.equal(calls, 1)
  assert.deepEqual(snapshot.get(process.pid), expected)
  assert.equal(snapshot.has(2147483647), false)
  assert.equal(snapshot.has(-1), false)
  assert.equal(processIdentities([], { executor() { throw new Error('must not run') } }).size, 0)
})

test('batch snapshot refuses wrong UID, unrequested rows and malformed birth stamps', () => {
  const birth = processIdentity(process.pid).start
  const snapshot = processIdentities([process.pid], { executor() {
    return `${process.pid} ${process.getuid() + 1} ${birth}\n999 ${process.getuid()} ${birth}\n${process.pid} ${process.getuid()} malformed\n`
  } })
  assert.equal(snapshot.size, 0)
  const vanished = processIdentities([process.pid], { executor() {
    throw Object.assign(new Error('ps partial result'), { status: 1,
      stdout: `${process.pid} ${process.getuid()} ${birth}\n` })
  } })
  assert.deepEqual(vanished.get(process.pid), { pid: process.pid, start: birth })
})


test('ps exiting 1 without a row for a PID that still exists is a failed check, never a dead process', () => {
  const birth = processIdentity(process.pid).start
  const failed = () => { throw Object.assign(new Error('ps failed'), { status: 1, stdout: '' }) }
  assert.throws(() => processIdentities([process.pid], { executor: failed }), error => error.code === 'CHAT_PRESENCE_UNAVAILABLE')
  // A row ps could not print in full is not proof either.
  assert.throws(() => processIdentities([process.pid], { executor() {
    throw Object.assign(new Error('ps failed'), { status: 1, stdout: `${process.pid} ${process.getuid()}\n` }) } }),
  error => error.code === 'CHAT_PRESENCE_UNAVAILABLE')
  // A PID that exited between the existence check and ps is simply absent.
  let checks = 0
  const exitedMeanwhile = (pid, signal) => { if (++checks > 1) throw Object.assign(new Error('gone'), { code: 'ESRCH' }) }
  assert.equal(processIdentities([4242], { executor: failed, signal: exitedMeanwhile }).size, 0)
  // ps can also fail with exit 0 and no rows (a failed sysctl prints a message and returns 0).
  assert.throws(() => processIdentities([process.pid], { executor: () => '' }), error => error.code === 'CHAT_PRESENCE_UNAVAILABLE')
  // A PID no process can have is absent; it never reaches ps or spoils the batch.
  const rows0 = processIdentities([2 ** 31, process.pid], { executor(file, args, options) {
    assert.equal(args[1], String(process.pid)); return execFileSync(file, args, options) } })
  assert.deepEqual(rows0.get(process.pid), { pid: process.pid, start: birth })
  // EPERM means the PID exists under another owner: it is checked, and simply not ours.
  const otherOwner = () => { throw Object.assign(new Error('not permitted'), { code: 'EPERM' }) }
  const rows = processIdentities([4242], { signal: otherOwner, executor: () => `4242 ${process.getuid() + 1} ${birth}\n` })
  assert.equal(rows.size, 0)
})

test('ps timeout and executable failure remain unknown presence instead of dead sessions', () => {
  for (const failure of [Object.assign(new Error('private diagnostics'), { status: 2 }),
    Object.assign(new Error('private timeout'), { code: 'ETIMEDOUT', killed: true }),
    Object.assign(new Error('private path'), { code: 'ENOENT' })]) {
    assert.throws(() => processIdentities([process.pid], { executor() { throw failure } }), error =>
      error.code === 'CHAT_PRESENCE_UNAVAILABLE' && error.message === 'Agent-chat process presence is unavailable; retry later')
  }
  // Exit 1 with no row is proof only for a PID that is gone; this one is alive (the test itself).
  assert.throws(() => processIdentities([process.pid], { executor() { throw Object.assign(new Error('no match'), { status: 1 }) } }),
    error => error.code === 'CHAT_PRESENCE_UNAVAILABLE')
})

test('bare Claude title requires a trusted executable mapping and cannot disguise Node', t => {
  const home = fixture(t)
  const env = { CLAUDE_CONFIG_DIR: home, CLAUDE_CODE_SESSION_ID: ID, CLAUDE_CODE_MESSAGING_SOCKET: '/private/native.sock' }
  assert.equal(inferNativeSession({}, env, { ppid: process.pid, getCommand: () => 'claude' }), null)
  assert.equal(inferNativeSession({}, env, { ppid: process.pid, getCommand: () => 'claude', getExecutable: () => '/tmp/claude' }), null)
  const executable = path.join(os.homedir(), '.local/bin/claude')
  if (!fs.existsSync(executable)) return
  const session = inferNativeSession({}, env, { ppid: process.pid, getCommand: () => 'claude', getExecutable: () => executable })
  assert.equal(session.clientPid, process.pid)
})

test('a Claude tab records the version its own executable runs, never the alias', t => {
  const home = fixture(t)
  const env = { CLAUDE_CONFIG_DIR: home, CLAUDE_CODE_SESSION_ID: ID, CLAUDE_CODE_MESSAGING_SOCKET: '/private/native.sock' }
  const versions = path.join(os.homedir(), '.local/share/claude/versions')
  const infer = executable => inferNativeSession({}, env, { ppid: process.pid, getCommand: () => 'claude', getExecutable: () => executable, expectedPredicate: () => true })
  assert.equal(infer(path.join(versions, '2.1.302')).claudeVersion, '2.1.302')
  assert.equal(Object.hasOwn(infer(path.join(os.homedir(), '.local/bin/claude')), 'claudeVersion'), false)
  assert.equal(Object.hasOwn(infer(path.join(versions, 'not-a-version')), 'claudeVersion'), false)
})
