import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { codexBinary } from './native-session.mjs'

const require = createRequire(import.meta.url)
const execute = promisify(execFile)
const CODEX = codexBinary(os.homedir(), { resolve: false })
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const MAX_PAYLOAD = 128 * 1024

// The release keeps node_modules next to this file; the plugin keeps it one folder up, where
// Claude Code installs a plugin's dependencies. Only those two exact paths are tried.
function localWebSocket() {
  const entries = ['./node_modules/ws/index.js', '../node_modules/ws/index.js'].map(name => fileURLToPath(new URL(name, import.meta.url)))
  const entry = entries.find(file => fs.existsSync(file)) ?? entries[0]
  try {
    if (fs.realpathSync(entry) !== entry) throw new Error('Unexpected module alias')
    return require(entry)
  } catch {
    throw Object.assign(new Error('Agent-chat local WebSocket dependency is unavailable'), { code: 'CHAT_NATIVE_WS_UNAVAILABLE' })
  }
}

async function loadedThread(client, session) {
  const result = await client.rpc('thread/loaded/list', {})
  if (!Array.isArray(result?.data) || result.data.some(id => typeof id !== 'string') || result.nextCursor) throw new Error('Invalid loaded thread list')
  return result.data.includes(session.id)
}
async function threadMetadata(client, session) {
  const result = await client.rpc('thread/read', { threadId: session.id, includeTurns: false })
  if (result?.thread?.id !== session.id || typeof result.thread.cwd !== 'string' || !path.isAbsolute(result.thread.cwd)) throw new Error('Invalid thread metadata')
  return { id: result.thread.id, cwd: result.thread.cwd }
}

function privateDirectory(value) {
  const stat = fs.lstatSync(value)
  if (!stat.isDirectory() || stat.uid !== process.getuid() || (stat.mode & 0o777) !== 0o700) {
    throw new Error('Native control directory is not private')
  }
}

// The daemon intentionally publishes this one alias. Resolve it, then validate
// the real socket and its parents rather than refusing the supported symlink.
export function validateControlSocket(profileHome, advertisedPath) {
  const home = fs.realpathSync(profileHome)
  const homeStat = fs.statSync(home)
  if (!homeStat.isDirectory() || homeStat.uid !== process.getuid() || homeStat.mode & 0o022) {
    throw new Error('Native profile is not owned by this user')
  }
  const aliasParent = path.join(home, 'app-server-control')
  const alias = path.join(aliasParent, 'app-server-control.sock')
  if (advertisedPath !== alias) throw new Error('Unexpected native control endpoint')
  privateDirectory(aliasParent)
  const link = fs.lstatSync(alias)
  if (link.uid !== process.getuid() || (!link.isSymbolicLink() && !link.isSocket())) {
    throw new Error('Invalid native control alias')
  }
  const canonical = fs.realpathSync(alias)
  if (canonical.includes(':') || canonical.includes('\0')) throw new Error('Invalid native socket path')
  const socket = fs.lstatSync(canonical)
  if (!socket.isSocket() || socket.uid !== process.getuid() || (socket.mode & 0o777) !== 0o600) {
    throw new Error('Native control socket is not private')
  }
  privateDirectory(path.dirname(canonical))
  let current = path.dirname(path.dirname(canonical))
  while (true) {
    const stat = fs.lstatSync(current)
    if (!stat.isDirectory() || ![0, process.getuid()].includes(stat.uid) ||
        ((stat.mode & 0o022) && !(stat.mode & 0o1000))) throw new Error('Unsafe native socket ancestor')
    const next = path.dirname(current)
    if (next === current) break
    current = next
  }
  return canonical
}

function connection(WebSocket, socketPath, timeoutMs, recheck) {
  return new Promise((resolve, reject) => {
    let socket, settled = false, serial = 0
    const pending = new Map()
    const fail = () => {
      clearTimeout(timer)
      socket?.terminate()
      const error = new Error('Native control connection failed')
      for (const waiter of pending.values()) waiter.reject(error)
      pending.clear()
      if (!settled) { settled = true; reject(error) }
    }
    const close = () => {
      clearTimeout(timer)
      socket?.terminate()
      fail()
    }
    const timer = setTimeout(close, timeoutMs)
    try {
      if (recheck() !== socketPath) throw new Error('Native control endpoint changed')
      socket = new WebSocket(`ws+unix://${socketPath}:/`, {
        maxPayload: MAX_PAYLOAD, perMessageDeflate: false, handshakeTimeout: timeoutMs,
      })
      socket.on('error', fail)
      socket.on('close', fail)
      socket.on('message', (data, binary) => {
        if (binary) { close(); return }
        let message
        try { message = JSON.parse(data.toString()) } catch { close(); return }
        if (!message || typeof message !== 'object' || Array.isArray(message)) { close(); return }
        const waiter = pending.get(message.id)
        if (!waiter) return // Notifications and unrelated IDs are never requests.
        pending.delete(message.id)
        if (message.error) {
          // In 0.162.1 metadata-only read returns this exact error only when
          // neither a loaded thread nor persisted metadata exists. Other errors
          // remain unknown presence and never revoke a durable membership.
          const missing = waiter.method === 'thread/read' && message.error.code === -32600 &&
            message.error.message === `thread not loaded: ${waiter.threadId}`
          waiter.reject(Object.assign(new Error('Native control RPC failed'),
            missing ? { code: 'CHAT_NATIVE_THREAD_GONE' } : {}))
        }
        else if (!Object.hasOwn(message, 'result')) waiter.reject(new Error('Invalid native control response'))
        else waiter.resolve(message.result)
      })
      socket.on('open', () => {
        settled = true
        resolve({
          close,
          notify(method) { socket.send(JSON.stringify({ method })) },
          rpc(method, params) {
            const id = ++serial
            return new Promise((resolveRPC, rejectRPC) => {
              pending.set(id, { resolve: resolveRPC, reject: rejectRPC, method, threadId: params?.threadId })
              socket.send(JSON.stringify({ id, method, params }), error => {
                if (error) { pending.delete(id); rejectRPC(new Error('Native control send failed')) }
              })
            })
          },
        })
      })
    } catch { close() }
  })
}

export function createNativeControl({ WebSocket, timeoutMs = 3000, executor = execute } = {}) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000) throw new TypeError('Invalid control timeout')
  // Discovery reports a fixed local alias only. Every call still revalidates
  // that alias and opens a fresh connection to query current thread state.
  const discovery = new Map()
  // allowStopped: a verified stopped daemon answers [] instead of failing.
  // fresh skips the brief discovery cache, which only ever holds a running daemon.
  async function run(session, operation, { allowStopped = false, fresh = allowStopped } = {}) {
    if (session?.runtime !== 'codex' || !UUID.test(session.id ?? '') ||
        typeof session.profileHome !== 'string' || !path.isAbsolute(session.profileHome)) throw new TypeError('Invalid native session')
    const started = Date.now()
    const profileHome = fs.realpathSync(session.profileHome)
    let status = fresh ? null : discovery.get(profileHome)
    if (!status || status.expiresAt <= started) {
      const nativeEnv = { ...process.env, CODEX_HOME: profileHome }
      delete nativeEnv.CLAUDE_CODE_MESSAGING_TOKEN
      delete nativeEnv.CLAUDE_CODE_MESSAGING_SOCKET
      let output
      try {
        output = await executor(CODEX, ['app-server', 'daemon', 'version'], {
          env: nativeEnv,
          timeout: timeoutMs, maxBuffer: MAX_PAYLOAD, encoding: 'utf8',
        })
      } catch (error) {
        const alias = path.join(profileHome, 'app-server-control', 'app-server-control.sock')
        // The version command does not start a daemon. Only its verified ENOENT
        // failure and an absent expected alias establish a stopped profile.
        if (allowStopped && !fs.existsSync(alias) && typeof error.stderr === 'string' &&
            error.stderr.trim().endsWith('No such file or directory (os error 2)')) return []
        throw new Error('Native daemon unavailable')
      }
      if (output.code !== undefined && output.code !== 0) throw new Error('Native daemon unavailable')
      let parsed
      try { parsed = JSON.parse(output.stdout) } catch { throw new Error('Invalid native daemon response') }
      if (parsed?.status !== 'running' || typeof parsed.socketPath !== 'string') throw new Error('Native daemon unavailable')
      status = { socketPath: parsed.socketPath, expiresAt: started + 250 }
      if (discovery.size >= 16) discovery.delete(discovery.keys().next().value)
      discovery.set(profileHome, status)
    }
    const endpoint = validateControlSocket(profileHome, status.socketPath)
    const remaining = timeoutMs - (Date.now() - started)
    if (remaining <= 0) throw new Error('Native control timed out')
    const client = await connection(WebSocket || localWebSocket(), endpoint, remaining,
      () => validateControlSocket(profileHome, status.socketPath))
    try {
      await client.rpc('initialize', { clientInfo: { name: 'agent_chat_control', version: '2.0.0' } })
      client.notify('initialized')
      return await operation(client)
    } finally { client.close() }
  }
  return {
    profileThreads(profileHome) {
      return run({ runtime: 'codex', id: '00000000-0000-0000-0000-000000000000', profileHome }, async client => {
        const loaded = await client.rpc('thread/loaded/list', {})
        if (!Array.isArray(loaded?.data) || loaded.data.length > 256 || loaded.nextCursor ||
            loaded.data.some(id => !UUID.test(id))) throw new Error('Invalid loaded thread list')
        const rows = []
        for (const id of loaded.data) {
          const result = await client.rpc('thread/read', { threadId: id, includeTurns: false })
          const thread = result?.thread
          if (thread?.id !== id || !['idle', 'notLoaded', 'active', 'systemError'].includes(thread.status?.type)) {
            throw new Error('Invalid thread status metadata')
          }
          if (thread.status.type === 'active' && !Array.isArray(thread.status.activeFlags)) throw new Error('Invalid active thread metadata')
          rows.push({ id, status: { type: thread.status.type } })
        }
        return rows
      }, { allowStopped: true })
    },
    // In-memory membership is a daemon fact, not evidence of a connected UI.
    // Immediate native unloading needs thread_unload_delay_secs = 0 and a
    // daemon restart. Neither setting nor restarting is this client's job.
    loaded(session) { return run(session, client => loadedThread(client, session)) },
    read(session) { return run(session, client => threadMetadata(client, session)) },
    // A verified stopped daemon has no loaded threads, so no open tab.
    async inspect(session) {
      const state = await run(session, async client => {
        const loaded = await loadedThread(client, session)
        try {
          // Metadata reads do not subscribe, resume or load an existing thread.
          const metadata = await threadMetadata(client, session)
          return { loaded, exists: true, cwd: metadata.cwd }
        } catch (error) {
          if (error.code === 'CHAT_NATIVE_THREAD_GONE') return { loaded: false, exists: false, cwd: null }
          throw error
        }
      }, { allowStopped: true, fresh: false })
      return Array.isArray(state) ? { loaded: false, exists: null, cwd: null, stopped: true } : state
    },
  }
}
