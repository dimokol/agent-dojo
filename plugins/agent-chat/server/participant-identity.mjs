import { createHash } from 'node:crypto'
import { identifier } from './store-files.mjs'
import { isDismissed } from './dismissals.mjs'

export const nameHoldMs = 7 * 86400000
export const completed = receipt => ['delivered','acked','received','handled'].includes(receipt?.status)
export const broadcast = name => ['all','everyone','any','*'].includes(String(name).toLowerCase())
export function participantId(session) {
  const conversation = session.runtime === 'claude' ? session.conversationId ?? session.id : session.id
  return createHash('sha256').update(JSON.stringify([session.runtime,session.profileHome??'',conversation,
    session.runtime==='manual' ? session.connectionId??'' : ''])).digest('hex')
}
const nameKey = name => identifier(name,'name').toLowerCase()
function validName(name) {
  const key=nameKey(name)
  if(broadcast(key))throw Error('invalid name reserved for broadcasts')
  return key
}
function conflict(rows) {
  return Object.assign(Error('Participant name migration conflict; explicit mapping required'),{code:'CHAT_IDENTITY_CONFLICT',conflicts:rows})
}
// A legacy name is accepted only when the project gives it one unambiguous owner.
export function initializeParticipants(state, now, mapping) {
  if(state.participants) return
  const groups=new Map(), owners=new Map(), conflicts=[]
  for(const [room,rs] of Object.entries(state.rooms))for(const member of Object.values(rs.members)) {
    const id=participantId(member.session)
    const row=groups.get(id)??{id,names:new Set(),members:[]}
    row.names.add(member.agent);row.members.push({room,member});groups.set(id,row)
  }
  for(const row of groups.values()) {
    row.name=mapping?.[row.id]??(row.names.size===1?[...row.names][0]:null)
    if(!row.name){conflicts.push({participant_id:row.id,names:[...row.names]});continue}
    const key=validName(row.name)
    if(owners.has(key)) conflicts.push({name:row.name,participant_ids:[owners.get(key),row.id]})
    owners.set(key,row.id)
    if(new Set(row.members.map(m=>m.room)).size!==row.members.length)conflicts.push({participant_id:row.id,names:[...row.names],reason:'Multiple aliases in one room require receipt reconciliation'})
  }
  if(conflicts.length)throw conflict(conflicts)
  state.participants={};state.nameOwners={}
  for(const row of groups.values()) {
    state.participants[row.id]={id:row.id,name:row.name,owner_since:now,source:'legacy'}
    state.nameOwners[nameKey(row.name)]={participant_id:row.id,owner_since:now}
    for(const {room,member} of row.members) {
      const old=member.agent
      delete state.rooms[room].members[old]
      member.agent=row.name;member.participant_id=row.id;member.owner_since=now
      state.rooms[room].members[row.name]=member
      renameGrants(state,old,row.name,member.session)
    }
    // A mapped-away alias is only reserved when no active participant owns that name;
    // otherwise its retirement would capture the active owner's direct mail.
    for(const old of row.names)if(nameKey(old)!==nameKey(row.name)&&!(state.nameOwners[nameKey(old)]&&state.nameOwners[nameKey(old)].retired_at===undefined))state.nameOwners[nameKey(old)]={participant_id:row.id,owner_since:now,retired_at:now}
  }
}
export function nameOwner(state, name, now, unread) {
  const owner=state.nameOwners?.[nameKey(name)]
  if(!owner)return null
  if(owner.retired_at!==undefined&&now>=owner.retired_at+nameHoldMs&&!unread(name,owner.participant_id))return null
  return state.participants[owner.participant_id]
}
export function registerParticipant(state,session,name,now,unread) {
  const key=validName(name), id=participantId(session), existing=state.participants[id]
  if(existing?.name) {
    if(existing.name!==name)throw Error('Use canonical name or explicitly rename this session')
    return existing
  }
  const owner=nameOwner(state,name,now,unread)
  if(owner&&owner.id!==id)throw Error(state.nameOwners[key].retired_at!==undefined?'name is reserved for its previous owner':'name is owned by another session already joined or reserved')
  const row={id,name,owner_since:now,source:'agent'}
  state.participants[id]=row;state.nameOwners[key]={participant_id:id,owner_since:now}
  for(const rs of Object.values(state.rooms))if(rs.retired_members?.[id]) {
    const member=rs.retired_members[id]
    delete rs.retired_members[id]
    member.agent=name;member.owner_since=now;rs.members[name]=member
  }
  return row
}
function renameGrants(state,old,name,session) {
  for(const grant of Object.values(state.claudeRooms??{})) {
    if(grant.profileHome!==session.profileHome||grant.conversationId!==(session.conversationId??session.id))continue
    for(const [room,names] of Object.entries(grant.rooms))grant.rooms[room]=[...new Set(names.map(alias=>alias===old?name:alias))]
  }
}
export function renameParticipant(state,id,name,{now,unread,source='agent'}={}) {
  const key=validName(name), row=state.participants[id]
  if(!row)throw Error('session is not joined as this agent')
  if(!['agent','explicit','native','default','legacy'].includes(source))throw Error('invalid name source')
  const owner=nameOwner(state,name,now,unread)
  if(owner&&owner.id!==id)throw Error('name collision with another owner')
  const old=row.name
  if(old===name){row.source=source;return {...row}}
  for(const rs of Object.values(state.rooms))for(const member of Object.values(rs.members))if(member.participant_id===id) {
    delete rs.members[member.agent];member.agent=name;rs.members[name]=member
    renameGrants(state,old,name,member.session)
  }
  if(nameKey(old)!==key)state.nameOwners[nameKey(old)]={participant_id:id,owner_since:row.owner_since,retired_at:now}
  state.nameOwners[key]={participant_id:id,owner_since:now}
  row.name=name;row.owner_since=now;row.source=source
  for(const rs of Object.values(state.rooms))if(rs.members[name]?.participant_id===id)rs.members[name].owner_since=now
  return {...row,previous_name:old}
}

// Retarget only unread direct mail. The canonical address and to_id never change.
export function adoptClosedName(state,session,name,now,records) {
  const owner=state.nameOwners[nameKey(name)], id=participantId(session)
  if(!owner||owner.participant_id===id||owner.retired_at!==undefined||state.participants[id])return
  const old=state.participants[owner.participant_id]
  if(old.name!==name)return
  // Mail in a damaged log can't be moved, so the name isn't taken over until it is repaired.
  const logs={}
  for(const room of Object.keys(state.rooms))try{logs[room]=records(room)}catch{return}
  records=room=>logs[room]
  const entries=Object.entries(state.rooms).flatMap(([room,rs])=>Object.values(rs.members).filter(m=>m.participant_id===old.id).map(member=>({room,rs,member})))
  if(entries.some(({member})=>member.joined))return
  for(const [room,rs] of Object.entries(state.rooms))if(!entries.some(entry=>entry.room===room)) {
    // Dismissed mail stays dismissed for whoever takes the name over.
    const mail=records(room).filter(message=>message.to.toLowerCase()===name.toLowerCase()&&!isDismissed(rs,message,old.id)&&
      (rs.delivery_owners?.[message.id]?.participant_id??message.to_id??rs.legacy_recipients?.[message.id])===old.id)
    if(mail.length)entries.push({room,rs,member:{agent:name,participant_id:old.id,owner_since:old.owner_since,
      session:entries[0]?.member.session??session,joined:false,after_cursor:0,received_cursor:0,ring_times:[],
      deliveries:Object.fromEntries(mail.map(message=>[message.id,{status:'pending',attempts:0,updated:new Date(now).toISOString()}]))}})
  }
  state.participants[id]={id,name,owner_since:now,source:'adoption'}
  old.previous_name=name;old.name=null
  state.nameOwners[nameKey(name)]={participant_id:id,owner_since:now}
  for(const {room,rs,member} of entries) {
    const deliveries={}, overrides=rs.delivery_owners??={}
    for(const message of records(room)) {
      const receipt=member.deliveries[message.id]
      if(!receipt||completed(receipt)||message.to.toLowerCase()!==name.toLowerCase())continue
      deliveries[message.id]={...receipt,status:'pending'}
      delete deliveries[message.id].claim_id;delete deliveries[message.id].ring_at
      overrides[message.id]={participant_id:id,previous_id:old.id,adopted_at:now}
      delete member.deliveries[message.id]
    }
    ;(rs.retired_members??={})[old.id]=member
    rs.members[name]={...member,session:{...session},participant_id:id,owner_since:now,deliveries,joined:false,ring_times:[],after_cursor:records(room).length}
  }
}
