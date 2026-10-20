import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { atomicJson, locked } from './store-files.mjs'
import { trustedClaudeCommand, runningClaudeVersion, processExecutable } from './native-session.mjs'
import { distribution } from './distribution.mjs'

const DEFAULT_VERSION = '2.1.296'
const STATE_ROOT = process.env.AGENT_CHAT_STATE_ROOT || path.join(os.homedir(), '.local/state/agent-chat')
const VERSION = /^\d+\.\d+\.\d+$/
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
function unavailable() {
  return Object.assign(new Error('Agent-chat Claude verification records are unavailable; operator recovery required'), { code: 'CHAT_CLAUDE_VERSIONS_UNAVAILABLE' })
}
function privateRoot(stateRoot, create = false) {
  if (typeof stateRoot !== 'string' || !path.isAbsolute(stateRoot) || path.normalize(stateRoot) !== stateRoot) throw unavailable()
  try {
    if (create && !fs.existsSync(stateRoot)) fs.mkdirSync(stateRoot, { recursive: true, mode: 0o700 })
    const stat = fs.lstatSync(stateRoot)
    if (!stat.isDirectory() || stat.uid !== process.getuid() || (stat.mode & 0o777) !== 0o700) throw unavailable()
    return true
  } catch (error) {
    if (!create && error.code === 'ENOENT') return false
    throw unavailable()
  }
}
function readRecords(stateRoot) {
  if (!privateRoot(stateRoot)) return { schema: 1, versions: {} }
  const file = path.join(stateRoot, 'claude-versions.json')
  try {
    const stat = fs.lstatSync(file)
    if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid() || (stat.mode & 0o777) !== 0o600) throw unavailable()
    const value = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (!object(value) || value.schema !== 1 || !object(value.versions)) throw unavailable()
    for (const [version, record] of Object.entries(value.versions)) {
      if (!VERSION.test(version) || !object(record) || record.verified !== true || record.receipt !== 'received' ||
          record.requestedModelTurns !== 2 || record.probe !== 'agent-chat-inbox-v1' ||
          typeof record.verifiedAt !== 'string' || !Number.isFinite(Date.parse(record.verifiedAt))) throw unavailable()
    }
    return value
  } catch (error) {
    if (error.code === 'ENOENT') return { schema: 1, versions: {} }
    throw unavailable()
  }
}

// The installed CLI that native wake-ups check, read from its version directory
// without starting it.
export function installedClaudeVersion() {
  const binary = fs.realpathSync(path.join(os.homedir(), '.local/bin/claude'))
  if (!trustedClaudeCommand(binary)) throw Error('Unsupported Claude installation')
  const version = path.basename(binary)
  if (!VERSION.test(version)) throw Error('Unknown Claude version')
  return version
}

// The version a registered tab runs: recorded at registration, else read from
// its live process, else the installed CLI (what a tab starting now would run).
export function sessionClaudeVersion(session, { executable = processExecutable, installed = installedClaudeVersion } = {}) {
  if (VERSION.test(session?.claudeVersion ?? '')) return session.claudeVersion
  return (Number.isSafeInteger(session?.clientPid) && session.clientPid > 0 ? runningClaudeVersion(executable(session.clientPid)) : undefined) ?? installed()
}

// Off, wake-ups never pause after a Claude update and no probe runs: the public plugin's
// default. Only the exact value 'off' turns it off.
export const versionCheckOff = (env = process.env) => (env.AGENT_CHAT_VERSION_CHECK ?? distribution.versionCheck) === 'off'
export function isVerifiedVersion(version, { stateRoot = STATE_ROOT, env = process.env } = {}) {
  if (versionCheckOff(env)) return true
  if (typeof version !== 'string' || !VERSION.test(version)) return false
  const records = readRecords(stateRoot)
  return version === DEFAULT_VERSION || records.versions[version]?.verified === true
}

// Operator verifier only. This function is never exposed as an MCP tool or
// environment override; only successful private probe evidence may call it.
export function recordVerifiedVersion(version, proof, { stateRoot = STATE_ROOT } = {}) {
  if (typeof version !== 'string' || !VERSION.test(version) || proof?.passed !== true ||
      proof.ready !== true || proof.pong !== true || proof.receipt !== 'received' ||
      proof.explicitAckCalls !== 0 || proof.requestedModelTurns !== 2 || proof.probe !== 'agent-chat-inbox-v1') throw unavailable()
  privateRoot(stateRoot, true)
  return locked(path.join(stateRoot, 'claude-versions'), () => {
    const records = readRecords(stateRoot)
    records.versions[version] = { verified: true, verifiedAt: new Date().toISOString(),
      receipt: proof.receipt, requestedModelTurns: proof.requestedModelTurns, probe: proof.probe }
    atomicJson(path.join(stateRoot, 'claude-versions.json'), records)
    return { version, verified: true }
  })
}
