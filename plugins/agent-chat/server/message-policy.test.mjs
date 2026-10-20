import test from 'node:test'
import assert from 'node:assert/strict'
import {postPolicy,shouldWake,readState} from './message-policy.mjs'
test('direct and broadcast wake defaults and explicit overrides are durable semantics',()=>{
 for(const [to,options,wake] of [['Reviewer',{},true],['Reviewer',{fyi:true},false],['all',{},false],['everyone',{urgent:true},true],['*',{},false],['ALL',{urgent:true},true]]){
  const policy=postPolicy({to,...options})
  assert.equal(shouldWake({to,...policy}),wake)
  assert.equal(shouldWake(JSON.parse(JSON.stringify({to,...policy}))),wake)
 }
 assert.deepEqual(postPolicy({to:'Reviewer',fyi:false}),{})
 assert.deepEqual(postPolicy({to:'all',urgent:false}),{})
})
test('invalid or contradictory wake controls fail instead of changing their meaning',()=>{
 for(const input of [{to:'Reviewer',urgent:true},{to:'all',fyi:true},{to:'all',fyi:true,urgent:true},{to:'Reviewer',fyi:'true'},{to:'all',urgent:1}])assert.throws(()=>postPolicy(input),/invalid/)
})
test('returned inbox content is delivered, not unread, without treating it as handled',()=>{
 for(const status of ['pending','dispatching','notified','failed',undefined])assert.equal(readState(status),'unread')
 assert.equal(readState('delivered'),'delivered')
 for(const status of ['acked','received'])assert.equal(readState(status),'received')
 assert.equal(readState('handled'),'handled')
})
