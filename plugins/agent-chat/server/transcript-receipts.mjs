import fs from 'node:fs'
import path from 'node:path'

// Whether an inbox result that held a message reached the model before its connection ended.
// The conversation's own transcript is the only record of that: Claude writes
// <profile>/projects/<launch folder>/<conversation>.jsonl, Codex
// <CODEX_HOME>/sessions/YYYY/MM/DD/rollout-<time>-<thread>.jsonl. Both are private formats, so
// any doubt (no file, unreadable, unknown shape) answers "not found", and the caller marks the
// mail instead of dropping it.

// Only the tail is read: unconfirmed mail was returned by the last call of a connection.
export const TAIL_BYTES = 16 * 1024 * 1024
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const INBOX_TOOL = /agent[-_]chat.*__inbox$/

// Claude names a project folder after the launch folder with every other character a dash. Long
// paths get a shortened name, so a miss falls back to looking in every project folder.
export function claudeTranscript(profileHome, conversationId, folders = []) {
  if (!UUID.test(conversationId ?? '') || typeof profileHome !== 'string') return null
  const projects = path.join(profileHome, 'projects'), file = `${conversationId}.jsonl`
  for (const folder of folders) if (typeof folder === 'string') {
    const candidate = path.join(projects, folder.replace(/[^A-Za-z0-9]/g, '-'), file)
    if (fs.existsSync(candidate)) return candidate
  }
  try {
    for (const entry of fs.readdirSync(projects, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const candidate = path.join(projects, entry.name, file)
      if (fs.existsSync(candidate)) return candidate
    }
  } catch {}
  return null
}

// Newest days first; the thread's rollout is usually in the latest few folders.
export function codexRollout(codexHome, threadId) {
  if (!UUID.test(threadId ?? '') || typeof codexHome !== 'string') return null
  const suffix = `-${threadId}.jsonl`, sessions = path.join(codexHome, 'sessions')
  const sorted = dir => { try { return fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => b.name.localeCompare(a.name)) } catch { return [] } }
  for (const year of sorted(sessions)) if (year.isDirectory())
    for (const month of sorted(path.join(sessions, year.name))) if (month.isDirectory())
      for (const day of sorted(path.join(sessions, year.name, month.name))) if (day.isDirectory()) {
        const hit = sorted(path.join(sessions, year.name, month.name, day.name)).find(entry => entry.isFile() && entry.name.startsWith('rollout-') && entry.name.endsWith(suffix))
        if (hit) return path.join(sessions, year.name, month.name, day.name, hit.name)
      }
  return null
}

function tail(file, maxBytes) {
  const fd = fs.openSync(file, 'r')
  try {
    const size = fs.fstatSync(fd).size, length = Math.min(size, maxBytes)
    const buffer = Buffer.alloc(length)
    fs.readSync(fd, buffer, 0, length, size - length)
    const lines = buffer.toString('utf8').split('\n')
    if (length < size) lines.shift() // a cut first line
    return lines
  } finally { fs.closeSync(fd) }
}

// The ids among `ids` that appear in the result of an agent-chat inbox call. Claude records a
// tool_use (name mcp__<server>__inbox) and later a tool_result with its tool_use_id; Codex an
// McpToolCall item (server agent_chat, tool inbox) with its result, or a function_call and its
// function_call_output. A doorbell or a history result naming the id proves nothing.
export function shownInInbox(file, ids, { maxBytes = TAIL_BYTES } = {}) {
  const found = new Set()
  if (!file || !ids.length) return found
  let lines
  try { lines = tail(file, maxBytes) } catch { return found }
  const calls = new Set()
  const scan = value => {
    if (!value || typeof value !== 'object') return
    if (Array.isArray(value)) { for (const item of value) scan(item); return }
    const name = typeof value.name === 'string' ? value.name : null
    if (name && INBOX_TOOL.test(name)) for (const id of [value.id, value.call_id]) if (typeof id === 'string') calls.add(id)
    const resultOf = value.tool_use_id ?? (value.type === 'function_call_output' ? value.call_id : undefined)
    const codexCall = value.tool === 'inbox' && /agent[-_]chat/.test(String(value.server ?? '')) && value.result !== undefined
    if ((typeof resultOf === 'string' && calls.has(resultOf)) || codexCall) {
      const text = JSON.stringify(codexCall ? value.result : value.content ?? value.output ?? '')
      for (const id of ids) if (text.includes(id)) found.add(id)
      return
    }
    for (const child of Object.values(value)) if (child && typeof child === 'object') scan(child)
  }
  for (const line of lines) {
    // Most lines name neither an inbox call nor a wanted id; they are never parsed.
    // Claude's request-shape records repeat every tool definition and are skipped whole.
    if (line.startsWith('{"type":"api-request') || (!line.includes('inbox') && !ids.some(id => line.includes(id)))) continue
    let value
    try { value = JSON.parse(line) } catch { continue }
    scan(value)
    if (found.size === ids.length) break
  }
  return found
}

// The transcript of the conversation this native session is in now, or null when unknown.
export function transcriptOf(session, { folders = [] } = {}) {
  try {
    if (session?.runtime === 'claude') return claudeTranscript(session.profileHome, session.conversationId ?? session.id, folders)
    if (session?.runtime === 'codex') return codexRollout(session.profileHome, session.id)
  } catch {}
  return null
}
