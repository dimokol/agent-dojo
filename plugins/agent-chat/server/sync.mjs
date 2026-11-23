// Device side of the hub, run inside the shared daemon: one engine per state root.
//
// The engine takes the sync lock (so two daemons, say two releases during an upgrade, never sync at
// once), then loops: follow new projects, send the outbox, push this device's members of shared
// rooms, and long-poll the hub's drain from the stored cursor. What comes back goes into the local
// rooms through the store, where each tab's log watcher rings its own recipients.
//
// Files, all under <state root>/sync (on the PC that is D:\AgentChat\state\sync):
//   device.json      key and hub (device.mjs)        outbox/<id>.json   posts the hub hasn't stored
//   cursor.json      last hub sequence stored here    failed/<id>.json   posts the hub refused for good, 30 days
//   projects.json    optional { "<project folder>": "<hub project>" } overrides
//   sync.lock        SQLite lock                      audit.log          metadata only, 1 MB x 3
import fs from 'node:fs'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { DatabaseSync } from 'node:sqlite'
import { loadDevice, deviceRequest, syncDir, HubError } from './device.mjs'
import { normalizeOrigin, validProject } from './hub-protocol.mjs'
import { ensureDirectory, readJson, atomicJson } from './store-files.mjs'
import { gitCommand } from './project-scope.mjs'
import { rotateAppend } from './hub.mjs'
import { createStore } from './store.mjs'

export const LEASE_MS = 90_000
const FAILED_KEEP_MS = 30 * 86400_000
const DRAIN_WAIT_S = 25
// A post the hub keeps refusing for a reason that may pass (room or name unknown there) waits this
// long in the outbox, then moves to failed/.
const OUTBOX_GIVE_UP_MS = 7 * 86400_000
const BATCH_BYTES = 700_000
const TOO_BIG_BYTES = 900_000

export function originOf(projectRoot, { timeoutMs = 5000 } = {}) {
  return new Promise(resolve => execFile(gitCommand(), ['-C', projectRoot, 'remote', 'get-url', 'origin'], { encoding: 'utf8', timeout: timeoutMs, windowsHide: true },
    (error, stdout) => resolve(error ? null : normalizeOrigin(String(stdout).trim()))))
}

export function createSync({ stateRoot, chatRoot, now = Date.now, retryMs = 30_000, drainWaitS = DRAIN_WAIT_S, log = () => {} }) {
  const dir = syncDir(stateRoot)
  ensureDirectory(dir)
  const files = { cursor: path.join(dir, 'cursor.json'), projects: path.join(dir, 'projects.json'), outbox: path.join(dir, 'outbox'), failed: path.join(dir, 'failed'), audit: path.join(dir, 'audit.log'), lock: path.join(dir, 'sync.lock') }
  const audit = line => rotateAppend(files.audit, `${new Date(now()).toISOString()} ${line}`)
  let device = loadDevice(stateRoot)
  let cursor = readJson(files.cursor, { cursor: 0 }).cursor ?? 0
  const projects = new Map()          // hub project -> { store, subscribed }
  const keys = new Map()              // project folder -> hub project or null
  const mine = new Map()              // project\0room\0alias -> what the hub holds for this device
  const waiting = new Map()           // outbox id -> the hub's last reason for not storing it
  let hubDown = false
  let devicesAt = 0
  let devices = {}, lock = null, stopped = false, running = null, abort = null, flushing = null, watcher = null, wakeLoop = null

  const projectKey = async projectRoot => {
    if (keys.has(projectRoot)) return keys.get(projectRoot)
    let override = null
    try { override = readJson(files.projects, {})[projectRoot] ?? null } catch {}
    const key = override && validProject(override) ? override : await originOf(projectRoot)
    keys.set(projectRoot, key && validProject(key) ? key : null)
    return keys.get(projectRoot)
  }
  const storeFor = project => projects.get(project)?.store ?? null

  const takeLock = () => {
    if (lock) return true
    const db = new DatabaseSync(files.lock)
    try { db.exec('PRAGMA busy_timeout=0; BEGIN IMMEDIATE'); lock = db; return true } catch { db.close(); return false }
  }

  // Cleanup runs when the lock is taken: refused posts older than 30 days go, and are logged.
  const cleanup = () => {
    let names = []
    try { names = fs.readdirSync(files.failed) } catch { return }
    for (const name of names) {
      const file = path.join(files.failed, name)
      try { if (now() - fs.statSync(file).mtimeMs > FAILED_KEEP_MS) { fs.rmSync(file); audit(`cleanup removed failed/${name}`) } } catch {}
    }
  }

  const request = (method, pathname, body, options) => deviceRequest(device, method, pathname, body, options)

  const subscribe = async () => {
    for (const [project, entry] of projects) if (!entry.subscribed) {
      const answer = await request('POST', '/v1/projects', { project })
      entry.subscribed = true
      if (answer.devices) { devices = answer.devices; devicesAt = now() }
      if (!apply(answer.events)) { entry.subscribed = false; throw new Error('a message could not be stored here yet; retrying') }
    }
  }

  // One flush at a time. The reset runs in .finally, after the assignment: a flush that finished
  // without awaiting would otherwise leave its settled promise in place for good.
  // A file written while a flush runs makes it go round once more.
  let again = false
  const flushOutbox = () => { if (flushing) { again = true; return flushing } ; return flushing = sendOutbox().finally(() => { flushing = null; if (again && !stopped) { again = false; flushOutbox().catch(() => {}) } }) }
  const giveUp = (name, id, reason) => {
    ensureDirectory(files.failed)
    try { fs.renameSync(path.join(files.outbox, name), path.join(files.failed, name)) } catch {}
    waiting.delete(id)
    audit(`post ${id} moved to failed/: ${reason}`)
  }
  const sendOutbox = async () => {
    let names
    try { names = fs.readdirSync(files.outbox).filter(name => name.endsWith('.json')) } catch { return }
    // Batches stay well under the hub's 1 MB request cap; one post too big on its own goes to failed/.
    const batches = [[]]
    let bytes = 0
    for (const name of names) {
      let envelope, size
      try { envelope = readJson(path.join(files.outbox, name), null); size = Buffer.byteLength(JSON.stringify(envelope)) } catch { continue }
      if (!envelope) continue
      if (size > TOO_BIG_BYTES) { giveUp(name, envelope.id, 'too large for the hub'); continue }
      if (bytes + size > BATCH_BYTES || batches.at(-1).length >= 50) { batches.push([]); bytes = 0 }
      batches.at(-1).push([name, envelope]); bytes += size
    }
    for (const batch of batches) {
      if (!batch.length) continue
      const answer = await request('POST', '/v1/messages', { messages: batch.map(([, e]) => e) })
      if (answer.devices) { devices = answer.devices; devicesAt = now() }
      for (const [name, envelope] of batch) {
        const result = answer.results?.[envelope.id]
        if (result?.stored) { fs.rmSync(path.join(files.outbox, name), { force: true }); waiting.delete(envelope.id) }
        else if (result?.error === 'invalid envelope' || result?.error === 'message id taken') giveUp(name, envelope.id, result.error)
        else if (result?.error) {
          let age = 0
          try { age = now() - fs.statSync(path.join(files.outbox, name)).mtimeMs } catch {}
          if (age > OUTBOX_GIVE_UP_MS) giveUp(name, envelope.id, `still refused after 7 days: ${result.error}`)
          else if (waiting.get(envelope.id) !== result.error) { waiting.set(envelope.id, result.error); audit(`post ${envelope.id} waits: ${result.error}`) }
        }
      }
    }
  }

  // This device's members of shared rooms, as the hub should hold them. A row that never joined
  // (a placeholder kept for direct mail) reserves nothing.
  const pushMembers = async () => {
    for (const [project, { store }] of projects) {
      for (const shared of store.sharedRooms()) {
        const rows = store.memberships().filter(row => row.room === shared.room && (row.joined || row.left_reason))
        const seen = new Set()
        for (const row of rows) {
          const keyOf = `${project}\0${shared.room}\0${row.agent.toLowerCase()}`
          seen.add(keyOf)
          const want = { alias: row.agent, participant: String(row.participant_id ?? ''), joined: row.joined === true, runtime: row.session?.runtime ?? '' }
          const held = mine.get(keyOf)
          if (held && held.alias === want.alias && held.participant === want.participant && held.joined === want.joined && held.runtime === want.runtime) continue
          try { await reserve(project, shared.room, want) }
          catch (error) { memberRefused(error, shared.room, row.agent) }
        }
        for (const [keyOf, held] of mine) if (keyOf.startsWith(`${project}\0${shared.room}\0`) && !seen.has(keyOf)) {
          try { await request('POST', '/v1/members', { project, room: shared.room, alias: held.alias, release: true }); mine.delete(keyOf) }
          catch (error) { memberRefused(error, shared.room, held.alias) }
        }
      }
    }
  }

  // One refused member (a name held elsewhere, a room the hub doesn't know after a reset) is logged
  // once and skipped; only an unreachable hub stops the pass.
  const refusedOnce = new Set()
  const memberRefused = (error, room, alias) => {
    if (error.unreachable || error.name === 'AbortError') throw error
    const line = `member ${room}/${alias} refused: ${error.body?.holder ? `held on ${error.body.holder}` : String(error.message).slice(0, 120)}`
    if (!refusedOnce.has(line)) { refusedOnce.add(line); audit(line) }
  }
  const reserve = async (project, room, member) => {
    const answer = await request('POST', '/v1/members', { project, room, ...member })
    if (answer.event) apply([answer.event])
    return answer.event
  }

  // Returns false when a message could not be stored for a reason that may pass (a busy state lock),
  // so the cursor stays put and the next drain brings it again.
  const apply = events => {
    let complete = true
    for (const event of events ?? []) {
      const store = storeFor(event.project)
      if (!store) continue
      try {
        if (event.type === 'room') {
          if (store.adoptSharedRoom({ room: event.room, title: event.title, project: event.project }) === 'conflict') audit(`room ${event.room}: a local room of that name isn't shared; skipped`)
        } else if (event.type === 'member') {
          const keyOf = `${event.project}\0${event.room}\0${event.alias.toLowerCase()}`
          if (event.device === device.id) { if (event.released) mine.delete(keyOf); else mine.set(keyOf, event) }
          else if (store.sharedRoom(event.room)) store.setRemoteMember(event.room, { ...event, device_name: devices[event.device]?.name ?? event.device })
        } else if (event.type === 'message' && event.device !== device.id && store.sharedRoom(event.room) && !store.hasMessage(event.room, event.envelope?.id)) {
          store.importRemote(event.room, { ...event, localDevice: device.id })
        }
      } catch (error) {
        audit(`event ${event.seq} (${event.type} ${event.room}) not applied: ${String(error.message).slice(0, 200)}`)
        if (event.type === 'message' && error.code !== 'CHAT_REMOTE_INVALID') { complete = false; break }
      }
    }
    return complete
  }

  const drain = async () => {
    abort = new AbortController()
    try {
      const answer = await request('GET', `/v1/drain?cursor=${cursor}&wait=${drainWaitS}`, undefined, { timeoutMs: (drainWaitS + 15) * 1000, signal: abort.signal })
      if (answer.devices) { devices = answer.devices; devicesAt = now() }
      if (!apply(answer.events)) throw new Error('a message could not be stored here yet; retrying from the same cursor')
      if (answer.cursor !== cursor) { cursor = answer.cursor; atomicJson(files.cursor, { cursor }) }
    } finally { abort = null }
  }

  const sleep = ms => new Promise(resolve => { const timer = setTimeout(resolve, ms); timer.unref?.(); wakeLoop = () => { clearTimeout(timer); resolve() } })

  const loop = async () => {
    while (!stopped && !takeLock()) await sleep(retryMs)
    if (stopped) return
    cleanup()
    try { ensureDirectory(files.outbox); watcher = fs.watch(files.outbox, () => { if (!stopped) flushOutbox().catch(() => {}) }) ; watcher.on('error', () => {}) } catch {}
    let backoff = 1000, lastError = null
    while (!stopped) {
      try {
        // Posts go out before members are released, so a post made under a name that is going away
        // still finds it held; the second flush sends posts that waited for a name just pushed.
        await subscribe(); await flushOutbox(); await pushMembers(); await flushOutbox(); await drain()
        if (lastError) { audit('hub reachable again'); lastError = null }
        hubDown = false
        backoff = 1000
      } catch (error) {
        if (stopped) break
        if (error.name === 'AbortError') continue
        const text = String(error.message).slice(0, 200)
        if (text !== lastError) { audit(`sync paused: ${text}`); log(`sync: ${text}`); lastError = text }
        hubDown = true
        await sleep(backoff); backoff = Math.min(30_000, backoff * 2)
      }
    }
  }

  return {
    get device() { return device },
    get cursor() { return cursor },
    get devices() { return devices },
    projectKey,
    // A tab of this project connected: follow its shared rooms from now on.
    async addProject(projectRoot, store) {
      const key = await projectKey(projectRoot)
      if (!key) return null
      if (!projects.has(key)) { projects.set(key, { store: store ?? createStore({ root: chatRoot, projectRoot, stateRoot }), subscribed: false }); abort?.abort(); wakeLoop?.() }
      return key
    },
    start() { device ??= loadDevice(stateRoot); if (device && !running) running = loop(); return running },
    async createRoom(project, room, title) { const answer = await request('POST', '/v1/rooms', { project, room, title }); apply([answer.event]) },
    reserve,
    // The sender's outlook for mail to a session on another device.
    get hubDown() { return hubDown },
    outlook(deviceId) {
      const d = devices[deviceId]
      const name = d?.name ?? deviceId
      if (hubDown) return { state: 'queued', detail: `in this machine's outbox until the hub is reachable, then queued for ${name}` }
      // The hub says how long ago it last heard from that device, so the two clocks never compare.
      const ago = d && Number.isFinite(d.seen_ms_ago) ? d.seen_ms_ago + (now() - devicesAt) : Infinity
      return ago < LEASE_MS ? { state: 'sent', detail: `${name} is online; it wakes when the hub hands it over` } : { state: 'queued', detail: `queued until ${name} is back` }
    },
    flush: () => flushOutbox(),
    async stop() {
      stopped = true; abort?.abort(); wakeLoop?.(); watcher?.close()
      await running?.catch(() => {})
      try { lock?.exec('ROLLBACK') } catch {}
      try { lock?.close() } catch {}
      lock = null
    },
  }
}

// One engine per state root in this process, started only on a paired device.
const engines = new Map()
export function syncFor({ stateRoot, chatRoot, log }) {
  if (engines.has(stateRoot)) return engines.get(stateRoot)
  if (!loadDevice(stateRoot)) return null
  const engine = createSync({ stateRoot, chatRoot, log })
  engines.set(stateRoot, engine)
  engine.start()
  return engine
}
export const stopAllSync = () => Promise.all([...engines.values()].map(engine => engine.stop()))
export { HubError }
