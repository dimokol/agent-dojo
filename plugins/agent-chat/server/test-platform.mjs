// Test helper (not a test file): what the suite does differently on Windows. Product code never
// imports this.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'

export const WIN = process.platform === 'win32'

// Skip options, one reason per group, so a Windows run lists why each test didn't run.
// Socket wake mode (Claude's messaging socket, Unix-socket listeners, the Codex control socket,
// the daemon's Unix socket) is macOS-only; Windows always wakes Claude through the hook.
export const socketOnly = { skip: WIN && 'socket wake mode and Unix sockets are macOS-only' }
// POSIX owner and mode bits mean nothing on Windows; privacy there is the folder ACL.
export const posixModesOnly = { skip: WIN && 'POSIX mode bits are macOS-only; Windows privacy is the folder ACL' }
// ps, lsof and /bin/sh stand-ins drive the macOS presence checks; Windows asks agent-chat-win.exe.
export const psOnly = { skip: WIN && 'ps and lsof presence checks are macOS-only' }

// Can this account make symlinks? Non-admin Windows without Developer Mode can't (EPERM); admin
// CI can, so those tests still run there.
export const CAN_SYMLINK = (() => {
  if (!WIN) return true
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-chat-symlink-probe-'))
  try { fs.symlinkSync(dir, path.join(dir, 'link'), 'dir'); return true }
  catch (error) { if (error.code === 'EPERM') return false; throw error }
  finally { fs.rmSync(dir, { recursive: true, force: true }) }
})()
export const symlinks = { skip: !CAN_SYMLINK && 'symlinks need admin or Developer Mode on this Windows account' }

// Claude's messaging endpoint for a test session: the Unix socket path on macOS, and on Windows a
// pipe name of the shape Claude uses there (\\.\pipe\LOCAL\cc-msg-<32 hex>), stable per path.
export const claudeEndpoint = unixPath => WIN
  ? `\\\\.\\pipe\\LOCAL\\cc-msg-${crypto.createHash('md5').update(String(unixPath)).digest('hex')}`
  : unixPath

// An owner-only POSIX mode check. Windows has no mode bits (Node reports made-up ones there), and
// privacy comes from the folder's ACL, so it checks nothing on Windows.
export function assertMode(file, expected, message) {
  if (!WIN) assert.equal(fs.statSync(file).mode & 0o777, expected, message)
}

// A link to a folder. Windows makes a junction, which needs no admin rights and which Node reads
// back like a symlink (lstat, readlink, realpath); elsewhere a plain symlink.
export const linkFolder = (target, link) => fs.symlinkSync(target, link, WIN ? 'junction' : undefined)

// Stop a child and wait until it is gone. Windows won't remove a folder a live process still has
// as its working directory (rmSync EPERM), so cleanup that deletes it waits for this first.
export const stopChild = child => child.exitCode !== null || child.signalCode !== null ? Promise.resolve()
  : new Promise(resolve => { child.once('exit', resolve); child.kill() })
