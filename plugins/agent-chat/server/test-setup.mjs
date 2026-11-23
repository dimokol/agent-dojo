// Loaded with --import before the test suite. On Windows, %TEMP% can carry ACL entries for other
// accounts (seen on the PC: orphaned SIDs with Modify), and agent-chat rightly refuses folders
// that inherit them. macOS gives each user a private temp folder; this gives the suite the same:
// one folder locked to this user, used as TEMP/TMP by every test process, removed at the end.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { WIN_HELPER } from './platform.mjs'

// The suite tests the version check as switched on. Set here, not in the npm script, because npm
// runs scripts with cmd on Windows, where `VAR=value command` doesn't parse.
process.env.AGENT_CHAT_VERSION_CHECK = 'on'

if (process.platform === 'win32' && !process.env.AGENT_CHAT_TEST_TEMP) {
  // realpathSync.native expands 8.3 short names (C:\Users\RUNNER~1 on CI), which git and Claude
  // never print, so paths compare equal.
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'agent-chat-tests-')))
  const state = execFileSync(WIN_HELPER, ['acl-lock', dir], { encoding: 'utf8', windowsHide: true }).trim()
  if (state !== 'private') throw new Error(`could not make the test temp folder private: ${state}`)
  process.env.TEMP = process.env.TMP = process.env.AGENT_CHAT_TEST_TEMP = dir
  const owner = process.pid
  process.on('exit', () => { if (process.pid === owner) try { fs.rmSync(dir, { recursive: true, force: true }) } catch {} })
}
