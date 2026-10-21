import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawn } from 'node:child_process'
import { createStore } from './store.mjs'
import { createService } from './server.mjs'
import { processIdentity } from './native-session.mjs'
import { projectNoticeId } from './notices.mjs'

// The third round of review on PR #6: each test fails without its fix.
const UUID = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
function temp(t, tag) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `agent-chat-${tag}-`)))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  return dir
}
function linkedRoot(t, tag) {
  const dir = temp(t, tag), project = path.join(dir, 'project'), stateRoot = path.join(dir, 'state')
  fs.mkdirSync(project); fs.mkdirSync(path.join(dir, 'real')); fs.symlinkSync(path.join(dir, 'real'), path.join(dir, 'link'))
  const key = root => crypto.createHash('sha256').update(root + '\n' + fs.realpathSync(project)).digest('hex').slice(0, 24)
  const linked = path.join(dir, 'link', 'chats'), real = path.join(dir, 'real', 'chats')
  return { project, stateRoot, linked, real, projects: path.join(stateRoot, 'projects'), linkedKey: key(linked), realKey: key(real) }
}

test('S1: every spelling of a chat root shares one state, even when two tabs open a fresh project together', t => {
  for (const order of [['linked', 'real'], ['real', 'linked']]) {
    const f = linkedRoot(t, 's1')
    // Both stores open before either writes, as two tabs starting at once do.
    const first = createStore({ root: f[order[0]], projectRoot: f.project, stateRoot: f.stateRoot })
    const second = createStore({ root: f[order[1]], projectRoot: f.project, stateRoot: f.stateRoot })
    first.createRoom({ room: 'room', title: 'room' })
    first.join({ room: 'room', agent: 'bob', session: { id: 'bob', runtime: 'manual' } })
    second.join({ room: 'room', agent: 'carol', session: { id: 'carol', runtime: 'manual' } })
    assert.deepEqual(fs.readdirSync(f.projects), [f.realKey], order.join(' then '))
    assert.deepEqual(first.members({ room: 'room' }).map(member => member.agent).sort(), ['bob', 'carol'])
    assert.equal(projectNoticeId(f.linked, f.project), f.realKey)
  }
})

test('S2: when both keys hold state, the resolved one is kept and the other is left alone', t => {
  const f = linkedRoot(t, 's2')
  const real = createStore({ root: f.real, projectRoot: f.project, stateRoot: f.stateRoot })
  real.createRoom({ room: 'room', title: 'room' })
  real.join({ room: 'room', agent: 'carol', session: { id: 'carol', runtime: 'manual' } })
  // A folder an older server made under the linked spelling, beside the resolved one.
  fs.cpSync(path.join(f.projects, f.realKey), path.join(f.projects, f.linkedKey), { recursive: true })
  const linked = createStore({ root: f.linked, projectRoot: f.project, stateRoot: f.stateRoot })
  assert.equal(path.basename(path.dirname(linked.statePath)), f.realKey)
  assert.deepEqual(fs.readdirSync(f.projects).sort(), [f.linkedKey, f.realKey].sort())
})

test('S3: with the check off, a tab whose version can\'t be looked up still shows as wakeable', async t => {
  const dir = temp(t, 's3'), home = process.env.HOME, check = process.env.AGENT_CHAT_VERSION_CHECK
  const child = spawn('sleep', ['60'], { stdio: 'ignore' }); t.after(() => child.kill())
  for (let i = 0; i < 50 && !processIdentity(child.pid); i++) await new Promise(resolve => setTimeout(resolve, 20))
  const client = processIdentity(child.pid)
  const store = createStore({ root: path.join(dir, 'chats'), projectRoot: dir }); store.createRoom({ room: 'room', title: 'room' })
  store.join({ room: 'room', agent: 'tab', session: { id: UUID(1), runtime: 'claude', clientPid: client.pid, clientStart: client.start } })
  const service = createService({ store, env: {}, adapters: { async alive() { return true }, async deliver() { return { status: 'accepted' } } } })
  // No Claude install in this HOME, as with a prerelease build: the version lookup throws.
  process.env.HOME = dir; process.env.AGENT_CHAT_VERSION_CHECK = 'off'
  try { assert.equal((await service.call('members', { room: 'room' })).find(row => row.name === 'tab').wakeable, true) }
  finally { process.env.HOME = home; if (check === undefined) delete process.env.AGENT_CHAT_VERSION_CHECK; else process.env.AGENT_CHAT_VERSION_CHECK = check; service.close() }
})

test('S4: a process check that failed reads as unknown, not as another tab holding the rooms', async t => {
  const dir = temp(t, 's4'), profile = path.join(dir, 'profile'); fs.mkdirSync(profile, { mode: 0o700 })
  const self = processIdentity(process.pid), clients = []
  for (let n = 0; n < 2; n++) {
    const child = spawn('sleep', ['60'], { stdio: 'ignore' }); t.after(() => child.kill())
    for (let i = 0; i < 50 && !processIdentity(child.pid); i++) await new Promise(resolve => setTimeout(resolve, 20))
    clients.push(processIdentity(child.pid))
  }
  const tab = n => ({ runtime: 'claude', id: UUID(n), profileHome: profile, endpoint: `/private/tab${n}.sock`, clientPid: clients[n - 1].pid, clientStart: clients[n - 1].start, serverPid: self.pid, serverStart: self.start })
  const options = { root: path.join(dir, 'chats'), stateRoot: path.join(dir, 'state'), projectRoot: dir }
  createStore(options).createRoom({ room: 'room', title: 'room' })
  const service = (session, isLive) => createService({ store: createStore(options), env: {}, adapters: { async deliver() { return { attempted: false, status: 'pending' } } },
    inferSession: () => session, resolveConversation: () => UUID(99), claudeVerified: () => true, isLive })
  const a = service(tab(1), () => true), b = service(tab(2), () => { throw new Error('ps timed out') })
  try {
    await a.call('join_room', { room: 'room', agent: 'PM' })
    await assert.rejects(b.call('post', { room: 'room', from: 'PM', to: 'all', message: 'hi' }), /^Error: Native Claude session check timed out; retry$/)
  } finally { a.close(); b.close() }
})
