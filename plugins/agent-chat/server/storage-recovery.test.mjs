// Recovery from damaged or failed writes, and one state per chat root. Found in review of PR #6.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createStore } from './store.mjs'
const session = id => ({ id, runtime: 'test', endpoint: 'test-only' })
function fixture(t, extra = {}) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'fix-'))
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }))
  const options = { root: path.join(temp, 'chats'), projectRoot: path.join(temp, 'repo'), ...extra }
  fs.mkdirSync(options.projectRoot)
  const store = createStore(options)
  store.createRoom({ room: 'r', title: 'r' })
  store.join({ room: 'r', agent: 'alice', session: session('a') }); store.join({ room: 'r', agent: 'bob', session: session('b') })
  return { temp, options, store }
}
test('M2: a write that fails partway leaves the log readable', t => {
  const { store } = fixture(t), real = fs.writeFileSync
  t.after(() => { fs.writeFileSync = real })
  fs.writeFileSync = (fd, data, ...rest) => {
    if (typeof fd === 'number' && String(data).startsWith('{"from_id"')) { fs.writeSync(fd, String(data).slice(0, 20)); throw Object.assign(new Error('ENOSPC'), { code: 'ENOSPC' }) }
    return real(fd, data, ...rest)
  }
  assert.throws(() => store.post({ room: 'r', from: 'alice', to: 'bob', message: 'x', sessionId: 'a' }), /ENOSPC/)
  fs.writeFileSync = real
  assert.equal(store.post({ room: 'r', from: 'alice', to: 'bob', message: 'y', sessionId: 'a' }).cursor, 1)
})
test('M3: a torn log in one room does not block joins elsewhere', t => {
  const { store } = fixture(t)
  store.post({ room: 'r', from: 'alice', message: 'hi', sessionId: 'a' })
  fs.appendFileSync(path.join(store.dir, 'rooms/r/chat.jsonl'), '{"torn')
  store.createRoom({ room: 'q', title: 'q' })
  assert.equal(store.join({ room: 'q', agent: 'carol', session: session('c') }).agent, 'carol')
})
test('L7: a symlinked parent of the root keys the same state', t => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'fix-'))
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }))
  fs.mkdirSync(path.join(temp, 'real')); fs.symlinkSync(path.join(temp, 'real'), path.join(temp, 'link')); fs.mkdirSync(path.join(temp, 'repo'))
  // Both spellings open the same fresh project before either writes, as two tabs do; either order.
  const stateRoot = path.join(temp, 'state')
  for (const [first, second] of [['real', 'link'], ['link', 'real']]) {
    const repo = path.join(temp, `repo-${first}`); fs.mkdirSync(repo)
    const a = createStore({ root: path.join(temp, first, 'chats'), projectRoot: repo, stateRoot })
    const b = createStore({ root: path.join(temp, second, 'chats'), projectRoot: repo, stateRoot })
    assert.equal(path.basename(path.dirname(a.statePath)), path.basename(path.dirname(b.statePath)), `${first} first`)
    a.createRoom({ room: 'r', title: 'r' })
    a.join({ room: 'r', agent: 'bob', session: session('b') }); b.join({ room: 'r', agent: 'carol', session: session('c') })
    assert.deepEqual(a.members({ room: 'r' }).map(member => member.agent).sort(), ['bob', 'carol'], `${first} first`)
  }
})
test('L9: a post whose state write fails still reports the durable message', t => {
  const { store } = fixture(t), real = fs.renameSync
  t.after(() => { fs.renameSync = real })
  let armed = true
  fs.renameSync = (from, to) => { if (armed && to.endsWith('state.json')) { armed = false; throw Object.assign(new Error('ENOSPC'), { code: 'ENOSPC' }) } return real(from, to) }
  const result = store.post({ room: 'r', from: 'alice', to: 'bob', message: 'once', sessionId: 'a' })
  assert.equal(result.cursor, 1); assert.ok(result.state_error)
  fs.renameSync = real
  assert.deepEqual(store.pending({ room: 'r', agent: 'bob', sessionId: 'b' }).map(m => m.message), ['once'])
})
test('L10: mail after a log is replaced by a shorter copy is delivered', t => {
  const { store } = fixture(t)
  for (let i = 0; i < 3; i++) store.post({ room: 'r', from: 'alice', to: 'bob', message: `old ${i}`, sessionId: 'a' })
  const log = path.join(store.dir, 'rooms/r/chat.jsonl'), tmp = log + '.new'
  fs.writeFileSync(tmp, fs.readFileSync(log, 'utf8').split('\n')[0] + '\n', { mode: 0o600 }); fs.renameSync(tmp, log)
  store.post({ room: 'r', from: 'alice', to: 'bob', message: 'new', sessionId: 'a' })
  assert.ok(store.pending({ room: 'r', agent: 'bob', sessionId: 'b' }).some(m => m.message === 'new'))
})
