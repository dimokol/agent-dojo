import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {createStore} from './store.mjs'
const A='00000000-0000-4000-8000-000000000001',B='00000000-0000-4000-8000-000000000002',C='00000000-0000-4000-8000-000000000003'
function setup(t) {
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'claude-restore-'))
  const store=createStore({root:path.join(directory,'chats'),projectRoot:directory})
  t.after(()=>fs.rmSync(directory,{recursive:true,force:true}))
  store.createRoom({room:'room',title:'Room'})
  const session={id:A,conversationId:A,runtime:'claude',profileHome:'/profile-a',endpoint:'/private/socket-a',clientPid:100,clientStart:'old birth'}
  store.join({room:'room',agent:'PM',session})
  return {store,session}
}
test('restart restores only the saved conversation and preserves unread canonical mail',t=>{
  const {store,session}=setup(t)
  const message=store.post({room:'room',from:'Sender',to:'PM',message:'Unread'})
  store.claim({room:'room',agent:'PM',sessionId:A,message_ids:[message.message_id]})
  store.deactivateSession(A)
  const next={...session,id:B,clientPid:200,clientStart:'new birth',endpoint:'/private/socket-b'}
  assert.equal(store.restoreClaude({session:next,source:'resume'},()=>false).restored.length,1)
  const receipt=store.pending({room:'room',agent:'PM',sessionId:B})[0]
  assert.equal(receipt.message_id,message.message_id);assert.equal(receipt.delivery.status,'pending')
  assert.equal(store.history({room:'room'}).length,1)
})
test('another conversation or profile cannot claim earlier memberships',t=>{
  const {store,session}=setup(t);store.deactivateSession(A)
  for(const next of [{...session,id:B,conversationId:B},{...session,id:B,profileHome:'/other-profile'}]) {
    assert.deepEqual(store.restoreClaude({session:next,source:'resume'},()=>false).restored,[])
    assert.equal(store.members({room:'room'}).length,0)
  }
})
test('a live owner and an explicit leave both prevent automatic takeover',t=>{
  const {store,session}=setup(t)
  const next={...session,id:B,clientPid:200,clientStart:'new birth'}
  assert.equal(store.restoreClaude({session:next,source:'resume'},()=>true).conflicts.length,1)
  store.leave({room:'room',agent:'PM',sessionId:A})
  assert.deepEqual(store.restoreClaude({session:next,source:'resume'},()=>false).restored,[])
})
test('clear closes old bindings and a later resume restores only their original conversation',t=>{
  const {store,session}=setup(t)
  const next={...session,conversationId:B}
  assert.equal(store.restoreClaude({session:next,source:'clear',previousConversationId:A},()=>true).restored.length,0)
  assert.equal(store.members({room:'room'}).length,0)
  const unrelated={...next,conversationId:C,clientPid:999}
  assert.deepEqual(store.restoreClaude({session:unrelated,source:'clear',previousConversationId:B},()=>false).restored,[])
  assert.equal(store.restoreClaude({session,source:'resume'},()=>true).restored.length,1)
})
test('resume returns to previously joined rooms without retaining the other conversation rooms',t=>{
  const {store,session}=setup(t)
  store.createRoom({room:'other',title:'Other'})
  store.join({room:'other',agent:'OtherPM',session:{...session,conversationId:B}})
  store.restoreClaude({session:{...session,conversationId:B},source:'resume'},()=>true)
  assert.equal(store.members({room:'room'}).length,0)
  assert.equal(store.members({room:'other'}).length,1)
  store.restoreClaude({session,source:'resume'},()=>true)
  assert.equal(store.members({room:'room'}).length,1)
  assert.equal(store.members({room:'other'}).length,0)
})
// Two accounts (CLAUDE_CONFIG_DIRs) whose projects/ point at one transcript store
// hold the same conversations, so a resume on the other account is the same session.
function profiles(t,shared=true) {
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'claude-profiles-'))
  t.after(()=>fs.rmSync(directory,{recursive:true,force:true}))
  const homes=['a','b'].map(name=>path.join(directory,'profile-'+name))
  fs.mkdirSync(path.join(directory,'shared'))
  for(const home of homes) {
    fs.mkdirSync(home)
    if(shared)fs.symlinkSync(path.join(directory,'shared'),path.join(home,'projects'))
    else fs.mkdirSync(path.join(home,'projects'))
  }
  return homes
}
function moveSetup(t,home) {
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'claude-move-'))
  t.after(()=>fs.rmSync(directory,{recursive:true,force:true}))
  const store=createStore({root:path.join(directory,'chats'),projectRoot:directory})
  store.createRoom({room:'room',title:'Room'});store.createRoom({room:'second',title:'Second'})
  const first={id:A,conversationId:A,runtime:'claude',profileHome:home,endpoint:'/private/socket-a',clientPid:100,clientStart:'old birth'}
  return {store,first}
}
test('a conversation resumed on another account with shared transcripts gets its rooms and mail back',t=>{
  const [a,b]=profiles(t)
  const {store,first}=moveSetup(t,a)
  store.join({room:'room',agent:'PM',session:first});store.join({room:'second',agent:'PM',session:first})
  const message=store.post({room:'room',from:'Sender',to:'PM',message:'Unread'})
  store.deactivateSession(A)
  const moved={...first,id:B,profileHome:b,clientPid:200,clientStart:'new birth',endpoint:'/private/socket-b'}
  const result=store.restoreClaude({session:moved,source:'resume'},()=>false)
  assert.deepEqual(result.restored.map(row=>row.room).sort(),['room','second'])
  for(const room of ['room','second']) {
    const [member]=store.members({room})
    assert.equal(member.agent,'PM');assert.equal(member.session.profileHome,b)
  }
  assert.deepEqual(store.pending({room:'room',agent:'PM',sessionId:B}).map(row=>row.message_id),[message.message_id])
})
test('switching accounts back and forth keeps the rooms each time',t=>{
  const [a,b]=profiles(t)
  const {store,first}=moveSetup(t,a)
  store.join({room:'room',agent:'PM',session:first})
  let current=first
  for(const [home,n] of [[b,2],[a,3],[b,4]]) {
    store.deactivateSession(current.id)
    current={...first,id:`00000000-0000-4000-8000-00000000000${n}`,profileHome:home,clientPid:100+n,clientStart:'birth '+n}
    assert.equal(store.restoreClaude({session:current,source:'resume'},()=>false).restored.length,1,home)
    assert.equal(store.members({room:'room'})[0].session.profileHome,home)
  }
})
test('accounts with separate transcripts keep their memberships apart',t=>{
  const [a,b]=profiles(t,false)
  const {store,first}=moveSetup(t,a)
  store.join({room:'room',agent:'PM',session:first});store.deactivateSession(A)
  assert.deepEqual(store.restoreClaude({session:{...first,id:B,profileHome:b,clientPid:200},source:'resume'},()=>false).restored,[])
  assert.equal(store.members({room:'room'}).length,0)
})
test('a move leaves a still-running tab and an explicit leave alone',t=>{
  const [a,b]=profiles(t)
  const {store,first}=moveSetup(t,a)
  store.join({room:'room',agent:'PM',session:first})
  const moved={...first,id:B,profileHome:b,clientPid:200,clientStart:'new birth'}
  assert.deepEqual(store.restoreClaude({session:moved,source:'resume'},()=>true).restored,[])
  assert.equal(store.members({room:'room'})[0].session.profileHome,a)
  store.leave({room:'room',agent:'PM',sessionId:A})
  assert.deepEqual(store.restoreClaude({session:moved,source:'resume'},()=>false).restored,[])
  assert.equal(store.members({room:'room'}).length,0)
})
test('a move joins only the rooms the session was in, mail elsewhere waits for a join',t=>{
  const [a,b]=profiles(t)
  const {store,first}=moveSetup(t,a)
  store.join({room:'room',agent:'PM',session:first})
  const elsewhere=store.post({room:'second',from:'Sender',to:'PM',message:'Elsewhere'})
  store.deactivateSession(A)
  const moved={...first,id:B,profileHome:b,clientPid:200,clientStart:'new birth'}
  assert.deepEqual(store.restoreClaude({session:moved,source:'resume'},()=>false).restored.map(r=>r.room),['room'])
  assert.equal(store.members({room:'second'}).length,0)
  store.join({room:'second',agent:'PM',session:moved})
  assert.deepEqual(store.pending({room:'second',agent:'PM',sessionId:B}).map(r=>r.message_id),[elsewhere.message_id])
})
test('a manual join takes a closed name back after it moved to another identity and back',t=>{
  const {store,first}=moveSetup(t,'/profile-a')
  store.join({room:'room',agent:'PM',session:first});store.deactivateSession(A)
  const other={...first,id:B,profileHome:'/profile-b',clientPid:200}
  store.join({room:'room',agent:'PM',session:other});store.deactivateSession(B)
  store.join({room:'room',agent:'PM',session:{...first,id:C,clientPid:300}})
  assert.equal(store.members({room:'room'})[0].session.profileHome,'/profile-a')
})
