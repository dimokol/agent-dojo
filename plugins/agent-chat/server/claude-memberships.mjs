import { createHash } from 'node:crypto'
import { participantId } from './participant-identity.mjs'
const key=session=>createHash('sha256').update(session.profileHome+'\n'+session.conversationId).digest('hex')
export function rememberClaudeMembership(state,{room,agent,session},joined=true) {
  if(session.runtime!=='claude'||!session.conversationId)return
  const index=state.claudeRooms??={}
  const record=index[key(session)]??={conversationId:session.conversationId,profileHome:session.profileHome,rooms:{}}
  const aliases=new Set(record.rooms[room]??[])
  if(joined)aliases.add(agent);else aliases.delete(agent)
  record.rooms[room]=[...aliases]
}
// Only trusted lifecycle observations may call this internal store operation.
export function restoreClaudeMemberships(state, { session, source, previousConversationId }, { isLive, preserveUnconfirmed }) {
  const restored = [], conflicts = []
  const sameClient = old => old.clientPid === session.clientPid && old.clientStart === session.clientStart && old.endpoint === session.endpoint
  const matchesProfile = old => old.runtime === 'claude' && old.profileHome === session.profileHome
  const conversation = old => old.conversationId ?? old.id
  for (const [room, rs] of Object.entries(state.rooms)) for (const member of Object.values(rs.members)) {
    const old = member.session
    if (!matchesProfile(old) || member.left_reason === 'explicit') continue
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
