import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {createService} from './server.mjs'
import {createStore} from './store.mjs'
import {processIdentity} from './native-session.mjs'
import {observeClaudeLifecycle,resolveClaudeConversation} from './claude-lifecycle.mjs'

test('lost lifecycle resolution cannot rejoin an old conversation through its launch identity',async t=>{
 const root=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'agent-chat-life-service-'))
 const store=createStore({root:path.join(root,'chats'),stateRoot:path.join(root,'state'),projectRoot:root})
 const self=processIdentity(process.pid)
 const launch='00000000-0000-4000-8000-000000000001',old='00000000-0000-4000-8000-000000000002',fresh='00000000-0000-4000-8000-000000000003'
 const session={runtime:'claude',id:launch,profileHome:root,clientPid:self.pid,clientStart:self.start,serverPid:self.pid,serverStart:self.start}
 let conversation=old
 const service=createService({store,env:{},adapters:{async deliver(){return {status:'accepted'}}},inferSession:()=>session,resolveConversation:()=>conversation})
 t.after(()=>{service.close();fs.rmSync(root,{recursive:true,force:true})})
 store.createRoom({room:'room',title:'Owned room'})
 await service.call('join_room',{room:'room',agent:'Reader'})
 store.restoreClaude({session:{...session,conversationId:fresh},source:'clear',previousConversationId:old},()=>true)
 assert.equal(store.memberships()[0].left_reason,'conversation_changed')
 conversation=null
 await assert.rejects(service.call('inbox',{room:'room',agent:'Reader'}),/conversation is unavailable/)
 await assert.rejects(service.call('post',{room:'room',from:'Reader',message:'must not post as the old conversation'}),/conversation is unavailable/)
 assert.equal(store.memberships()[0].joined,false)
 assert.equal(store.memberships()[0].session.conversationId,old)
 assert.deepEqual(store.history({room:'room'}),[])
})

test('clear cannot inherit a legacy alias that has only a launch identity',async t=>{
 const root=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'agent-chat-legacy-clear-'))
 const store=createStore({root:path.join(root,'chats'),stateRoot:path.join(root,'state'),projectRoot:root})
 const self=processIdentity(process.pid)
 const launch='00000000-0000-4000-8000-000000000001',fresh='00000000-0000-4000-8000-000000000003'
 const session={runtime:'claude',id:launch,profileHome:root,clientPid:self.pid,clientStart:self.start,serverPid:self.pid,serverStart:self.start}
 const service=createService({store,env:{},adapters:{async deliver(){return {status:'accepted'}}},inferSession:()=>session,resolveConversation:()=>fresh})
 t.after(()=>{service.close();fs.rmSync(root,{recursive:true,force:true})})
 store.createRoom({room:'room',title:'Legacy room'})
 store.join({room:'room',agent:'LegacyReader',session})
 store.restoreClaude({session:{...session,conversationId:fresh},source:'clear',previousConversationId:launch},()=>true)
 assert.equal(store.memberships()[0].left_reason,'conversation_changed')
 await service.call('list_rooms')
 assert.equal(store.memberships()[0].joined,false)
 await assert.rejects(service.call('inbox',{room:'room',agent:'LegacyReader'}),/join_room/)
})

// Seen live 2026-10-19: a resumed tab's MCP server is spawned with a fresh
// launch id while its hooks see the resumed conversation id, so inbox and
// join_room failed until the lifecycle record stopped requiring the ids to match.
test('a resumed tab reads its mail although its MCP server was spawned with another launch id',async t=>{
 const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'agent-chat-resume-launch-')))
 const profile=path.join(root,'profile');fs.mkdirSync(profile,{mode:0o700})
 const store=createStore({root:path.join(root,'chats'),stateRoot:path.join(root,'state'),projectRoot:root})
 const self=processIdentity(process.pid),parent={pid:self.pid,start:self.start,trusted:true}
 const launch='00000000-0000-4000-8000-000000000011',resumed='00000000-0000-4000-8000-000000000012',endpoint='/private/agent-chat-test.sock'
 const facts={ancestors:()=>[parent],validateSocket:value=>value}
 store.createRoom({room:'room',title:'Resume room'})
 store.join({room:'room',agent:'Reader',session:{runtime:'claude',id:resumed,conversationId:resumed,profileHome:profile,endpoint:'/private/old.sock',clientPid:1,clientStart:'earlier process'}})
 store.deactivateSession(resumed)
 const writer={runtime:'manual',id:'writer'}
 store.join({room:'room',agent:'Writer',session:writer})
 store.post({room:'room',from:'Writer',to:'Reader',message:'sent while the tab was closed',sessionId:'writer'})
 const observation=observeClaudeLifecycle({hook_event_name:'SessionStart',source:'resume',session_id:resumed,cwd:root},
  {CLAUDE_CONFIG_DIR:profile,CLAUDE_CODE_SESSION_ID:resumed,CLAUDE_CODE_MESSAGING_SOCKET:endpoint},{stateRoot:store.stateRoot,projectRoot:root,scope:()=>root,...facts})
 store.restoreClaude(observation,()=>false)
 const session={runtime:'claude',id:launch,profileHome:profile,endpoint,clientPid:self.pid,clientStart:self.start,serverPid:self.pid,serverStart:self.start}
 const service=createService({store,env:{},adapters:{async deliver(){return {attempted:false,status:'pending'}}},inferSession:()=>session,
  resolveConversation:(value,options)=>resolveClaudeConversation(value,{...options,...facts})})
 t.after(()=>{service.close();fs.rmSync(root,{recursive:true,force:true})})
 const inbox=await service.call('inbox',{room:'room',agent:'Reader'})
 assert.deepEqual(inbox.map(item=>item.message),['sent while the tab was closed'])
 assert.equal(store.memberships().find(row=>row.agent==='Reader').session.id,launch)
})

test('delivery_status tells an unregistered Claude tab that a restart will not restore its rooms',async t=>{
 const root=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'agent-chat-unregistered-'))
 const store=createStore({root:path.join(root,'chats'),stateRoot:path.join(root,'state'),projectRoot:root})
 const self=processIdentity(process.pid)
 const session={runtime:'claude',id:'00000000-0000-4000-8000-000000000021',profileHome:root,clientPid:self.pid,clientStart:self.start,serverPid:self.pid,serverStart:self.start}
 let conversation=null
 const service=createService({store,env:{},adapters:{async deliver(){return {attempted:false,status:'pending'}}},inferSession:()=>session,resolveConversation:()=>conversation,claudeVerified:()=>true})
 t.after(()=>{service.close();fs.rmSync(root,{recursive:true,force:true})})
 store.createRoom({room:'room',title:'Unregistered room'})
 await service.call('join_room',{room:'room',agent:'Fresh'})
 const rows=await service.call('delivery_status',{room:'room',agent:'Fresh'})
 assert.deepEqual(rows.map(row=>row.status),['not_registered'])
 assert.match(rows[0].reason,/no restart registration/)
})
