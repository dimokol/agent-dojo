// "Unknown" is never read as a definite answer: a ps, lsof or git that failed, timed out or listed
// nothing means unknown, never closed, not registered or not native. Also the hot path: one ps
// listing per call shared by every Claude recipient, and one lsof per tab.
import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { needsModuleMocks, install, reset, mode, calls, count, START, tempRoot } from './ac203-fake-procs.mjs'

if (!needsModuleMocks(import.meta.url)) await define()

async function define() {
  // A native install under a private HOME, so the trusted-executable check passes without the real one.
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ac203-home-')))
  after(() => fs.rmSync(home, { recursive: true, force: true }))
  const versions = path.join(home, '.local/share/claude/versions'); fs.mkdirSync(versions, { recursive: true, mode: 0o755 })
  for (const dir of [path.join(home, '.local/share/claude'), versions]) fs.chmodSync(dir, 0o755)
  const EXE = path.join(versions, '2.1.296'); fs.writeFileSync(EXE, '', { mode: 0o755 })
  fs.mkdirSync(path.join(home, '.local/bin'), { recursive: true }); fs.symlinkSync(EXE, path.join(home, '.local/bin/claude'))
  process.env.HOME = home
  install()
  const { inferNativeSession } = await import('./native-session.mjs')
  const { resolveClaudeConversation, claudeLifecycleAncestors } = await import('./claude-lifecycle.mjs')
  const { projectRoot } = await import('./project-scope.mjs')
  const { createAdapters } = await import('./adapters.mjs')
  const { createService } = await import('./server.mjs')
  const { createStore } = await import('./store.mjs')
  const { createController } = await import('./controller.mjs')

  const ID = '00000000-0000-4000-8000-0000000000a1', CONV = '00000000-0000-4000-8000-0000000000c1'
  const fixture = t => {
    const root = tempRoot(t, 'uv'), profile = path.join(root, 'profile'), project = path.join(root, 'project')
    fs.mkdirSync(profile, { mode: 0o700 }); fs.mkdirSync(project, { mode: 0o700 })
    const store = createStore({ root: path.join(root, 'chats'), stateRoot: path.join(root, 'state'), projectRoot: project })
    return { root, profile, project, store, stateRoot: path.join(root, 'state') }
  }
  const session = (profile, extra = {}) => ({ runtime: 'claude', id: ID, profileHome: profile, endpoint: '/private/agent-chat-uv.sock',
    clientPid: process.pid, clientStart: START, serverPid: process.pid, serverStart: START, ...extra })
  const services = []
  test.afterEach(() => { for (const s of services.splice(0)) try { s.close() } catch {} ; reset() })

  test('a ps -ax that exits 0 with no rows is unknown to resolveClaudeConversation and the ancestor walk, not "no record"', t => {
    const { profile, project, stateRoot } = fixture(t)
    mode.psAx = 'empty0'
    assert.throws(() => resolveClaudeConversation(session(profile), { stateRoot, projectRoot: project }), { code: 'CHAT_CLAUDE_LIFECYCLE_UNAVAILABLE' })
    assert.throws(() => claudeLifecycleAncestors(process.pid), { code: 'CHAT_CLAUDE_LIFECYCLE_UNAVAILABLE' })
    // A listing that has rows but leaves out a PID that still exists is just as untrustworthy.
    mode.psAx = 'ok'; mode.extraPids = []
    assert.throws(() => claudeLifecycleAncestors(process.ppid), { code: 'CHAT_CLAUDE_LIFECYCLE_UNAVAILABLE' })
  })

  test('delivery_status does not report not_registered when ps -ax lists nothing', async t => {
    const { store, profile } = fixture(t)
    const svc = createService({ store, env: {}, adapters: { async deliver() { return { status: 'accepted' } } }, inferSession: () => session(profile) }); services.push(svc)
    await svc.call('join_room', { room: 'r', agent: 'Me' })
    mode.psAx = 'empty0'
    const rows = await svc.call('delivery_status', { room: 'r', agent: 'Me' })
    assert.deepEqual(rows.filter(row => row.status === 'not_registered'), [])
  })

  test('alive() with live pids and a ps -ax listing nothing is unknown (throws), not closed', async t => {
    const { root, profile, project } = fixture(t)
    const adapters = createAdapters({ stateRoot: path.join(root, 'state'), control: {} })
    mode.psAx = 'empty0'
    await assert.rejects(adapters.alive(session(profile, { conversationId: CONV, lifecycle: true }), project), { code: 'CHAT_CLAUDE_LIFECYCLE_UNAVAILABLE' })
  })

  test('a post to a Claude tab does not deactivate it when ps -ax lists nothing', async t => {
    const { root, profile, store } = fixture(t)
    store.createRoom({ room: 'r', title: 'r' })
    store.join({ room: 'r', agent: 'Peer', session: session(profile, { id: '00000000-0000-4000-8000-0000000000e2', conversationId: CONV, lifecycle: true, claudeVersion: '2.1.296' }) })
    store.join({ room: 'r', agent: 'Sender', session: { runtime: 'manual', id: 'sender' } })
    const controller = createController({ store, adapters: createAdapters({ stateRoot: path.join(root, 'state'), control: {}, verifiedClaudeVersion: () => true }) })
    store.post({ room: 'r', from: 'Sender', to: 'Peer', message: 'hi', sessionId: 'sender' })
    mode.psAx = 'empty0'
    const out = await controller.dispatch('r')
    assert.equal(store.memberships().find(m => m.agent === 'Peer').joined, true, JSON.stringify(out))
  })

  test('a ps timeout while reading the parent command is unknown (CHAT_PRESENCE_UNAVAILABLE), not "not native"', t => {
    const { profile } = fixture(t)
    mode.psComm = 'timeout'
    const env = { CLAUDE_CODE_SESSION_ID: ID, CLAUDE_CODE_MESSAGING_SOCKET: '/private/agent-chat-uv.sock', CLAUDE_CONFIG_DIR: profile }
    assert.throws(() => inferNativeSession(undefined, env, { pid: process.pid, ppid: process.pid }), { code: 'CHAT_PRESENCE_UNAVAILABLE' })
    mode.psComm = 'empty0'
    assert.throws(() => inferNativeSession(undefined, env, { pid: process.pid, ppid: process.pid }), { code: 'CHAT_PRESENCE_UNAVAILABLE' })
  })

  test('the server reports a ps timeout during the native check as busy (retry), not "not recognised"', async t => {
    const { store } = fixture(t)
    const svc = createService({ store, env: { CLAUDE_CODE_SESSION_ID: ID }, adapters: {},
      inferSession: () => { throw Object.assign(new Error('x'), { code: 'CHAT_PRESENCE_UNAVAILABLE' }) } }); services.push(svc)
    const { transientError } = await import('./server.mjs')
    await assert.rejects(svc.call('join_room', { room: 'r', agent: 'Me' }), error => transientError(error) && !/not recognised/.test(error.message))
  })

  test('a ps timeout when the MCP server starts does not stop it; identity is looked up on first need', async t => {
    const { root } = fixture(t)
    const here = path.dirname(fileURLToPath(import.meta.url))
    const child = spawnSync(process.execPath, ['--experimental-test-module-mocks', '--input-type=module', '-e', `
      import { install, mode } from ${JSON.stringify(path.join(here, 'ac203-fake-procs.mjs'))}
      install(); mode.psP = 'timeout'
      const { createService } = await import(${JSON.stringify(path.join(here, 'server.mjs'))})
      const { createStore } = await import(${JSON.stringify(path.join(here, 'store.mjs'))})
      const store = createStore({ root: ${JSON.stringify(path.join(root, 'c2'))}, stateRoot: ${JSON.stringify(path.join(root, 's2'))}, projectRoot: ${JSON.stringify(path.join(root, 'project'))} })
      let s
      await store.createRoom({ room: 'r', title: 'r' })
      try { s = createService({ store, env: {}, adapters: { async deliver() { return { status: 'accepted' } } }, inferSession: () => null }) } catch (e) { console.log('THREW', e.code); process.exit(0) }
      try { await s.call('join_room', { room: 'r', agent: 'm', session: { runtime: 'manual', id: 'm' } }); console.log('JOINED') } catch (e) { console.log('CALL', e.code) }
      mode.psP = 'ok'
      try { await s.call('join_room', { room: 'r', agent: 'm', session: { runtime: 'manual', id: 'm' } }); console.log('JOINED') } catch (e) { console.log('CALL', e.code, e.message) }
      s.close()
    `], { encoding: 'utf8', env: { ...process.env } })
    // Started; the first call while ps still times out is busy; the next one works.
    assert.equal(child.stdout.trim(), 'CALL CHAT_PRESENCE_UNAVAILABLE\nJOINED', child.stderr.slice(0, 400))
  })

  test('strict projectRoot: a git that failed to start (EAGAIN) is unknown, and so is a Codex worktree tab', async t => {
    const { root, project } = fixture(t)
    mode.git = 'eagain'
    assert.throws(() => projectRoot(project, { strict: true }), /Project scope unavailable/)
    assert.equal(projectRoot(project), fs.realpathSync(project), 'non-strict callers keep the folder')
    const worktree = path.join(root, 'worktree'); fs.mkdirSync(worktree)
    const adapters = createAdapters({ stateRoot: path.join(root, 'state'), control: { inspect: async () => ({ loaded: true, cwd: worktree }) } })
    await assert.rejects(adapters.alive({ runtime: 'codex', id: '00000000-0000-4000-8000-0000000000d1' }, fs.realpathSync(project)))
    // git's own answer (not a repository) still keeps the folder in strict mode.
    mode.git = 'exit128'
    assert.equal(projectRoot(project, { strict: true }), fs.realpathSync(project))
  })

  test('delivery_status reuses the tab\'s cached process check instead of ps -ax + lsof per call', async t => {
    const { store, profile } = fixture(t)
    // A PID of its own: the per-process executable cache must not carry over from another test.
    mode.exe = EXE; mode.extraPids = [900010]
    const svc = createService({ store, env: {}, adapters: { async deliver() { return { status: 'accepted' } } }, inferSession: () => session(profile, { clientPid: 900010 }) }); services.push(svc)
    await svc.call('join_room', { room: 'r', agent: 'Me' })
    calls.length = 0
    for (let i = 0; i < 3; i++) await svc.call('delivery_status', { room: 'r', agent: 'Me' })
    assert.equal(count('psAx', 'lsof'), 0, JSON.stringify(calls))
  })

  test('a post to three Claude tabs runs one ps listing and one lsof per tab, then none for the version', async t => {
    const { root, profile, store } = fixture(t)
    mode.exe = EXE; mode.extraPids = [900001, 900002, 900003]
    store.createRoom({ room: 'r', title: 'r' })
    store.join({ room: 'r', agent: 'S', session: { runtime: 'manual', id: 's' } })
    mode.extraPids.forEach((pid, i) => store.join({ room: 'r', agent: `Peer${i}`, session: { runtime: 'claude', id: `00000000-0000-4000-8000-00000000010${i}`, profileHome: profile,
      endpoint: `/private/agent-chat-hot${i}.sock`, clientPid: pid, clientStart: START, conversationId: `00000000-0000-4000-8000-00000000020${i}`, lifecycle: true } }))
    const { EventEmitter } = await import('node:events')
    const connect = () => { const socket = new EventEmitter(); socket.destroy = () => {}; socket.write = (_d, done) => setImmediate(done); setImmediate(() => socket.emit('connect')); return socket }
    // The socket and lifecycle record are stand-ins; the ancestor walk (ps + lsof) is the real one.
    const resolveConversation = (s, options) => options.ancestors(s.clientPid)[0]?.trusted ? s.conversationId : null
    const adapters = createAdapters({ stateRoot: path.join(root, 'state'), control: {}, verifiedClaudeVersion: () => true, connect, resolveConversation })
    const controller = createController({ store, adapters })
    store.post({ room: 'r', from: 'S', message: 'x', urgent: true, sessionId: 's' })
    calls.length = 0
    const out = await controller.dispatch('r')
    assert.deepEqual(out.map(row => row.transport).sort(), ['rung', 'rung', 'rung'], JSON.stringify(out))
    const first = { psAx: count('psAx'), psP: count('psP'), lsof: count('lsof') }
    t.diagnostic(`first post to 3 Claude tabs: ${JSON.stringify(first)}`)
    assert.deepEqual(first, { psAx: 1, psP: 0, lsof: 3 })
  })
}
