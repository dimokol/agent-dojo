#!/usr/bin/env node
// This machine as a device of an agent-chat hub: its key, its id, and the hub it trusts.
//
//   node device.mjs pair <invite code> [--name <device name>] [--address host:port]
//   node device.mjs status
//   node device.mjs unpair
//
// Everything lives in <state root>/sync/device.json (private, like the rest of the state root), so
// a machine whose state root is on another drive (the PC's D:\AgentChat\state) keeps it there too.
import './runtime.mjs'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { PROTOCOL, PROTOCOL_HEADER, newKeyPair, privateKeyFrom, publicKeyFrom, requestBytes, responseBytes, signHeaders, verifySignature, timeOk, decodeInvite } from './hub-protocol.mjs'
import { ensureDirectory, readJson, atomicJson } from './store-files.mjs'

export const defaultStateRoot = (env = process.env) => env.AGENT_CHAT_STATE_ROOT || path.join(os.homedir(), '.local', 'state', 'agent-chat')
export const syncDir = stateRoot => path.join(stateRoot, 'sync')
const deviceFile = stateRoot => path.join(syncDir(stateRoot), 'device.json')

export function loadDevice(stateRoot) {
  let saved
  try { saved = readJson(deviceFile(stateRoot), null) } catch { return null }
  if (!saved?.id || !saved.private_key || !saved.hub?.address || !saved.hub?.key) return null
  return { ...saved, privateKey: privateKeyFrom(saved.private_key), hubKey: publicKeyFrom(saved.hub.key) }
}

export class HubError extends Error {
  constructor(message, { status = 0, body = null, unreachable = false } = {}) { super(message); this.status = status; this.body = body; this.unreachable = unreachable }
}

// One signed request. The answer must carry the hub's signature over this request's nonce.
export function hubRequest({ address, hubKey, id = null, privateKey = null }, method, pathname, body, { timeoutMs = 10_000, signal } = {}) {
  const match = /^(.+):(\d{1,5})$/.exec(address)
  if (!match) return Promise.reject(new HubError('invalid hub address'))
  const text = body === undefined ? '' : JSON.stringify(body)
  const headers = { [PROTOCOL_HEADER]: PROTOCOL, 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) }
  let nonce
  if (privateKey) {
    const signed = signHeaders(privateKey, id, ({ time, nonce }) => requestBytes({ method, path: pathname, time, nonce, body: text }))
    Object.assign(headers, signed); nonce = signed['x-ac-nonce']
  } else {
    // Pairing has no device key yet; a nonce still binds the hub's signed answer to this request.
    nonce = crypto.randomBytes(16).toString('base64url')
    headers['x-ac-nonce'] = nonce
  }
  return new Promise((resolve, reject) => {
    const request = http.request({ host: match[1], port: Number(match[2]), method, path: pathname, headers, timeout: timeoutMs, signal, agent: false }, response => {
      const chunks = []
      response.on('data', chunk => chunks.push(chunk))
      response.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8')
        const h = response.headers
        if (h['x-ac-device'] !== 'hub' || !timeOk(h['x-ac-time']) || !verifySignature(hubKey, responseBytes({ status: response.statusCode, requestNonce: nonce, time: h['x-ac-time'], nonce: h['x-ac-nonce'], body: raw }), h['x-ac-sig']))
          return reject(new HubError('hub answer has no valid hub signature', { status: response.statusCode }))
        let parsed = null
        try { parsed = raw ? JSON.parse(raw) : null } catch { return reject(new HubError('hub sent invalid JSON')) }
        if (response.statusCode >= 400) return reject(new HubError(parsed?.error ?? `hub refused (${response.statusCode})`, { status: response.statusCode, body: parsed }))
        resolve(parsed)
      })
      response.on('error', error => reject(new HubError(`hub connection failed: ${error.code ?? error.message}`, { unreachable: true })))
    })
    request.on('timeout', () => request.destroy(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' })))
    request.on('error', error => reject(error.name === 'AbortError' ? error : new HubError(`hub unreachable: ${error.code ?? error.message}`, { unreachable: true })))
    request.end(text)
  })
}

export const deviceRequest = (device, method, pathname, body, options) =>
  hubRequest({ address: device.hub.address, hubKey: device.hubKey, id: device.id, privateKey: device.privateKey }, method, pathname, body, options)

export async function pair(stateRoot, code, { name = os.hostname().split('.')[0], address } = {}) {
  const invite = decodeInvite(code)
  if (loadDevice(stateRoot)) throw new Error('this machine is already paired; run unpair first')
  const hub = { address: address ?? invite.address, key: invite.hubKey }
  const keys = newKeyPair()
  const answer = await hubRequest({ address: hub.address, hubKey: publicKeyFrom(hub.key) }, 'POST', '/v1/pair', { secret: invite.secret, key: keys.publicKey, name })
  if (typeof answer?.device !== 'string') throw new Error('hub gave no device id')
  ensureDirectory(syncDir(stateRoot))
  // A new pairing starts reading the hub's log from the start; a cursor from another hub would skip it.
  atomicJson(path.join(syncDir(stateRoot), 'cursor.json'), { cursor: 0 })
  atomicJson(deviceFile(stateRoot), { id: answer.device, name, private_key: keys.privateKey, public_key: keys.publicKey, hub, paired_at: new Date().toISOString() })
  return { id: answer.device, name, hub: hub.address }
}

export function unpair(stateRoot) {
  const file = deviceFile(stateRoot)
  if (!fs.existsSync(file)) return false
  fs.rmSync(file)
  fs.rmSync(path.join(syncDir(stateRoot), 'cursor.json'), { force: true })
  return true
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [command, ...argv] = process.argv.slice(2)
  const option = flag => { const i = argv.indexOf(flag); return i >= 0 ? argv[i + 1] : undefined }
  const stateRoot = defaultStateRoot()
  ;(async () => {
    if (command === 'pair') {
      const result = await pair(stateRoot, argv.find(arg => arg.startsWith('acinv1.')), { name: option('--name'), address: option('--address') })
      process.stdout.write(`paired as ${result.id} (${result.name}) with the hub at ${result.hub}; data in ${syncDir(stateRoot)}\n`)
    } else if (command === 'status') {
      const device = loadDevice(stateRoot)
      if (!device) return process.stdout.write(`not paired (state root ${stateRoot})\n`)
      process.stdout.write(`device ${device.id} (${device.name}), hub ${device.hub.address}\n`)
      try { await deviceRequest(device, 'GET', '/v1/drain?cursor=0&wait=0'); process.stdout.write('hub reachable, signatures check out\n') }
      catch (error) { process.stdout.write(`hub check failed: ${error.message}\n`); process.exitCode = 1 }
    } else if (command === 'unpair') process.stdout.write(unpair(stateRoot) ? 'unpaired; run revoke on the hub too\n' : 'was not paired\n')
    else throw new Error('usage: device.mjs pair <code> [--name n] [--address host:port] | status | unpair')
  })().catch(error => { process.stderr.write(`${error.message}\n`); process.exit(1) })
}
