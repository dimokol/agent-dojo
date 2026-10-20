import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pruneHousekeeping } from './notice-files.mjs'
import { statuslineName } from './statusline-name.mjs'

function stateRoot(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agent-chat-housekeeping-'))); fs.chmodSync(root, 0o700)
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  return root
}
const put = (file, ageMs, now) => { fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 }); fs.writeFileSync(file, '{}\n', { mode: 0o600 }); fs.utimesSync(file, (now - ageMs) / 1000, (now - ageMs) / 1000) }

test('old native-name caches and orphaned hook tasks go; names, fresh files and strangers stay', t => {
  const root = stateRoot(t), now = Date.now(), day = 86_400_000
  const id = n => String(n).repeat(64).slice(0, 64), task = n => `${String(n).repeat(8)}-1111-4111-8111-${String(n).repeat(12)}.json`
  put(path.join(root, 'names', `${id(1)}.native`), 20 * day, now)
  put(path.join(root, 'names', `${id(2)}.native`), 2 * day, now)
  put(path.join(root, 'names', `${id(3)}.name`), 90 * day, now)
  put(path.join(root, 'names', 'notes.txt'), 90 * day, now)
  put(path.join(root, 'hook-tasks', task(4)), 2 * 3_600_000, now)
  put(path.join(root, 'hook-tasks', task(5)), 60_000, now)
  assert.equal(pruneHousekeeping(root, { now }), 2)
  assert.deepEqual(fs.readdirSync(path.join(root, 'names')).sort(), [`${id(2)}.native`, `${id(3)}.name`, 'notes.txt'])
  assert.deepEqual(fs.readdirSync(path.join(root, 'hook-tasks')), [task(5)])
  assert.equal(pruneHousekeeping(path.join(root, 'missing'), { now }), 0)
})

test('a verification probe shows no name and writes no cache file', t => {
  const root = stateRoot(t)
  const input = { session_id: '12345678-1234-4234-8234-123456789abc', session_name: 'Probe title' }
  assert.equal(statuslineName(input, { stateRoot: root, env: { AGENT_CHAT_VERIFY_CHILD: '1', CLAUDE_CONFIG_DIR: root } }), '')
  assert.equal(fs.existsSync(path.join(root, 'names')), false)
  statuslineName(input, { stateRoot: root, env: { CLAUDE_CONFIG_DIR: root } })
  assert.equal(fs.readdirSync(path.join(root, 'names')).length, 1)
})
