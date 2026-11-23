import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import { exitOnCrash, restoreKeyFile } from './daemon.mjs'
import { gitCommand } from './project-scope.mjs'

test('an uncaught error or rejection in the daemon is logged and exits, so the bridges start a fresh one', () => {
  for (const event of ['uncaughtException', 'unhandledRejection']) {
    const proc = new EventEmitter(), lines = [], codes = []
    exitOnCrash(proc, { log: line => lines.push(line), exit: code => codes.push(code) })
    proc.emit(event, new Error('boom'))
    assert.deepEqual(codes, [1])
    assert.match(lines[0], /^(uncaught|unhandled), exiting so the bridges start a fresh daemon: Error: boom/)
  }
})

test('a removed or changed key file is put back; an intact one is left alone', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-chat-key-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const file = path.join(dir, 'abc.key'), text = '{"pipe":"p","key":"k"}\n'
  assert.equal(restoreKeyFile(file, text), true)
  assert.equal(fs.readFileSync(file, 'utf8'), text)
  assert.equal(restoreKeyFile(file, text), false)
  fs.rmSync(file)
  assert.equal(restoreKeyFile(file, text), true)
  fs.writeFileSync(file, 'stale')
  assert.equal(restoreKeyFile(file, text), true)
  assert.equal(fs.readFileSync(file, 'utf8'), text)
  if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600)
  assert.deepEqual(fs.readdirSync(dir), ['abc.key'])
})

test('Windows finds git on PATH first, then in the standard Git for Windows folders', () => {
  const has = files => file => files.includes(file)
  assert.equal(gitCommand({ windows: false }), 'git')
  assert.equal(gitCommand({ windows: true, env: { PATH: 'C:\\Tools;C:\\Git\\cmd' }, exists: has(['C:\\Git\\cmd\\git.exe']) }), 'git')
  assert.equal(gitCommand({ windows: true, env: { PATH: 'C:\\Windows', SystemDrive: 'C:' }, exists: has(['C:\\Program Files\\Git\\cmd\\git.exe']) }), 'C:\\Program Files\\Git\\cmd\\git.exe')
  assert.equal(gitCommand({ windows: true, env: { PATH: '', LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local' }, exists: has(['C:\\Users\\me\\AppData\\Local\\Programs\\Git\\cmd\\git.exe']) }), 'C:\\Users\\me\\AppData\\Local\\Programs\\Git\\cmd\\git.exe')
  assert.equal(gitCommand({ windows: true, env: {}, exists: () => false }), 'git')
})
