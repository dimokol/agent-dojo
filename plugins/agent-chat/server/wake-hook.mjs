#!/usr/bin/env node
// The Windows wake waiter (macOS runs wake.sh, which starts this on Windows).
// Claude Code asyncRewake hook: waits in the background while the session is idle, and when mail
// arrives (a ring file, see wake-ring.mjs) writes the wake text to stderr and exits 2, which
// starts a turn in the idle session. Exit 0 means "nothing to do": not an interactive session,
// a newer waiter took over, or the session's Claude is gone.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { defaultWakeDir, ensureWakeDir, armedFile, ringFile, isAlive, readJson, writeJsonAtomic, sweepWakeFiles } from './wake-ring.mjs'

// The folder watch reacts to a ring at once. This safety check catches a missed event, a newer
// waiter and a Claude that is gone, at a pace that keeps an idle tab's CPU near zero.
const CHECK_MS = Number(process.env.AGENT_CHAT_WAKE_CHECK_MS) || 10_000

function hookInput() {
  try { return JSON.parse(fs.readFileSync(0, 'utf8') || '{}') } catch { return {} }
}

// Only an interactive session can be woken. A `claude -p` run waits for its hooks before it
// exits, so the hook must leave at once there.
function interactive(env) {
  if (/^sdk/.test(env.CLAUDE_CODE_ENTRYPOINT || '')) return false
  if (env.CLAUDE_CODE_SESSION_ATTENDED === '0') return false
  return true
}

export async function runWakeHook({ env = process.env, input = hookInput() } = {}) {
  const claudePid = Number(env.CLAUDE_PID)
  if (!interactive(env) || !isAlive(claudePid)) return { code: 0 }
  const dir = defaultWakeDir(env)
  ensureWakeDir(dir)
  sweepWakeFiles({ dir })
  const mark = armedFile(dir, claudePid)
  const me = process.pid
  writeJsonAtomic(mark, { waiter: me, event: input.hook_event_name || null, at: Date.now() })
  const mine = () => readJson(mark)?.waiter === me
  const release = () => { if (mine()) fs.rmSync(mark, { force: true }) }

  // Claim the ring by renaming it, so a ring written meanwhile stays for the next waiter.
  const take = () => {
    const taken = path.join(dir, `taken-${claudePid}-${me}`)
    try { fs.renameSync(ringFile(dir, claudePid), taken) } catch { return null }
    let text = ''
    try { text = fs.readFileSync(taken, 'utf8').split('\n')[0] } catch {}
    fs.rmSync(taken, { force: true })
    return text || null
  }

  return await new Promise(resolve => {
    let watcher, timer, done = false
    const finish = result => {
      if (done) return
      done = true
      clearInterval(timer)
      try { watcher?.close() } catch {}
      resolve(result)
    }
    const check = () => {
      if (done) return
      if (!mine()) return finish({ code: 0 })
      if (!isAlive(claudePid)) { release(); return finish({ code: 0 }) }
      const text = take()
      if (text) { release(); return finish({ code: 2, text }) }
    }
    try { watcher = fs.watch(dir, () => check()); watcher.on('error', () => {}) } catch {}
    timer = setInterval(check, CHECK_MS)
    check()
  })
}

const isMain = () => { try { return fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url)) } catch { return false } }
if (isMain()) {
  const result = await runWakeHook().catch(() => ({ code: 0 }))
  if (result.text) process.stderr.write(result.text + '\n')
  process.exit(result.code)
}
