import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

// strict: a git that timed out or was killed throws instead of falling back to
// the directory itself, which for a worktree or subdirectory is the wrong root.
// Presence checks use it; a wrong root there would read a live tab as closed.
export function projectRoot(start, { strict = false } = {}) {
  try {
    const common = execFileSync('git', ['-C', start, 'rev-parse', '--path-format=absolute', '--git-common-dir'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 3000 }).trim()
    if (path.basename(common) === '.git') return fs.realpathSync(path.dirname(common))
    return fs.realpathSync(start)
  } catch (error) {
    if (strict && (error.signal || error.killed || error.code === 'ETIMEDOUT')) throw new Error('Project scope unavailable')
    return fs.realpathSync(start)
  }
}
