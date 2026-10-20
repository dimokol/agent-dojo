// Private flag files kept current on store writes, read by the Claude hook
// without the store lock. Content is counts, room names and timestamps only.
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { sessionUnread, unreadReport, formatAge } from './chat-queries.mjs'
import { distribution } from './distribution.mjs'
import { UUID, NAME, claudeParticipantId, nameFiles, privateDirectory, readPrivate, writeIfChanged, removeIfPresent, readNativeRecord, readShown, recordShown } from './notice-files.mjs'

export const noticeDirectory = stateRoot => path.join(stateRoot, 'notices')
// The store's private project directory key; the hook can compute it without the lock.
export const projectNoticeId = (root, projectRoot) =>
  createHash('sha256').update(path.resolve(root) + '\n' + fs.realpathSync(projectRoot)).digest('hex').slice(0, 24)
export const sessionGateFile = (stateRoot, sessionId) => path.join(noticeDirectory(stateRoot), `session-${sessionId}.gate`)
const unreadFile = (stateRoot, participantId) => path.join(noticeDirectory(stateRoot), `${participantId}.unread`)
const orphanFile = (stateRoot, projectId) => {
  if (!NAME.test(projectId)) throw Error('invalid project notice id')
  return path.join(noticeDirectory(stateRoot), `project-${projectId}.orphans`)
}

// The prompt guard is a static shell stat and cannot hash a participant, so
// each session also gets an empty gate named by its launch and conversation
// UUIDs; Node then picks the exact participant from the hook input.
export function computeNotices(state, now, records) {
  const participants = new Map(), knownParticipants = new Set(), gates = new Set(), knownGates = new Set()
  for (const entry of sessionUnread(state)) {
    if (entry.runtime !== 'claude') continue
    knownParticipants.add(entry.participant_id)
    for (const id of entry.sessionIds) if (UUID.test(id)) knownGates.add(id)
    if (!entry.rooms.length) continue
    const rooms = entry.rooms.map(({ room, count }) => ({ room, count })).sort((a, b) => a.room.localeCompare(b.room))
    participants.set(entry.participant_id, JSON.stringify({ schema: 1, rooms }) + '\n')
    for (const { sessionIds } of entry.rooms) for (const id of sessionIds) if (UUID.test(id)) gates.add(id)
  }
  const { orphans } = unreadReport(state, now, records)
  return { participants, knownParticipants, gates, knownGates,
    orphans: orphans.count ? JSON.stringify({ schema: 1, count: orphans.count, oldest_at: orphans.oldest_at }) + '\n' : null }
}

// Call after the state write, under the store lock. Notices are derived, so a
// failure is returned for reporting instead of failing the mail operation.
export function syncNotices({ stateRoot, projectId, state, now, records }) {
  let written = 0, removed = 0
  try {
    const notices = computeNotices(state, now, records), directory = noticeDirectory(stateRoot)
    privateDirectory(stateRoot); privateDirectory(directory, true)
    const existing = new Set(fs.readdirSync(directory))
    const put = (file, text) => { if (writeIfChanged(file, text)) written++ }
    const drop = file => { if (existing.has(path.basename(file)) && removeIfPresent(file)) removed++ }
    for (const id of notices.knownParticipants) notices.participants.has(id) ? put(unreadFile(stateRoot, id), notices.participants.get(id)) : drop(unreadFile(stateRoot, id))
    for (const id of notices.knownGates) notices.gates.has(id) ? put(sessionGateFile(stateRoot, id), '') : drop(sessionGateFile(stateRoot, id))
    notices.orphans ? put(orphanFile(stateRoot, projectId), notices.orphans) : drop(orphanFile(stateRoot, projectId))
    return { written, removed }
  } catch (error) { return { written, removed, error: error.message === 'unsafe notice directory' ? error.message : 'notice update failed' } }
}

// Store side of the statusline cache: canonical names for Claude participants.
// The widget owns the separate .native file, so the two writers never race.
export function syncNameCache({ stateRoot, state }) {
  let written = 0, removed = 0
  try {
    const directory = path.join(stateRoot, 'names')
    privateDirectory(stateRoot); privateDirectory(directory, true)
    const existing = new Set(fs.readdirSync(directory))
    const claude = new Set(Object.values(state.rooms).flatMap(rs => [...Object.values(rs.members), ...Object.values(rs.retired_members ?? {})])
      .filter(member => member.session?.runtime === 'claude' && member.participant_id).map(member => member.participant_id))
    for (const id of claude) {
      const row = state.participants?.[id], file = nameFiles(stateRoot, id).name
      if (row?.name) { if (writeIfChanged(file, JSON.stringify({ schema: 1, name: row.name, source: row.source }) + '\n')) written++ }
      else if (existing.has(path.basename(file)) && removeIfPresent(file)) removed++
    }
    return { written, removed }
  } catch (error) { return { written, removed, error: error.message === 'unsafe notice directory' ? error.message : 'name cache update failed' } }
}
// For the server's default naming: the widget's normalized native session name.
export const readNativeLabel = (stateRoot, participantId) => readNativeRecord(stateRoot, participantId)?.label ?? null

// Readers never throw and never echo unvalidated content.
function parse(file) {
  try { return JSON.parse(readPrivate(file) ?? 'null') } catch { return null }
}
export function sessionUnreadLine({ stateRoot, profileHome, conversationId }) {
  if (!UUID.test(conversationId ?? '') || typeof profileHome !== 'string') return null
  const value = parse(unreadFile(stateRoot, claudeParticipantId(profileHome, conversationId)))
  const rooms = value?.schema === 1 && Array.isArray(value.rooms) ? value.rooms : []
  if (!rooms.length || rooms.length > 64 || !rooms.every(row => NAME.test(row?.room) && Number.isSafeInteger(row.count) && row.count > 0)) return null
  const total = rooms.reduce((sum, row) => sum + row.count, 0)
  return `agent-chat: ${total} unread in ${rooms.length === 1 ? rooms[0].room : rooms.map(row => `${row.room} (${row.count})`).join(', ')}`
}
export function projectOrphanLine({ stateRoot, projectId, now = Date.now() }) {
  let value
  try { value = parse(orphanFile(stateRoot, projectId)) } catch { return null }
  const at = Date.parse(value?.oldest_at)
  if (value?.schema !== 1 || !Number.isSafeInteger(value.count) || value.count < 1 || !Number.isFinite(at)) return null
  return `agent-chat: ${value.count} unread message${value.count === 1 ? '' : 's'} to closed sessions, oldest ${formatAge(now - at)}; run ${distribution.unreadCommand} to review`
}
// Orphan mail can sit for weeks, so startup names it at most once a day per
// project; /unread still lists everything. A marker in the future is ignored.
const DAY = 24 * 3600000
export function dailyOrphanLine({ stateRoot, projectId, now = Date.now() }) {
  const line = projectOrphanLine({ stateRoot, projectId, now }), name = `orphans-${projectId}`
  if (!line) return null
  const last = Date.parse(readShown(stateRoot, name)?.trim())
  if (last <= now && now - last < DAY) return null
  recordShown(stateRoot, name, new Date(now).toISOString() + '\n')
  return line
}
