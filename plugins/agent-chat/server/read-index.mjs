import { isBroadcast, readState } from './message-policy.mjs'
import { isDismissed } from './dismissals.mjs'

// Per-recipient read state lives in each member's deliveries. Received and
// handled entries older than this fold into the member's received_cursor.
// One day: only open mail needs per-message proof, and every write rewrites state.
export const compactAfterMs = 86400000
const done = status => ['acked', 'received', 'handled'].includes(status)
export const directTarget = (rs, message) => rs?.delivery_owners?.[message.id]?.participant_id ?? message.to_id ?? rs?.legacy_recipients?.[message.id] ?? null
// Addressing fixed when the message was written. A lazily resolved legacy
// recipient can change later, so it never counts as proof.
function fixedRecipients(rs, message) {
  if (isBroadcast(message.to)) return Array.isArray(message.audience) ? message.audience : null
  const id = rs?.delivery_owners?.[message.id]?.participant_id ?? message.to_id
  return id ? [id] : null
}
const rows = rs => [...Object.values(rs?.members ?? {}), ...Object.values(rs?.retired_members ?? {})]

// Members existing before this index were pruned by count, so a missing
// receipt at or below their legacy_cursor proves nothing.
export function migrateReadIndex(state) {
  if (state.read_index === 1) return
  for (const rs of Object.values(state.rooms)) for (const member of rows(rs)) member.legacy_cursor = rs.routed_cursor
  state.read_index = 1
}

// Runs on write under the state lock. The watermark passes open entries,
// which stay explicit as exceptions; it stops at any fixed-addressed message
// without an entry, because a missing entry above it would then read as received.
// It never passes routed_cursor: mail appended after routing (another process,
// or a line completed mid-transaction) has no entries yet, and routing skips
// anything at or below the watermark.
export function compactReadIndex(rs, messages, byId, { now, sender }) {
  const routed = Math.min(messages.length, rs.routed_cursor)
  for (const member of Object.values(rs.members)) {
    let watermark = Math.max(member.received_cursor ?? 0, member.legacy_cursor ?? 0)
    while (watermark < routed) {
      const message = messages[watermark]
      if (!member.deliveries[message.id] && sender(message) !== member.participant_id && fixedRecipients(rs, message)?.includes(member.participant_id) &&
          !isDismissed(rs, message, member.participant_id)) break
      watermark++
    }
    member.received_cursor = watermark
    for (const [id, receipt] of Object.entries(member.deliveries)) {
      const message = byId.get(id)
      // An unreadable timestamp keeps the entry: NaN never reads as old enough.
      if (!message || message.cursor > watermark || message.cursor <= (member.legacy_cursor ?? 0) || !done(receipt.status) || !(now - Date.parse(receipt.updated) >= compactAfterMs)) continue
      if (fixedRecipients(rs, message)?.includes(member.participant_id)) delete member.deliveries[id]
    }
  }
}

function stateOf(row, message, fixed) {
  if (!row) return 'unread'
  const receipt = row.deliveries[message.id]
  if (receipt) return readState(receipt.status)
  if (fixed && message.cursor > (row.legacy_cursor ?? 0) && message.cursor <= (row.received_cursor ?? 0)) return 'received'
  return 'unknown_legacy'
}

export function recipientStates(state, rs, message, senderId) {
  const label = (id, row) => row?.agent ?? state.participants?.[id]?.name ?? message.to
  // Dismissed open mail reads as handled; the log and any receipt stay as they were.
  const read = (id, row, fixed) => isDismissed(rs, message, id) ? 'handled' : stateOf(row, message, fixed)
  const fixed = fixedRecipients(rs, message)
  if (fixed) return fixed.map(id => {
    const row = rows(rs).find(member => member.participant_id === id)
    return { participant_id: id, agent: label(id, row), read_state: read(id, row, true) }
  })
  if (!isBroadcast(message.to)) {
    const id = directTarget(rs, message), row = id && rows(rs).find(member => member.participant_id === id)
    return [{ participant_id: id, agent: label(id, row), read_state: read(id, row, false) }]
  }
  // Audience-free broadcast: an entry is proof; otherwise only a legacy row
  // that was joined before the message could have been a recipient.
  return rows(rs).filter(row => row.deliveries[message.id] || (row.participant_id !== senderId &&
    message.cursor > row.after_cursor && message.cursor <= (row.legacy_cursor ?? 0)))
    .map(row => ({ participant_id: row.participant_id, agent: row.agent, read_state: read(row.participant_id, row, false) }))
}
