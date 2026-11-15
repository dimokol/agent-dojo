// Store edges: a failed create_room left a project behind, prototype-key titles and names, history
// reading a folder this project never claimed, and one loose room taking down list_rooms.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn, execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { createStore } from './store.mjs'

const SERVER = path.join(path.dirname(fileURLToPath(import.meta.url)), 'server.mjs')
const HOOK = path.join(path.dirname(fileURLToPath(import.meta.url)), 'claude-session-hook.mjs')
const temp = t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ac203-store-')))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  return root
}
const manual = id => ({ id, runtime: 'manual', endpoint: 'test-only' })
const leftovers = (root, project = 'myproj') => [
  fs.existsSync(path.join(root, 'chats', project)) && `chats/${project}`,
  fs.existsSync(path.join(root, 'state', 'projects')) && fs.readdirSync(path.join(root, 'state', 'projects')).length && 'state/projects/*',
].filter(Boolean)

test('titles that slug to a prototype key make a room, and nothing is created before the name is settled', t => {
  const root = temp(t), project = path.join(root, 'myproj'); fs.mkdirSync(project)
  const store = createStore({ root: path.join(root, 'chats'), stateRoot: path.join(root, 'state'), projectRoot: project })
  // A refused explicit name leaves no project behind.
  assert.throws(() => store.createRoom({ room: 'bad name', title: 't' }), /invalid room/)
  // A post from a session that can't be a member (no project yet) is refused before anything is made.
  assert.throws(() => store.post({ room: 'r', from: 'a', message: 'x', sessionId: 'a' }), /session is not joined as this agent/)
  assert.deepEqual(leftovers(root), [])
  for (const title of ['constructor', 'toString', '__proto__', 'prototype', 'hasOwnProperty']) {
    const made = store.createRoom({ title })
    assert.equal(made.title, title)
    assert.ok(store.listRooms().some(row => row.room === made.room && row.title === title), title)
  }
})

test('names whose lowercase form is a prototype key work as names, and __proto__ in any case is refused', t => {
  const root = temp(t), project = path.join(root, 'myproj'); fs.mkdirSync(project)
  const store = createStore({ root: path.join(root, 'chats'), stateRoot: path.join(root, 'state'), projectRoot: project })
  store.createRoom({ room: 'r', title: 'r' })
  store.join({ room: 'r', agent: 'Constructor', session: manual('a') })
  store.join({ room: 'r', agent: 'Bob', session: manual('b') })
  store.post({ room: 'r', from: 'Bob', to: 'Constructor', message: 'hi', sessionId: 'b' })
  assert.equal(store.pending({ room: 'r', agent: 'Constructor', sessionId: 'a' }).length, 1)
  store.unreadReport()
  assert.throws(() => store.join({ room: 'r', agent: '__PROTO__', session: manual('c') }), /invalid (agent|name)/)
  // The state written with a "constructor" key stays valid: a fresh store reads it.
  assert.equal(createStore({ root: path.join(root, 'chats'), stateRoot: path.join(root, 'state'), projectRoot: project }).members({ room: 'r' }).length, 2)
  // A name only the prototype "owns" is free, not taken.
  assert.throws(() => store.join({ room: 'r', agent: 'Bob', session: manual('d') }), /owned by another session|already joined/)
})

test('history and join ignore a same-named project folder this project never claimed', t => {
  const root = temp(t), project = path.join(root, 'two', 'app'); fs.mkdirSync(project, { recursive: true })
  const foreign = path.join(root, 'chats', 'app', 'rooms', 'main'); fs.mkdirSync(foreign, { recursive: true, mode: 0o700 })
  for (const d of [path.join(root, 'chats'), path.join(root, 'chats', 'app'), path.join(root, 'chats', 'app', 'rooms')]) fs.chmodSync(d, 0o700)
  fs.writeFileSync(path.join(foreign, 'room.json'), JSON.stringify({ id: 'main', title: 'main', created: new Date().toISOString() }), { mode: 0o600 })
  fs.writeFileSync(path.join(foreign, 'chat.jsonl'), JSON.stringify({ id: 'm1', ts: new Date().toISOString(), from: 'X', to: 'all', message: 'foreign', channel: 'main' }) + '\n', { mode: 0o600 })
  const store = createStore({ root: path.join(root, 'chats'), stateRoot: path.join(root, 'state'), projectRoot: project })
  assert.deepEqual(store.history({ room: 'main' }).map(m => m.message), [])
  assert.throws(() => store.join({ room: 'main', agent: 'B', session: manual('b') }), /room does not exist/)
  assert.equal(fs.existsSync(path.join(root, 'chats', 'app', 'project.json')), false)
})

const looseFixture = (t, { dir = true, files = true } = {}) => {
  const root = temp(t)
  const options = { root: path.join(root, 'chats'), projectRoot: path.join(root, 'repo'), stateRoot: path.join(root, 'state') }
  fs.mkdirSync(options.projectRoot)
  let store = createStore(options)
  for (const r of ['good', 'bad']) {
    store.createRoom({ room: r, title: r })
    store.join({ room: r, agent: 'alice', session: manual('a') }); store.join({ room: r, agent: 'bob', session: manual('b') })
    store.post({ room: r, from: 'alice', to: 'bob', message: 'hi', sessionId: 'a' })
  }
  const bad = path.join(store.dir, 'rooms', 'bad')
  if (dir) fs.chmodSync(bad, 0o755)
  if (files) for (const f of fs.readdirSync(bad)) fs.chmodSync(path.join(bad, f), 0o644)
  store = createStore(options)
  return { root, store, bad, options }
}
const fix = dir => `chmod 700 '${dir}' && chmod 600 '${dir}'/*`
for (const variant of [{ name: 'folder 0755 and files 0644', dir: true, files: true }, { name: 'folder 0755', dir: true, files: false }, { name: 'files 0644', dir: false, files: true }]) {
  test(`a loose room (${variant.name}) is listed as damaged with its fix; other rooms keep working`, t => {
    const { store, bad } = looseFixture(t, variant)
    const rooms = store.listRooms()
    assert.ok(rooms.some(r => r.room === 'good' && r.messages === 1), JSON.stringify(rooms))
    const damaged = rooms.find(r => r.room === 'bad')
    assert.equal(damaged?.damaged, true, JSON.stringify(rooms))
    assert.ok(damaged.error.includes(fix(bad)), damaged.error)
    assert.equal(store.post({ room: 'good', from: 'bob', to: 'alice', message: 'ok', sessionId: 'b' }).cursor, 2)
    store.join({ room: 'good', agent: 'carol', session: manual('c') })
    assert.throws(() => store.post({ room: 'bad', from: 'alice', to: 'bob', message: 'x', sessionId: 'a' }),
      error => error.code === 'CHAT_ROOM_UNSAFE' && error.message.startsWith('Room bad ') && error.message.includes(fix(bad)))
    assert.throws(() => store.history({ room: 'bad' }), { code: 'CHAT_ROOM_UNSAFE' })
    // Nothing was chmodded behind the user's back.
    assert.notEqual(fs.statSync(bad).mode & 0o077 || fs.readdirSync(bad).some(f => fs.statSync(path.join(bad, f)).mode & 0o077), 0)
  })
}

test('over MCP, list_rooms lists a loose room as damaged and its own errors name the room and the fix', async t => {
  const { root, bad, options } = looseFixture(t)
  execFileSync('git', ['init', '-q', options.projectRoot])
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('CLAUDE_CODE_')))
  const child = spawn(process.execPath, [SERVER], { cwd: options.projectRoot, env: { ...env, AGENT_CHAT_ROOT: options.root, AGENT_CHAT_STATE_ROOT: options.stateRoot } })
  let out = ''
  child.stdout.on('data', d => { out += d })
  const calls = [['list_rooms', {}], ['history', { room: 'good' }], ['history', { room: 'bad' }]]
  child.stdin.end(calls.map(([name, args], i) => JSON.stringify({ jsonrpc: '2.0', id: i + 1, method: 'tools/call', params: { name, arguments: args } }) + '\n').join(''))
  const killer = setTimeout(() => child.kill(), 15_000)
  await new Promise(resolve => child.on('close', resolve))
  clearTimeout(killer)
  const byId = Object.fromEntries(out.trim().split('\n').filter(Boolean).map(line => JSON.parse(line)).map(m => [m.id, m.result]))
  const rooms = JSON.parse(byId[1].content[0].text)
  assert.ok(rooms.some(r => r.room === 'good') && rooms.find(r => r.room === 'bad')?.damaged, byId[1].content[0].text)
  assert.equal(byId[2].isError, undefined)
  assert.equal(byId[3].isError, true)
  assert.ok(byId[3].content[0].text.startsWith('Room bad ') && byId[3].content[0].text.includes(fix(bad)), byId[3].content[0].text)
  void root
})

test('a loose rooms folder is still refused, and the tab is told at start which folder and how to fix it', t => {
  const { options } = looseFixture(t, { dir: false, files: false })
  execFileSync('git', ['init', '-q', options.projectRoot])
  const store = createStore(options)
  fs.chmodSync(store.roomsDir, 0o755)
  assert.throws(() => createStore(options), /unsafe directory/)
  const env = { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('CLAUDE_CODE_') && !k.startsWith('AGENT_CHAT_'))),
    AGENT_CHAT_ROOT: options.root, AGENT_CHAT_STATE_ROOT: options.stateRoot }
  const input = JSON.stringify({ session_id: '00000000-0000-4000-8000-00000000ab01', source: 'startup', hook_event_name: 'SessionStart', cwd: options.projectRoot })
  const said = JSON.parse(execFileSync(process.execPath, [HOOK], { input, env, encoding: 'utf8', timeout: 30_000 }) || '{}').systemMessage ?? ''
  assert.ok(said.includes(`Agent-chat won't use ${store.roomsDir}`) && said.includes('chmod 700'), said)
  assert.equal(fs.statSync(store.roomsDir).mode & 0o777, 0o755, 'left as the user set it')
})
