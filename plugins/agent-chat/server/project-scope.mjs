import fs from 'node:fs'
import path from 'node:path'
import { execFile, execFileSync } from 'node:child_process'

// strict: a git that could not answer (timed out, killed, or failed to start on a busy machine:
// EAGAIN, EMFILE, ENOMEM) throws instead of falling back to the directory itself, which for a
// worktree or subdirectory is the wrong root. Presence checks use it; a wrong root there would read
// a live tab as closed. git's own answer (not a repository) and no git at all keep the folder.
// The shared daemon runs with the PATH of the tab that started it. On Windows git may be missing
// from it, which would scope every tab by its folder with no error, so the standard Git for Windows
// folders are tried after PATH. Claude Code on Windows needs Git for Windows, so one is there.
export function gitCommand({ windows = process.platform === 'win32', env = process.env, exists = fs.existsSync } = {}) {
  if (!windows) return 'git'
  for (const dir of String(env.PATH ?? env.Path ?? '').split(';')) if (dir && exists(path.win32.join(dir, 'git.exe'))) return 'git'
  const drive = env.SystemDrive || 'C:'
  const candidates = [path.win32.join(`${drive}\\`, 'Program Files', 'Git', 'cmd', 'git.exe'),
    ...(env.LOCALAPPDATA ? [path.win32.join(env.LOCALAPPDATA, 'Programs', 'Git', 'cmd', 'git.exe')] : [])]
  return candidates.find(file => exists(file)) ?? 'git'
}
let git
const gitBinary = () => git ??= gitCommand()
const GIT_ARGS = start => ['-C', start, 'rev-parse', '--path-format=absolute', '--git-common-dir']
function fromCommon(start, common) {
  try { if (path.basename(common) === '.git') return fs.realpathSync(path.dirname(common)) } catch {}
  return fs.realpathSync(start)
}
function failed(start, error, strict, answered) {
  if (strict && !answered && error.code !== 'ENOENT') throw new Error('Project scope unavailable')
  return fs.realpathSync(start)
}
export function projectRoot(start, { strict = false, timeoutMs = 3000 } = {}) {
  let common
  try {
    common = execFileSync(gitBinary(), GIT_ARGS(start),
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: timeoutMs }).trim()
  } catch (error) {
    return failed(start, error, strict, Number.isInteger(error.status) && !error.signal && !error.killed)
  }
  return fromCommon(start, common)
}
// The same answer without blocking: the shared daemon opens many tabs' connections in one thread,
// and a git that takes seconds on a busy machine must not hold up the others.
export function projectRootAsync(start, { strict = false, timeoutMs = 3000 } = {}) {
  return new Promise((resolve, reject) => {
    execFile(gitBinary(), GIT_ARGS(start), { encoding: 'utf8', timeout: timeoutMs }, (error, stdout) => {
      try {
        if (!error) return resolve(fromCommon(start, String(stdout).trim()))
        // execFile reports git's own exit as a numeric code, a spawn failure as a string code.
        resolve(failed(start, error, strict, Number.isInteger(error.code) && !error.signal && !error.killed))
      } catch (failure) { reject(failure) }
    })
  })
}
