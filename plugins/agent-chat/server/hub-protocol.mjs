// What the hub and every device agree on: protocol version, request signing, invite codes and the
// cleanup of text that came from another device.
//
// A signed request carries four headers: x-ac-device (the device id, or "hub" on a response),
// x-ac-time (ms since epoch), x-ac-nonce (random) and x-ac-sig, an Ed25519 signature over
//   METHOD \n PATH \n TIME \n NONCE \n sha256(body) hex
// A response is signed over STATUS \n <request nonce> \n TIME \n NONCE \n sha256(body), so a
// recorded answer can't be replayed to another request.
import crypto from 'node:crypto'

export const PROTOCOL = '1'
export const PROTOCOL_HEADER = 'agent-chat-protocol'
export const DEFAULT_PORT = 47390
export const MAX_SKEW_MS = 5 * 60_000
export const INVITE_TTL_MS = 10 * 60_000
export const MAX_BODY = 1024 * 1024
const INVITE_PREFIX = 'acinv1.'

export const sha256 = data => crypto.createHash('sha256').update(data).digest('hex')
export const b64u = buf => Buffer.from(buf).toString('base64url')

export function newKeyPair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519')
  return { publicKey: publicKeyText(publicKey), privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }) }
}
// A public key travels as the base64url of its raw 32 bytes.
export function publicKeyText(key) {
  const der = key.export({ type: 'spki', format: 'der' })
  return b64u(der.subarray(der.length - 32))
}
export function publicKeyFrom(text) {
  const raw = Buffer.from(String(text), 'base64url')
  if (raw.length !== 32) throw new Error('invalid public key')
  return crypto.createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), raw]), format: 'der', type: 'spki' })
}
export const privateKeyFrom = pem => crypto.createPrivateKey(pem)

export const requestBytes = ({ method, path, time, nonce, body }) => `${method}\n${path}\n${time}\n${nonce}\n${sha256(body ?? '')}`
export const responseBytes = ({ status, requestNonce, time, nonce, body }) => `${status}\n${requestNonce}\n${time}\n${nonce}\n${sha256(body ?? '')}`

export function signHeaders(privateKey, id, bytesOf) {
  const time = String(Date.now()), nonce = b64u(crypto.randomBytes(16))
  const sig = b64u(crypto.sign(null, Buffer.from(bytesOf({ time, nonce })), privateKey))
  return { 'x-ac-device': id, 'x-ac-time': time, 'x-ac-nonce': nonce, 'x-ac-sig': sig }
}
export function verifySignature(publicKey, bytes, sig) {
  try { return crypto.verify(null, Buffer.from(bytes), publicKey, Buffer.from(String(sig), 'base64url')) } catch { return false }
}
export const timeOk = (time, now = Date.now()) => /^\d{1,16}$/.test(String(time)) && Math.abs(now - Number(time)) <= MAX_SKEW_MS
export const nonceOk = nonce => typeof nonce === 'string' && /^[A-Za-z0-9_-]{16,64}$/.test(nonce)

// Invite: the hub's address and public key plus a 128-bit secret. Single use, 10 minutes.
export function encodeInvite({ address, hubKey, secret, expires }) {
  return INVITE_PREFIX + b64u(JSON.stringify({ a: address, k: hubKey, s: secret, e: expires }))
}
export function decodeInvite(code, now = Date.now()) {
  const text = String(code ?? '').trim()
  if (!text.startsWith(INVITE_PREFIX)) throw new Error('not an agent-chat invite code')
  let invite
  try { invite = JSON.parse(Buffer.from(text.slice(INVITE_PREFIX.length), 'base64url').toString('utf8')) } catch { throw new Error('damaged invite code') }
  if (!invite || typeof invite.a !== 'string' || typeof invite.k !== 'string' || typeof invite.s !== 'string' || !Number.isSafeInteger(invite.e)) throw new Error('damaged invite code')
  publicKeyFrom(invite.k)
  if (invite.e < now) throw new Error('invite code expired; make a new one on the hub')
  return { address: invite.a, hubKey: invite.k, secret: invite.s, expires: invite.e }
}
export function secretsMatch(given, expectedHash) {
  const a = Buffer.from(sha256(String(given)), 'hex'), b = Buffer.from(String(expectedHash), 'hex')
  return a.length === b.length && crypto.timingSafeEqual(a, b)
}

// A git origin as one key on every OS: host and path, lower case, no scheme, user, port or .git.
// git@github.com:Dimokol/Agent-Dojo.git, https://github.com/dimokol/agent-dojo and
// ssh://git@github.com:22/dimokol/agent-dojo all give github.com/dimokol/agent-dojo.
export function normalizeOrigin(url) {
  let text = String(url ?? '').trim()
  if (!text) return null
  let host, rest
  const scp = /^(?:[^@/]+@)?([^:/]+):(?!\/)(.+)$/.exec(text)
  if (!/^[a-z+]+:\/\//i.test(text) && scp) [host, rest] = [scp[1], scp[2]]
  else {
    try { const parsed = new URL(text); host = parsed.hostname; rest = parsed.pathname } catch { return null }
  }
  rest = rest.replace(/^\/+|\/+$/g, '').replace(/\.git$/i, '')
  if (!host || !rest) return null
  return `${host}/${rest}`.toLowerCase()
}
export const validProject = value => typeof value === 'string' && /^[a-z0-9.-]+(\/[a-z0-9._~-]+)+$/.test(value) && value.length <= 200

// Text from another device. Removes ANSI escapes, control characters (keeping tab and newline),
// bidi overrides, zero-width and tag characters, and defuses tags that mimic the harness's own
// wrappers, so a peer can't hide text from the user or pose as the system.
const ANSI = /\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)|[@-Z\\-_])/g
const CONTROL = /[\x00-\x08\x0b-\x1f\x7f-\x9f]/g
const INVISIBLE = /[؜​-‏‪-‮⁠-⁤⁦-⁯﻿\u{e0000}-\u{e007f}]/gu
const WRAPPERS = /<(\/?)(system-reminder|system|function_results|function_calls|invoke|parameter|antml:[a-z_]+|user|assistant|human)\b/gi
export function cleanRemoteText(text) {
  return String(text).replace(ANSI, '').replace(CONTROL, '').replace(INVISIBLE, '').replace(WRAPPERS, '‹$1$2')
}
