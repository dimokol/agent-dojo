// What differs between macOS/Linux and Windows, in one place.
//
// File checks (file-modes.mjs): on Windows, Node reports uid 0 and made-up mode bits for every
// file, so the owner and mode parts of a check pass there and privacy comes from the folder's ACL.
// A private root folder is checked (or, when agent-chat just made it, locked) once per process
// with agent-chat-win.exe, and everything agent-chat creates under it inherits that ACL.
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

export { WINDOWS, ownedByMe, ownedByMeOrRoot, hasModeBits, modeIs } from './file-modes.mjs'
import { WINDOWS } from './file-modes.mjs'

// A new entry survives a crash only once its folder is flushed. Windows can't open a folder for
// fsync (EPERM) and NTFS journals the entry itself.
export function fsyncDir(dir) {
  if (WINDOWS) return
  const fd = fs.openSync(dir, 'r')
  try { fs.fsyncSync(fd) } finally { fs.closeSync(fd) }
}

// Claude's messaging endpoint on Windows, one per claude.exe (relay 039). Agent-chat never
// connects to it there (Windows wakes through the hook), so only its shape is checked.
export const WINDOWS_CLAUDE_ENDPOINT = /^\\\\\.\\pipe\\LOCAL\\cc-msg-[0-9a-f]{32}$/i

export const WIN_HELPER = path.join(path.dirname(fileURLToPath(import.meta.url)), 'agent-chat-win.exe')

// Folders whose ACL passed in this process; anything below them inherits it.
const privateRoots = new Set()
const under = (dir, root) => dir === root || dir.startsWith(root.endsWith(path.sep) ? root : root + path.sep)

// Windows only: is dir private to this user (its ACL names only this user, SYSTEM and
// Administrators)? created: agent-chat just made it, so lock it first. Throws when the helper
// can't run, so a missing exe never reads as "private".
export function windowsFolderPrivate(dir, { created = false, helper = WIN_HELPER, run = execFileSync } = {}) {
  if (!WINDOWS && helper === WIN_HELPER) return true
  const resolved = path.resolve(dir)
  for (const root of privateRoots) if (under(resolved, root)) return true
  const output = run(helper, [created ? 'acl-lock' : 'acl-check', resolved], { encoding: 'utf8', timeout: 5000, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  if (output !== 'private') return false
  privateRoots.add(resolved)
  return true
}

// For tests: forget which roots passed.
export function resetPrivateRoots() { privateRoots.clear() }

// Windows process rows from agent-chat-win.exe: { pid, ppid, start, mine, image, name } per live
// PID asked for, or every process with all. Throws when the helper fails, so a check that could
// not run never reads as "no such process".
export function windowsProcessRows(pids, { all = false, timeoutMs = 2000, helper = WIN_HELPER, run = execFileSync } = {}) {
  const args = all ? ['ps', '--all'] : ['ps', ...pids.map(String)]
  if (!all && !pids.length) return new Map()
  const output = run(helper, args, { encoding: 'utf8', timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] })
  const rows = new Map()
  for (const line of String(output).split('\n')) {
    if (!line.trim()) continue
    const row = JSON.parse(line)
    if (Number.isSafeInteger(row.pid)) rows.set(row.pid, row)
  }
  return rows
}
