// Test helper (not a test file): a fake execFileSync for ps, lsof and git, so presence checks can be
// driven into timeouts, spawn failures and empty listings. install() must run before the runtime
// modules are imported, and needs node --experimental-test-module-mocks (see needsModuleMocks).
import test, { mock } from 'node:test'
import assert from 'node:assert/strict'
import * as cp from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const START = 'Mon Jan  1 00:00:00 2024'
export const uid = process.getuid?.() // undefined on Windows, where the files using this skip
export const calls = []
const defaults = () => ({ psP: 'ok', psComm: 'ok', psAx: 'ok', lsof: 'ok', git: 'ok', axComm: 'claude', exe: null, gitOut: null, extraPids: [] })
export const mode = defaults()
const failure = (file, code) => Object.assign(new Error(`spawnSync ${file} ${code}`), code === 'ETIMEDOUT'
  ? { code, signal: 'SIGTERM', status: null, stdout: '' } : { code, errno: -35, status: null, stdout: '' })

function fakeExecFileSync(file, args = [], opts = {}) {
  const kind = file === '/bin/ps' ? (args[0] === '-ax' ? 'psAx' : args.includes('comm=') ? 'psComm' : 'psP')
    : /lsof$/.test(file) ? 'lsof' : /git$/.test(file) ? 'git' : 'other'
  if (kind === 'other') return cp.execFileSync(file, args, opts)
  calls.push({ kind, args })
  const m = mode[kind]
  if (m === 'timeout') throw failure(file, 'ETIMEDOUT')
  if (m === 'eagain') throw failure(file, 'EAGAIN')
  if (m === 'empty0') return ''
  if (m === 'exit128') throw Object.assign(new Error(`${file} exited 128`), { status: 128, signal: null, stdout: '' })
  if (kind === 'psP') return args[1].split(',').map(Number).filter(pid => [process.pid, ...mode.extraPids].includes(pid)).map(pid => `${pid} ${uid} ${START}`).join('\n') + '\n'
  if (kind === 'psComm') return `${uid} claude\n`
  if (kind === 'psAx') return [process.pid, ...mode.extraPids].map(pid => `${pid} 1 ${uid} ${START} ${mode.axComm}`).join('\n') + '\n'
  if (kind === 'lsof') return `p${args[2]}\nftxt\nn${mode.exe}\n`
  return mode.gitOut
}

export function install() {
  mock.module('node:child_process', { namedExports: { ...cp, execFileSync: fakeExecFileSync } })
}
export function reset() { calls.length = 0; Object.assign(mode, defaults()) }
export const count = (...kinds) => calls.filter(call => kinds.includes(call.kind)).length

export function tempRoot(t, name) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `ac203-${name}-`)))
  fs.chmodSync(root, 0o700)
  const thaw = dir => { try { const stat = fs.lstatSync(dir); if (stat.isDirectory() && !stat.isSymbolicLink()) { fs.chmodSync(dir, 0o700); for (const n of fs.readdirSync(dir)) thaw(path.join(dir, n)) } } catch {} }
  t.after(() => { thaw(root); fs.rmSync(root, { recursive: true, force: true }) })
  return root
}

// npm test runs without the module-mock flag. A file that needs it then runs itself once more, with
// the flag, as a single test; returns true when the caller should stop defining tests.
export function needsModuleMocks(url) {
  if (typeof mock.module === 'function') return false
  test(`${path.basename(fileURLToPath(url))} (rerun with --experimental-test-module-mocks)`, () => {
    const child = cp.spawnSync(process.execPath, ['--experimental-test-module-mocks', '--test', '--test-reporter=spec', fileURLToPath(url)],
      { encoding: 'utf8', env: process.env, timeout: 120_000 })
    assert.equal(child.status, 0, child.stdout + child.stderr)
  })
  return true
}
