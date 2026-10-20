import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { DatabaseSync } from 'node:sqlite'
import { createStore } from './store.mjs'

const moduleUrl = new URL('./store.mjs', import.meta.url).href
const session = (id = 'thread-1') => ({ id, runtime: 'test', endpoint: 'test-only' })
function fixture(t) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-chat-store-test-'))
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }))
  const root = path.join(temp, 'chats'), projectRoot = path.join(temp, 'repo')
  fs.mkdirSync(projectRoot)
  const options = { root, projectRoot }
  return { temp, options, store: createStore(options) }
}
function child(options, action, number = 0) {
  const program = `import {createStore} from ${JSON.stringify(moduleUrl)};
    const s=createStore(JSON.parse(process.argv[1]));
    const action=process.argv[2], n=process.argv[3];
    if(action==='post') for(let i=0;i<12;i++) s.post({room:'parallel',from:'writer'+n,message:n+':'+i,idempotency_key:n+':'+i});
    if(action==='canonical') s.postCanonicalOnly({room:'parallel',from:'same',message:'same',idempotency_key:'one'});
    if(action==='idem') s.post({room:'parallel',from:'same',message:'same',idempotency_key:'one'});
    if(action==='room') s.createRoom({title:'Parallel title'});
    if(action==='join') s.join({room:'parallel',agent:'Reader',session:{id:'session'+n,runtime:'test',endpoint:'test'}});
    if(action==='claim') {
      const message_ids=s.pending({room:'parallel',agent:'Reader',sessionId:'thread-1'}).map(m=>m.message_id);
      process.stdout.write(JSON.stringify(s.claim({room:'parallel',agent:'Reader',sessionId:'thread-1',message_ids})));
    }
    if(action==='ack') {
      const message_ids=s.pending({room:'parallel',agent:'Reader',sessionId:'thread-1'}).map(m=>m.message_id);
      if(message_ids.length) s.ack({room:'parallel',agent:'Reader',sessionId:'thread-1',message_ids});
    }
  `
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, ['--input-type=module', '-e', program, JSON.stringify(options), action, String(number)], { stdio: ['ignore', 'pipe', 'pipe'] })
    let error = '', output = ''
    proc.stdout.on('data', (data) => { output += data })
    proc.stderr.on('data', (data) => { error += data })
    proc.on('error', reject)
    proc.on('close', (code) => code === 0 ? resolve(output) : reject(new Error(error || `child exit ${code}`)))
  })
}

test('direct mail before join, broadcasts and case-insensitive name ownership', (t) => {
  const { store } = fixture(t)
  store.createRoom({ room: 'room', title: 'Room' })
  const before=store.post({ room: 'room', from: 'Sender', to: 'Reader', message: 'before join' })
  store.join({ room: 'room', agent: 'Reader', session: session() })
  assert.throws(()=>store.join({ room: 'room', agent: 'reader', session: session('thread-2') }),/owned/)
  store.join({ room: 'room', agent: 'Other', session: session('thread-2') })
  const addressed = store.post({ room: 'room', from: 'Sender', to: 'Reader', channel: 'Main', message: 'addressed' })
  store.post({ room: 'room', from: 'Sender', to: 'Nobody', message: 'unmatched retained' })
  store.post({ room: 'room', from: 'Reader', message: 'own broadcast' })
  const broadcast = store.post({ room: 'room', from: 'Sender', to: '*', message: 'all joined' })
  assert.deepEqual(store.pending({ room: 'room', agent: 'Reader', sessionId: 'thread-1' }).map((m) => m.message_id), [before.message_id,addressed.message_id, broadcast.message_id])
  assert.equal(store.pending({ room: 'room', agent: 'Other', sessionId: 'thread-2' }).length, 2)
  assert.equal(store.history({ room: 'room', channel: 'Main' }).length, 1)
  assert.equal(store.history({ room: 'room', channel: 'main' }).length, 4)
  assert.equal(store.history({ room: 'room' }).length, 5)
})

test('membership, pending receipts and processing acknowledgements survive restart', (t) => {
  const { options, store } = fixture(t)
  store.createRoom({ room: 'room', title: 'Room' })
  store.join({ room: 'room', agent: 'Reader', session: session() })
  const post = store.post({ room: 'room', from: 'Sender', message: 'durable' })
  store.updateDelivery({ room: 'room', agent: 'Reader', sessionId: 'thread-1', message_ids: [post.message_id], status: 'delivered' })
  const second = createStore(options)
  assert.equal(second.members({ room: 'room' })[0].session.id, 'thread-1')
  assert.equal(second.pending({ room: 'room', agent: 'Reader', sessionId: 'thread-1' })[0].delivery.status, 'delivered')
  second.ack({ room: 'room', agent: 'Reader', sessionId: 'thread-1', message_ids: [post.message_id] })
  second.ack({ room: 'room', agent: 'Reader', sessionId: 'thread-1', message_ids: [post.message_id] })
  const third = createStore(options)
  assert.deepEqual(third.pending({ room: 'room', agent: 'Reader', sessionId: 'thread-1' }), [])
  third.updateDelivery({ room: 'room', agent: 'Reader', sessionId: 'thread-1', message_ids: [post.message_id], status: 'failed' })
  assert.equal(third.deliveryStatus({ room: 'room' })[0].status, 'acked')
  assert.throws(() => third.ack({ room: 'room', agent: 'Reader', sessionId: 'other', message_ids: [post.message_id] }), /not joined/)
  assert.equal(fs.statSync(third.statePath).mode & 0o777, 0o600)
  assert.equal(fs.statSync(path.dirname(third.statePath)).mode & 0o777, 0o700)
})

test('session binding does not pretend registered sessions are live', (t) => {
  const { store } = fixture(t)
  store.createRoom({ room: 'room', title: 'Room' })
  store.join({ room: 'room', agent: 'Reader', session: session() })
  assert.throws(() => store.join({ room: 'room', agent: 'Reader', session: session('other') }), /already joined/)
  assert.throws(() => store.assertMember('room', 'Reader', 'other'), /not joined/)
  store.leave({ room: 'room', agent: 'Reader', sessionId: 'thread-1' })
  store.post({ room: 'room', from: 'Sender', to: 'Reader', message: 'while not joined' })
  assert.deepEqual(store.members({ room: 'room' }), [])
  store.join({ room: 'room', agent: 'Reader', session: session('other') })
  assert.equal(store.pending({ room: 'room', agent: 'Reader', sessionId: 'other' })[0].message, 'while not joined')
})

test('explicit resume replays addressed history; log append recovery routes missed state update', (t) => {
  const { store, options } = fixture(t)
  store.createRoom({ room: 'room', title: 'Room' })
  // Broadcasts keep the audience recorded when posted; addressed mail is replayed.
  store.post({ room: 'room', from: 'Sender', to: 'Reader', message: 'history' })
  store.join({ room: 'room', agent: 'Reader', session: session(), after_cursor: 0 })
  const log = path.join(store.roomsDir, 'room', 'chat.jsonl')
  fs.appendFileSync(log, JSON.stringify({ id: 'crash-event', from: 'Sender', to: 'Reader', channel: 'main', message: 'written before state update', ts: new Date().toISOString() }) + '\n')
  const second = createStore(options)
  assert.deepEqual(second.pending({ room: 'room', agent: 'Reader', sessionId: 'thread-1' }).map((m) => m.message), ['history', 'written before state update'])
})

test('idempotent posts reject mismatched retry payloads', (t) => {
  const { store, options } = fixture(t)
  const first = store.post({ room: 'room', from: 'Sender', message: 'once', idempotency_key: 'request' })
  const retry = createStore(options).post({ room: 'room', from: 'Sender', message: 'once', idempotency_key: 'request' })
  assert.equal(first.message_id, retry.message_id)
  assert.equal(retry.duplicate, true)
  assert.equal(store.history({ room: 'room' }).length, 1)
  assert.throws(() => store.post({ room: 'room', from: 'Sender', message: 'changed', idempotency_key: 'request' }), /different message/)
})

test('multiple processes serialize first room creation, posts and idempotent retries', async (t) => {
  const { options, store } = fixture(t)
  await Promise.all(Array.from({ length: 6 }, (_, n) => child(options, 'post', n)))
  await Promise.all(Array.from({ length: 6 }, (_, n) => child(options, 'idem', n)))
  await Promise.all(Array.from({ length: 4 }, (_, n) => child(options, 'room', n)))
  const records = store.history({ room: 'parallel', limit: 10000 })
  assert.equal(records.length, 73)
  assert.equal(new Set(records.map((m) => m.message_id)).size, 73)
  assert.equal(store.listRooms().length, 5)
  const lines = fs.readFileSync(path.join(store.roomsDir, 'parallel', 'chat.jsonl'), 'utf8').trim().split('\n')
  assert.equal(lines.length, 73)
  assert.equal(lines.filter((line) => JSON.parse(line).message === 'same').length, 1)
})

test('legacy central bucket and canonical record format stay readable', (t) => {
  const { store, options } = fixture(t)
  store.materialize()
  const room = path.join(store.roomsDir, 'legacy')
  fs.mkdirSync(room,{mode:0o700})
  fs.writeFileSync(path.join(room, 'room.json'), JSON.stringify({ id: 'legacy', title: 'Legacy', created: '2026-01-01' }),{mode:0o600})
  fs.writeFileSync(path.join(room, 'chat.jsonl'), JSON.stringify({ id: 'old-id', ts: '2026-01-01', from: 'Old', to: 'all', channel: 'main', reply_to: null, message: 'old message' }) + '\n',{mode:0o600})
  const second = createStore(options)
  assert.equal(second.dir, store.dir)
  assert.equal(second.history({ room: 'legacy' })[0].message_id, 'old-id')
  second.join({ room: 'legacy', agent: 'Reader', session: session(), after_cursor: 0 })
  assert.equal(second.pending({ room: 'legacy', agent: 'Reader', sessionId: 'thread-1' }).length, 1)
})

test('rejects dot segments, prototype keys, symlink directories and symlink logs', (t) => {
  const { store, temp } = fixture(t)
  for (const room of ['.', '..', '__proto__', '../escape']) assert.throws(() => store.post({ room, from: 'Sender', message: 'bad' }), /invalid room/)
  const outside = path.join(temp, 'outside'); fs.mkdirSync(outside)
  store.materialize()
  fs.symlinkSync(outside, path.join(store.roomsDir, 'link'))
  assert.throws(() => store.post({ room: 'link', from: 'Sender', message: 'bad' }), /unsafe directory/)
  store.createRoom({ room: 'room', title: 'Room' })
  const target = path.join(outside, 'log'); fs.writeFileSync(target, '')
  fs.symlinkSync(target, path.join(store.roomsDir, 'room', 'chat.jsonl'))
  assert.throws(() => store.post({ room: 'room', from: 'Sender', message: 'bad' }), /unsafe file/)
  assert.equal(fs.readFileSync(target, 'utf8'), '')
})

test('canonical corruption fails closed instead of shifting cursors', (t) => {
  const { store } = fixture(t)
  store.post({ room: 'room', from: 'Sender', message: 'okay' })
  fs.appendFileSync(path.join(store.roomsDir, 'room', 'chat.jsonl'), '{partial')
  assert.throws(() => store.post({ room: 'room', from: 'Sender', message: 'must not append' }), /incomplete canonical log/)
})

test('same-basename projects get separate buckets', (t) => {
  const { temp, options, store } = fixture(t)
  const other = path.join(temp, 'other', 'repo'); fs.mkdirSync(other, { recursive: true })
  const second = createStore({ root: options.root, projectRoot: other })
  // Folders are claimed on first use, so the second project takes the suffixed name then.
  store.materialize(); second.materialize()
  assert.notEqual(store.project, second.project)
  assert.notEqual(store.dir, second.dir)
  const longName = 'long--project-' + 'x'.repeat(70)
  const longRoot = path.join(temp, longName); fs.mkdirSync(longRoot)
  const long = createStore({ root: options.root, projectRoot: longRoot })
  assert.equal(long.project, longName.replace(/-{2,}/g, '-').slice(0, 64))
})

test('durable claims prevent concurrent duplicate dispatch and remain uncertain across restart', async (t) => {
  const { store, options } = fixture(t)
  store.createRoom({ room: 'parallel', title: 'Parallel' })
  store.join({ room: 'parallel', agent: 'Reader', session: { id: 'thread-1', runtime: 'manual' } })
  const post = store.post({ room: 'parallel', from: 'Sender', message: 'notify once', urgent: true })
  const claims = await Promise.all(Array.from({ length: 5 }, () => child(options, 'claim')))
  assert.equal(claims.map((output) => JSON.parse(output).length).reduce((sum, n) => sum + n, 0), 1)
  const second = createStore(options)
  assert.equal(second.pending({ room: 'parallel', agent: 'Reader', sessionId: 'thread-1' })[0].delivery.status, 'dispatching')
  assert.deepEqual(second.claim({ room: 'parallel', agent: 'Reader', sessionId: 'thread-1', message_ids: [post.message_id] }), [])
  second.updateDelivery({ room: 'parallel', agent: 'Reader', sessionId: 'thread-1', message_ids: [post.message_id], status: 'notified' })
  assert.equal(second.deliveryStatus({})[0].attempts, 1)
  await Promise.all(Array.from({ length: 5 }, () => child(options, 'ack')))
  assert.deepEqual(second.pending({ room: 'parallel', agent: 'Reader', sessionId: 'thread-1' }), [])
  assert.equal(second.deliveryStatus({})[0].status, 'acked')
})

test('concurrent join cannot overwrite another registered session', async (t) => {
  const { store, options } = fixture(t)
  store.createRoom({ room: 'parallel', title: 'Parallel' })
  const joins = await Promise.allSettled(Array.from({ length: 5 }, (_, n) => child(options, 'join', n)))
  assert.equal(joins.filter((result) => result.status === 'fulfilled').length, 1)
  assert.equal(store.members({ room: 'parallel' }).length, 1)
})

test('live SQLite mutex remains held beyond the legacy four-second steal timeout', async t => {
  const { store, options } = fixture(t)
  store.materialize(); store.listRooms() // Initialise the mutex through the production private-file path.
  const db = new DatabaseSync(path.join(path.dirname(store.statePath), '.lock.sqlite'))
  db.exec('BEGIN IMMEDIATE')
  let completed = false
  const posting = child(options, 'idem').then(() => { completed = true })
  await new Promise(resolve => setTimeout(resolve, 4200))
  assert.equal(completed, false)
  db.exec('ROLLBACK'); db.close()
  await posting
  assert.equal(store.history({ room: 'parallel' }).length, 1)
})

test('SIGKILL releases the OS mutex for competing writers without PID or reaper recovery', async t => {
  const { store, options } = fixture(t)
  store.materialize(); store.listRooms()
  const mutex = path.join(path.dirname(store.statePath), '.lock.sqlite')
  const program = `import {DatabaseSync} from 'node:sqlite';
    const db=new DatabaseSync(process.argv[1]);db.exec('BEGIN IMMEDIATE');
    console.log('LOCKED');setInterval(()=>{},1000);`
  const owner = spawn(process.execPath, ['--input-type=module', '-e', program, mutex], { stdio: ['ignore', 'pipe', 'pipe'] })
  t.after(() => owner.kill('SIGKILL'))
  await new Promise((resolve, reject) => { owner.stdout.once('data', resolve); owner.once('error', reject) })
  const exited = new Promise(resolve => owner.once('exit', resolve))
  owner.kill('SIGKILL'); await exited
  await Promise.all(Array.from({ length: 5 }, () => child(options, 'idem')))
  assert.equal(store.history({ room: 'parallel' }).length, 1)
})

test('sender validation and history snapshots prevent impersonation and cache mutation', (t) => {
  const { store } = fixture(t)
  store.createRoom({ room: 'room', title: 'Room' })
  store.join({ room: 'room', agent: 'Sender', session: session() })
  assert.throws(() => store.post({ room: 'room', from: 'Sender', message: 'spoof', sessionId: 'other' }), /not joined/)
  store.post({ room: 'room', from: 'Sender', message: 'valid', sessionId: 'thread-1' })
  store.history({ room: 'room' })[0].message = 'mutated'
  assert.equal(store.history({ room: 'room' })[0].message, 'valid')
  const stat = fs.statSync(store.statePath)
  store.members({ room: 'room' }); store.pending({ room: 'room', agent: 'Sender', sessionId: 'thread-1' })
  assert.equal(fs.statSync(store.statePath).mtimeMs, stat.mtimeMs)
})

test('same-session join refreshes validated metadata while preserving cursor and receipts', (t) => {
  const { store, options } = fixture(t)
  store.createRoom({ room: 'room', title: 'Room' })
  store.join({ room: 'room', agent: 'Reader', session: { id: 'thread-1', runtime: 'test', endpoint: 'old', profileHome: '/old', pid: process.pid }, after_cursor: 0 })
  const post = store.post({ room: 'room', from: 'Sender', message: 'pending', urgent: true })
  store.claim({ room: 'room', agent: 'Reader', sessionId: 'thread-1', message_ids: [post.message_id] })
  const refreshed = store.join({ room: 'room', agent: 'Reader', session: { id: 'thread-1', runtime: 'test', endpoint: 'new', profileHome: '/old', pid: process.pid }, after_cursor: 100 })
  assert.equal(refreshed.session.endpoint, 'new')
  assert.equal(refreshed.session.profileHome, '/old')
  assert.throws(() => store.join({ room: 'room', agent: 'Reader', session: { id: 'thread-1', runtime: 'test', profileHome: '/other' } }), /already joined/)
  assert.equal(refreshed.session.pid, process.pid)
  assert.equal(refreshed.after_cursor, 0)
  assert.equal(refreshed.deliveries[post.message_id].status, 'dispatching')
  assert.equal(createStore(options).members({ room: 'room' })[0].session.endpoint, 'new')
  assert.throws(() => store.join({ room: 'room', agent: 'Reader', session: { id: 'thread-1', runtime: 'test', pid: 0 } }), /positive integer/)
  assert.throws(() => store.join({ room: 'room', agent: 'Reader', session: { id: 'thread-1', runtime: 'test', pid: 1.5 } }), /positive integer/)
})


const damagedMessage = 'Agent-chat delivery state is damaged; operator recovery required'
const damaged = error => error.code === 'CHAT_STATE_DAMAGED' && error.message === damagedMessage

test('damaged delivery metadata fails closed with a generic coded error and remains untouched', t => {
  const { store } = fixture(t)
  store.createRoom({ room: 'room', title: 'Room' })
  store.join({ room: 'room', agent: 'Reader', session: session() })
  const sent = store.post({ room: 'room', from: 'Sender', message: 'canonical mail' })
  const valid = JSON.parse(fs.readFileSync(store.statePath, 'utf8'))
  const log = path.join(store.roomsDir, 'room', 'chat.jsonl')
  const canonical = fs.readFileSync(log, 'utf8')
  const corruptions = ['{private/path-and-value', 'null', '[]', '{}', JSON.stringify({ version: 2, rooms: {} })]
  for (const mutate of [
    state => { state.rooms = [] },
    state => { state.rooms.room.members = null },
    state => { state.rooms.room.routed_cursor = 'unknown' },
    state => { state.rooms.room.members.Reader.session = null },
    state => { state.rooms.room.members.Reader.deliveries[sent.message_id].status = 'invented' },
    state => { state.rooms.room.members.Reader.ring_times = [null] },
  ]) {
    const copy = structuredClone(valid); mutate(copy); corruptions.push(JSON.stringify(copy))
  }
  const identity = { room: 'room', agent: 'Reader', sessionId: 'thread-1' }
  for (const corruption of corruptions) {
    fs.writeFileSync(store.statePath, corruption)
    for (const action of [
      () => store.members({ room: 'room' }), () => store.memberships(),
      () => store.pending(identity), () => store.deliveryStatus({}), () => store.listRooms(),
      () => store.claim({ ...identity, message_ids: [sent.message_id] }),
      () => store.post({ room: 'room', from: 'Sender', message: 'must not append' }),
      () => store.join({ room: 'room', agent: 'New', session: session('new') }),
    ]) assert.throws(action, damaged)
    assert.equal(fs.readFileSync(store.statePath, 'utf8'), corruption)
    assert.equal(fs.readFileSync(log, 'utf8'), canonical)
  }
})

test('internal canonical-only posting preserves damaged state, retries once, and routes after operator repair', t => {
  const { store, options } = fixture(t)
  store.createRoom({ room: 'room', title: 'Room' })
  store.join({ room: 'room', agent: 'Reader', session: session() })
  store.post({ room: 'room', from: 'Sender', to: 'Reader', message: 'before damage' })
  const saved = fs.readFileSync(store.statePath, 'utf8')
  const broken = '{damaged metadata'
  fs.writeFileSync(store.statePath, broken)
  const args = { room: 'room', from: 'Sender', to: 'Reader', message: 'durable during damage', idempotency_key: 'fallback' }
  const sent = store.postCanonicalOnly(args)
  assert.equal(sent.cursor, 2)
  const retried = store.postCanonicalOnly(args)
  assert.equal(retried.duplicate, true)
  assert.equal(retried.message_id, sent.message_id)
  assert.throws(() => store.postCanonicalOnly({ ...args, message: 'changed retry' }), /idempotency key reused/)
  assert.throws(() => store.postCanonicalOnly({ ...args, message: '' }), /message must contain/)
  assert.throws(() => store.postCanonicalOnly({ ...args, room: '../escape' }), /invalid room/)
  assert.equal(fs.readFileSync(store.statePath, 'utf8'), broken)
  const log = path.join(store.roomsDir, 'room', 'chat.jsonl')
  const rows = fs.readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse)
  assert.equal(rows.length, 2)
  assert.equal(rows[1].id, sent.message_id)
  assert.match(fs.readFileSync(path.join(store.roomsDir, 'room', 'chat.md'), 'utf8'), /durable during damage/)
  assert.throws(() => store.memberships(), damaged)
  // Only the test's simulated operator restores the last valid metadata. A new
  // store then catches up from canonical JSONL; the fallback itself never reset it.
  fs.writeFileSync(store.statePath, saved)
  const repaired = createStore(options)
  const inbox = repaired.pending({ room: 'room', agent: 'Reader', sessionId: 'thread-1' })
  assert.equal(inbox.length, 2)
  assert.equal(inbox[1].message_id, sent.message_id)
  assert.equal(inbox[1].delivery.status, 'pending')
  assert.equal(inbox[1].delivery.attempts, 0)
})

test('canonical-only workers share the normal room mutex and deduplicate without metadata', async t => {
  const { store, options } = fixture(t)
  store.createRoom({ room: 'parallel', title: 'Parallel' })
  fs.writeFileSync(store.statePath, '{broken')
  await Promise.all(Array.from({ length: 5 }, () => child(options, 'canonical')))
  const rows = fs.readFileSync(path.join(store.roomsDir, 'parallel', 'chat.jsonl'), 'utf8').trim().split('\n').map(JSON.parse)
  assert.equal(rows.length, 1)
  assert.equal(rows[0].idempotency_key, 'one')
  assert.equal(fs.readFileSync(store.statePath, 'utf8'), '{broken')
  const retried = store.postCanonicalOnly({ room: 'parallel', from: 'same', message: 'same', idempotency_key: 'one' })
  assert.equal(retried.duplicate, true)
})

test('canonical-only transcript failure still reports a durable post without resetting damaged metadata', t => {
  const { store, temp } = fixture(t)
  store.createRoom({ room: 'room', title: 'Room' })
  fs.writeFileSync(store.statePath, '{broken')
  const target = path.join(temp, 'unrelated-transcript')
  fs.writeFileSync(target, 'untouched')
  const transcript = path.join(store.roomsDir, 'room', 'chat.md')
  fs.unlinkSync(transcript); fs.symlinkSync(target, transcript)
  const sent = store.postCanonicalOnly({ room: 'room', from: 'Sender', message: 'safe canonical write', idempotency_key: 'derived-failure' })
  assert.equal(sent.transcript_error, 'Derived transcript could not be updated; canonical post is durable')
  assert.equal(fs.readFileSync(target, 'utf8'), 'untouched')
  assert.equal(JSON.parse(fs.readFileSync(path.join(store.roomsDir, 'room', 'chat.jsonl'), 'utf8')).id, sent.message_id)
  assert.equal(fs.readFileSync(store.statePath, 'utf8'), '{broken')
})
