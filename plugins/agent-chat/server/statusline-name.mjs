#!/usr/bin/env node
// ccstatusline custom-command widget: prints this Claude session's agent-chat
// name. It runs on every status refresh, so it never takes the store lock,
// opens a socket or spawns a process; a deadline and silence cover any error,
// because ccstatusline shows a non-zero exit or a timeout as text.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { UUID, defaultStateRoot, claudeParticipantId, claudeProfileHome, nameFiles, privateDirectory, writeIfChanged, readNameRecord, readNativeRecord } from './notice-files.mjs'

export const deadlineMs = 300
const inputLimit = 65536
// Same normalisation as the store's default names, minus its fallback word:
// an empty label means there is no native name to offer.
export function nativeLabel(value) {
  if (typeof value !== 'string') return null
  const label = value.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/-{2,}/g, '-').replace(/^[-.]+|[-.]+$/g, '').slice(0, 55)
  return label || null
}
// The store writes <participant>.name; this widget alone writes .native, so the
// two never race on one file. An explicit /name freezes the default label.
export function statuslineName(input, { stateRoot, env = process.env }) {
  // A verification probe is a throwaway conversation: no name and no cache file.
  if (env.AGENT_CHAT_VERIFY_CHILD === '1' || !UUID.test(input?.session_id ?? '') || !path.isAbsolute(stateRoot)) return ''
  privateDirectory(stateRoot)
  const participant = claudeParticipantId(claudeProfileHome(env), input.session_id)
  const current = readNameRecord(stateRoot, participant)
  const label = current?.source === 'explicit' ? null : nativeLabel(input.session_name)
  if (label && readNativeRecord(stateRoot, participant)?.label !== label) {
    privateDirectory(path.join(stateRoot, 'names'), true)
    writeIfChanged(nameFiles(stateRoot, participant).native, JSON.stringify({ schema: 1, label }) + '\n')
  }
  return current?.name ?? ''
}
function stateRootArgument(argv, env) {
  const index = argv.indexOf('--state-root')
  return index === -1 ? defaultStateRoot(env) : argv[index + 1] ?? ''
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const quiet = () => process.exit(0)
  process.on('uncaughtException', quiet)
  setTimeout(quiet, deadlineMs)
  let text = '', over = false
  process.stdin.setEncoding('utf8')
  process.stdin.on('error', quiet)
  // Drain past the limit rather than closing early, which would fail the writer.
  process.stdin.on('data', chunk => { if (!over) text += chunk; if (text.length > inputLimit) { over = true; text = '' } })
  process.stdin.on('end', () => {
    let output = ''
    try { if (!over) output = statuslineName(JSON.parse(text), { stateRoot: stateRootArgument(process.argv, process.env) }) } catch { output = '' }
    if (output) fs.writeSync(1, output)
    quiet()
  })
}
