#!/usr/bin/env node
// The shared agent-chat daemon: one process serves every tab's MCP connection.
//
//   node daemon.mjs <socket>
//
// Each tab runs agent-chat-bridge (bridge.c), a small process that Claude or Codex starts in place of
// server.mjs. The bridge connects to <socket>, starting this daemon when nothing answers, and sends
// one hello line: its own PID, its parent's PID (the tab), its folder and the environment keys in
// HELLO_ENV. The daemon answers {"ok":true} or {"error":"<text>"}, then the connection carries MCP
// lines both ways. Each connection gets its own store and service, exactly as a server.mjs started
// by that tab would have, with the bridge standing in for the server process.
//
// One daemon runs per socket; a lock next to the socket keeps a second one from starting. It exits
// IDLE_MS after its last connection closes. The socket and its folder are private to this user.
import './runtime.mjs'
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import readline from 'node:readline'
import { EventEmitter } from 'node:events'
import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { openDaemonConnection, serveConnection, startupErrorText } from './server.mjs'
import { adoptProcess, releaseProcess } from './native-session.mjs'
import { hasModeBits, ownedByMe, WINDOWS, WIN_HELPER, windowsFolderPrivate } from './platform.mjs'
import { randomBytes } from 'node:crypto'

// The only environment a tab hands over. Anything else (tokens, the tab's whole shell) stays home.
export const HELLO_ENV = ['CLAUDE_CODE_SESSION_ID', 'CLAUDE_CODE_MESSAGING_SOCKET', 'CLAUDE_CONFIG_DIR', 'CODEX_HOME',
  'AGENT_CHAT_CODEX_HOME', 'AGENT_CHAT_VERIFY_CHILD', 'AGENT_CHAT_ROOT', 'AGENT_CHAT_STATE_ROOT', 'AGENT_CHAT_VERSION_CHECK',
  'AGENT_CHAT_DIR', 'AGENT_CHAT_PROJECT', 'AGENT_CHAT_WAKE', 'AGENT_CHAT_WAKE_DIR']
const HELLO_TIMEOUT_MS = 10_000
const HELLO_MAX_BYTES = 64 * 1024

export function parseHello(line) {
  let hello
  try { hello = JSON.parse(line) } catch { return null }
  if (!hello || hello.v !== 1) return null
  const pid = hello.pid, ppid = hello.ppid
  if (!Number.isSafeInteger(pid) || pid <= 1 || !Number.isSafeInteger(ppid) || ppid <= 0) return null
  if (typeof hello.cwd !== 'string' || !path.isAbsolute(hello.cwd) || hello.cwd.includes('\0')) return null
  const env = {}
  for (const [key, value] of Object.entries(hello.env ?? {})) {
    if (!HELLO_ENV.includes(key) || typeof value !== 'string' || value.includes('\0')) return null
    env[key] = value
  }
  if (hello.key !== undefined && typeof hello.key !== 'string') return null
  return { proc: { pid, ppid, cwd: hello.cwd }, env, ...(hello.key === undefined ? {} : { key: hello.key }) }
}

// The bridge names its own PID and parent. ps confirms both when it can answer; a ps that can't run
// (a busy machine) proves nothing either way, and the native checks still verify the parent later.
function confirmPeer({ pid, ppid }) {
  if (WINDOWS) return new Promise(resolve => {
    execFile(WIN_HELPER, ['ps', String(pid)], { encoding: 'utf8', timeout: 2000, windowsHide: true }, (error, stdout) => {
      if (error) return resolve(true)
      let row = null
      try { row = JSON.parse(String(stdout).trim().split('\n')[0] || 'null') } catch {}
      resolve(!!row && row.pid === pid && row.mine === true && row.ppid === ppid)
    })
  })
  return new Promise(resolve => {
    execFile('/bin/ps', ['-p', String(pid), '-o', 'uid=', '-o', 'ppid='], { encoding: 'utf8', timeout: 2000, env: { ...process.env, LC_ALL: 'C' } }, (error, stdout) => {
      if (error && !(error.code === 1 && !String(stdout).trim())) return resolve(true)
      const match = /^\s*(\d+)\s+(\d+)\s*$/.exec(String(stdout))
      resolve(!!match && Number(match[1]) === process.getuid() && Number(match[2]) === ppid)
    })
  })
}

function privateFolder(directory) {
  // The first folder made: on Windows the lock starts there, so a parent made on the way is private too.
  const first = fs.mkdirSync(directory, { recursive: true, mode: 0o700 })
  if (WINDOWS && !windowsFolderPrivate(first ?? directory, { created: first !== undefined })) throw new Error(`unsafe daemon folder ${directory}`)
  const stat = fs.lstatSync(directory)
  if (!stat.isDirectory() || !ownedByMe(stat) || hasModeBits(stat, 0o077)) throw new Error(`unsafe daemon folder ${directory}`)
}

export function startDaemon(socketPath, { idleMs = Number(process.env.AGENT_CHAT_DAEMON_IDLE_MS) || 120_000, log = () => {}, exit = code => process.exit(code) } = {}) {
  if (!path.isAbsolute(socketPath)) throw new Error('absolute socket path required')
  privateFolder(path.dirname(socketPath))
  // SQLite holds an OS lock for the daemon's life; process death, SIGKILL included, releases it.
  const lock = new DatabaseSync(socketPath + '.lock')
  try { lock.exec('PRAGMA busy_timeout=0; BEGIN IMMEDIATE') }
  catch { lock.close(); log('another daemon holds the lock'); return null }
  fs.rmSync(socketPath, { force: true })
  // Windows: the socket path is a key file naming a random pipe; a hello must carry its key.
  const windowsPipe = WINDOWS ? { pipe: `\\\\.\\pipe\\agent-chat-${randomBytes(16).toString('hex')}`, key: randomBytes(32).toString('hex') } : null
  let connections = 0, idleTimer = null, stopping = false
  const stop = reason => {
    if (stopping) return
    stopping = true
    clearTimeout(idleTimer)
    log(`stop: ${reason}`)
    server.close()
    try { fs.rmSync(socketPath, { force: true }) } catch {}
    try { lock.exec('ROLLBACK') } catch {}
    try { lock.close() } catch {}
    exit(0)
  }
  const armIdle = () => { clearTimeout(idleTimer); if (!connections && !stopping) idleTimer = setTimeout(() => stop('idle'), idleMs) }
  const server = net.createServer(socket => {
    connections++; clearTimeout(idleTimer)
    let proc = null, received = 0, ended = false, closedService = false
    // The service closes exactly once, whether the bridge ended its side or the socket was reset
    // (a killed bridge): readline only reports the first.
    const closeService = () => { if (served && !closedService) { closedService = true; relay.emit('close') } }
    const finish = () => {
      if (ended) return
      ended = true; connections--
      if (state !== 'open') state = 'closed'
      closeService()
      if (proc) releaseProcess(proc.pid)
      armIdle()
    }
    socket.on('close', finish)
    socket.on('error', () => {})
    const lines = readline.createInterface({ input: socket, crlfDelay: Infinity })
    // MCP lines that arrive while the connection opens wait here, then replay in order.
    const relay = new EventEmitter(), pending = []
    let state = 'hello', served = false
    const helloTimer = setTimeout(() => { if (state === 'hello') socket.destroy() }, HELLO_TIMEOUT_MS)
    const countBytes = chunk => { received += chunk.length; if (state === 'hello' && received > HELLO_MAX_BYTES) socket.destroy() }
    socket.on('data', countBytes)
    lines.on('close', () => { if (state !== 'open') state = 'closed'; closeService() })
    lines.on('error', () => {})
    lines.on('line', async line => {
      if (state === 'open') return relay.emit('line', line)
      if (state === 'opening') return pending.push(line)
      if (state !== 'hello') return
      state = 'opening'; clearTimeout(helloTimer); socket.off('data', countBytes)
      const hello = parseHello(line)
      const refuse = text => { socket.end(JSON.stringify({ error: text }) + '\n'); state = 'closed' }
      if (!hello) return refuse('Agent-chat bridge sent an invalid hello')
      if (windowsPipe && hello.key !== windowsPipe.key) return refuse('Agent-chat bridge sent the wrong key')
      if (!await confirmPeer(hello.proc)) return refuse('Agent-chat bridge identity did not match its process')
      if (state === 'closed' || socket.destroyed) return
      proc = hello.proc
      adoptProcess(proc.pid)
      let connection
      try { connection = await openDaemonConnection({ env: hello.env, proc }) }
      catch (error) { log(`connection refused: ${String(error?.message ?? error).slice(0, 200)}`); return refuse(startupErrorText(error, hello.env)) }
      if (state === 'closed' || socket.destroyed) { try { connection.service.close() } catch {} ; return }
      socket.write('{"ok":true}\n')
      served = true
      serveConnection({ ...connection, lines: relay, write: (text, callback) => socket.destroyed ? callback?.(new Error('closed')) : socket.write(text, callback) })
      // The service's start-up pass (presence, this tab's rooms) runs on the next turn, as it does
      // before a server.mjs reads its first line; queued calls wait until it has.
      setImmediate(() => {
        if (state !== 'opening') return
        state = 'open'
        for (const queued of pending.splice(0)) relay.emit('line', queued)
      })
    })
  })
  server.on('error', error => { log(`server error: ${error.code ?? error.message}`); stop('server error') })
  server.listen(windowsPipe ? windowsPipe.pipe : socketPath, () => {
    if (windowsPipe) {
      const temp = `${socketPath}.${process.pid}.tmp`
      fs.writeFileSync(temp, JSON.stringify(windowsPipe) + '\n', { mode: 0o600 })
      fs.renameSync(temp, socketPath)
    } else fs.chmodSync(socketPath, 0o600)
    log(`listening (pid ${process.pid})`)
    armIdle()
  })
  return { server, stop, get connections() { return connections } }
}

function fileLog(socketPath) {
  const file = path.join(path.dirname(socketPath), 'daemon.log')
  return line => {
    try {
      try { if (fs.statSync(file).size > 262_144) fs.renameSync(file, file + '.1') } catch {}
      fs.appendFileSync(file, `${new Date().toISOString()} ${path.basename(socketPath)} ${line}\n`, { mode: 0o600 })
    } catch {}
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const socketPath = process.argv[2]
  const log = fileLog(socketPath ?? '/nonexistent/daemon')
  // One tab's failure must not end every tab's agent-chat: log it and keep serving.
  process.on('uncaughtException', error => log(`uncaught: ${String(error?.stack ?? error).slice(0, 300)}`))
  process.on('unhandledRejection', error => log(`unhandled: ${String(error?.stack ?? error).slice(0, 300)}`))
  try { if (!startDaemon(socketPath, { log })) process.exit(0) }
  catch (error) { log(`start failed: ${error.message}`); process.exit(1) }
}
