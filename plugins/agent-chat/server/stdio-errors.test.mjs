import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

// Errors a client can fix reach it word for word over stdio; before PR #6's review they all
// came back as one generic failure, which also claimed a never-stored post was kept.
const SERVER = fileURLToPath(new URL('./server.mjs', import.meta.url))

async function session(t, calls) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agent-chat-stdio-')))
  const project = path.join(dir, 'project'); fs.mkdirSync(project)
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const env = { ...process.env, AGENT_CHAT_ROOT: path.join(dir, 'chats'), AGENT_CHAT_STATE_ROOT: path.join(dir, 'state') }
  for (const name of Object.keys(env)) if (/^(CLAUDE|CODEX)/.test(name)) delete env[name]
  const child = spawn(process.execPath, [SERVER], { cwd: project, env, stdio: ['pipe', 'pipe', 'pipe'] })
  t.after(() => child.kill())
  const replies = new Map()
  let buffer = ''
  child.stdout.on('data', data => {
    buffer += data
    for (let end; (end = buffer.indexOf('\n')) >= 0; buffer = buffer.slice(end + 1)) { const reply = JSON.parse(buffer.slice(0, end)); replies.get(reply.id)?.(reply) }
  })
  const call = (id, name, args) => new Promise(resolve => {
    replies.set(id, reply => resolve(reply.result.isError ? reply.result.content[0].text : JSON.parse(reply.result.content[0].text)))
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } }) + '\n')
  })
  const results = []
  for (const [index, [name, args]] of calls.entries()) results.push(await call(index + 1, name, args))
  child.stdin.end()
  return results
}

test('fixable errors reach the client word for word', async t => {
  const me = { id: 'me', runtime: 'manual' }
  const results = await session(t, [
    ['create_room', { room: 'room', title: 'room' }],
    ['create_room', { room: 'long', title: 'x'.repeat(201) }],
    ['join_room', { room: 'room', agent: 'Me' }],
    ['join_room', { room: 'room', agent: 'Me', session: me }],
    ['post', { room: 'room', from: 'Me', to: 'all', message: ' ' }],
    ['post', { room: 'room', from: 'Me', to: 'all', message: 'one', idempotency_key: 'k' }],
    ['post', { room: 'room', from: 'Me', to: 'all', message: 'two', idempotency_key: 'k' }],
    ['ack', { room: 'room', agent: 'Me', message_ids: ['not-a-message'] }],
    ['join_room', { room: 'room', agent: 'Me', session: { id: 'other', runtime: 'manual' } }],
  ])
  assert.deepEqual(results.filter(result => typeof result === 'string'), [
    'title must contain 1 to 200 characters',
    'invalid session; a manual client passes session with id and runtime manual',
    'message must contain 1 to 200000 characters',
    'idempotency key reused with different message',
    'message not pending for this session',
    'name is owned by another session already joined or reserved',
  ])
})
