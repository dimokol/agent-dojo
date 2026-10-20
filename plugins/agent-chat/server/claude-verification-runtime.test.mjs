import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { resumedTranscriptProof, resumeCaseEnv, resumeState, removeProbeConversation } from './claude-verification-runtime.mjs'
const targetId = '12345678-1234-1234-1234-123456789abc'
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'owned-resume-proof-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const cwd = '/owned/project', configHome = path.join(root, 'profile')
  const folder = path.join(configHome, 'projects', '-owned-project')
  fs.mkdirSync(folder, { recursive: true, mode: 0o700 })
  return { cwd, configHome, targetId, marker: 'unique-resumed-marker', file: path.join(folder, `${targetId}.jsonl`) }
}

test('resume proof requires the exact owned session, user marker and new transcript bytes', t => {
  const f = fixture(t)
  const initial = JSON.stringify({ type: 'user', sessionId: targetId, message: { content: 'prior ελληνικά' } }) + '\n'
  fs.writeFileSync(f.file, initial, { mode: 0o600 })
  const before = resumedTranscriptProof(f)
  assert.equal(before.matched, false)
  assert.equal(before.bytes, Buffer.byteLength(initial))
  fs.appendFileSync(f.file, JSON.stringify({ type: 'user', sessionId: targetId,
    message: { content: [{ type: 'text', text: f.marker }] } }) + '\n')
  assert.equal(resumedTranscriptProof({ ...f, afterBytes: before.bytes }).matched, true)
  assert.equal(resumedTranscriptProof({ ...f, afterBytes: fs.statSync(f.file).size }).matched, false)
})

test('wrong-session rows, assistant echoes and unrelated transcripts never prove native resume', t => {
  const f = fixture(t)
  fs.writeFileSync(f.file, [
    { type: 'user', sessionId: 'different', message: { content: f.marker } },
    { type: 'assistant', sessionId: targetId, message: { content: f.marker } },
  ].map(row => JSON.stringify(row)).join('\n') + '\n', { mode: 0o600 })
  fs.writeFileSync(path.join(path.dirname(f.file), 'unrelated.jsonl'), '{private unrelated contents')
  assert.equal(resumedTranscriptProof(f).matched, false)
  assert.throws(() => resumedTranscriptProof({ ...f, targetId: '../other' }), /INVALID_OWNED/)
  assert.throws(() => resumedTranscriptProof({ ...f, afterBytes: -1 }), /INVALID_OWNED/)
})

test('missing transcript remains unproven and linked transcript is refused', t => {
  const f = fixture(t)
  assert.deepEqual(resumedTranscriptProof(f), { matched: false, bytes: 0 })
  const elsewhere = path.join(path.dirname(f.file), 'other')
  fs.writeFileSync(elsewhere, 'private', { mode: 0o600 })
  fs.symlinkSync(elsewhere, f.file)
  assert.throws(() => resumedTranscriptProof(f), /UNSAFE_OWNED_TRANSCRIPT/)
})

test('the resume case saves transcripts even when started from inside a Claude tab', () => {
  // Inside a tab the child-session marker turns transcript saving off, and /resume then finds nothing.
  assert.deepEqual(resumeCaseEnv({ CLAUDE_CODE_CHILD_SESSION: '1', CLAUDECODE: '1', PATH: '/bin' }), { PATH: '/bin' })
})

test('resume waits for the old conversation to load, and a missing target fails at once', () => {
  // Claude 2.1.303 prints no "Resumed" line; it redraws the old conversation.
  assert.equal(resumeState('❯ /resume 1234', 1000, 2000), 'pending')
  assert.equal(resumeState('❯ /resume 1234', 1000, 7000), 'settled')
  assert.equal(resumeState('Resumed session', 1000, 1500), 'settled')
  assert.equal(resumeState('⎿  Session 1234 was not found.', 1000, 1500), 'not_found')
  assert.equal(resumeState('⎿ Session1234wasnotfound.', 1000, 9000), 'not_found')
})

test('a probe removes only its own conversation files, by exact ID', t => {
  const configHome = fs.mkdtempSync(path.join(os.tmpdir(), 'probe-cleanup-'))
  t.after(() => fs.rmSync(configHome, { recursive: true, force: true }))
  const cwd = '/Users/someone/Work/my.app', project = path.join(configHome, 'projects', '-Users-someone-Work-my-app')
  const own = '11111111-2222-4333-8444-555555555555', resumed = '66666666-7777-4888-9999-aaaaaaaaaaaa', other = 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff'
  fs.mkdirSync(path.join(project, own, 'tool-results'), { recursive: true })
  fs.mkdirSync(path.join(configHome, 'session-env', own), { recursive: true })
  for (const id of [own, other]) fs.writeFileSync(path.join(project, `${id}.jsonl`), '{}\n')
  fs.mkdirSync(path.join(configHome, 'session-env', other))
  assert.equal(removeProbeConversation({ cwd, configHome, ids: [own, resumed, own] }), 3)
  assert.deepEqual(fs.readdirSync(project), [`${other}.jsonl`])
  assert.deepEqual(fs.readdirSync(path.join(configHome, 'session-env')), [other])
  assert.throws(() => removeProbeConversation({ cwd, configHome, ids: ['../../x'] }), /INVALID_OWNED_PROBE_ID/)
})
