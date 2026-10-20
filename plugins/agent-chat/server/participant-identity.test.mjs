import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createStore } from './store.mjs'

function fixture(t) {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'chat-identity-'))
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}))
  let clock=1_800_000_000_000
  const store=createStore({root:path.join(dir,'chats'),projectRoot:dir,now:()=>clock})
  for(const room of ['one','two'])store.createRoom({room,title:room})
  return {store,advance:days=>{clock+=days*86400000}}
}
const session=id=>({id,runtime:'codex',profileHome:'/fixture/profile'})

test('canonical name is unique across rooms ignoring case',t=>{
  const {store}=fixture(t)
  store.join({room:'one',agent:'Reader',session:session('a')})
  assert.throws(()=>store.join({room:'two',agent:'reader',session:session('b')}),/name.*(owned|reserved|collision)/i)
  assert.throws(()=>store.join({room:'two',agent:'Other',session:session('a')}),/canonical name/i)
})

test('rename keeps stable routing, immutable history and in-flight claims across rooms',t=>{
  const {store}=fixture(t)
  const member=store.join({room:'one',agent:'Reader',session:session('a')})
  store.join({room:'two',agent:'Reader',session:session('a')})
  const old=store.post({room:'one',from:'Writer',to:'Reader',message:'before'})
  const identity={room:'one',agent:'Reader',sessionId:'a',participantId:member.participant_id}
  store.claim({...identity,message_ids:[old.message_id]})
  const claim=store.assertMember('one','Reader','a').deliveries[old.message_id].claim_id
  store.renameSession({...identity,name:'Reviewer',source:'agent'})
  store.updateDelivery({...identity,message_ids:[old.message_id],expected_claim_id:claim,status:'notified'})
  assert.equal(store.members({room:'two'})[0].agent,'Reviewer')
  const next=store.post({room:'one',from:'Writer',to:'reader',message:'retired name'})
  const history=store.history({room:'one'})
  assert.equal(history[0].to,'Reader')
  assert.equal(history[0].to_id,member.participant_id)
  assert.equal(history[1].to_id,member.participant_id)
  assert.deepEqual(store.pending(identity).map(m=>m.id),[old.message_id,next.message_id])
})

test('retired name requires both seven days and all old-name direct mail received',t=>{
  const {store,advance}=fixture(t)
  const member=store.join({room:'one',agent:'Old',session:session('a')})
  const identity={room:'one',agent:'Old',sessionId:'a',participantId:member.participant_id}
  const mail=store.post({room:'one',from:'Writer',to:'Old',message:'unread'})
  store.renameSession({...identity,name:'New'})
  advance(8)
  assert.throws(()=>store.join({room:'two',agent:'Old',session:session('b')}),/reserved/)
  store.ack({...identity,message_ids:[mail.message_id]})
  const next=store.join({room:'two',agent:'Old',session:session('b')})
  assert.notEqual(next.participant_id,member.participant_id)
  assert.ok(next.owner_since)
  assert.equal(store.history({room:'one'})[0].to_id,member.participant_id)
  assert.equal(store.pending(identity).length,0)
})

test('Claude identity follows actual conversation across launches, clear receives no old name',t=>{
  const {store}=fixture(t)
  const claude=(id,conversationId)=>({id,conversationId,runtime:'claude',profileHome:'/fixture/profile'})
  const member=store.join({room:'one',agent:'Claude',session:claude('launch1','11111111-1111-1111-1111-111111111111')})
  const resumed=store.join({room:'two',agent:'Claude',session:claude('launch2','11111111-1111-1111-1111-111111111111')})
  assert.equal(resumed.participant_id,member.participant_id)
  assert.throws(()=>store.join({room:'two',agent:'Claude',session:claude('launch2','22222222-2222-2222-2222-222222222222')}),/owned/)
})

test('explicit closed-name adoption transfers only unread direct mail across rooms',t=>{
  const {store}=fixture(t)
  const first=store.join({room:'one',agent:'Reader',session:session('a')})
  store.join({room:'two',agent:'Reader',session:session('a')})
  const delivered=store.post({room:'one',from:'Writer',to:'Reader',message:'returned'})
  const unread=store.post({room:'two',from:'Writer',to:'Reader',message:'unread'})
  const broadcast=store.post({room:'one',from:'Writer',message:'broadcast'})
  store.updateDelivery({room:'one',agent:'Reader',sessionId:'a',message_ids:[delivered.message_id],status:'delivered'})
  store.deactivateSession('a')
  const next=store.join({room:'one',agent:'Reader',session:session('b')})
  store.join({room:'two',agent:'Reader',session:session('b')})
  assert.notEqual(next.participant_id,first.participant_id)
  assert.deepEqual(store.pending({room:'one',agent:'Reader',sessionId:'b'}),[])
  assert.deepEqual(store.pending({room:'two',agent:'Reader',sessionId:'b'}).map(row=>row.id),[unread.message_id])
  const state=JSON.parse(fs.readFileSync(store.statePath,'utf8'))
  assert.equal(state.rooms.one.retired_members[first.participant_id].deliveries[delivered.message_id].status,'delivered')
  assert.ok(state.rooms.one.retired_members[first.participant_id].deliveries[broadcast.message_id])
  assert.equal(store.history({room:'two'})[0].to_id,first.participant_id)
  assert.equal(state.rooms.two.delivery_owners[unread.message_id].participant_id,next.participant_id)
})

test('delivered content stays delivered across rejoin and does not prolong name reservation',t=>{
  const {store,advance}=fixture(t)
  const member=store.join({room:'one',agent:'Old',session:session('a')})
  const identity={room:'one',agent:'Old',sessionId:'a',participantId:member.participant_id}
  const mail=store.post({room:'one',from:'Writer',to:'Old',message:'read'})
  store.updateDelivery({...identity,message_ids:[mail.message_id],status:'delivered'})
  store.deactivateSession('a')
  store.join({room:'one',agent:'Old',session:session('a')})
  assert.equal(store.deliveryStatus(identity)[0].status,'delivered')
  store.renameSession({...identity,name:'New'})
  advance(8)
  store.join({room:'two',agent:'Old',session:session('b')})
  store.updateDelivery({...identity,message_ids:[mail.message_id],status:'received'})
  assert.equal(store.pending(identity).length,0)
})

test('legacy aliases require an explicit mapping without rewriting history',t=>{
  const {store}=fixture(t)
  store.join({room:'one',agent:'One',session:session('a')})
  store.join({room:'two',agent:'One',session:session('a')})
  const state=JSON.parse(fs.readFileSync(store.statePath,'utf8'))
  const id=state.rooms.one.members.One.participant_id
  delete state.participants;delete state.nameOwners
  state.rooms.two.members.Two={...state.rooms.two.members.One,agent:'Two'}
  delete state.rooms.two.members.One
  fs.writeFileSync(store.statePath,JSON.stringify(state))
  assert.throws(()=>store.memberships(),error=>error.code==='CHAT_IDENTITY_CONFLICT'&&error.conflicts[0].names.length===2)
  store.migrateParticipantNames({[id]:'Chosen'})
  assert.deepEqual(store.memberships().map(m=>m.agent),['Chosen','Chosen'])
})

test('native defaults are normalized and collision suffixed; explicit names reject invalid input',t=>{
  const {store}=fixture(t)
  const choice=store.chooseDefaultName(session('a'),'Agent','Review User Interface')
  assert.deepEqual(choice,{name:'review-user-interface',source:'native'})
  store.join({room:'one',agent:choice.name,session:session('a')})
  assert.equal(store.chooseDefaultName(session('b'),'Agent','Review User Interface').name,'review-user-interface-2')
  assert.throws(()=>store.renameSession({room:'one',agent:choice.name,sessionId:'a',name:'bad name',source:'explicit'}),/invalid name/)
})

test('a legacy name held by a closed and a live session stays with the one the mapping keeps',t=>{
  const {store}=fixture(t)
  store.join({room:'one',agent:'Pm',session:session('live')})
  store.join({room:'two',agent:'Other',session:session('old')})
  const state=JSON.parse(fs.readFileSync(store.statePath,'utf8'))
  const live=state.rooms.one.members.Pm.participant_id, old=state.rooms.two.members.Other.participant_id
  delete state.participants;delete state.nameOwners
  state.rooms.two.members.Pm={...state.rooms.two.members.Other,agent:'Pm'}
  delete state.rooms.two.members.Other
  fs.writeFileSync(store.statePath,JSON.stringify(state))
  assert.throws(()=>store.memberships(),error=>error.code==='CHAT_IDENTITY_CONFLICT')
  // Keep the live owner first and last in iteration order to cover both overwrite directions.
  for(const mapping of [{[live]:'Pm',[old]:'Pm-old'},{[old]:'Pm-old',[live]:'Pm'}]){
    const fresh=JSON.parse(JSON.stringify(state));fs.writeFileSync(store.statePath,JSON.stringify(fresh))
    store.migrateParticipantNames(mapping)
    const owners=JSON.parse(fs.readFileSync(store.statePath,'utf8')).nameOwners
    assert.equal(owners.pm.participant_id,live);assert.equal(owners.pm.retired_at,undefined)
  }
})
