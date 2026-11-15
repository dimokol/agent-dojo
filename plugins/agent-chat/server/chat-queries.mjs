// Read-only views over a persisted store state. Nothing here writes, locks or
// adopts; callers pass the state they already read under the store lock.
import { isBroadcast, readState, wakes } from './message-policy.mjs'
import { recipientStates } from './read-index.mjs'

const seenStatuses = new Set(['delivered', 'acked', 'received', 'handled'])
const statusRank = ['joined', 'not_in_room', 'closed', 'left', 'never_joined']
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
function roomStatus(rs, participantId, joinedElsewhere = new Set()) {
  if (!participantId) return 'never_joined'
  const member = Object.values(rs.members).find(row => row.participant_id === participantId)
  // Retired rows belong to a closed owner whose name was explicitly taken over.
  const status = member ? memberStatus(member) : Object.values(rs.retired_members ?? {}).some(row => row.participant_id === participantId) ? 'closed' : 'never_joined'
  // A session joined in another room is live: its mail here waits until it joins this room.
  return status === 'never_joined' && joinedElsewhere.has(participantId) ? 'not_in_room' : status
}
const canonicalName = (state, member) => state.participants?.[member.participant_id]?.name ?? member.agent
// One row per name: a retired owner's mail (a closed name another session took over) counts
// under the name's current owner, never as a second row with the same name.
function groupOf(state, row) {
  const retired = state.participants?.[row.participant_id]
  const name = retired && !retired.name && retired.previous_name
  if (!name) return { key: row.participant_id ?? `to:${row.agent.toLowerCase()}`, name: row.agent, participant_id: row.participant_id ?? null }
  const owner = state.nameOwners && Object.hasOwn(state.nameOwners, name.toLowerCase()) ? state.nameOwners[name.toLowerCase()].participant_id : null
  const current = owner && state.participants[owner]?.name?.toLowerCase() === name.toLowerCase() ? owner : null
  return current ? { key: current, name: state.participants[current].name, participant_id: current } : { key: `to:${name.toLowerCase()}`, name, participant_id: row.participant_id }
}
const senderId = (state, message) => { const key = String(message.from).toLowerCase(); return message.from_id ?? (state.nameOwners && Object.hasOwn(state.nameOwners, key) ? state.nameOwners[key].participant_id : null) ?? null }

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
  const joinedElsewhere = new Set(Object.values(state.rooms).flatMap(rs => Object.values(rs.members).filter(row => row.joined).map(row => row.participant_id)))
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
        const { key, name, participant_id } = groupOf(state, row)
        const group = groups.get(key) ?? { name, participant_id, rooms: new Map() }
        const status = roomStatus(rs, participant_id, joinedElsewhere)
        const entry = group.rooms.get(room) ?? { room, status, unread: 0, delivered: 0, at: null }
        entry[row.read_state]++; entry.at = older(entry.at, at)
        group.rooms.set(room, entry); groups.set(key, group)
        if (row.read_state === 'unread' && !['joined', 'not_in_room'].includes(status) && !isBroadcast(message.to)) { orphanCount++; orphanOldest = older(orphanOldest, at) }
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

const joinedIds = state => new Set(Object.values(state.rooms).flatMap(rs => Object.values(rs.members).filter(row => row.joined).map(row => row.participant_id)))
// Why mail for a name not joined in this room waits: its tab closed, or the name is elsewhere,
// left or never joined. A name joined in another room is a live tab, so not closed.
export function absentReason(state, rs, participantId, joined = joinedIds(state)) {
  return !joined.has(participantId) && roomStatus(rs ?? { members: {} }, participantId) === 'closed' ? 'closed' : 'not_in_room'
}

// 2.0.0 to 2.0.2 stored every transport outcome as status notified plus an error text, success
// included. Only a ring (2.0.2's wording or 2.0.0/2.0.1's "Peer frame written") or a Codex queue
// that went through reads as such; any other text there was an uncertain write. The view maps it
// the 2.0.3 way and drops the error key; disk keeps it.
const legacySuccess = /^(The tab was rung|Peer frame written|Codex queue command accepted)/
export function receiptView(receipt) {
  if (!receipt || receipt.state || typeof receipt.error !== 'string') return receipt
  const { error, ...rest } = receipt
  if (receipt.status !== 'notified') return ['pending', 'failed'].includes(receipt.status) ? receipt : rest
  return legacySuccess.test(error) ? rest : { ...rest, state: 'held', reason: 'write_uncertain' }
}

// The sender's view of mail it sent: per message, per recipient, the delivery state and read state.
// A receipt written by an older release has no state; its status decides.
export function sentReport(state, room, participantId, records, limit = 20) {
  const rs = state.rooms[room]
  if (!rs || !participantId) return []
  const joined = joinedIds(state)
  const sent = records(room).filter(message => (message.from_id ?? senderId(state, message)) === participantId).slice(-limit)
  return sent.map(message => ({ sent: true, message_id: message.id, to: message.to, recipients: recipientStates(state, rs, message, participantId).map(entry => {
    const row = rowsOf(rs).find(member => member.participant_id === entry.participant_id)
    const receipt = receiptView(row?.deliveries[message.id])
    const held = reason => ({ state: 'held', ...(reason ? { reason } : {}) })
    let view
    if (!['unread', 'unknown_legacy'].includes(entry.read_state)) view = receipt?.state ? { state: receipt.state } : {}
    else if (receipt?.status === 'notified' && receipt.state !== 'held') view = { state: receipt.state ?? (row.session.runtime === 'codex' ? 'queued' : 'rung') }
    else if (receipt?.status === 'notified') view = held(receipt.reason)
    else if (receipt?.status === 'dispatching') view = held(receipt.state === 'held' ? receipt.reason : 'ringing')
    else if (!row?.joined) view = held(absentReason(state, rs, entry.participant_id, joined))
    else view = held(receipt?.state === 'held' ? receipt.reason : wakes(message) ? 'waiting' : 'no_wake')
    return { agent: entry.agent, ...view, read_state: entry.read_state }
  }) }))
}
