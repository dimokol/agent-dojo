import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

// strict: a git that could not answer (timed out, killed, or failed to start on a busy machine:
// EAGAIN, EMFILE, ENOMEM) throws instead of falling back to the directory itself, which for a
// worktree or subdirectory is the wrong root. Presence checks use it; a wrong root there would read
// a live tab as closed. git's own answer (not a repository) and no git at all keep the folder.
export function projectRoot(start, { strict = false, timeoutMs = 3000 } = {}) {
  let common
  try {
    common = execFileSync('git', ['-C', start, 'rev-parse', '--path-format=absolute', '--git-common-dir'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: timeoutMs }).trim()
  } catch (error) {
    const answered = Number.isInteger(error.status) && !error.signal && !error.killed
    if (strict && !answered && error.code !== 'ENOENT') throw new Error('Project scope unavailable')
    return fs.realpathSync(start)
  }
  try { if (path.basename(common) === '.git') return fs.realpathSync(path.dirname(common)) } catch {}
  return fs.realpathSync(start)
}
