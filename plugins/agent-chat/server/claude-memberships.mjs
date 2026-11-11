import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { participantId, adoptClosedName } from './participant-identity.mjs'
const key=session=>createHash('sha256').update(session.profileHome+'\n'+session.conversationId).digest('hex')
export function rememberClaudeMembership(state,{room,agent,session},joined=true) {
  if(session.runtime!=='claude'||!session.conversationId)return
  const index=state.claudeRooms??={}
  const record=index[key(session)]??={conversationId:session.conversationId,profileHome:session.profileHome,rooms:{}}
  const aliases=new Set(record.rooms[room]??[])
  if(joined)aliases.add(agent);else aliases.delete(agent)
  record.rooms[room]=[...aliases]
}
// Two accounts (Claude config dirs) hold the same conversations when their
// projects/ folders resolve to one place.
export function sharesTranscripts(a, b) {
  try { return fs.realpathSync(path.join(a, 'projects')) === fs.realpathSync(path.join(b, 'projects')) } catch { return false }
}
// A conversation resumed on another account that shares its transcripts is the
// same session: its names move to the new identity (pending mail included) the
// way a manual join takes over a closed name. Returns the rooms it was in;
// rooms that only held mail for the name stay unjoined.
function moveFromOtherAccount(state, session, { isLive, preserveUnconfirmed, now, records, sameTranscripts }) {
  const id = participantId(session), moved = new Map(), skip = new Set()
  if (!now || !records) return skip
  const conversation = old => old.conversationId ?? old.id
  for (const [room, rs] of Object.entries(state.rooms)) for (const member of Object.values(rs.members)) {
    const old = member.session
    if (old?.runtime !== 'claude' || !old.profileHome || old.profileHome === session.profileHome) continue
    if (conversation(old) !== session.conversationId || member.left_reason === 'explicit') continue
    if (member.participant_id && member.participant_id !== participantId(old)) continue
    if (!sameTranscripts(old.profileHome, session.profileHome)) continue
    const rooms = moved.get(member.agent) ?? new Set()
    rooms.add(room); moved.set(member.agent, rooms)
  }
  for (const [name, rooms] of moved) {
    const members = Object.values(state.rooms).flatMap(rs => Object.values(rs.members).filter(m => m.agent === name && m.participant_id !== id))
    // The old tab still running keeps its names; that is a conflict, not a move.
    if (members.some(m => { if (!m.joined) return false; try { return isLive({ pid: m.session.clientPid, start: m.session.clientStart }) } catch { return true } })) continue
    for (const m of members) if (m.joined) { m.joined = false; m.left_reason = 'session_closed'; preserveUnconfirmed(m) }
    adoptClosedName(state, session, name, now, records)
    for (const [room, rs] of Object.entries(state.rooms)) if (rs.members[name]?.participant_id === id && !rooms.has(room)) skip.add(room + '\n' + name)
  }
  return skip
}
// Only trusted lifecycle observations may call this internal store operation.
export function restoreClaudeMemberships(state, { session, source, previousConversationId }, { isLive, preserveUnconfirmed, now, records, sameTranscripts = sharesTranscripts }) {
  const restored = [], conflicts = []
  const skip = moveFromOtherAccount(state, session, { isLive, preserveUnconfirmed, now, records, sameTranscripts })
  const sameClient = old => old.clientPid === session.clientPid && old.clientStart === session.clientStart && old.endpoint === session.endpoint
  const matchesProfile = old => old.runtime === 'claude' && old.profileHome === session.profileHome
  const conversation = old => old.conversationId ?? old.id
  for (const [room, rs] of Object.entries(state.rooms)) for (const member of Object.values(rs.members)) {
    const old = member.session
    if (!matchesProfile(old) || member.left_reason === 'explicit' || skip.has(room + '\n' + member.agent)) continue
    const known=state.claudeRooms?.[key(session)]
    const target = member.participant_id ? member.participant_id===participantId(session) :
      known?.profileHome===session.profileHome&&known.conversationId===session.conversationId&&known.rooms[room]?.includes(member.agent) || conversation(old) === session.conversationId
    // Switching to another conversation must not keep receiving its mail.
    if (!target) {
      if (member.joined && sameClient(old)) {
        member.joined = false; member.left_reason = 'conversation_changed'; preserveUnconfirmed(member)
      }
      continue
    }
    // The same saved conversation may be open twice. Keep its live owner.
    if (member.joined && !sameClient(old)) {
      let live
      try { live = isLive({pid:old.clientPid,start:old.clientStart}) } catch { live = true }
      if (live) { conflicts.push({room,agent:member.agent}); continue }
    }
    member.session = {...session, lifecycle:true}
    member.joined = true; delete member.left_reason
    preserveUnconfirmed(member)
    rememberClaudeMembership(state,{room,agent:member.agent,session})
    restored.push({room,agent:member.agent})
  }
  return {restored,conflicts}
}
