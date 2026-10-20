import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {createService} from './server.mjs'
import {createStore} from './store.mjs'

test('inbox as the last receiver call allows new mail to ring before a received receipt',async t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'agent-chat-last-inbox-'))
 const store=createStore({root:path.join(root,'chats'),stateRoot:path.join(root,'state'),projectRoot:root})
 const calls=[],adapters={async deliver(input){calls.push(input);return {status:'accepted'}}}
 const sender=createService({store,adapters,env:{}}),receiver=createService({store,adapters,env:{}})
 t.after(()=>{sender.close();receiver.close();fs.rmSync(root,{recursive:true,force:true})})
 await sender.call('create_room',{room:'room',title:'Inbox regression'})
 for(const [service,agent] of [[sender,'Sender'],[receiver,'Receiver']])await service.call('join_room',{room:'room',agent,session:{id:agent,runtime:'manual'}})
 const first=await sender.call('post',{room:'room',from:'Sender',to:'Receiver',message:'first'})
 const args={room:'room',agent:'Receiver'},inbox=await receiver.call('inbox',args)
 receiver.written('inbox',args,inbox)
 assert.equal(store.assertMember('room','Receiver','Receiver').deliveries[first.message_id].status,'delivered')
 calls.length=0
 const second=await sender.call('post',{room:'room',from:'Sender',to:'Receiver',message:'second'})
 assert.equal(calls.length,1,'new mail must ring without another receiver call')
 assert.deepEqual(calls[0].messages.map(message=>message.id),[second.message_id])
 assert.equal(store.assertMember('room','Receiver','Receiver').deliveries[first.message_id].status,'delivered')
})
