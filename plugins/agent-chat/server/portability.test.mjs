import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { defaultChatRoot } from './store.mjs'
import { distribution } from './distribution.mjs'
const here = path.dirname(fileURLToPath(import.meta.url))

test('no shipped file pins one user home; the chat root follows the running home', () => {
  const shipped = fs.readdirSync(here).filter(name => name.endsWith('.mjs') && !name.endsWith('.test.mjs'))
  const pinned = shipped.filter(name => /\/Users\/[^/\s'"]+/.test(fs.readFileSync(path.join(here, name), 'utf8')))
  assert.deepEqual(pinned, [])
  assert.equal(defaultChatRoot(), path.join(os.homedir(), ...distribution.chatRoot))
})

test('Codex is found where its installers put it, and CODEX_HOME names the profile', async () => {
  const { codexBinary, inferNativeSession } = await import('./native-session.mjs')
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agent-chat-codex-')))
  try {
    fs.mkdirSync(path.join(home, '.local', 'bin'), { recursive: true }); fs.writeFileSync(path.join(home, 'codex-real'), '')
    fs.symlinkSync(path.join(home, 'codex-real'), path.join(home, '.local', 'bin', 'codex'))
    assert.equal(codexBinary(home), path.join(home, 'codex-real'))
    assert.equal(codexBinary(home, { resolve: false }), path.join(home, '.local', 'bin', 'codex'))
    const profile = path.join(home, 'codex-profile'); fs.mkdirSync(profile, { mode: 0o700 })
    const meta = { 'x-codex-turn-metadata': { thread_id: '12345678-1234-4234-8234-123456789abc' } }
    assert.equal(inferNativeSession(meta, { CODEX_HOME: profile }).profileHome, profile)
    assert.equal(inferNativeSession(meta, { AGENT_CHAT_CODEX_HOME: profile, CODEX_HOME: path.join(home, 'other') }).profileHome, profile)
  } finally { fs.rmSync(home, { recursive: true, force: true }) }
})

test('the version check follows AGENT_CHAT_VERSION_CHECK, then the distribution default', async () => {
  const { isVerifiedVersion } = await import('./claude-versions.mjs')
  const stateRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agent-chat-gate-'))); fs.chmodSync(stateRoot, 0o700)
  try {
    // This install holds wake-ups by default; the public plugin's distribution.mjs ships it off.
    assert.equal(isVerifiedVersion('9.9.9', { stateRoot, env: {} }), distribution.versionCheck === 'off')
    assert.equal(isVerifiedVersion('9.9.9', { stateRoot, env: { AGENT_CHAT_VERSION_CHECK: 'on' } }), false)
    assert.equal(isVerifiedVersion('9.9.9', { stateRoot, env: { AGENT_CHAT_VERSION_CHECK: 'off' } }), true)
    assert.equal(isVerifiedVersion('9.9.9', { stateRoot, env: { AGENT_CHAT_VERSION_CHECK: 'yes' } }), false)
  } finally { fs.rmSync(stateRoot, { recursive: true, force: true }) }
})
