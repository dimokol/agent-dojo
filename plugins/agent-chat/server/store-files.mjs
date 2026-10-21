import './runtime.mjs'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
const { DatabaseSync } = await import('node:sqlite')

export function identifier(value, name = 'identifier') {
  if (typeof value !== 'string' || !/^[A-Za-z0-9._-]{1,64}$/.test(value) || ['.', '..', '__proto__', 'constructor', 'prototype'].includes(value) || Object.hasOwn(Object.prototype, value)) {
    throw new Error(`invalid ${name}`)
  }
  return value
}
export function slug(value, max = 55) {
  return String(value).trim().toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/-{2,}/g, '-').replace(/^[-.]+|[-.]+$/g, '').slice(0, max) || 'room'
}
// What the user sees for a folder ensureDirectory refuses: the folder, home-relative, and the fix.
export function unsafeFolderLine(dir) {
  const home = os.homedir() + path.sep
  const shown = dir.startsWith(home) ? '~' + path.sep + dir.slice(home.length) : dir
  let link = false
  try { const stat = fs.lstatSync(dir); link = stat.isSymbolicLink() || !stat.isDirectory() } catch {}
  return link
    ? `Agent-chat won't use ${shown}: it's a link or not a folder. Make it a real folder, or point AGENT_CHAT_ROOT or AGENT_CHAT_STATE_ROOT at one, then reconnect agent-chat in /mcp.`
    : `Agent-chat won't use ${shown}: other users can read it, or it isn't a folder you own. Run chmod 700 on it, then reconnect agent-chat in /mcp.`
}
// The root's parent resolved through links (the nearest existing ancestor), so every
// spelling of one chat root keys the same state. The root itself stays as given:
// ensureDirectory still refuses it if it is a link.
export function canonicalRoot(root) {
  const resolved = path.resolve(root), rest = [path.basename(resolved)]
  for (let dir = path.dirname(resolved); ; dir = path.dirname(dir)) {
    try { return path.join(fs.realpathSync(dir), ...rest) }
    catch (error) { if (error.code !== 'ENOENT' || dir === path.dirname(dir)) throw error; rest.unshift(path.basename(dir)) }
  }
}
// The projects/<key> folder holding a project's private state, keyed by the chat root resolved
// through links, so every spelling of one root shares one state from the first call.
export function projectStateKey(root, projectRoot) {
  return crypto.createHash('sha256').update(canonicalRoot(root) + '\n' + fs.realpathSync(projectRoot)).digest('hex').slice(0, 24)
}
// State made before that sits under the key of the root as given. Move it once, unless the
// resolved key already holds state: that only happens when versions were mixed, and the resolved
// one wins. A server from before this change still running in another tab then fails visibly
// until its tab restarts.
export function migrateProjectState(root, projectRoot, stateRoot) {
  const given = crypto.createHash('sha256').update(path.resolve(root) + '\n' + fs.realpathSync(projectRoot)).digest('hex').slice(0, 24)
  const canonical = projectStateKey(root, projectRoot), projects = path.join(stateRoot, 'projects')
  if (given === canonical || fs.existsSync(path.join(projects, canonical))) return
  try { fs.renameSync(path.join(projects, given), path.join(projects, canonical)) } catch { /* None to move, or another session moved it. */ }
}
export function ensureDirectory(dir, mode = 0o700) {
  const created = !fs.existsSync(dir)
  if (created) fs.mkdirSync(dir, { recursive: true, mode })
  const stat = fs.lstatSync(dir)
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid() || (stat.mode & 0o077)) throw Object.assign(new Error('unsafe directory ownership or permissions'), { path: dir })
  if (created) {
    const parent = fs.openSync(path.dirname(dir), 'r')
    try { fs.fsyncSync(parent) } finally { fs.closeSync(parent) }
  }
}
export function safeFile(file) {
  try {
    const stat = fs.lstatSync(file)
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.uid !== process.getuid() || (stat.mode & 0o077)) throw new Error('unsafe file ownership or permissions')
  } catch (error) { if (error.code !== 'ENOENT') throw error }
}
export function readJson(file, fallback) {
  safeFile(file)
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) }
  catch (error) { if (error.code === 'ENOENT') return fallback; throw error }
}
export function atomicJson(file, value) {
  safeFile(file)
  const temp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`
  let fd
  try {
    fd = fs.openSync(temp, 'wx', 0o600)
    fs.writeFileSync(fd, JSON.stringify(value) + '\n')
    fs.fsyncSync(fd)
    fs.closeSync(fd); fd = undefined
    fs.renameSync(temp, file)
    const parent = fs.openSync(path.dirname(file), 'r')
    try { fs.fsyncSync(parent) } finally { fs.closeSync(parent) }
  } finally {
    if (fd !== undefined) fs.closeSync(fd)
    try { fs.unlinkSync(temp) } catch (error) { if (error.code !== 'ENOENT') throw error }
  }
}
export function append(file, text) {
  safeFile(file)
  const created = !fs.existsSync(file)
  const fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_APPEND | fs.constants.O_NOFOLLOW, 0o600)
  try {
    const size = fs.fstatSync(fd).size
    try { fs.writeFileSync(fd, text); fs.fsyncSync(fd) }
    // A torn line would make every later read of this log fail; put the file back as it was.
    catch (error) { try { fs.ftruncateSync(fd, size); fs.fsyncSync(fd) } catch {} throw error }
  } finally { fs.closeSync(fd) }
  if (created) {
    const parent = fs.openSync(path.dirname(file), 'r')
    try { fs.fsyncSync(parent) } finally { fs.closeSync(parent) }
  }
}

// SQLite owns the OS mutex. Process death releases it, including SIGKILL.
// The database is only a mutex; canonical messages remain in JSONL.
export function locked(file, callback) {
  const mutex = `${file}.sqlite`
  safeFile(mutex)
  try {
    const fd = fs.openSync(mutex, 'wx', 0o600)
    fs.closeSync(fd)
  } catch (error) { if (error.code !== 'EEXIST') throw error }
  safeFile(mutex)
  const db = new DatabaseSync(mutex)
  let acquired = false
  try {
    db.exec('PRAGMA busy_timeout=10000; BEGIN IMMEDIATE')
    acquired = true
    return callback()
  } finally {
    try { if (acquired) db.exec('ROLLBACK') } finally { db.close() }
  }
}

// The folder projectDirectory would claim, found without creating anything.
export function predictProjectDirectory(root, projectRoot) {
  const canonical = fs.realpathSync(projectRoot), preferred = slug(path.basename(canonical), 64)
  const owner = project => readJson(path.join(root, project, 'project.json'), null)?.project_root
  const taken = owner(preferred)
  const project = taken && taken !== canonical ? `${preferred.slice(0, 55)}-${crypto.createHash('sha256').update(canonical).digest('hex').slice(0, 8)}` : preferred
  return { project, dir: path.join(root, project), claimed: owner(project) === canonical }
}
export function projectDirectory(root, projectRoot, lockRoot = path.join(root, '.runtime', 'locks')) {
  ensureDirectory(root)
  ensureDirectory(lockRoot)
  const canonical = fs.realpathSync(projectRoot)
  const preferred = slug(path.basename(canonical), 64)
  return locked(path.join(lockRoot, 'project-scopes'), () => {
    let project = preferred
    let dir = path.join(root, project)
    ensureDirectory(dir)
    const existing = readJson(path.join(dir, 'project.json'), null)
    if (existing && existing.project_root !== canonical) {
      project = `${preferred.slice(0, 55)}-${crypto.createHash('sha256').update(canonical).digest('hex').slice(0, 8)}`
      dir = path.join(root, project); ensureDirectory(dir)
    }
    const meta = readJson(path.join(dir, 'project.json'), null)
    if (meta && meta.project_root !== canonical) throw new Error('project collision')
    if (!meta) atomicJson(path.join(dir, 'project.json'), { id: project, name: path.basename(canonical), project_root: canonical, created: new Date().toISOString() })
    return { project, dir }
  })
}
