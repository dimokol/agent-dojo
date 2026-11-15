import { createHash } from 'node:crypto'
import { identifier } from './store-files.mjs'
import { isDismissed } from './dismissals.mjs'
import { directTarget } from './read-index.mjs'

export const nameHoldMs = 7 * 86400000
export const completed = receipt => ['delivered','acked','received','handled'].includes(receipt?.status)
export const broadcast = name => ['all','everyone','any','*'].includes(String(name).toLowerCase())
export function participantId(session) {
  const conversation = session.runtime === 'claude' ? session.conversationId ?? session.id : session.id
  return createHash('sha256').update(JSON.stringify([session.runtime,session.profileHome??'',conversation,
    session.runtime==='manual' ? session.connectionId??'' : ''])).digest('hex')
}
// Names are owned case-insensitively, by their lowercase key. "__PROTO__" would set the map's
// prototype instead of a key, so it is no name.
const nameKey = name => {
  const key=identifier(name,'name').toLowerCase()
  if(key==='__proto__')throw Error('invalid name')
  return key
}
// "Constructor" lowercases to a key every object inherits: only the map's own entries count.
const ownerEntry = (state, key) => state.nameOwners && Object.hasOwn(state.nameOwners, key) ? state.nameOwners[key] : undefined
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
    for(const old of row.names)if(nameKey(old)!==nameKey(row.name)&&!(ownerEntry(state,nameKey(old))&&ownerEntry(state,nameKey(old)).retired_at===undefined))state.nameOwners[nameKey(old)]={participant_id:row.id,owner_since:now,retired_at:now}
  }
}
export function nameOwner(state, name, now, unread) {
  const owner=ownerEntry(state,nameKey(name))
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
  if(owner&&owner.id!==id)throw Error(ownerEntry(state,key).retired_at!==undefined?'name is reserved for its previous owner':'name is owned by another session already joined or reserved')
  const row={id,name,owner_since:now,source:'agent'}
  state.participants[id]=row;state.nameOwners[key]={participant_id:id,owner_since:now}
  reviveRetired(state,id,now)
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

// Retarget open direct mail. Mail the old owner read but never confirmed (delivered) moves too,
// marked maybe_seen: its result may have reached that session, never this one. The canonical
// address and to_id never change. keep: the same conversation under a new identity (a tab that
// joined before its conversation registered); its receipts move as they are.
export function adoptClosedName(state,session,name,now,records,{keep=false,queue=true}={}) {
  const owner=ownerEntry(state,nameKey(name)), id=participantId(session)
  if(!owner||owner.participant_id===id||owner.retired_at!==undefined||state.participants[id]?.name)return
  const old=state.participants[owner.participant_id]
  if(old.name!==name)return
  // A room whose log can't be read (damaged, or a folder others can read) doesn't block the
  // takeover: its mail stays on the old owner's retired row, parked for this participant, and
  // settleParked moves it here once the log reads again, whatever either side is called by then.
  const logs={}
  for(const room of Object.keys(state.rooms))try{logs[room]=records(room)}catch{}
  records=room=>logs[room]
  const readable=room=>Object.hasOwn(logs,room)
  const all=Object.entries(state.rooms).flatMap(([room,rs])=>Object.values(rs.members).filter(m=>m.participant_id===old.id).map(member=>({room,rs,member})))
  if(all.some(({member})=>member.joined))return
  const entries=all.filter(({room})=>readable(room))
  for(const {room,rs,member} of all)if(!readable(room)){(rs.retired_members??={})[old.id]={...member,parked_for:{participant_id:id,name}};delete rs.members[member.agent]}
  for(const [room,rs] of Object.entries(state.rooms))if(readable(room)&&!all.some(entry=>entry.room===room)) {
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
    // The old owner's watermarks describe its own mail. This identity has received nothing in this
    // row yet, so a watermark carried over would hide its own mail waiting in the log.
    const row={...member,session:{...session},participant_id:id,owner_since:now,deliveries:{},joined:false,ring_times:[],after_cursor:records(room).length,received_cursor:0}
    delete row.legacy_cursor
    for(const message of records(room)) {
      const receipt=member.deliveries[message.id]
      if(!receipt||settled(receipt)||message.to.toLowerCase()!==name.toLowerCase())continue
      moveReceipt(rs,message,member,row,old.id,id,now,keep)
    }
    retire(rs,old.id,member)
    rs.members[name]=row
  }
  // This identity may have been taken over once itself: what it left behind comes back now.
  reviveRetired(state,id,now)
  if(queue)queueOwn(state,id,now,records)
}

// Mail addressed to a participant that waited in a room's log because it had no row there goes on
// the row it has now, above that row's watermark, the way routing would have queued it.
function queueOwn(state,id,now,records) {
  for(const [room,rs] of Object.entries(state.rooms)) {
    const row=Object.values(rs.members).find(member=>member.participant_id===id)
    if(!row)continue
    let log
    try{log=records(room)}catch{continue}
    for(const message of log)if(message.cursor>(row.received_cursor??0)&&!row.deliveries[message.id]&&message.from_id!==id&&
      directTarget(rs,message)===id&&!isDismissed(rs,message,id))row.deliveries[message.id]={status:'pending',attempts:0,updated:new Date(now).toISOString()}
  }
}

// One open receipt moves to another row and the message is recorded as that participant's. keep:
// the same conversation under a new identity, so the receipt moves as it is. Otherwise it reopens,
// marked maybe_seen if the previous holder was shown it. A receipt the target row has already wins.
function moveReceipt(rs,message,fromRow,toRow,from,to,now,keep=false) {
  const receipt=fromRow.deliveries[message.id]
  if(!toRow.deliveries[message.id]) {
    const moved=toRow.deliveries[message.id]=keep?{...receipt}:{...receipt,status:'pending',...(receipt.status==='delivered'?{maybe_seen:true}:{})}
    if(!keep){delete moved.claim_id;delete moved.ring_at}
  }
  ;(rs.delivery_owners??={})[message.id]={participant_id:to,previous_id:from,adopted_at:now}
  delete fromRow.deliveries[message.id]
}
// A participant keeps one retired row per room: a second retirement merges into the first.
function retire(rs,id,member) {
  const earlier=rs.retired_members?.[id]
  ;(rs.retired_members??={})[id]=earlier&&!earlier.parked_for?{...member,deliveries:{...earlier.deliveries,...member.deliveries}}:member
}
// The row a participant needs in a room to hold mail: its own, else a placeholder under its current
// name when nobody else's row has that name. Null when there is no session to fill one with.
function rowFor(state,rs,id,session,log) {
  const own=Object.values(rs.members).find(member=>member.participant_id===id)
  const name=state.participants[id]?.name
  if(own||!name||!session||rs.members[name])return own??null
  return rs.members[name]={agent:name,participant_id:id,owner_since:state.participants[id].owner_since,session:{...session},joined:false,after_cursor:log.length,received_cursor:0,ring_times:[],deliveries:{}}
}
const sessionOf=(state,id)=>Object.values(state.rooms).flatMap(rs=>Object.values(rs.members)).find(member=>member.participant_id===id)?.session
// Rows a participant left when its name was taken over come back once it has a name again. Where it
// already has a row in that room, the two merge, and the retired row's watermarks win: they describe
// this participant's own mail, the row it has now may have come from another identity. A row parked
// during a takeover holds mail for the name's new owner until its log reads again, so it stays.
function reviveRetired(state,id,now) {
  const name=state.participants[id]?.name
  if(!name)return
  for(const rs of Object.values(state.rooms)) {
    const member=rs.retired_members?.[id]
    if(!member||member.parked_for)continue
    const current=Object.values(rs.members).find(row=>row.participant_id===id)
    if(!current&&rs.members[name])continue
    delete rs.retired_members[id]
    if(current) {
      current.deliveries={...member.deliveries,...current.deliveries}
      current.received_cursor=member.received_cursor??0
      if(member.legacy_cursor!==undefined)current.legacy_cursor=member.legacy_cursor;else delete current.legacy_cursor
    } else {member.agent=name;member.owner_since=now;rs.members[name]=member}
  }
}
// The same conversation under a new identity (a tab that joined before its conversation was known):
// every name `from` holds or reserves and all its open mail, whatever name it was addressed to,
// become `to`'s. Mail with no row to hold it waits in the log for `to` to join that room.
function moveIdentity(state,from,to,now,records) {
  for(const entry of Object.values(state.nameOwners))if(entry.participant_id===from)entry.participant_id=to
  for(const [room,rs] of Object.entries(state.rooms)) {
    let log
    try{log=records(room)}catch{continue}
    const rows=[...Object.values(rs.members),...Object.values(rs.retired_members??{})].filter(member=>member.participant_id===from&&!member.parked_for)
    for(const message of log) {
      if(directTarget(rs,message)!==from||isDismissed(rs,message,from))continue
      const holder=rows.find(member=>member.deliveries[message.id])
      if(holder?settled(holder.deliveries[message.id]):rows.some(member=>(member.received_cursor??0)>=message.cursor))continue
      const target=rowFor(state,rs,to,sessionOf(state,to),log)
      if(holder&&target)moveReceipt(rs,message,holder,target,from,to,now,true)
      else {
        ;(rs.delivery_owners??={})[message.id]={participant_id:to,previous_id:from,adopted_at:now}
        if(target&&!target.deliveries[message.id])target.deliveries[message.id]={status:'pending',attempts:0,updated:new Date(now).toISOString()}
      }
    }
  }
}

// A named session taking over a closed session's name: the adoption above, then this session's
// own rooms move to the new name (merging with any room the adoption filled) and its old name
// stays reserved for it, as in a rename. False when the adoption did not happen.
export function adoptClosedNameAsRename(state,session,name,now,records) {
  const id=participantId(session), row=state.participants[id]
  if(!row?.name)return false
  const old=row.name, mine=[]
  for(const rs of Object.values(state.rooms))for(const [agent,member] of Object.entries(rs.members))if(member.participant_id===id){delete rs.members[agent];mine.push({rs,member})}
  row.name=null
  adoptClosedName(state,session,name,now,records,{queue:false})
  if(state.participants[id]?.name!==name) {
    row.name=old;state.participants[id]=row
    for(const {rs,member} of mine)rs.members[member.agent]=member
    return false
  }
  for(const {rs,member} of mine) {
    const adopted=rs.members[name]?.participant_id===id?rs.members[name]:null
    member.agent=name;member.owner_since=now
    if(adopted)member.deliveries={...adopted.deliveries,...member.deliveries}
    rs.members[name]=member
    renameGrants(state,old,name,member.session)
  }
  if(nameKey(old)!==nameKey(name))state.nameOwners[nameKey(old)]={participant_id:id,owner_since:row.owner_since,retired_at:now}
  queueOwn(state,id,now,records)
  return true
}

const settled = receipt => ['acked','received','handled'].includes(receipt?.status)
// Before 2.0.3 a takeover left delivered mail on the retired row of the old owner, where nobody
// could read it. The name's current owner takes it when it joins or reads, the same way adoption
// moves it now. `session` fills a placeholder row in a room where the owner has none.
export function reclaimRetired(state,id,session,now,records) {
  settleParked(state,now,records)
  const name=state.participants[id]?.name
  if(!name||state.nameOwners[nameKey(name)]?.participant_id!==id||state.nameOwners[nameKey(name)].retired_at!==undefined)return
  for(const [room,rs] of Object.entries(state.rooms)) {
    const retired=Object.values(rs.retired_members??{}).filter(row=>row.participant_id!==id&&!row.parked_for&&
      state.participants[row.participant_id]?.name===null&&String(state.participants[row.participant_id]?.previous_name).toLowerCase()===name.toLowerCase()&&
      Object.values(row.deliveries).some(receipt=>!settled(receipt)))
    if(!retired.length)continue
    let log
    try{log=records(room)}catch{continue}
    for(const row of retired)for(const message of log) {
      const receipt=row.deliveries[message.id]
      if(!receipt||settled(receipt)||message.to.toLowerCase()!==name.toLowerCase()||isDismissed(rs,message,row.participant_id))continue
      const owner=rowFor(state,rs,id,session,log)
      if(!owner)break
      moveReceipt(rs,message,row,owner,row.participant_id,id,now)
    }
  }
}

// Mail parked in a room whose log could not be read during a takeover belongs to the participant
// that took the name over then (recorded on the row), under whatever name it has now. Once the log
// reads, that mail moves to its row in the room (a placeholder if it has none); the rest of the
// row stays with its old owner, which gets it back if it registers again.
export function settleParked(state,now,records) {
  for(const [room,rs] of Object.entries(state.rooms))for(const row of Object.values(rs.retired_members??{})) {
    if(!row.parked_for)continue
    const {participant_id:to,name}=row.parked_for, current=state.participants[to]?.name
    if(!current)continue
    let log
    try{log=records(room)}catch{continue}
    const mail=log.filter(message=>row.deliveries[message.id]&&!settled(row.deliveries[message.id])&&message.to.toLowerCase()===name.toLowerCase()&&!isDismissed(rs,message,row.participant_id))
    const owner=mail.length?rowFor(state,rs,to,sessionOf(state,to),log):null
    if(mail.length&&!owner)continue
    for(const message of mail)moveReceipt(rs,message,row,owner,row.participant_id,to,now)
    delete row.parked_for
  }
}

// A tab that joined before Claude recorded its conversation has rows with no conversationId,
// under its launch id's identity. Once the conversation is known they belong to it, so they move
// to it as they are (no close, receipts unchanged), the way a takeover of a closed name moves rows.
// Only rows of this same tab process that are still joined count: rows a lifecycle /clear already
// closed belong to the conversation it left. The launch id's identity is also the launch
// conversation's, so nothing moves while that identity holds any row with a conversation.
export function adoptUnresolved(state,session,now,records,preserveUnconfirmed) {
  const id=participantId(session), unresolvedId=participantId({...session,conversationId:undefined})
  if(unresolvedId===id||!state.participants[unresolvedId]?.name||state.participants[id]?.name)return []
  const all=rowsOf(state,unresolvedId)
  if(!all.length||all.some(member=>member.session.conversationId||member.session.id!==session.id||!sameTab(session,member.session))||!all.some(member=>member.joined))return []
  for(const member of all)if(member.joined){member.joined=false;member.left_reason='conversation_changed';preserveUnconfirmed(member)}
  return moveTo(state,session,unresolvedId,state.participants[unresolvedId].name,now,records,true)
}

// A tab switching conversations (a /clear, a /resume) takes back what its current conversation
// held: if the conversation it just left in this same tab process took this one's name over (a
// /clear, a join under the same name, a /resume back), that one is closed by now, so the name,
// rooms and mail come back the way any takeover of a closed name moves them. Returns the rooms
// joined back.
export function takeBackName(state,session,now,records) {
  const id=participantId(session), own=state.participants[id]
  if(!own||own.name||!own.previous_name)return []
  const entry=ownerEntry(state,nameKey(own.previous_name))
  if(!entry||entry.retired_at!==undefined||entry.participant_id===id)return []
  const rows=rowsOf(state,entry.participant_id)
  if(!rows.length||rows.some(member=>member.joined||!sameTab(session,member.session)))return []
  return moveTo(state,session,entry.participant_id,own.previous_name,now,records,false)
}
const rowsOf=(state,pid)=>Object.values(state.rooms).flatMap(rs=>Object.values(rs.members).filter(member=>member.participant_id===pid))
const sameTab=(session,old)=>old?.runtime==='claude'&&old.profileHome===session.profileHome&&old.clientPid===session.clientPid&&old.clientStart===session.clientStart
function moveTo(state,session,from,name,now,records,keep) {
  const id=participantId(session)
  const rejoin=Object.entries(state.rooms).filter(([,rs])=>Object.values(rs.members).some(member=>member.participant_id===from&&member.left_reason==='conversation_changed')).map(([room])=>room)
  const source=keep?state.participants[from].source:state.participants[id]?.source
  adoptClosedName(state,session,name,now,records,{keep})
  if(state.participants[id]?.name!==name)return []
  if(keep)moveIdentity(state,from,id,now,records)
  if(source)state.participants[id].source=source
  const back=[]
  for(const room of rejoin) {
    const member=state.rooms[room].members[name]
    if(member?.participant_id!==id)continue
    member.joined=true;delete member.left_reason;member.session={...session}
    back.push({room,agent:name})
  }
  return back
}
