import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { isVerifiedVersion, recordVerifiedVersion } from './claude-versions.mjs'
// These tests cover the version gate, which the plugin ships switched off; turn it on here so a
// plain `node --test` passes too. Read at call time, so setting it after the imports is enough.
process.env.AGENT_CHAT_VERSION_CHECK = 'on'

const proof = { passed: true, ready: true, pong: true, receipt: 'received', explicitAckCalls: 0, requestedModelTurns: 2, probe: 'agent-chat-inbox-v1' }
const unavailable = error => error.code === 'CHAT_CLAUDE_VERSIONS_UNAVAILABLE' &&
  error.message === 'Agent-chat Claude verification records are unavailable; operator recovery required'
function fixture(t) {
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-version-'))
  t.after(() => fs.rmSync(stateRoot, { recursive: true, force: true }))
  return { stateRoot, file: path.join(stateRoot, 'claude-versions.json') }
}

test('audited default is allowed, unknown exact versions stay blocked, and reads create no records', t => {
  const { stateRoot, file } = fixture(t)
  assert.equal(isVerifiedVersion('2.1.296', { stateRoot }), true)
  assert.equal(isVerifiedVersion('2.1.297', { stateRoot }), false)
  assert.equal(isVerifiedVersion('2.1.*', { stateRoot }), false)
  assert.equal(isVerifiedVersion('2.1.297 (Claude Code)', { stateRoot }), false)
  assert.equal(fs.existsSync(file), false)
})

test('successful receipt proof records only the exact version in a private allowlist', t => {
  const { stateRoot, file } = fixture(t)
  assert.deepEqual(recordVerifiedVersion('2.1.297', proof, { stateRoot }), { version: '2.1.297', verified: true })
  assert.equal(fs.statSync(file).mode & 0o777, 0o600)
  assert.equal(isVerifiedVersion('2.1.297', { stateRoot }), true)
  assert.equal(isVerifiedVersion('2.1.298', { stateRoot }), false)
  const records = JSON.parse(fs.readFileSync(file, 'utf8'))
  assert.equal(records.versions['2.1.297'].receipt, 'received')
  assert.equal(records.versions['2.1.297'].requestedModelTurns, 2)
})

test('missing or failed proof never changes the allowlist', t => {
  const { stateRoot, file } = fixture(t)
  for (const change of [{ passed: false }, { ready: false }, { pong: false }, { receipt: 'notified' }, { explicitAckCalls: 1 }, { requestedModelTurns: 3 }]) {
    assert.throws(() => recordVerifiedVersion('2.1.297', { ...proof, ...change }, { stateRoot }), unavailable)
  }
  assert.equal(fs.existsSync(file), false)
})

test('invalid records fail closed without exposing damaged content or resetting it', t => {
  const { stateRoot, file } = fixture(t)
  for (const text of ['{private-token', 'null', '{}', JSON.stringify({ schema: 1, versions: { '2.1.297': { verified: false } } })]) {
    fs.writeFileSync(file, text, { mode: 0o600 })
    assert.throws(() => isVerifiedVersion('2.1.297', { stateRoot }), unavailable)
    assert.throws(() => recordVerifiedVersion('2.1.297', proof, { stateRoot }), unavailable)
    assert.equal(fs.readFileSync(file, 'utf8'), text)
  }
})

test('directory and file permissions, symlinks and hardlinks are refused', t => {
  const { stateRoot, file } = fixture(t)
  recordVerifiedVersion('2.1.297', proof, { stateRoot })
  fs.chmodSync(file, 0o644)
  assert.throws(() => isVerifiedVersion('2.1.297', { stateRoot }), unavailable)
  fs.chmodSync(file, 0o600)
  fs.chmodSync(stateRoot, 0o755)
  assert.throws(() => isVerifiedVersion('2.1.297', { stateRoot }), unavailable)
  fs.chmodSync(stateRoot, 0o700)
  const linked = path.join(stateRoot, 'link')
  fs.linkSync(file, linked)
  assert.throws(() => isVerifiedVersion('2.1.297', { stateRoot }), unavailable)
  fs.unlinkSync(linked)
  fs.renameSync(file, linked); fs.symlinkSync(linked, file)
  assert.throws(() => isVerifiedVersion('2.1.297', { stateRoot }), unavailable)
  assert.throws(() => isVerifiedVersion('2.1.297', { stateRoot: linked }), unavailable)
})
