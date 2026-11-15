// Dismissal: the user's decision that open mail to a recipient who is not
// joined (a closed tab, a left alias, a name nobody holds) needs no reading.
// The canonical log is never touched. A receipt that exists turns handled; a
// recipient without one gets a per-room record, so a later owner of that name
// never inherits the mail.
import { isBroadcast } from './message-policy.mjs'

// rs.dismissed[message_id] = { by, by_name, at } for direct mail (whoever its recipient
// is or becomes), plus recipients: [participant ids] for a broadcast.
export function isDismissed(rs, message, participantId) {
  const entry = rs?.dismissed?.[message.id]
  if (!entry) return false
  return !isBroadcast(message.to) || (Array.isArray(entry.recipients) && entry.recipients.includes(participantId))
}

export function validDismissals(rs, participants) {
  if (rs.dismissed === undefined) return true
  if (rs.dismissed === null || typeof rs.dismissed !== 'object' || Array.isArray(rs.dismissed)) return false
  // by is the caller's participant id; a caller that never joined has no participant row.
  return Object.values(rs.dismissed).every(entry => entry && typeof entry === 'object' && typeof entry.by === 'string' && !!entry.by &&
    (entry.by_name === undefined || typeof entry.by_name === 'string') &&
    typeof entry.at === 'string' && (entry.recipients === undefined || (Array.isArray(entry.recipients) && entry.recipients.every(id => typeof id === 'string'))))
}

// rows(message) gives that message's recipient read states (read-index.mjs).
// Refuses a recipient joined anywhere in the project: a live session reads
// its own mail. Returns the dismissed message ids.
export function dismissMail(state, room, messages, { by, byName, recipient, recipientId, messageIds, rows, at }) {
  const rs = state.rooms[room]
  const live = recipientId && Object.values(state.rooms).some(other => Object.values(other.members).some(member => member.participant_id === recipientId && member.joined))
  if (live) throw new Error('recipient is joined; it reads its own mail')
  const wanted = messageIds ? new Set(messageIds) : null
  const name = recipient.toLowerCase(), dismissed = [], who = { by, ...(byName ? { by_name: byName } : {}) }
  for (const message of messages) {
    if (wanted && !wanted.has(message.id)) continue
    const row = rows(message).find(row => recipientId ? row.participant_id === recipientId : !row.participant_id && row.agent.toLowerCase() === name)
    if (!row || !['unread', 'delivered', 'unknown_legacy'].includes(row.read_state)) continue
    const member = [...Object.values(rs.members), ...Object.values(rs.retired_members ?? {})].find(member => recipientId && member.participant_id === recipientId)
    const receipt = member?.deliveries[message.id]
    if (receipt) Object.assign(receipt, { status: 'handled', updated: at, dismissed: { ...who, at } })
    else if (isBroadcast(message.to)) {
      const entry = (rs.dismissed ??= {})[message.id] ??= { ...who, at, recipients: [] }
      if (recipientId && !entry.recipients.includes(recipientId)) entry.recipients.push(recipientId)
    } else (rs.dismissed ??= {})[message.id] = { ...who, at }
    dismissed.push(message.id)
  }
  if (wanted && wanted.size !== dismissed.length) throw new Error('message not open for this recipient')
  return dismissed
}
