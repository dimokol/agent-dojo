import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { spawn, execFileSync } from 'node:child_process'
import { processIdentity, isProcessLive } from './native-session.mjs'
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
const requireProof = (value, code) => { if (!value) throw new Error(code) }
export function spawnVerificationPty(args, { cwd, env }) {
  const bridge = `import os,pty,subprocess,select,sys,json,fcntl,termios,struct
master,slave=pty.openpty()
fcntl.ioctl(slave,termios.TIOCSWINSZ,struct.pack('HHHH',40,120,0,0))
def own_terminal():
 os.setsid()
 fcntl.ioctl(0,termios.TIOCSCTTY,0)
actor=subprocess.Popen(json.loads(sys.argv[1]),stdin=slave,stdout=slave,stderr=slave,preexec_fn=own_terminal)
os.close(slave)
try:
 while actor.poll() is None:
  ready,_,_=select.select([master,sys.stdin.fileno()],[],[],0.5)
  if master in ready:
   try: data=os.read(master,8192)
   except OSError: break
   if not data: break
   sys.stdout.buffer.write(data);sys.stdout.buffer.flush()
  if sys.stdin.fileno() in ready:
   data=os.read(sys.stdin.fileno(),8192)
   if not data: break
   os.write(master,data)
   print('VERIFY_INPUT_BYTES:'+str(len(data)),flush=True)
finally:
 if actor.poll() is None:
  actor.terminate()
  try: actor.wait(timeout=2)
  except subprocess.TimeoutExpired: actor.kill();actor.wait()
 os.close(master)
sys.exit(actor.returncode if actor.returncode is not None and actor.returncode>=0 else 1)
`
  return spawn('/usr/bin/python3', ['-c', bridge, JSON.stringify(args)], { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] })

}
// Started from inside a Claude tab, the probe inherits the tab's child-session marker and saves
// no transcript, so /resume finds nothing. Only the resume case needs one.
export function resumeCaseEnv(env) {
  const next = { ...env }
  delete next.CLAUDE_CODE_CHILD_SESSION; delete next.CLAUDECODE
  return next
}
// Claude 2.1.303 prints no "Resumed" line after /resume <id>; it redraws the old conversation.
// A settle period stands in for it. The transcript check afterwards proves the right target.
export function resumeState(text, sentAt, now = Date.now()) {
  if (/was\s*not\s*found/i.test(text)) return 'not_found'
  return /(?:Resumed|resum(?:e|ed) session)/i.test(text) || now - sentAt >= 6000 ? 'settled' : 'pending'
}
export async function stopVerificationPty(child, childExited, owned, result) {
    if (child?.pid) {
      // Capture this PTY's process tree before closing it, including a CLI that
      // never reached READY. Only recorded descendants can receive a signal.
      try {
        const original = owned.get(child.pid)
        requireProof(original && isProcessLive(original), 'OWNED_PTY_NO_LONGER_LIVE')
        const rows = execFileSync('/bin/ps', ['-ax', '-o', 'pid=', '-o', 'ppid=', '-o', 'uid='], {
          encoding: 'utf8', timeout: 1000, maxBuffer: 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'],
          env: { ...process.env, LC_ALL: 'C', TZ: 'UTC' },
        }).trim().split('\n').map(row => row.trim().split(/\s+/).map(Number))
        const parents = new Map(rows.filter(row => row[2] === process.getuid()).map(row => [row[0], row[1]]))
        for (const pid of parents.keys()) {
          let current = pid
          for (let hop = 0; hop < 12 && current; hop++) {
            if (current === child.pid) {
              const identity = processIdentity(pid)
              if (identity && !owned.has(pid)) owned.set(pid, identity)
              break
            }
            current = parents.get(current)
          }
        }
      } catch { result.cleanupPresenceUnavailable = true }
      child.stdin.on('error', () => {})
      child.stdin.write('\x03')
      await Promise.race([childExited, delay(1000)])
      for (const identity of [...owned.values()].reverse()) {
        try { if (isProcessLive(identity)) process.kill(identity.pid, 'SIGTERM') } catch { result.cleanupPresenceUnavailable = true }
      }
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM')
      const force = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
        for (const identity of owned.values()) {
          try { if (isProcessLive(identity)) process.kill(identity.pid, 'SIGKILL') } catch {}
        }
      }, 2000)
      result.ownedPtyExit = await childExited
      const deadline = Date.now() + 2000
      let remaining = []
      do {
        remaining = [...owned.values()].filter(identity => { try { return isProcessLive(identity) } catch { return true } })
        if (!remaining.length) break
        await delay(50)
      } while (Date.now() < deadline)
      if (remaining.length) {
        for (const identity of remaining) { try { if (isProcessLive(identity)) process.kill(identity.pid,'SIGKILL') } catch {} }
        await delay(250)
        remaining=remaining.filter(identity=>{try{return isProcessLive(identity)}catch{return true}})
      }
      clearTimeout(force)
      if (remaining.length) { result.passed = false; result.cleanupIncomplete = true; process.exitCode = 1 }
    }

}

// Exact caller-owned transcript only. Never enumerates another conversation.
export function resumedTranscriptProof({ cwd, configHome = path.join(os.homedir(), '.claude'), targetId, marker, afterBytes = 0 }) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(targetId) || typeof marker !== 'string' || !marker) throw new Error('INVALID_OWNED_TRANSCRIPT_PROOF')
  const file = path.join(configHome, 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'), `${targetId}.jsonl`)
  if (!Number.isSafeInteger(afterBytes) || afterBytes < 0) throw new Error('INVALID_OWNED_TRANSCRIPT_PROOF')
  let buffer
  try {
    const stat = fs.lstatSync(file)
    if (!stat.isFile() || stat.uid !== process.getuid() || stat.nlink !== 1 || (stat.mode & 0o022)) throw new Error('UNSAFE_OWNED_TRANSCRIPT')
    buffer = fs.readFileSync(file)
  } catch (error) { if (error.code === 'ENOENT') return { matched: false, bytes: 0 }; throw error }
  const rows = buffer.subarray(afterBytes).toString('utf8').split('\n').filter(Boolean).map(line => { try { return JSON.parse(line) } catch { return null } })
  const matched = rows.some(row => row?.type === 'user' && row.sessionId === targetId &&
    (typeof row.message?.content === 'string' ? row.message.content.includes(marker) :
      Array.isArray(row.message?.content) && row.message.content.some(part => part.type === 'text' && part.text?.includes(marker))))
  return { matched, bytes: buffer.length }
}

// Removes the probe's own conversation files, found by the exact IDs it generated; nothing else
// is enumerated. Without this every check left a transcript in the project's /resume list.
export function removeProbeConversation({ cwd, configHome = path.join(os.homedir(), '.claude'), ids }) {
  const project = path.join(configHome, 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'))
  let removed = 0
  for (const id of new Set(ids)) {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) throw new Error('INVALID_OWNED_PROBE_ID')
    for (const target of [path.join(project, `${id}.jsonl`), path.join(project, id), path.join(configHome, 'session-env', id)]) {
      try { fs.rmSync(target, { recursive: true }); removed++ } catch (error) { if (error.code !== 'ENOENT') throw error }
    }
  }
  return removed
}
