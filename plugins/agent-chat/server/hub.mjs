#!/usr/bin/env node
// The agent-chat hub: the canonical copy of every shared room, and the place devices pull from.
//
//   node hub.mjs serve  [--dir <folder>] [--listen host:port]...   (default 127.0.0.1:47390)
//   node hub.mjs invite [--dir <folder>] --address host:port       one-time pairing code, 10 minutes
//   node hub.mjs devices [--dir <folder>]
//   node hub.mjs revoke <device id> [--dir <folder>]
//
// It never connects out. Devices pair once with an invite code, then sign every request; the hub
// signs every answer. Each device long-polls GET /v1/drain with its cursor (the last hub sequence it
// stored) and gets the events of the projects it follows: rooms made, members, messages.
//
// Data (one private folder, default <state root>/hub; the chat root sits under ~/Documents on the
// Mac, which macOS keeps from background jobs like a launchd hub): hub-key.pem, devices.json, events.jsonl
// (append-only, fsynced, the canonical log), cursors.json, invites/ (one file per open invite,
// deleted on use or expiry), audit.log (metadata only, 1 MB x 3).
import './runtime.mjs'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { PROTOCOL, PROTOCOL_HEADER, DEFAULT_PORT, INVITE_TTL_MS, MAX_BODY, newKeyPair, publicKeyFrom, privateKeyFrom, requestBytes, responseBytes,
  signHeaders, verifySignature, timeOk, nonceOk, encodeInvite, secretsMatch, sha256, b64u, validProject } from './hub-protocol.mjs'
import { ensureDirectory, readJson, atomicJson, append, identifier } from './store-files.mjs'
import { isBroadcast } from './message-policy.mjs'

export const defaultHubDir = (env = process.env) => env.AGENT_CHAT_HUB_DIR || path.join(env.AGENT_CHAT_STATE_ROOT || path.join(os.homedir(), '.local', 'state', 'agent-chat'), 'hub')
const LEASE_MS = 60_000
const DRAIN_BATCH = 500
const MAX_WAIT_S = 30
const NONCE_TTL_MS = 2 * 10 * 60_000

export function rotateAppend(file, line, { max = 1024 * 1024, keep = 3 } = {}) {
  try {
    try {
      if (fs.statSync(file).size > max) {
        for (let n = keep - 1; n >= 1; n--) try { fs.renameSync(`${file}.${n}`, `${file}.${n + 1}`) } catch {}
        fs.renameSync(file, `${file}.1`)
      }
    } catch {}
    fs.appendFileSync(file, line + '\n', { mode: 0o600 })
  } catch {}
}

export function hubKey(dir) {
  ensureDirectory(dir)
  const file = path.join(dir, 'hub-key.pem')
  if (!fs.existsSync(file)) {
    const pair = newKeyPair()
    try { fs.writeFileSync(file, pair.privateKey, { mode: 0o600, flag: 'wx' }) } catch (error) { if (error.code !== 'EEXIST') throw error }
  }
  const privateKey = privateKeyFrom(fs.readFileSync(file, 'utf8'))
  const der = crypto.createPublicKey(privateKey).export({ type: 'spki', format: 'der' })
  return { privateKey, publicKey: b64u(der.subarray(der.length - 32)) }
}

export function createInvite(dir, { address, now = Date.now() }) {
  if (typeof address !== 'string' || !/^[A-Za-z0-9.-]+:\d{1,5}$/.test(address)) throw new Error('address must be host:port, e.g. dimokritoss-macbook-air:47390')
  const { publicKey } = hubKey(dir)
  const invites = path.join(dir, 'invites')
  ensureDirectory(invites)
  // Expired invites go whenever a new one is made.
  for (const name of fs.readdirSync(invites)) try { if (readJson(path.join(invites, name), {}).expires < now) fs.rmSync(path.join(invites, name)) } catch {}
  const secret = b64u(crypto.randomBytes(16)), expires = now + INVITE_TTL_MS
  atomicJson(path.join(invites, `${b64u(crypto.randomBytes(9))}.json`), { hash: sha256(secret), expires })
  return encodeInvite({ address, hubKey: publicKey, secret, expires })
}

const name64 = value => String(value ?? '').replace(/[^A-Za-z0-9._-]+/g, '-').slice(0, 64) || 'device'
const lower = text => String(text).toLowerCase()

function validEnvelope(e) {
  if (!e || typeof e !== 'object') return false
  try { identifier(e.room, 'room'); identifier(e.from, 'from'); identifier(e.channel ?? 'main', 'channel'); if (!isBroadcast(e.to)) identifier(e.to, 'to') } catch { return false }
  if (typeof e.id !== 'string' || !/^[A-Za-z0-9-]{8,128}$/.test(e.id) || !validProject(e.project)) return false
  if (typeof e.ts !== 'string' || e.ts.length > 40 || (e.reply_to != null && (typeof e.reply_to !== 'string' || e.reply_to.length > 128))) return false
  const body = e.body
  if (!body || (typeof body.plain !== 'string' && typeof body.enc !== 'string')) return false
  if (typeof body.plain === 'string' && (!body.plain.trim() || body.plain.length > 200_000)) return false
  if (typeof body.enc === 'string' && body.enc.length > 400_000) return false
  for (const flag of ['fyi', 'urgent']) if (e[flag] !== undefined && typeof e[flag] !== 'boolean') return false
  if (e.participant !== undefined && (typeof e.participant !== 'string' || e.participant.length > 200)) return false
  return true
}

export function createHub({ dir = defaultHubDir(), now = Date.now, log = () => {} } = {}) {
  ensureDirectory(dir)
  const keys = hubKey(dir)
  const files = { devices: path.join(dir, 'devices.json'), events: path.join(dir, 'events.jsonl'), cursors: path.join(dir, 'cursors.json'), audit: path.join(dir, 'audit.log') }
  let devices = {}, devicesMtime = -1
  const loadDevices = () => {
    let mtime = 0
    try { mtime = fs.statSync(files.devices).mtimeMs } catch {}
    if (mtime === devicesMtime) return
    devices = readJson(files.devices, {}); devicesMtime = mtime
  }
  const saveDevices = () => { atomicJson(files.devices, devices); try { devicesMtime = fs.statSync(files.devices).mtimeMs } catch {} }
  loadDevices()
  const events = [], messageIds = new Map(), rooms = new Map()
  const roomKey = (project, room) => `${project}\0${lower(room)}`
  const index = event => {
    events.push(event)
    if (event.type === 'room') rooms.set(roomKey(event.project, event.room), { project: event.project, room: event.room, title: event.title, members: new Map() })
    else if (event.type === 'member') {
      const entry = rooms.get(roomKey(event.project, event.room))
      if (entry) event.released ? entry.members.delete(lower(event.alias)) : entry.members.set(lower(event.alias), event)
    } else if (event.type === 'message') messageIds.set(event.envelope.id, event)
  }
  try {
    for (const line of fs.readFileSync(files.events, 'utf8').split('\n')) if (line.trim()) index(JSON.parse(line))
  } catch (error) { if (error.code !== 'ENOENT') throw error }
  const head = () => events.at(-1)?.seq ?? 0
  const cursors = readJson(files.cursors, {})
  let cursorTimer = null
  const saveCursorsSoon = () => { cursorTimer ??= setTimeout(() => { cursorTimer = null; try { atomicJson(files.cursors, cursors) } catch {} }, 1000) }
  const lastSeen = new Map(), nonces = new Map(), buckets = new Map(), waiters = new Set()
  const audit = line => rotateAppend(files.audit, `${new Date(now()).toISOString()} ${line}`)

  const record = event => {
    const full = { seq: head() + 1, at: new Date(now()).toISOString(), ...event }
    append(files.events, JSON.stringify(full) + '\n')
    index(full)
    for (const waiter of [...waiters]) waiter.check()
    return full
  }
  const follows = (device, project) => devices[device]?.projects?.includes(project)
  const devicesView = () => Object.fromEntries(Object.entries(devices).filter(([, d]) => !d.revoked).map(([id, d]) => [id, { name: d.name, last_seen: lastSeen.get(id) ?? null, seen_ms_ago: lastSeen.has(id) ? now() - lastSeen.get(id) : null }]))
  const pending = (device, cursor) => events.filter(event => event.seq > cursor && follows(device, event.project)).slice(0, DRAIN_BATCH)
  const takeToken = device => {
    const t = now(), bucket = buckets.get(device) ?? { tokens: 120, at: t }
    bucket.tokens = Math.min(120, bucket.tokens + (t - bucket.at) / 50); bucket.at = t
    buckets.set(device, bucket)
    if (bucket.tokens < 1) return false
    bucket.tokens -= 1; return true
  }

  // Each handler returns [status, body]; body is JSON.
  const routes = {
    'POST /v1/pair': (_device, body) => {
      if (!body || typeof body.secret !== 'string' || typeof body.key !== 'string') return [400, { error: 'invalid pairing request' }]
      try { publicKeyFrom(body.key) } catch { return [400, { error: 'invalid device key' }] }
      const folder = path.join(dir, 'invites')
      let names = []
      try { names = fs.readdirSync(folder) } catch {}
      for (const name of names) {
        let invite
        try { invite = readJson(path.join(folder, name), null) } catch { continue }
        if (!invite || invite.expires < now()) { try { fs.rmSync(path.join(folder, name)) } catch {} ; continue }
        if (!secretsMatch(body.secret, invite.hash)) continue
        fs.rmSync(path.join(folder, name))
        loadDevices()
        const id = `d-${crypto.randomBytes(6).toString('hex')}`
        devices[id] = { name: name64(body.name), key: body.key, paired_at: new Date(now()).toISOString(), projects: [] }
        saveDevices()
        audit(`pair ${id} ${devices[id].name}`)
        return [200, { device: id, protocol: PROTOCOL }]
      }
      audit('pair refused: no matching invite')
      return [403, { error: 'invite code unknown, used or expired; make a new one on the hub' }]
    },
    'POST /v1/projects': (device, body) => {
      if (!validProject(body?.project)) return [400, { error: 'invalid project' }]
      const d = devices[device]
      if (!d.projects.includes(body.project)) { d.projects.push(body.project); saveDevices() }
      return [200, { head: head(), events: events.filter(event => event.project === body.project), devices: devicesView() }]
    },
    'POST /v1/rooms': (device, body) => {
      if (!validProject(body?.project) || typeof body.title !== 'string' || !body.title.trim() || body.title.length > 200) return [400, { error: 'invalid room' }]
      try { identifier(body.room, 'room') } catch { return [400, { error: 'invalid room' }] }
      if (rooms.has(roomKey(body.project, body.room))) return [409, { error: 'shared room already exists' }]
      const d = devices[device]
      if (!d.projects.includes(body.project)) { d.projects.push(body.project); saveDevices() }
      return [200, { event: record({ type: 'room', project: body.project, room: body.room, title: body.title.trim(), device }) }]
    },
    'POST /v1/members': (device, body) => {
      const entry = body && rooms.get(roomKey(body.project, body.room))
      if (!entry) return [404, { error: 'no such shared room' }]
      try { identifier(body.alias, 'agent') } catch { return [400, { error: 'invalid alias' }] }
      const held = entry.members.get(lower(body.alias))
      if (held && held.device !== device) return [409, { error: 'alias held by another device', holder: devices[held.device]?.name ?? held.device }]
      if (body.release) return held ? [200, { event: record({ type: 'member', project: entry.project, room: entry.room, alias: held.alias, device, released: true, joined: false }) }] : [200, { event: null }]
      const member = { alias: body.alias, participant: String(body.participant ?? '').slice(0, 200), joined: body.joined === true, runtime: String(body.runtime ?? '').slice(0, 20) }
      if (held && held.alias === member.alias && held.participant === member.participant && held.joined === member.joined && held.runtime === member.runtime) return [200, { event: held }]
      return [200, { event: record({ type: 'member', project: entry.project, room: entry.room, device, ...member }) }]
    },
    'POST /v1/messages': (device, body) => {
      if (!Array.isArray(body?.messages) || body.messages.length > 100) return [400, { error: 'invalid messages' }]
      const results = {}
      for (const envelope of body.messages) {
        if (!validEnvelope(envelope)) { results[envelope?.id ?? '?'] = { error: 'invalid envelope' }; continue }
        const earlier = messageIds.get(envelope.id)
        if (earlier) { results[envelope.id] = earlier.device === device ? { stored: earlier.seq } : { error: 'message id taken' }; continue }
        const entry = rooms.get(roomKey(envelope.project, envelope.room))
        if (!entry) { results[envelope.id] = { error: 'no such shared room' }; continue }
        // A device posts only under aliases it holds in that room.
        const sender = entry.members.get(lower(envelope.from))
        if (!sender || sender.device !== device) { results[envelope.id] = { error: 'sender alias not held by this device' }; continue }
        const target = isBroadcast(envelope.to) ? null : entry.members.get(lower(envelope.to))
        const event = record({ type: 'message', project: entry.project, room: entry.room, device, to_device: target?.device ?? null, to_participant: target?.participant ?? null, envelope })
        results[envelope.id] = { stored: event.seq }
      }
      return [200, { results, devices: devicesView() }]
    },
  }

  const drain = (device, url, response, send) => {
    const cursor = Number(url.searchParams.get('cursor') ?? 0)
    const wait = Math.min(MAX_WAIT_S, Math.max(0, Number(url.searchParams.get('wait') ?? 0)))
    if (!Number.isSafeInteger(cursor) || cursor < 0 || !Number.isFinite(wait)) return send(400, { error: 'invalid cursor' })
    // The cursor a device asks from is what it has stored: the hub keeps it as that device's place.
    if ((cursors[device] ?? -1) !== cursor) { cursors[device] = cursor; saveCursorsSoon() }
    const answer = () => {
      const batch = pending(device, cursor)
      send(200, { events: batch, cursor: batch.length ? batch.at(-1).seq : Math.max(cursor, head()), head: head(), devices: devicesView() })
    }
    if (pending(device, cursor).length || !wait) return answer()
    const waiter = { check: () => { if (pending(device, cursor).length) done() } }
    const timer = setTimeout(() => done(), wait * 1000)
    const done = () => { if (!waiters.delete(waiter)) return; clearTimeout(timer); lastSeen.set(device, now()); answer() }
    waiters.add(waiter)
    response.on('close', () => { if (waiters.delete(waiter)) clearTimeout(timer) })
  }

  const handler = (request, response) => {
    const chunks = []
    let size = 0, tooBig = false
    // Past the cap the body is dropped, not kept, and the answer is a 413 the device can act on.
    request.on('data', chunk => { size += chunk.length; if (size > MAX_BODY) { tooBig = true; chunks.length = 0 } else if (!tooBig) chunks.push(chunk) })
    request.on('error', () => {})
    request.on('end', () => {
      const raw = tooBig ? '' : Buffer.concat(chunks).toString('utf8')
      const requestNonce = String(request.headers['x-ac-nonce'] ?? '')
      let url, route = '?', who = '-'
      const send = (status, body) => {
        if (response.writableEnded || response.destroyed) return
        const text = JSON.stringify(body)
        const headers = signHeaders(keys.privateKey, 'hub', ({ time, nonce }) => responseBytes({ status, requestNonce, time, nonce, body: text }))
        response.writeHead(status, { 'content-type': 'application/json', [PROTOCOL_HEADER]: PROTOCOL, ...headers })
        response.end(text)
        if (status >= 400 || route !== 'GET /v1/drain') audit(`${who} ${route.slice(0, 80)} ${status}`)
      }
      // Anything a stranger sends (a request target URL can't parse, say) gets a 400, never a crash.
      try {
      try { url = new URL(request.url, 'http://hub'); route = `${request.method} ${url.pathname}` } catch { return send(400, { error: 'bad request target' }) }
      if (tooBig) return send(413, { error: 'request too large' })
      if (request.headers[PROTOCOL_HEADER] !== PROTOCOL) return send(426, { error: `protocol mismatch: the hub speaks ${PROTOCOL}, this device ${request.headers[PROTOCOL_HEADER] ?? 'none'}; update this device's agent-chat` })
      let body = null
      if (raw) try { body = JSON.parse(raw) } catch { return send(400, { error: 'invalid JSON' }) }
      if (route === 'POST /v1/pair') return send(...routes[route](null, body))
      loadDevices()
      const device = String(request.headers['x-ac-device'] ?? ''), time = request.headers['x-ac-time'], nonce = request.headers['x-ac-nonce']
      const known = Object.hasOwn(devices, device) && !devices[device].revoked ? devices[device] : null
      who = known ? device : `unknown(${device.slice(0, 20)})`
      if (!known) return send(401, { error: 'unknown device; pair it again with a new invite code' })
      if (!timeOk(time, now()) || !nonceOk(nonce)) return send(401, { error: 'request time off by more than 5 minutes, or bad nonce' })
      if (!verifySignature(publicKeyFrom(known.key), requestBytes({ method: request.method, path: request.url, time, nonce, body: raw }), request.headers['x-ac-sig'])) return send(401, { error: 'bad signature' })
      const t = now()
      for (const [n, expires] of nonces) if (expires < t) nonces.delete(n)
      if (nonces.has(`${device}:${nonce}`)) return send(401, { error: 'replayed request' })
      nonces.set(`${device}:${nonce}`, t + NONCE_TTL_MS)
      if (!takeToken(device)) return send(429, { error: 'rate limited' })
      lastSeen.set(device, t)
      if (route === 'GET /v1/drain') return drain(device, url, response, send)
      const route_ = routes[route]
      if (!route_) return send(404, { error: 'not found' })
      try { send(...route_(device, body)) } catch (error) { log(`error ${route}: ${error.message}`); send(500, { error: 'hub error' }) }
      } catch (error) { log(`request failed: ${String(error?.message).slice(0, 200)}`); try { send(400, { error: 'bad request' }) } catch {} }
    })
  }

  return {
    handler, dir, publicKey: keys.publicKey, head, events, devices: () => (loadDevices(), devices), lastSeen,
    close() { clearTimeout(cursorTimer); try { atomicJson(files.cursors, cursors) } catch {} ; for (const w of [...waiters]) { waiters.delete(w) } },
  }
}

// Listens on each address it's given, never on all interfaces. An address that isn't up yet (the
// Tailscale IP before tailscaled starts) is retried every 30 seconds.
export function serveHub({ dir = defaultHubDir(), listen = [{ host: '127.0.0.1', port: DEFAULT_PORT }], log = () => {}, retryMs = 30_000 } = {}) {
  const hub = createHub({ dir, log })
  const servers = []
  let closed = false
  const ready = listen.map(({ host, port }) => new Promise(resolve => {
    const server = http.createServer(hub.handler)
    server.requestTimeout = 30_000; server.headersTimeout = 20_000; server.keepAliveTimeout = 65_000
    servers.push(server)
    const attempt = () => {
      if (closed) return resolve(null)
      server.once('error', error => { log(`listen ${host}:${port} failed (${error.code}), retrying`); setTimeout(attempt, retryMs).unref() })
      server.listen(port, host, () => { log(`listening on ${host}:${server.address().port}`); resolve(server.address()) })
    }
    attempt()
  }))
  return { hub, servers, ready: Promise.all(ready), close: () => new Promise(resolve => { closed = true; hub.close(); let left = servers.length; if (!left) resolve(); for (const s of servers) { s.closeAllConnections?.(); s.close(() => { if (!--left) resolve() }) } }) }
}

function parseArgs(argv) {
  const options = { listen: [], rest: [] }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--dir') options.dir = argv[++i]
    else if (arg === '--listen') options.listen.push(argv[++i])
    else if (arg === '--address') options.address = argv[++i]
    else options.rest.push(arg)
  }
  return options
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [command, ...argv] = process.argv.slice(2)
  const options = parseArgs(argv)
  const dir = options.dir ? path.resolve(options.dir) : defaultHubDir()
  try {
    if (command === 'serve') {
      const listen = (options.listen.length ? options.listen : [`127.0.0.1:${DEFAULT_PORT}`]).map(text => {
        const match = /^(.+):(\d{1,5})$/.exec(text)
        if (!match || match[1] === '0.0.0.0' || match[1] === '::') throw new Error(`--listen takes one address and port, never all interfaces: ${text}`)
        return { host: match[1], port: Number(match[2]) }
      })
      const log = line => rotateAppend(path.join(dir, 'hub.log'), `${new Date().toISOString()} ${line}`)
      // A crash is logged and the process exits; launchd starts a fresh hub.
      process.on('uncaughtException', error => { log(`crash: ${String(error?.stack ?? error).slice(0, 300)}`); process.exit(1) })
      const running = serveHub({ dir, listen, log })
      process.on('SIGTERM', () => running.close().then(() => process.exit(0)))
      process.on('SIGINT', () => running.close().then(() => process.exit(0)))
    } else if (command === 'invite') {
      if (!options.address) throw new Error('invite needs --address host:port, the name the other device reaches this hub by')
      process.stdout.write(createInvite(dir, { address: options.address }) + '\n')
      process.stderr.write('Single use, valid 10 minutes. Pass it by hand, never through git.\n')
    } else if (command === 'devices') {
      const devices = readJson(path.join(dir, 'devices.json'), {})
      for (const [id, d] of Object.entries(devices)) process.stdout.write(`${id}  ${d.name}  paired ${d.paired_at}${d.revoked ? '  REVOKED' : ''}  projects: ${d.projects.join(', ') || '-'}\n`)
    } else if (command === 'revoke') {
      const file = path.join(dir, 'devices.json'), devices = readJson(file, {}), id = options.rest[0]
      if (!devices[id]) throw new Error(`no device ${id}`)
      devices[id].revoked = new Date().toISOString(); atomicJson(file, devices)
      process.stdout.write(`revoked ${id}\n`)
    } else throw new Error('usage: hub.mjs serve|invite|devices|revoke [--dir <folder>]')
  } catch (error) { process.stderr.write(`${error.message}\n`); process.exit(1) }
}
