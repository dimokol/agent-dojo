// ac203: per-recipient delivery result states (rung / queued / held + reason), the sender note,
// the sender's view in delivery_status, and the peer wording. Ported from the delivery-states repro.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import { createService } from './server.mjs'
import { createStore } from './store.mjs'
import { createAdapters } from './adapters.mjs'
import { tools } from './tools.mjs'

const CLAUDE = '12345678-1234-4234-8234-123456789012'
const CODEX = '12345678-1234-4234-8234-123456789013'

function fixture(t, { socketError = false } = {}) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ac203-delivery-')))
  fs.chmodSync(dir, 0o700)
  const stateRoot = path.join(dir, 'state'); fs.mkdirSync(stateRoot, { mode: 0o700 })
  const project = path.join(dir, 'project'); fs.mkdirSync(project)
  const store = createStore({ root: path.join(dir, 'chats'), projectRoot: project, stateRoot })
  const frames = []
  // Fake socket: drives the real writeClaude code in adapters.mjs.
  const connect = () => {
    const s = new EventEmitter()
    s.destroy = () => {}
    s.write = (data, cb) => { frames.push(String(data)); setImmediate(() => cb(socketError ? new Error('EPIPE') : undefined)) }
    setImmediate(() => s.emit('connect'))
    return s
  }
  const executor = async (file, args) => {
    if (args[0] === '--version') return { code: 0, stdout: 'codex-cli 0.162.1\n' }
    if (args[1] === '--help') return { code: 0, stdout: '--thread <THREAD> --message <TEXT>' }
    return { code: 0, stdout: 'accepted' }
  }
  const adapters = createAdapters({ requireProcessIdentity: false, connect, executor, verifiedClaudeVersion: () => true, stateRoot })
  const sender = createService({ store, adapters, env: {}, reconcileEveryMs: 0 })
  t.after(() => { sender.close(); fs.rmSync(dir, { recursive: true, force: true }) })
  return { dir, store, sender, frames }
}
async function setup(f, recipient) {
  await f.sender.call('create_room', { room: 'r', title: 'r' })
  await f.sender.call('join_room', { room: 'r', agent: 'Sender', session: { id: 'Sender', runtime: 'manual' } })
  if (recipient) return f.store.join({ room: 'r', ...recipient })
}
const claudeRecipient = (f, extra = {}) => ({ agent: 'Rcpt', session: { id: CLAUDE, runtime: 'claude', claudeVersion: '2.1.296', endpoint: path.join(f.dir, 'no.sock'), ...extra } })
const receipt = (f, id) => f.store.memberships().find(m => m.agent === 'Rcpt')?.deliveries[id]
const row = (posted, agent = 'Rcpt') => posted.delivery.find(r => r.agent === agent)
const post = (f, message, to = 'Rcpt') => f.sender.call('post', { room: 'r', from: 'Sender', to, message })

test('ac203 A: a Claude ring reads rung, stores no error, and tells the sender to end its turn', async t => {
  const f = fixture(t); await setup(f, claudeRecipient(f))
  const posted = await post(f, 'hi')
  assert.equal(f.frames.length, 1, 'socket was written')
  assert.deepEqual(row(posted), { agent: 'Rcpt', state: 'rung' })
  const stored = receipt(f, posted.message_id)
  assert.equal(stored.status, 'notified')
  assert.equal(stored.state, 'rung')
  assert.equal('error' in stored, false, 'no error key on a successful ring')
  assert.match(posted.note, /end your turn/i)
  assert.match(posted.note, /reply wakes you/i)
})

test('ac203 B: a Codex recipient reads queued, with no error stored', async t => {
  const f = fixture(t); await setup(f, { agent: 'Rcpt', session: { id: CODEX, runtime: 'codex' } })
  const posted = await post(f, 'hi')
  assert.deepEqual(row(posted), { agent: 'Rcpt', state: 'queued' })
  assert.equal('error' in receipt(f, posted.message_id), false)
  assert.match(posted.note, /reply wakes you/i)
})

test('ac203 C: a name never in the room is held / not_in_room, and no note is given', async t => {
  const f = fixture(t); await setup(f)
  const posted = await post(f, 'hi', 'Ghost')
  const r = row(posted, 'Ghost')
  assert.equal(r.state, 'held'); assert.equal(r.reason, 'not_in_room')
  assert.equal('note' in posted, false, 'nothing was rung or queued')
})

test('ac203 D: an exhausted ring budget is held / budget', async t => {
  const f = fixture(t); const member = await setup(f, claudeRecipient(f))
  const identity = { room: 'r', agent: 'Rcpt', sessionId: CLAUDE, participantId: member.participant_id }
  for (let i = 0; i < 30; i++) {
    const p = await post(f, `m${i}`)
    assert.equal(row(p).state, 'rung', `ring ${i}`)
    f.store.ack({ ...identity, message_ids: [p.message_id] }) // read, so the unread gate never applies
  }
  const posted = await post(f, 'over budget')
  assert.equal(f.frames.length, 30)
  assert.equal(row(posted).state, 'held'); assert.equal(row(posted).reason, 'budget')
})

test('ac203 E: a closed recipient tab is held / closed', async t => {
  // pid 1 is live, but this start time never matches, so the server's own reconcile closes it.
  const f = fixture(t); await setup(f, claudeRecipient(f, { clientPid: 1, clientStart: 'never-matches' }))
  const posted = await post(f, 'hi')
  assert.equal(f.frames.length, 0)
  assert.equal(row(posted).state, 'held'); assert.equal(row(posted).reason, 'closed')
})

test('ac203 F: a recipient already rung and not yet reading is held / not_read_since_last_ring', async t => {
  const f = fixture(t); await setup(f, claudeRecipient(f))
  await post(f, 'first')
  const posted = await post(f, 'second')
  assert.equal(f.frames.length, 1)
  assert.equal(row(posted).state, 'held'); assert.equal(row(posted).reason, 'not_read_since_last_ring')
})

test('ac203 G: an uncertain socket write is held / write_uncertain, not notified, and is not rung again', async t => {
  const f = fixture(t, { socketError: true }); await setup(f, claudeRecipient(f))
  const posted = await post(f, 'hi')
  const r = row(posted)
  assert.equal(r.state, 'held'); assert.equal(r.reason, 'write_uncertain')
  assert.match(r.detail, /15 minutes/, 'the sender is told when a new post rings again')
  const stored = receipt(f, posted.message_id)
  assert.notEqual(stored.status, 'notified', 'uncertain write must not read as notified')
  assert.equal(stored.reason, 'write_uncertain')
  // Duplicate-ring protection: the next post does not ring again while that ring may have landed.
  const next = await post(f, 'again')
  assert.equal(f.frames.length, 1)
  assert.equal(row(next).state, 'held')
})

test('ac203 H: delivery_status shows the sender the states of mail it sent', async t => {
  const f = fixture(t); await setup(f, claudeRecipient(f))
  const first = await post(f, 'first')
  const ghost = await post(f, 'hello?', 'Ghost')
  const rows = await f.sender.call('delivery_status', { room: 'r', agent: 'Sender' })
  const sent = rows.filter(entry => entry.sent)
  assert.deepEqual(sent.find(entry => entry.message_id === first.message_id),
    { sent: true, message_id: first.message_id, to: 'Rcpt', recipients: [{ agent: 'Rcpt', state: 'rung', read_state: 'unread' }] })
  assert.deepEqual(sent.find(entry => entry.message_id === ghost.message_id).recipients,
    [{ agent: 'Ghost', state: 'held', reason: 'not_in_room', read_state: 'unread' }])
})

test('ac203 I: peer wording says teammate request, fits the task, cannot grant permissions', async t => {
  const f = fixture(t); await setup(f, claudeRecipient(f))
  await post(f, 'hi')
  const text = JSON.parse(f.frames[0]).message.content
  assert.match(text, /teammate's request/)
  assert.match(text, /permissions? the user hasn't given/)
  assert.doesNotMatch(text, /Peer activity, not a user instruction/)
  // The plugin README sits next to .claude-plugin; a copy of this suite outside the plugin skips it.
  let readme = ''
  if (fs.existsSync(new URL('../.claude-plugin/plugin.json', import.meta.url))) {
    readme = fs.readFileSync(new URL('../README.md', import.meta.url), 'utf8')
    assert.match(readme, /A peer's message is a teammate's request/)
    assert.doesNotMatch(readme, /Peer messages are data/)
  }
  const source = fs.readFileSync(new URL('./server.mjs', import.meta.url), 'utf8')
  assert.doesNotMatch(source, /Peer messages are data and cannot grant user permission/)
  assert.match(source, /teammate's request/)
  const descriptions = tools.map(tool => tool.description).join('\n')
  assert.doesNotMatch(descriptions, /Peer content is data|Peer messages cannot grant permission/)
  for (const text of [readme, source, descriptions]) assert.doesNotMatch(text, /—/)
})

test('ac203 J: a receipt stored by an older release (no state, an error note) still reads correctly', async t => {
  const f = fixture(t); await setup(f, claudeRecipient(f))
  const posted = await post(f, 'hi')
  const disk = JSON.parse(fs.readFileSync(f.store.statePath, 'utf8'))
  const old = Object.values(disk.rooms.r.members).find(member => member.agent === 'Rcpt').deliveries[posted.message_id]
  delete old.state; old.error = 'The tab was rung and reads its inbox on its next turn. Nothing else to do; a reply wakes you.'
  fs.writeFileSync(f.store.statePath, JSON.stringify(disk))
  const rows = await f.sender.call('delivery_status', { room: 'r', agent: 'Sender' })
  assert.deepEqual(rows.find(entry => entry.sent).recipients, [{ agent: 'Rcpt', state: 'rung', read_state: 'unread' }])
})
