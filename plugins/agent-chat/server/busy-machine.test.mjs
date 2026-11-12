// 2.0.2: what a busy machine or a burst of restored tabs used to break.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {spawnSync} from 'node:child_process'
import {createService,capInbox,transientError,BUSY} from './server.mjs'
import {createStore} from './store.mjs'
import {processIdentity} from './native-session.mjs'
import {currentClaudeConversation} from './claude-lifecycle.mjs'

const fixture=t=>{
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'agent-chat-busy-')))
  // Services close before the folder goes: their background dispatch still holds the store.
  const services=[]
  t.after(()=>{for(const service of services)service.close();fs.rmSync(root,{recursive:true,force:true})})
  const own=service=>(services.push(service),service)
  const profile=path.join(root,'profile');fs.mkdirSync(profile,{mode:0o700})
  return {root,profile,own,store:createStore({root:path.join(root,'chats'),stateRoot:path.join(root,'state'),projectRoot:root})}
}
const adapters={async deliver(){return {status:'accepted'}}}
const self=processIdentity(process.pid)
const claude=(profile,extra={})=>({runtime:'claude',id:'00000000-0000-4000-8000-000000000021',profileHome:profile,endpoint:'/private/agent-chat-busy.sock',clientPid:self.pid,clientStart:self.start,serverPid:self.pid,serverStart:self.start,...extra})
const deadPid=()=>spawnSync('/usr/bin/true').pid

test('a native Claude session is checked once per connection, so a slow ps later cannot fail a call',async t=>{
  const {store,profile,own}=fixture(t)
  let checks=0
  const service=own(createService({store,env:{},adapters,inferSession:()=>{if(++checks>1)throw Object.assign(Error('ps timed out'),{code:'CHAT_PRESENCE_UNAVAILABLE'});return claude(profile)},resolveConversation:()=>null}))
  await service.call('join_room',{room:'room',agent:'Reader'})
  for(let i=0;i<3;i++)await service.call('history',{room:'room'})
  await service.call('post',{room:'room',from:'Reader',message:'still works'})
  assert.equal(checks,1)
})

test('cleanup closes a Claude member that has no server PID once its tab is gone, and keeps a live one',async t=>{
  const {store,profile,own}=fixture(t)
  store.createRoom({room:'room',title:'room'})
  store.join({room:'room',agent:'Ghost',session:{runtime:'claude',id:'00000000-0000-4000-8000-000000000031',profileHome:profile,clientPid:deadPid(),clientStart:'Mon Jan  1 00:00:00 2024'}})
  store.join({room:'room',agent:'Alive',session:{runtime:'claude',id:'00000000-0000-4000-8000-000000000032',profileHome:profile,clientPid:self.pid,clientStart:self.start}})
  const service=own(createService({store,env:{},adapters,inferSession:()=>null}))
  await service.call('list_rooms')
  const joined=Object.fromEntries(store.memberships().map(row=>[row.agent,row.joined]))
  assert.deepEqual(joined,{Ghost:false,Alive:true})
})

test('a tab whose start-up registration failed registers itself on its next call',async t=>{
  const {store,profile,own}=fixture(t)
  const conversation='00000000-0000-4000-8000-000000000041'
  const session=claude(profile)
  store.createRoom({room:'room',title:'room'})
  store.join({room:'room',agent:'Orchestrator',session:{...claude(profile,{clientPid:deadPid(),clientStart:'earlier'}),conversationId:conversation}})
  store.deactivateSession(session.id)
  let registered=false
  const calls=[]
  const service=own(createService({store,env:{},adapters,inferSession:()=>session,
    resolveConversation:()=>registered?conversation:null,
    currentConversation:(home,pid)=>{calls.push(['current',home,pid]);return conversation},
    observeLifecycle:input=>{calls.push(['observe',input.source,input.session_id]);registered=true
      return {session:{...session,conversationId:conversation,lifecycle:true},conversationId:conversation,previousConversationId:null,source:'resume'}}}))
  assert.deepEqual(await service.call('inbox',{room:'room',agent:'Orchestrator'}),[])
  assert.deepEqual(calls,[['current',profile,self.pid],['observe','resume',conversation]])
  assert.equal(fs.existsSync(path.join(store.stateRoot,'lifecycle-failures',`pending-${session.id}.json`)),false)
  assert.equal(store.memberships().find(row=>row.agent==='Orchestrator').joined,true)
})

test('when self-registration cannot run, the error says it is retried, not a restart',async t=>{
  const {store,profile,own}=fixture(t)
  const session=claude(profile)
  store.createRoom({room:'room',title:'room'})
  store.join({room:'room',agent:'Reader',session:{...session,conversationId:'00000000-0000-4000-8000-000000000051'}})
  const service=own(createService({store,env:{},adapters,inferSession:()=>session,resolveConversation:()=>null,currentConversation:()=>null}))
  await assert.rejects(service.call('inbox',{room:'room',agent:'Reader'}),/^Error: Native Claude registration is still pending after a busy start; it is retried on every call; retry this call in a few seconds$/)
})

test('room tools join a native session on first use, and a tab name addresses its own alias',async t=>{
  const {store,profile,own}=fixture(t)
  const service=own(createService({store,env:{},adapters,inferSession:()=>claude(profile),resolveConversation:()=>null}))
  assert.deepEqual(await service.call('inbox',{room:'fresh',agent:'Reader'}),[])
  assert.equal(store.memberships().find(row=>row.room==='fresh').joined,true)
  // The session keeps its canonical name (Reader) in every room, whatever it asks for here.
  const {agent:alias}=await service.call('join_room',{room:'joined',agent:'Builder'})
  assert.equal(alias,'Reader')
  const peer=own(createService({store,env:{},adapters,inferSession:()=>null}))
  await peer.call('join_room',{room:'joined',agent:'Peer',session:{id:'manual-peer',runtime:'manual'}})
  await peer.call('post',{room:'joined',from:'Peer',to:alias,message:'for the builder'})
  const mail=await service.call('inbox',{room:'joined',agent:'thaparo-f9'})
  assert.equal(mail.length,1)
})

test('inbox returns the oldest mail up to a size bound and says how much is left',()=>{
  const small=Array.from({length:30},(_,i)=>({message_id:String(i),message:'x'}))
  const capped=capInbox(small)
  assert.equal(capped.length,26)
  assert.deepEqual(capped.at(-1),{more:5,note:'5 more unread; call inbox again after reading these.'})
  const huge=[{message_id:'a',message:'y'.repeat(50_000)},{message_id:'b',message:'z'}]
  assert.deepEqual(capInbox(huge).map(row=>row.message_id??row.more),['a',1],'one oversize message still comes through on its own')
  assert.deepEqual(capInbox([]),[])
})

test('timeouts on a busy machine are told apart from real failures',()=>{
  assert.equal(transientError(Object.assign(Error('x'),{code:'CHAT_PRESENCE_UNAVAILABLE'})),true)
  assert.equal(transientError(Object.assign(Error('database is locked'),{code:'ERR_SQLITE_ERROR',errcode:5})),true)
  assert.equal(transientError(Object.assign(Error('state'),{code:'CHAT_STATE_DAMAGED'})),false)
  assert.equal(transientError(Error('anything else')),false)
  assert.match(BUSY,/^Agent-chat timed out because the machine is busy/)
})

test("Claude's per-process session file names the current conversation, and any doubt reads as none",t=>{
  const {root,profile}=fixture(t)
  const conversation='00000000-0000-4000-8000-000000000061',sessions=path.join(profile,'sessions')
  fs.mkdirSync(sessions,{mode:0o700})
  const socket=path.join(root,'sock');fs.writeFileSync(socket,'')
  const started='Tue Nov 10 08:07:12 2026'
  const write=(row,mode=0o600)=>{const file=path.join(sessions,'4242.json');fs.writeFileSync(file,JSON.stringify({procStart:started,...row}));fs.chmodSync(file,mode)}
  const read=(pid=4242,start=started)=>currentClaudeConversation(profile,pid,socket,start)
  write({pid:4242,sessionId:conversation,messagingSocketPath:socket})
  assert.equal(read(),conversation)
  assert.equal(read(4242,'Tue Nov 10  08:07:12  2026'),conversation,'ps pads with spaces')
  assert.equal(read(4243),null,'another process')
  assert.equal(read(4242,'Mon Nov  9 22:00:00 2026'),null,'an earlier process that had this PID')
  assert.equal(currentClaudeConversation(profile,4242,socket),null,'no start time to compare')
  write({pid:4243,sessionId:conversation})
  assert.equal(read(),null,'pid inside the file must match')
  write({pid:4242,sessionId:conversation,messagingSocketPath:path.join(root,'other')})
  assert.equal(read(),null,'another socket')
  write({pid:4242,sessionId:conversation},0o622)
  assert.equal(read(),null,'writable by others')
  write({pid:4242,sessionId:'not-a-uuid'})
  assert.equal(read(),null)
})

test('a conversation check that timed out never self-registers over what may be a good record',async t=>{
  const {store,profile,own}=fixture(t)
  const session=claude(profile)
  store.createRoom({room:'room',title:'room'})
  store.join({room:'room',agent:'Reader',session:{...session,conversationId:'00000000-0000-4000-8000-000000000071'}})
  let observed=0
  const service=own(createService({store,env:{},adapters,inferSession:()=>session,
    resolveConversation:()=>{throw Object.assign(Error('ps timed out'),{code:'CHAT_CLAUDE_LIFECYCLE_UNAVAILABLE'})},
    currentConversation:()=>'00000000-0000-4000-8000-000000000072',observeLifecycle:()=>{observed++;return null}}))
  await assert.rejects(service.call('inbox',{room:'room',agent:'Reader'}),/registration is still pending/)
  assert.equal(observed,0)
})

test("a name another session held can't be borrowed to read its receipts",async t=>{
  const {store,profile,own}=fixture(t)
  const bob=own(createService({store,env:{},adapters,inferSession:()=>null}))
  await bob.call('create_room',{room:'r',title:'r'})
  await bob.call('join_room',{room:'r',agent:'Bob',session:{id:'manual-bob',runtime:'manual'}})
  const carol=own(createService({store,env:{},adapters,inferSession:()=>null}))
  await carol.call('join_room',{room:'r',agent:'Carol',session:{id:'manual-carol',runtime:'manual'}})
  await carol.call('post',{room:'r',from:'Carol',to:'Bob',message:'for bob only'})
  await bob.call('leave_room',{room:'r',agent:'Bob'})
  const alice=own(createService({store,env:{},adapters,inferSession:()=>claude(profile),resolveConversation:()=>null}))
  await alice.call('join_room',{room:'r',agent:'Alice'})
  await assert.rejects(alice.call('delivery_status',{room:'r',agent:'Bob'}),/Not joined to this room from this tab/)
  await assert.rejects(alice.call('inbox',{room:'r',agent:'Bob'}),/Not joined to this room from this tab/)
})

test('mail the inbox cap held back can ring the tab again',async t=>{
  const {store,profile,own}=fixture(t)
  const reader=own(createService({store,env:{},adapters,inferSession:()=>claude(profile),resolveConversation:()=>null}))
  const {agent}=await reader.call('join_room',{room:'r',agent:'Reader'})
  const peer=own(createService({store,env:{},adapters:{async deliver(){return {attempted:true,status:'rung'}}},inferSession:()=>null}))
  await peer.call('join_room',{room:'r',agent:'Peer',session:{id:'manual-peer',runtime:'manual'}})
  for(let i=0;i<30;i++)await peer.call('post',{room:'r',from:'Peer',to:agent,message:`note ${i}`})
  const args={room:'r',agent}
  const first=await reader.call('inbox',args)
  assert.equal(first.at(-1).more,5)
  reader.written('inbox',args,first)
  const statuses=store.deliveryStatus({room:'r',agent}).map(row=>row.status)
  assert.equal(statuses.filter(status=>status==='delivered').length,25)
  assert.equal(statuses.filter(status=>['notified','dispatching'].includes(status)).length,0,'held-back mail must not keep blocking new rings')
  const second=await reader.call('inbox',args)
  assert.deepEqual(second.map(row=>row.message),['note 25','note 26','note 27','note 28','note 29'])
})
