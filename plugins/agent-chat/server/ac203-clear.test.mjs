// Seen live 2026-11-15 on the installed 2.0.3: after /clear the tab dropped out of its rooms
// (members said closed, new mail was held with reason closed and never rang) until the model
// called join_room again, which a freshly cleared model has no reason to do. /clear keeps the
// tab: its rooms and name move to the new conversation, and mail the earlier conversation saw
// but never confirmed comes back marked maybe_seen.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {createStore} from './store.mjs'
const A='00000000-0000-4000-8000-0000000000a1',B='00000000-0000-4000-8000-0000000000b2',C='00000000-0000-4000-8000-0000000000c3'
function setup(t) {
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'ac203-clear-'))
  const store=createStore({root:path.join(directory,'chats'),projectRoot:directory})
  t.after(()=>fs.rmSync(directory,{recursive:true,force:true}))
  store.createRoom({room:'room',title:'Room'});store.createRoom({room:'two',title:'Two'})
  const session={id:A,conversationId:A,runtime:'claude',profileHome:'/profile-a',endpoint:'/private/socket-a',clientPid:100,clientStart:'birth'}
  store.join({room:'room',agent:'PM',session});store.join({room:'two',agent:'PM',session})
  return {store,session}
}
const row=(store,room)=>store.memberships().find(m=>m.room===room&&m.agent==='PM')
test('/clear keeps the tab in its rooms under its name, on the new conversation', t => {
  const {store,session}=setup(t)
  const cleared={...session,conversationId:B}
  const {restored}=store.restoreClaude({session:cleared,source:'clear',previousConversationId:A},()=>true)
  assert.deepEqual(restored.map(r=>r.room).sort(),['room','two'])
  for(const room of ['room','two']) {
    assert.equal(row(store,room).joined,true)
    assert.equal(row(store,room).session.conversationId,B)
  }
  assert.equal(store.members({room:'room'}).length,1)
})
test('/clear: mail the earlier conversation saw but never confirmed comes back marked maybe_seen', t => {
  const {store,session}=setup(t)
  const seen=store.post({room:'room',from:'Peer',to:'PM',message:'seen before clear'})
  const unseen=store.post({room:'room',from:'Peer',to:'PM',message:'not yet seen'})
  store.claim({room:'room',agent:'PM',sessionId:A,message_ids:[seen.message_id]})
  store.updateDelivery({room:'room',agent:'PM',sessionId:A,message_ids:[seen.message_id],status:'delivered',release_claim:true})
  const cleared={...session,conversationId:B}
  store.restoreClaude({session:cleared,source:'clear',previousConversationId:A},()=>true)
  const byId=Object.fromEntries(store.pending({room:'room',agent:'PM',sessionId:A}).map(r=>[r.message_id,r.delivery]))
  assert.equal(byId[seen.message_id]?.maybe_seen,true)
  assert.equal(byId[unseen.message_id]?.status,'pending')
  assert.notEqual(byId[unseen.message_id]?.maybe_seen,true)
})
test('/clear then /resume back: the earlier conversation takes its rooms and name back', t => {
  const {store,session}=setup(t)
  const cleared={...session,conversationId:B}
  store.restoreClaude({session:cleared,source:'clear',previousConversationId:A},()=>true)
  const back=store.restoreClaude({session,source:'resume',previousConversationId:B},()=>true)
  assert.deepEqual(back.restored.map(r=>r.room).sort(),['room','two'])
  assert.equal(row(store,'room').session.conversationId,A)
  assert.equal(row(store,'room').joined,true)
})
test('/clear keeps a /name rename as a rename, so a later join_room under another name does not override it', t => {
  const {store,session}=setup(t)
  store.renameSession({room:'room',agent:'PM',sessionId:A,name:'Boss',source:'explicit'})
  store.restoreClaude({session:{...session,conversationId:B},source:'clear',previousConversationId:A},()=>true)
  const now=store.memberships().find(m=>m.room==='room'&&m.joined)
  assert.equal(now.agent,'Boss')
  assert.equal(now.session.conversationId,B)
  const joined=store.joinName({...session,conversationId:B},'Other')
  assert.equal(joined.name,'Boss')
})
test('/clear in another tab process, or a left room, moves nothing', t => {
  const {store,session}=setup(t)
  store.leave({room:'two',agent:'PM',sessionId:A})
  const other={...session,conversationId:C,clientPid:999,clientStart:'other'}
  assert.deepEqual(store.restoreClaude({session:other,source:'clear',previousConversationId:A},()=>true).restored,[])
  assert.equal(row(store,'room').session.conversationId,A)
  store.restoreClaude({session:{...session,conversationId:B},source:'clear',previousConversationId:A},()=>true)
  assert.equal(row(store,'room').joined,true)
  assert.equal(store.members({room:'two'}).length,0)
})

// Review 2026-11-15: three ways a /clear still dropped the rooms.
test('/clear right after a join made before Claude recorded the conversation keeps the rooms', t => {
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'ac203-clear-'))
  const store=createStore({root:path.join(directory,'chats'),projectRoot:directory})
  t.after(()=>fs.rmSync(directory,{recursive:true,force:true}))
  store.createRoom({room:'room',title:'Room'})
  const early={id:A,runtime:'claude',profileHome:'/profile-a',endpoint:'/private/socket-a',clientPid:100,clientStart:'birth'}
  store.join({room:'room',agent:'PM',session:early})
  store.restoreClaude({session:{...early,conversationId:B},source:'clear',previousConversationId:A},()=>true)
  assert.equal(row(store,'room').joined,true)
  assert.equal(row(store,'room').session.conversationId,B)
})
test('two quick /clears (the first one never restored) keep the rooms on the last conversation', t => {
  const {store,session}=setup(t)
  store.restoreClaude({session:{...session,conversationId:C},source:'clear',previousConversationId:B,clearedFrom:[B,A]},()=>true)
  assert.equal(row(store,'room').joined,true)
  assert.equal(row(store,'room').session.conversationId,C)
})
test('a /resume to a conversation that never chatted, then /clear: the rooms stay with the conversation resumed away from', t => {
  const {store,session}=setup(t)
  const D='00000000-0000-4000-8000-0000000000d5',E='00000000-0000-4000-8000-0000000000e6'
  store.restoreClaude({session:{...session,conversationId:D},source:'resume',previousConversationId:A},()=>true)
  assert.equal(row(store,'room').joined,false)
  // The record of a /clear after a /resume names only the resumed conversation (claude-lifecycle.mjs).
  assert.deepEqual(store.restoreClaude({session:{...session,conversationId:E},source:'clear',previousConversationId:D,clearedFrom:[D]},()=>true).restored,[])
  assert.equal(row(store,'room').joined,false)
  assert.equal(row(store,'room').session.conversationId,A)
})
test('the lifecycle record of a /clear lists where it came from, through /clears that never restored, and a /resume ends the chain', async t => {
  const {observeClaudeLifecycle}=await import('./claude-lifecycle.mjs')
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'ac203-clear-chain-')))
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}))
  const profile=path.join(root,'profile'),project=path.join(root,'project')
  fs.mkdirSync(profile,{mode:0o700});fs.mkdirSync(project,{mode:0o700})
  const parent={pid:process.pid,start:'Thu Oct 15 15:00:00 2026',trusted:true}
  const env={CLAUDE_CONFIG_DIR:profile,CLAUDE_CODE_SESSION_ID:A,CLAUDE_CODE_MESSAGING_SOCKET:'/private/test-native.sock'}
  const options={stateRoot:path.join(root,'state'),projectRoot:project,scope:()=>project,ancestors:()=>[parent],validateSocket:endpoint=>endpoint}
  const start=(source,id)=>observeClaudeLifecycle({hook_event_name:'SessionStart',source,session_id:id,cwd:project},env,options)
  const D='00000000-0000-4000-8000-0000000000d5'
  assert.deepEqual(start('startup',A).clearedFrom,[])
  assert.deepEqual(start('clear',B).clearedFrom,[A])
  assert.deepEqual(start('clear',C).clearedFrom,[B,A])
  assert.deepEqual(start('clear',C).clearedFrom,[B,A],'a retry of the same /clear keeps the chain')
  assert.deepEqual(start('resume',D).clearedFrom,[])
  assert.deepEqual(start('clear',B).clearedFrom,[D])
})
test('a /clear the server notices first (its hook failed to restore) keeps the rooms', async t => {
  const {createService}=await import('./server.mjs')
  const {processIdentity}=await import('./native-session.mjs')
  const root=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'ac203-clear-svc-'))
  const store=createStore({root:path.join(root,'chats'),stateRoot:path.join(root,'state'),projectRoot:root})
  const self=processIdentity(process.pid)
  const session={runtime:'claude',id:A,profileHome:root,clientPid:self.pid,clientStart:self.start,serverPid:self.pid,serverStart:self.start}
  let conversation=A,start={source:'startup',clearedFrom:[]}
  const service=createService({store,env:{},adapters:{async deliver(){return {status:'accepted'}}},inferSession:()=>session,
    resolveConversation:()=>conversation,lifecycleStart:()=>start})
  t.after(()=>{service.close();fs.rmSync(root,{recursive:true,force:true})})
  store.createRoom({room:'room',title:'Room'})
  await service.call('join_room',{room:'room',agent:'PM'})
  conversation=B;start={source:'clear',clearedFrom:[A]}
  await service.call('list_rooms')
  assert.equal(row(store,'room').joined,true)
  assert.equal(row(store,'room').session.conversationId,B)
})
test('a /resume the server notices first still leaves the rooms of the conversation it left', async t => {
  const {createService}=await import('./server.mjs')
  const {processIdentity}=await import('./native-session.mjs')
  const root=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'ac203-clear-svc-'))
  const store=createStore({root:path.join(root,'chats'),stateRoot:path.join(root,'state'),projectRoot:root})
  const self=processIdentity(process.pid)
  const session={runtime:'claude',id:A,profileHome:root,clientPid:self.pid,clientStart:self.start,serverPid:self.pid,serverStart:self.start}
  let conversation=A,start={source:'startup',clearedFrom:[]}
  const service=createService({store,env:{},adapters:{async deliver(){return {status:'accepted'}}},inferSession:()=>session,
    resolveConversation:()=>conversation,lifecycleStart:()=>start})
  t.after(()=>{service.close();fs.rmSync(root,{recursive:true,force:true})})
  store.createRoom({room:'room',title:'Room'})
  await service.call('join_room',{room:'room',agent:'PM'})
  conversation=B;start={source:'resume',clearedFrom:[]}
  await service.call('list_rooms')
  assert.equal(row(store,'room').joined,false)
})
test('a failed /clear start is retried as a /clear', async t => {
  const {pendingRegistrationSource}=await import('./claude-lifecycle.mjs')
  const markRegistrationRetry=(root,launch,{stage,source})=>{
    fs.mkdirSync(path.join(root,'lifecycle-failures'),{recursive:true})
    fs.writeFileSync(path.join(root,'lifecycle-failures',`pending-${launch}.json`),JSON.stringify({stage,source,at:'now',tries:0}))
  }
  const stateRoot=fs.mkdtempSync(path.join(os.tmpdir(),'ac203-clear-retry-'))
  t.after(()=>fs.rmSync(stateRoot,{recursive:true,force:true}))
  const launch='00000000-0000-4000-8000-0000000000d4'
  assert.equal(pendingRegistrationSource(stateRoot,launch),null)
  markRegistrationRetry(stateRoot,launch,{stage:'process',source:'clear'})
  assert.equal(pendingRegistrationSource(stateRoot,launch),'clear')
  markRegistrationRetry(stateRoot,launch,{stage:'process',source:'startup'})
  assert.equal(pendingRegistrationSource(stateRoot,launch),null)
})
test('a /clear the server notices late follows the record, not the conversation the server saw last', async t => {
  const {createService}=await import('./server.mjs')
  const {processIdentity}=await import('./native-session.mjs')
  const root=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'ac203-clear-svc-'))
  const store=createStore({root:path.join(root,'chats'),stateRoot:path.join(root,'state'),projectRoot:root})
  const self=processIdentity(process.pid)
  const session={runtime:'claude',id:A,profileHome:root,clientPid:self.pid,clientStart:self.start,serverPid:self.pid,serverStart:self.start}
  const Z='00000000-0000-4000-8000-0000000000f7'
  let conversation=A,start={source:'startup',clearedFrom:[]}
  const service=createService({store,env:{},adapters:{async deliver(){return {status:'accepted'}}},inferSession:()=>session,
    resolveConversation:()=>conversation,lifecycleStart:()=>start})
  t.after(()=>{service.close();fs.rmSync(root,{recursive:true,force:true})})
  store.createRoom({room:'room',title:'Room'});store.createRoom({room:'zed',title:'Zed'})
  store.join({room:'zed',agent:'Zed',session:{...session,conversationId:Z}})
  store.deactivateSession(A,{conversationId:Z},'conversation_changed')
  await service.call('join_room',{room:'room',agent:'PM'})
  // With no chat call in between: hooks /resume A to Z (Z restores Zed), then /clear Z to B, whose restore is late.
  store.restoreClaude({session:{...session,conversationId:Z},source:'resume',previousConversationId:A},()=>true)
  conversation=B;start={source:'clear',clearedFrom:[Z]}
  await service.call('list_rooms')
  const joined=store.memberships().filter(m=>m.joined).map(m=>[m.room,m.agent,m.session.conversationId])
  assert.deepEqual(joined,[['zed','Zed',B]])
})
