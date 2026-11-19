// Loaded with --import before the test suite. On Windows, %TEMP% can carry ACL entries for other
// accounts (seen on the PC: orphaned SIDs with Modify), and agent-chat rightly refuses folders
// that inherit them. macOS gives each user a private temp folder; this gives the suite the same:
// one folder locked to this user, used as TEMP/TMP by every test process, removed at the end.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { WIN_HELPER } from './platform.mjs'

if (process.platform === 'win32' && !process.env.AGENT_CHAT_TEST_TEMP) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-chat-tests-'))
  const state = execFileSync(WIN_HELPER, ['acl-lock', dir], { encoding: 'utf8', windowsHide: true }).trim()
  if (state !== 'private') throw new Error(`could not make the test temp folder private: ${state}`)
  process.env.TEMP = process.env.TMP = process.env.AGENT_CHAT_TEST_TEMP = dir
  const owner = process.pid
  process.on('exit', () => { if (process.pid === owner) try { fs.rmSync(dir, { recursive: true, force: true }) } catch {} })
}
