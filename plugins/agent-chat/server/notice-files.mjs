// Small private files outside the store lock: prompt notices and the statusline
// name cache. Builtins only, so the hook and widget load nothing heavy.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
export const NAME = /^[A-Za-z0-9._-]{1,64}$/
export const defaultStateRoot = (env = process.env) => env.AGENT_CHAT_STATE_ROOT || path.join(os.homedir(), '.local/state/agent-chat')
// Same digest as participant-identity.participantId for a Claude conversation.
export const claudeParticipantId = (profileHome, conversationId) =>
  createHash('sha256').update(JSON.stringify(['claude', profileHome, conversationId, ''])).digest('hex')
export function claudeProfileHome(env = process.env) {
  const value = env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude')
  if (!path.isAbsolute(value) || value.includes('\0')) throw Error('invalid Claude profile')
  return fs.realpathSync(value)
}
export const nameFiles = (stateRoot, participantId) => ({
  name: path.join(stateRoot, 'names', `${participantId}.name`), native: path.join(stateRoot, 'names', `${participantId}.native`) })

// Owned, not a link, closed to group and others. Creates one level only, so a
// missing state root never gets invented by a reader.
export function privateDirectory(directory, create = false) {
  if (create) try { fs.mkdirSync(directory, { mode: 0o700 }) } catch (error) { if (error.code !== 'EEXIST') throw error }
  const stat = fs.lstatSync(directory)
  if (!stat.isDirectory() || stat.uid !== process.getuid() || stat.mode & 0o077) throw Error('unsafe notice directory')
}
export function readPrivate(file, max = 4096) {
  let fd
  try { fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW) }
  catch (error) { if (error.code === 'ENOENT') return null; throw error }
  try {
    const stat = fs.fstatSync(fd)
    if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid() || stat.mode & 0o077 || stat.size > max) throw Error('unsafe notice file')
    return fs.readFileSync(fd, 'utf8')
  } finally { fs.closeSync(fd) }
}
// Compare first; rename keeps readers from seeing a partial file. No fsync:
// these files are derived and the next store write rebuilds them.
export function writeIfChanged(file, text) {
  if (readPrivate(file) === text) return false
  const temp = `${file}.${randomUUID()}.tmp`
  try {
    fs.writeFileSync(temp, text, { flag: 'wx', mode: 0o600 })
    fs.renameSync(temp, file)
  } finally { try { fs.unlinkSync(temp) } catch (error) { if (error.code !== 'ENOENT') throw error } }
  return true
}
export function removeIfPresent(file) {
  try { fs.unlinkSync(file); return true } catch (error) { if (error.code === 'ENOENT') return false; throw error }
}
function record(file, check) {
  try { const value = JSON.parse(readPrivate(file) ?? 'null'); return value?.schema === 1 && check(value) ? value : null }
  catch { return null }
}
export const readNameRecord = (stateRoot, participantId) =>
  record(nameFiles(stateRoot, participantId).name, value => NAME.test(value.name) && typeof value.source === 'string')
export const readNativeRecord = (stateRoot, participantId) =>
  record(nameFiles(stateRoot, participantId).native, value => NAME.test(value.label))

// Hook-owned markers of lines already shown, apart from the derived notices the
// store rewrites. A marker that can't be read or written never hides a line.
const shownFile = (stateRoot, name) => {
  if (!NAME.test(name)) throw Error('invalid marker')
  return path.join(stateRoot, 'shown', name)
}
export function readShown(stateRoot, name) {
  try { return readPrivate(shownFile(stateRoot, name)) } catch { return null }
}
export function recordShown(stateRoot, name, text) {
  try { privateDirectory(stateRoot); privateDirectory(path.join(stateRoot, 'shown'), true); writeIfChanged(shownFile(stateRoot, name), text) } catch {}
}

// Housekeeping, run from the session hook. A .native file is as old as its label, and the
// widget rewrites a missing one on its next status refresh, so dropping an old one costs a
// rewrite at most. A hook task outlives its worker only when the worker was killed.
export function pruneHousekeeping(stateRoot, { now = Date.now(), nativeAgeMs = 14 * 86_400_000, taskAgeMs = 3_600_000 } = {}) {
  let removed = 0
  for (const [folder, pattern, age] of [['names', /^[0-9a-f]{64}\.native$/, nativeAgeMs], ['hook-tasks', /^[0-9a-f-]{36}\.json$/, taskAgeMs]]) {
    const directory = path.join(stateRoot, folder)
    let names
    try { names = fs.readdirSync(directory) } catch (error) { if (error.code === 'ENOENT') continue; throw error }
    for (const name of names.filter(name => pattern.test(name))) {
      const file = path.join(directory, name)
      try { const stat = fs.lstatSync(file); if (stat.isFile() && now - stat.mtimeMs > age) { fs.unlinkSync(file); removed++ } } catch {}
    }
  }
  return removed
}
