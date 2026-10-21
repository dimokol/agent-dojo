import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createStore } from './store.mjs'
import { createService } from './server.mjs'
import { createController } from './controller.mjs'

function setup(t,adapters={deliver:async()=>({status:'accepted'})}) {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'chat-identity-service-'))
  const store=createStore({root:path.join(dir,'chats'),projectRoot:dir})
  store.createRoom({room:'room',title:'Room'})
  const service=createService({store,adapters,env:{}})
  t.after(()=>{service.close();fs.rmSync(dir,{recursive:true,force:true})})
  return {store,service}
}

test('native response receipt survives external rename before stdout callback',async t=>{
  const {store,service}=setup(t)
  await service.call('join_room',{room:'room',agent:'Reader',session:{id:'a',runtime:'manual'}})
  store.post({room:'room',from:'Writer',to:'Reader',message:'read'})
  const args={room:'room',agent:'Reader'}, rows=await service.call('inbox',args)
  const member=store.members({room:'room'})[0]
  store.renameSession({...args,sessionId:'a',participantId:member.participant_id,name:'New'})
  service.written('inbox',args,rows,100)
  await service.call('list_rooms',{},undefined,undefined,101)
  assert.equal(store.deliveryStatus({room:'room',agent:'New'})[0].status,'received')
  await service.call('post',{room:'room',from:'Reader',message:'old bound label'})
  const posted=store.history({room:'room'}).at(-1)
  assert.equal(posted.from,'New')
  assert.equal(posted.from_id,member.participant_id)
})

test('controller transport completion after rename updates the original stable receipt',async t=>{
  const {store}=setup(t)
  let release
  store.join({room:'room',agent:'Reader',session:{id:'a',runtime:'manual'}})
  store.post({room:'room',from:'Writer',to:'Reader',message:'mail'})
  const controller=createController({store,adapters:{deliver:()=>new Promise(resolve=>{release=resolve})}})
  const run=controller.dispatch('room')
  store.renameSession({room:'room',agent:'Reader',sessionId:'a',name:'New'})
  release({status:'accepted'})
  await run
  assert.equal(store.deliveryStatus({room:'room',agent:'New'})[0].status,'notified')
})

test('rename MCP operation updates all room bindings and refuses another connection',async t=>{
  const {store,service}=setup(t)
  store.createRoom({room:'other',title:'Other'})
  for(const room of ['room','other'])await service.call('join_room',{room,agent:'Reader',session:{id:'a',runtime:'manual'}})
  const renamed=await service.call('rename_session',{room:'room',agent:'Reader',name:'New'})
  assert.equal(renamed.source,'explicit')
  await service.call('post',{room:'other',from:'New',message:'new name'})
  const other=createService({store,env:{},adapters:{deliver:async()=>({status:'accepted'})}})
  try {await assert.rejects(other.call('rename_session',{room:'room',agent:'New',name:'Stolen'}),/join_room/)}finally{other.close()}
})
