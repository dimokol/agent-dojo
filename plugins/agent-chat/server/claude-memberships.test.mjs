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
