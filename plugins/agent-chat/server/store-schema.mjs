import path from 'node:path'
import { identifier } from './store-files.mjs'
import { validDismissals } from './dismissals.mjs'
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const count = value => Number.isSafeInteger(value) && value >= 0
const times = value => value === undefined || (Array.isArray(value) && value.every(time => Number.isFinite(time) && time >= 0))
const receiptStatuses = new Set(['pending', 'dispatching', 'notified', 'delivered', 'failed', 'acked', 'received', 'handled'])
// Stored semantics a release must understand to read this state: stable
// participant ids, per-recipient read state, and the wake policy and broadcast
// audience on canonical messages. The installer makes them sticky release
// capabilities, so once active no release without them can be switched in.
export const stateCapabilities = Object.freeze(['participant-ids', 'read-index', 'wake-fyi'])
export function stateDamage() {
  return Object.assign(new Error('Agent-chat delivery state is damaged; operator recovery required'), { code: 'CHAT_STATE_DAMAGED' })
}
export function validState(state) {
  if (!object(state) || state.version !== 1 || !object(state.rooms) || !times(state.ring_times) || (state.read_index !== undefined && state.read_index !== 1)) return false
  try {
    if(state.participants!==undefined) {
      if(!object(state.participants)||!object(state.nameOwners))return false
      for(const [id,row] of Object.entries(state.participants)) {
        if(!/^[a-f0-9]{64}$/.test(id)||!object(row)||row.id!==id||!count(row.owner_since)||typeof row.source!=='string')return false
        if(row.name!==null)identifier(row.name)
      }
      for(const [name,row] of Object.entries(state.nameOwners)) {
        identifier(name)
        if(name!==name.toLowerCase()||!object(row)||!state.participants[row.participant_id]||!count(row.owner_since)||(row.retired_at!==undefined&&!count(row.retired_at)))return false
      }
    } else if(state.nameOwners!==undefined)return false
    if(state.claudeRooms!==undefined) {
      if(!object(state.claudeRooms))return false
      for(const [key,row] of Object.entries(state.claudeRooms)) {
        if(!/^[a-f0-9]{64}$/.test(key)||!object(row)||!object(row.rooms)||typeof row.profileHome!=='string'||!path.isAbsolute(row.profileHome)||!/^[-a-f0-9]{36}$/i.test(row.conversationId??''))return false
        for(const [room,aliases] of Object.entries(row.rooms)){identifier(room);if(!Array.isArray(aliases))return false;for(const alias of aliases)identifier(alias)}
      }
    }
    for (const [room, rs] of Object.entries(state.rooms)) {
      identifier(room)
      if (!object(rs) || !count(rs.routed_cursor) || !object(rs.members)) return false
      if(rs.legacy_recipients!==undefined&&(!object(rs.legacy_recipients)||Object.values(rs.legacy_recipients).some(id=>!state.participants?.[id])))return false
      if(rs.delivery_owners!==undefined&&(!object(rs.delivery_owners)||Object.values(rs.delivery_owners).some(row=>!object(row)||!state.participants?.[row.participant_id]||!state.participants?.[row.previous_id]||!count(row.adopted_at))))return false
      if(rs.retired_members!==undefined&&!object(rs.retired_members))return false
      if(!validDismissals(rs,state.participants))return false
      for (const [agent, member] of Object.entries(rs.members)) {
        identifier(agent)
        if (!object(member) || member.agent !== agent || typeof member.joined !== 'boolean' ||
            !count(member.after_cursor) || (member.received_cursor !== undefined && !count(member.received_cursor)) || (member.legacy_cursor !== undefined && !count(member.legacy_cursor)) ||
            !object(member.session) || typeof member.session.id !== 'string' || !member.session.id || member.session.id.length > 300 ||
            typeof member.session.runtime !== 'string' || !member.session.runtime || !object(member.deliveries) || !times(member.ring_times)) return false
        if(state.participants&&(!state.participants[member.participant_id]||state.participants[member.participant_id].name!==agent||!count(member.owner_since)))return false
        for (const field of ['pid', 'serverPid', 'clientPid']) if (member.session[field] !== undefined && (!count(member.session[field]) || !member.session[field])) return false
        for (const field of ['endpoint', 'profileHome', 'serverStart', 'clientStart', 'connectionId','conversationId']) if (member.session[field] !== undefined && (typeof member.session[field] !== 'string' || !member.session[field])) return false
        for (const [id, receipt] of Object.entries(member.deliveries)) {
          identifier(id)
          if (!object(receipt) || !receiptStatuses.has(receipt.status) || !count(receipt.attempts) || typeof receipt.updated !== 'string') return false
          if (receipt.claim_id !== undefined && typeof receipt.claim_id !== 'string') return false
          if (receipt.ring_at !== undefined && (!Number.isFinite(receipt.ring_at) || receipt.ring_at < 0)) return false
        }
      }
    }
    return true
  } catch { return false }
}
