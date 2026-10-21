import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync, spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { claudeParticipantId, nameFiles } from './notice-files.mjs'
import { nativeLabel } from './statusline-name.mjs'
import { slug } from './store-files.mjs'

const script = fileURLToPath(new URL('./statusline-name.mjs', import.meta.url))
const C1 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', C2 = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
function fixture(t) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agent-chat-statusline-')))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const stateRoot = path.join(dir, 'state'), profile = path.join(dir, 'profile')
  for (const directory of [stateRoot, profile]) fs.mkdirSync(directory, { mode: 0o700 })
  const env = { ...process.env, CLAUDE_CONFIG_DIR: profile }
  delete env.AGENT_CHAT_STATE_ROOT
  const files = conversation => nameFiles(stateRoot, claudeParticipantId(profile, conversation))
  const run = (input, args = ['--state-root', stateRoot]) =>
    execFileSync(process.execPath, [script, ...args], { input: typeof input === 'string' ? input : JSON.stringify(input), env, encoding: 'utf8', timeout: 3000 })
  const canonical = (conversation, name, source) => {
    fs.mkdirSync(path.join(stateRoot, 'names'), { mode: 0o700, recursive: true })
    fs.writeFileSync(files(conversation).name, JSON.stringify({ schema: 1, name, source }), { mode: 0o600 })
  }
  return { dir, stateRoot, env, files, run, canonical }
}
const stamp = file => { const s = fs.statSync(file); return [s.ino, s.mtimeMs] }
const native = file => JSON.parse(fs.readFileSync(file, 'utf8'))

test('prints this session\'s cached canonical name and nothing for another session', t => {
  const f = fixture(t)
  f.canonical(C1, 'Reviewer', 'agent')
  assert.equal(f.run({ session_id: C1, session_name: 'Ignored For Display' }), 'Reviewer')
  assert.equal(f.run({ session_id: C2 }), '')
})

test('the native session name becomes the cached default label: compared first, written on change, private', t => {
  const f = fixture(t), file = f.files(C1).native
  assert.equal(f.run({ session_id: C1, session_name: 'Review UI' }), '', 'no canonical name yet prints nothing')
  assert.deepEqual(native(file), { schema: 1, label: 'review-ui' })
  assert.equal(fs.statSync(file).mode & 0o777, 0o600)
  assert.equal(fs.statSync(path.dirname(file)).mode & 0o777, 0o700)
  const before = stamp(file)
  f.run({ session_id: C1, session_name: 'Review UI' }); f.run({ session_id: C1, session_name: '  review   ui!' })
  assert.deepEqual(stamp(file), before, 'the same label is never rewritten')
  f.run({ session_id: C1 })
  assert.deepEqual(stamp(file), before, 'an absent native name leaves the cache alone')
  f.canonical(C1, 'review-ui', 'native')
  assert.equal(f.run({ session_id: C1, session_name: 'Design pass' }), 'review-ui')
  assert.deepEqual(native(file), { schema: 1, label: 'design-pass' }, 'a native default still follows the native name')
  assert.deepEqual(fs.readdirSync(path.dirname(file)).filter(name => name.endsWith('.tmp')), [])
})

test('an explicit name freezes the default label', t => {
  const f = fixture(t)
  f.canonical(C1, 'Chosen', 'explicit')
  assert.equal(f.run({ session_id: C1, session_name: 'Native Title' }), 'Chosen')
  assert.equal(fs.existsSync(f.files(C1).native), false)
})

test('any error prints nothing, exits 0 and writes nothing', t => {
  const f = fixture(t)
  for (const input of ['{broken', '[]', { session_id: '../escape' }, { session_id: 42 }]) assert.equal(f.run(input), '')
  assert.equal(f.run({ session_id: C1, session_name: 'x' }, ['--state-root', path.join(f.dir, 'absent')]), '')
  assert.equal(fs.existsSync(path.join(f.dir, 'absent')), false, 'a missing state root is never created')
  assert.equal(f.run({ session_id: C1 }, ['--state-root', 'relative']), '')
  f.canonical(C1, '\u001b[31mred', 'agent')
  assert.equal(f.run({ session_id: C1 }), '', 'no terminal escapes reach the status line')
  f.canonical(C1, 'Fine', 'agent'); fs.chmodSync(f.files(C1).name, 0o644)
  assert.equal(f.run({ session_id: C1 }), '', 'a file readable by others is not trusted')
  fs.chmodSync(f.files(C1).name, 0o600); fs.chmodSync(path.join(f.stateRoot, 'names'), 0o755)
  assert.equal(f.run({ session_id: C1, session_name: 'New name' }), '')
  assert.equal(fs.existsSync(f.files(C1).native), false)
})

test('a stalled stdin ends silently within the deadline', async t => {
  const f = fixture(t), began = performance.now()
  const child = spawn(process.execPath, [script, '--state-root', f.stateRoot], { env: f.env, stdio: ['pipe', 'pipe', 'pipe'] })
  let output = ''
  child.stdout.on('data', chunk => { output += chunk })
  const code = await new Promise(resolve => child.on('exit', resolve))
  child.stdin.destroy()
  assert.equal(code, 0); assert.equal(output, '')
  assert.ok(performance.now() - began < 1500, 'well inside the ccstatusline timeout')
})

test('the widget and its helpers load only builtins: no store lock, network or child process', () => {
  for (const file of ['statusline-name.mjs', 'notice-files.mjs']) {
    const source = fs.readFileSync(new URL('./' + file, import.meta.url), 'utf8')
    const imports = [...source.matchAll(/^import .* from '([^']+)'/gm)].map(match => match[1])
    assert.ok(imports.every(name => ['node:fs', 'node:os', 'node:path', 'node:crypto', 'node:url', './notice-files.mjs'].includes(name)), `${file}: ${imports}`)
    assert.doesNotMatch(source, /child_process|node:net|node:http|sqlite|import\(/)
  }
})

test('native labels normalise like store default names and refuse empty results', () => {
  assert.equal(nativeLabel('Review User Interface'), 'review-user-interface')
  assert.equal(nativeLabel('..--Ünïcode!!'), 'n-code')
  assert.equal(nativeLabel('!!!'), null)
  assert.equal(nativeLabel('x'.repeat(80)).length, 55)
  assert.equal(nativeLabel(7), null)
  for (const value of ['Review User Interface', '  a--b  ', 'x'.repeat(54) + '-yz']) assert.equal(nativeLabel(value), slug(value, 55))
})
