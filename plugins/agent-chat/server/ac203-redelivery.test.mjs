import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createStore } from './store.mjs'
import { createService } from './server.mjs'
import { processIdentity } from './native-session.mjs'
import { claudeEndpoint } from './test-platform.mjs'

// 2.0.3: mail whose inbox result was the last thing a connection returned (read, then exit) came
// back on the next connection as fresh. Now the conversation's transcript decides: an inbox
// result with that id in it counts as received; otherwise the mail comes back marked maybe_seen.
// A closed name taken over moves mail the old owner read but never confirmed, marked the same way.
const CONV = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', LAUNCH = '11111111-1111-4111-8111-111111111111'
const THREAD = '01a1d9b3-2b60-7843-8f30-22d49666eca0'
const accepted = { async deliver() { return { status: 'accepted' } } }
const self = processIdentity(process.pid)

function fixture(t) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agent-chat-ac203-redelivery-')))
  const closers = []
  t.after(() => { for (const close of closers.reverse()) try { close() } catch {} ; fs.rmSync(dir, { recursive: true, force: true }) })
  const stateRoot = path.join(dir, 'state'), root = path.join(dir, 'chats'), profile = path.join(dir, 'profile'), codexHome = path.join(dir, 'codex')
  for (const folder of [stateRoot, profile, codexHome]) fs.mkdirSync(folder, { mode: 0o700 })
  const store = createStore({ root, projectRoot: dir, stateRoot })
  store.createRoom({ room: 'r', title: 'r' })
  const own = service => (closers.push(() => service.close()), service)
  return { dir, stateRoot, root, profile, codexHome, store, own }
}
const claude = (f, extra = {}) => ({ runtime: 'claude', id: LAUNCH, profileHome: f.profile, endpoint: claudeEndpoint('/private/agent-chat-ac203.sock'),
  clientPid: self.pid, clientStart: self.start, serverPid: self.pid, serverStart: self.start, ...extra })
const codex = f => ({ runtime: 'codex', id: THREAD, profileHome: f.codexHome, serverPid: self.pid, serverStart: self.start })
const service = (f, session, conversation = CONV) => createService({ store: f.store, env: {}, adapters: accepted, inferSession: () => session, resolveConversation: () => conversation })
const receiptOf = (f, agent, id) => f.store.memberships().find(m => m.agent === agent && m.deliveries[id])?.deliveries[id]

async function readThenExit(f, session, conversation = CONV) {
  const peer = f.own(createService({ store: f.store, env: {}, adapters: accepted, inferSession: () => null }))
  await peer.call('join_room', { room: 'r', agent: 'Peer', session: { id: 'peer', runtime: 'manual' } })
  // Owned, so a failed assertion below still closes it (an open service's folder watch keeps the
  // test process alive).
  const a = f.own(service(f, session, conversation))
  const { agent } = await a.call('join_room', { room: 'r', agent: 'Reader' })
  const sent = await peer.call('post', { room: 'r', from: 'Peer', to: agent, message: 'hello once' })
  const args = { room: 'r', agent }
  const first = await a.call('inbox', args)
  a.written('inbox', args, first)
  assert.deepEqual(first.map(m => m.message_id), [sent.message_id])
  a.close()
  assert.equal(receiptOf(f, agent, sent.message_id).status, 'delivered')
  return { args, sent, peer }
}
// Claude keeps <profile>/projects/<launch folder, every other character a dash>/<conversation>.jsonl.
function claudeTranscript(f, lines, folder = f.dir) {
  const dir = path.join(f.profile, 'projects', folder.replace(/[^A-Za-z0-9]/g, '-'))
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, `${CONV}.jsonl`), lines.map(line => JSON.stringify(line)).join('\n') + '\n')
}
const toolUse = (id, name, input) => ({ type: 'assistant', sessionId: CONV, message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] } })
const toolResult = (id, text) => ({ type: 'user', sessionId: CONV, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: [{ type: 'text', text }] }] } })
const inboxText = sent => JSON.stringify([{ message_id: sent.message_id, from: 'Peer', to: 'Reader', message: 'hello once' }])

for (const [label, next] of [
  ['MCP reconnect, same launch id', f => claude(f)],
  ['claude --resume, new launch id, same conversation', f => claude(f, { id: '22222222-2222-4222-8222-222222222222' })],
]) test(`read-then-exit, ${label}, no transcript: the mail comes back marked maybe_seen with a note`, async t => {
  const f = fixture(t)
  const { args, sent } = await readThenExit(f, claude(f))
  const b = f.own(service(f, next(f)))
  const again = await b.call('inbox', args)
  const same = again.filter(m => m.message_id === sent.message_id)
  assert.equal(same.length, 1, 'mail is never lost')
  assert.equal(same[0].maybe_seen, true)
  assert.match(again.at(-1).note, /before a restart/)
  // Read on this connection, the next call confirms it as usual.
  b.written('inbox', args, again)
  assert.deepEqual(await b.call('inbox', args), [])
  assert.equal(receiptOf(f, args.agent, sent.message_id).status, 'received')
})

test('read-then-exit, resumed: an inbox result in the transcript counts as received', async t => {
  const f = fixture(t)
  const { args, sent } = await readThenExit(f, claude(f))
  claudeTranscript(f, [toolUse('toolu_1', 'mcp__agent-chat__inbox', args), toolResult('toolu_1', inboxText(sent))])
  const b = f.own(service(f, claude(f, { id: '22222222-2222-4222-8222-222222222222' })))
  assert.deepEqual(await b.call('inbox', args), [])
  assert.equal(receiptOf(f, args.agent, sent.message_id).status, 'received')
})

test('read-then-exit, resumed: the id outside an inbox result proves nothing', async t => {
  const f = fixture(t)
  const { args, sent } = await readThenExit(f, claude(f))
  // A doorbell names the id, and so can a history result; only an inbox result shows the mail.
  claudeTranscript(f, [{ type: 'user', message: { role: 'user', content: `agent-chat: new mail ${sent.message_id}` } },
    toolUse('toolu_2', 'mcp__agent-chat__history', { room: 'r' }), toolResult('toolu_2', inboxText(sent))])
  const b = f.own(service(f, claude(f)))
  const again = await b.call('inbox', args)
  assert.equal(again.find(m => m.message_id === sent.message_id)?.maybe_seen, true)
})

test('a damaged transcript reads as unknown: redelivered marked, never dropped', async t => {
  const f = fixture(t)
  const { args, sent } = await readThenExit(f, claude(f))
  claudeTranscript(f, [])
  fs.writeFileSync(path.join(f.profile, 'projects', f.dir.replace(/[^A-Za-z0-9]/g, '-'), `${CONV}.jsonl`), `{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"x","content":"${sent.message_id}`)
  const b = f.own(service(f, claude(f)))
  assert.equal((await b.call('inbox', args)).find(m => m.message_id === sent.message_id)?.maybe_seen, true)
})

test('same connection: mail read once is confirmed by the next call and not returned again, unmarked first time', async t => {
  const f = fixture(t)
  const peer = f.own(createService({ store: f.store, env: {}, adapters: accepted, inferSession: () => null }))
  await peer.call('join_room', { room: 'r', agent: 'Peer', session: { id: 'peer', runtime: 'manual' } })
  const a = f.own(service(f, claude(f)))
  const { agent } = await a.call('join_room', { room: 'r', agent: 'Reader' })
  const sent = await peer.call('post', { room: 'r', from: 'Peer', to: agent, message: 'hi' })
  const first = await a.call('inbox', { room: 'r', agent })
  assert.deepEqual(first.map(m => Object.keys(m).includes('maybe_seen')), [false])
  a.written('inbox', { room: 'r', agent }, first)
  assert.deepEqual(await a.call('inbox', { room: 'r', agent }), [])
  assert.equal(receiptOf(f, agent, sent.message_id).status, 'received')
})

test('Codex thread back on a new MCP connection: its rollout decides', async t => {
  const f = fixture(t)
  const { args, sent, peer } = await readThenExit(f, codex(f))
  const b = f.own(service(f, codex(f)))
  const again = await b.call('inbox', args)
  assert.equal(again.find(m => m.message_id === sent.message_id)?.maybe_seen, true, 'no rollout: marked')
  // A second message, read and then found in the rollout, counts as received.
  const c = f.own(service(f, codex(f)))
  const second = await peer.call('post', { room: 'r', from: 'Peer', to: args.agent, message: 'second' })
  const read = await c.call('inbox', args)
  c.written('inbox', args, read.filter(m => m.message_id === second.message_id)); c.close()
  const day = path.join(f.codexHome, 'sessions', '2026', '11', '14'); fs.mkdirSync(day, { recursive: true })
  fs.writeFileSync(path.join(day, `rollout-2026-11-14T12-56-00-${THREAD}.jsonl`), JSON.stringify({ type: 'event_msg', payload: { type: 'item_completed', thread_id: THREAD,
    item: { type: 'McpToolCall', server: 'agent_chat', tool: 'inbox', arguments: args, status: 'completed', result: { content: [{ type: 'text', text: JSON.stringify([{ message_id: second.message_id }]) }] } } } }) + '\n')
  const d = f.own(service(f, codex(f)))
  assert.ok(!(await d.call('inbox', args)).some(m => m.message_id === second.message_id))
  assert.equal(receiptOf(f, args.agent, second.message_id).status, 'received')
})

test('after /clear the new conversation takes the name over: mail the old one read comes back marked', async t => {
  const f = fixture(t)
  const { args, sent } = await readThenExit(f, claude(f))
  const cleared = f.own(service(f, claude(f), 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'))
  const { agent } = await cleared.call('join_room', { room: 'r', agent: args.agent })
  assert.equal(agent, args.agent)
  const again = await cleared.call('inbox', { room: 'r', agent })
  assert.equal(again.find(m => m.message_id === sent.message_id)?.maybe_seen, true)
})

// Bug 2: three sessions in a row take over a closed name, each reads its mail and closes.
function takeovers(f, { readBeforeClose }) {
  const s = f.store
  s.join({ room: 'r', agent: 'Peer', session: { id: 'peer', runtime: 'manual' } })
  const sent = []
  for (const n of [1, 2, 3]) {
    const id = `rs${n}`
    const m = s.join({ room: 'r', agent: 'run-supervisor', session: { id, runtime: 'manual' } })
    sent.push(s.post({ room: 'r', from: 'Peer', to: 'run-supervisor', message: `job ${n}`, sessionId: 'peer' }).message_id)
    if (readBeforeClose) s.updateDelivery({ room: 'r', agent: 'run-supervisor', sessionId: id, participantId: m.participant_id, message_ids: [sent.at(-1)], status: 'delivered' })
    s.deactivateSession(id)
  }
  return sent
}
for (const readBeforeClose of [true, false]) test(`unread lists a taken-over name once (each session ${readBeforeClose ? 'read' : 'did not read'} its mail)`, t => {
  const f = fixture(t)
  takeovers(f, { readBeforeClose })
  const report = f.store.unreadReport()
  const names = report.recipients.map(r => r.name.toLowerCase())
  assert.equal(new Set(names).size, names.length, `duplicate recipient rows: ${JSON.stringify(report.recipients)}`)
  const rs = report.recipients.find(r => r.name === 'run-supervisor')
  assert.equal(rs.unread + rs.delivered, 3)
})

test('the next owner of a taken-over name reads the mail earlier owners read but never confirmed, marked', async t => {
  const f = fixture(t)
  const sent = takeovers(f, { readBeforeClose: true })
  const next = f.store.join({ room: 'r', agent: 'run-supervisor', session: { id: 'rs4', runtime: 'manual' } })
  const mail = f.store.pending({ room: 'r', agent: 'run-supervisor', sessionId: 'rs4', participantId: next.participant_id })
  assert.deepEqual(mail.map(m => m.id).sort(), [...sent].sort())
  assert.ok(mail.every(m => m.delivery.maybe_seen === true && m.delivery.status === 'pending'))
})

test('mail already stuck on a retired owner (state from before 2.0.3) shows once and is readable by the current owner', async t => {
  const f = fixture(t)
  const sent = takeovers(f, { readBeforeClose: true })
  // Recreate the old takeover result: delivered receipts left on the retired rows.
  const statePath = f.store.statePath, state = JSON.parse(fs.readFileSync(statePath, 'utf8'))
  const rs = state.rooms.r, owner = rs.members['run-supervisor']
  const log = fs.readFileSync(path.join(f.store.dir, 'rooms', 'r', 'chat.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line))
  for (const id of sent.slice(0, 2)) {
    delete owner.deliveries[id]; delete rs.delivery_owners?.[id]
    rs.retired_members[log.find(m => m.id === id).to_id].deliveries[id] = { status: 'delivered', attempts: 1, updated: new Date().toISOString() }
  }
  fs.writeFileSync(statePath, JSON.stringify(state))
  const report = f.store.unreadReport()
  assert.equal(report.recipients.filter(r => r.name === 'run-supervisor').length, 1)
  const next = f.store.join({ room: 'r', agent: 'run-supervisor', session: { id: 'rs4', runtime: 'manual' } })
  const mail = f.store.pending({ room: 'r', agent: 'run-supervisor', sessionId: 'rs4', participantId: next.participant_id })
  assert.deepEqual(mail.map(m => m.id).sort(), [...sent].sort())
})
