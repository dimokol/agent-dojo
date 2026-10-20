// Read-only views over a persisted store state. Nothing here writes, locks or
// adopts; callers pass the state they already read under the store lock.
import { isBroadcast, readState } from './message-policy.mjs'
import { recipientStates } from './read-index.mjs'

const seenStatuses = new Set(['delivered', 'acked', 'received', 'handled'])
const statusRank = ['joined', 'closed', 'left', 'never_joined']
const byName = (a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()) || String(a.participant_id).localeCompare(String(b.participant_id))
const rowsOf = rs => [...Object.values(rs?.members ?? {}), ...Object.values(rs?.retired_members ?? {})]

export function formatAge(ms) {
  if (!Number.isFinite(ms)) return null
  const minutes = Math.floor(Math.max(0, ms) / 60000)
  if (minutes < 1) return '<1m'
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  return hours < 24 ? `${hours}h` : `${Math.floor(hours / 24)}d`
}
const aged = (at, now) => at === null ? { oldest_at: null, oldest_age: null } : { oldest_at: new Date(at).toISOString(), oldest_age: formatAge(now - at) }
const older = (a, b) => a === null ? b : b === null ? a : Math.min(a, b)

// A row without a left_reason that never held the room is a placeholder kept
// for direct mail (join and adoption create them), so it never joined there.
function memberStatus(member) {
  if (!member) return 'never_joined'
  if (member.joined) return 'joined'
  if (member.left_reason === 'explicit') return 'left'
  return member.left_reason ? 'closed' : 'never_joined'
}
function roomStatus(rs, participantId) {
  if (!participantId) return 'never_joined'
  const member = Object.values(rs.members).find(row => row.participant_id === participantId)
  if (member) return memberStatus(member)
  // Retired rows belong to a closed owner whose name was explicitly taken over.
  return Object.values(rs.retired_members ?? {}).some(row => row.participant_id === participantId) ? 'closed' : 'never_joined'
}
const canonicalName = (state, member) => state.participants?.[member.participant_id]?.name ?? member.agent
const senderId = (state, message) => message.from_id ?? state.nameOwners?.[String(message.from).toLowerCase()]?.participant_id ?? null

// Last seen is evidence the agent itself acted: its inbox returned content
// (delivered or later receipts) or, when records are given, it posted.
function lastSeen(state, participantId, records) {
  let latest = null
  for (const rs of Object.values(state.rooms)) for (const row of rowsOf(rs)) {
    if (row.participant_id !== participantId) continue
    for (const receipt of Object.values(row.deliveries)) if (seenStatuses.has(receipt.status) && !receipt.dismissed) latest = Math.max(latest ?? 0, Date.parse(receipt.updated) || 0)
  }
  if (records) for (const room of Object.keys(state.rooms)) {
    let messages
    try { messages = records(room) } catch { continue }
    for (const message of messages) if (message.from_id === participantId) latest = Math.max(latest ?? 0, Date.parse(message.ts) || 0)
  }
  return latest || null
}

// isLive(member) and isClosed(member) are synchronous: precompute async adapter
// presence and Claude version verification. Unknown presence (a throw) reads
// as not wakeable now. A joined member whose tab is definitely gone reads as
// closed before the next delivery attempt records it.
export function members(state, room, now, isLive, records, isClosed = () => false) {
  const rs = state.rooms?.[room]
  if (!rs) return []
  return Object.values(rs.members).filter(member => memberStatus(member) !== 'never_joined').map(member => {
    let live = false, closed = false
    if (member.joined && member.session.runtime !== 'manual') {
      try { live = isLive(member) === true } catch { live = false }
      try { closed = !live && isClosed(member) === true } catch { closed = false }
    }
    const seen = lastSeen(state, member.participant_id, records)
    return { name: canonicalName(state, member), participant_id: member.participant_id ?? null, runtime: member.session.runtime,
      joined: member.joined && !closed, status: closed ? 'closed' : memberStatus(member), wakeable: live,
      last_seen: seen === null ? null : new Date(seen).toISOString(), last_seen_age: seen === null ? null : formatAge(now - seen) }
  }).sort(byName)
}

// records(room) returns that room's canonical records with cursors. Messages
// never touch the state file, so unowned addressees and legacy proof need them.
export function unreadReport(state, now, records) {
  const groups = new Map(), unknown = new Map(), damaged_rooms = []
  let orphanCount = 0, orphanOldest = null
  for (const [room, rs] of Object.entries(state.rooms)) {
    let messages
    try { messages = records(room) } catch { damaged_rooms.push(room); continue }
    for (const message of messages) {
      const at = Date.parse(message.ts)
      for (const row of recipientStates(state, rs, message, senderId(state, message))) {
        if (row.read_state === 'unknown_legacy') {
          const key = JSON.stringify([row.participant_id, row.agent.toLowerCase(), room])
          const entry = unknown.get(key) ?? { name: row.agent, participant_id: row.participant_id ?? null, room, count: 0, at: null }
          entry.count++; entry.at = older(entry.at, at); unknown.set(key, entry)
          continue
        }
        if (!['unread', 'delivered'].includes(row.read_state)) continue
        const key = row.participant_id ?? `to:${row.agent.toLowerCase()}`
        const group = groups.get(key) ?? { name: row.agent, participant_id: row.participant_id ?? null, rooms: new Map() }
        const status = roomStatus(rs, row.participant_id)
        const entry = group.rooms.get(room) ?? { room, status, unread: 0, delivered: 0, at: null }
        entry[row.read_state]++; entry.at = older(entry.at, at)
        group.rooms.set(room, entry); groups.set(key, group)
        if (row.read_state === 'unread' && status !== 'joined' && !isBroadcast(message.to)) { orphanCount++; orphanOldest = older(orphanOldest, at) }
      }
    }
  }
  const recipients = [...groups.values()].map(group => {
    const rooms = [...group.rooms.values()].sort((a, b) => a.room.localeCompare(b.room))
    const at = rooms.reduce((value, entry) => older(value, entry.at), null)
    return { name: group.name, participant_id: group.participant_id,
      status: statusRank.find(status => rooms.some(entry => entry.status === status)),
      unread: rooms.reduce((sum, entry) => sum + entry.unread, 0), delivered: rooms.reduce((sum, entry) => sum + entry.delivered, 0), ...aged(at, now),
      rooms: rooms.map(({ at: roomAt, ...entry }) => ({ ...entry, ...aged(roomAt, now) })) }
  }).sort(byName)
  const unknown_legacy = [...unknown.values()].map(({ at, ...entry }) => ({ ...entry, ...aged(at, now) }))
    .sort((a, b) => byName(a, b) || a.room.localeCompare(b.room))
  return { recipients, unknown_legacy, orphans: { count: orphanCount, ...aged(orphanOldest, now) }, damaged_rooms }
}

// Per-session unread for the prompt notice: only rooms the row holds now. The
// receipts are explicit for joined rows, so no canonical log read is needed.
export function sessionUnread(state) {
  const sessions = new Map()
  for (const [room, rs] of Object.entries(state.rooms)) for (const member of Object.values(rs.members)) {
    const entry = sessions.get(member.participant_id) ?? { participant_id: member.participant_id, runtime: member.session.runtime, sessionIds: new Set(), rooms: [] }
    for (const value of [member.session.id, member.session.conversationId]) if (value) entry.sessionIds.add(value)
    const count = member.joined ? Object.values(member.deliveries).filter(receipt => readState(receipt.status) === 'unread').length : 0
    if (count) entry.rooms.push({ room, count, sessionIds: [member.session.id, member.session.conversationId].filter(Boolean) })
    if (member.participant_id) sessions.set(member.participant_id, entry)
  }
  return [...sessions.values()]
}
