import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { EventEmitter } from 'node:events'
import { spawn } from 'node:child_process'
import {scheduleVerification,verificationStatus,runVerificationWorker,clearFailure,refreshVerificationAttention} from './claude-auto-verify.mjs'
// These tests cover the version gate, which the plugin ships switched off; turn it on here so a
// plain `node --test` passes too. Read at call time, so setting it after the imports is enough.
process.env.AGENT_CHAT_VERSION_CHECK = 'on'
const version='2.1.301'
function fixture(t){const root=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'ac-auto-fixture-'));fs.chmodSync(root,0o700);t.after(()=>fs.rmSync(root,{recursive:true,force:true}));return {version,stateRoot:root,cwd:root,profileHome:root}}
function scheduled(input,extra={}){let launched=0;const deps={isVerified:()=>false,spawnWorker(){launched++;const child=new EventEmitter();child.unref=()=>{};return child},...extra};const result=scheduleVerification(input,deps);return {result,launched,deps,input:{...input,attempt:JSON.parse(fs.readFileSync(result.flagPath)).attempt}}}
const proof={version,passed:true,probe:'agent-chat-inbox-v1',requestedModelTurns:2,ready:true,pong:true,receipt:'received',explicitAckCalls:0}
test('fast scheduling detaches fixed worker, records before spawn, and launches once across profiles',t=>{
 const input=fixture(t);let args,options
 const first=scheduled(input,{spawnWorker(binary,a,o){args=a;options=o;assert.equal(verificationStatus(version,input).status,'running');const child=new EventEmitter();child.unref=()=>{};return child}})
 assert.equal(first.result.status,'launched');assert.equal(options.detached,true);assert.equal(options.env.AGENT_CHAT_VERIFY_CHILD,'1');assert.equal(options.stdio,'ignore');assert.equal(args[1],'--worker')
 const second=scheduled({...input,profileHome:input.cwd});assert.equal(second.launched,0);assert.equal(second.result.status,'running')
 assert.equal(fs.statSync(first.result.flagPath).mode&0o777,0o600)
})
test('concurrent processes schedule only one durable attempt',async t=>{
 const input=fixture(t),module=new URL('./claude-auto-verify.mjs',import.meta.url).href
 const code=`import {scheduleVerification} from ${JSON.stringify(module)};import {EventEmitter} from 'node:events';const r=scheduleVerification(${JSON.stringify(input)},{isVerified:()=>false,spawnWorker(){const c=new EventEmitter();c.unref=()=>{};return c}});process.stdout.write(r.status)`
 const run=()=>new Promise((resolve,reject)=>{const child=spawn(process.execPath,['--input-type=module','-e',code]);let out='',err='';child.stderr.on('data',d=>err+=d);child.stdout.on('data',d=>out+=d);child.once('error',reject);child.once('close',c=>c===0?resolve(out):reject(Error('fixture process failed '+err)))})
 const results=await Promise.all(Array.from({length:6},run));assert.equal(results.filter(r=>r==='launched').length,1);assert.equal(results.filter(r=>r==='running').length,5)
})
test('concurrent worker calls claim once and successful proof requires durable verification',async t=>{
 const first=scheduled(fixture(t));let calls=0,observed
 const executor=async(binary,args,options)=>{calls++;observed={args,options};await new Promise(r=>setTimeout(r,15));return {stdout:'Safe notice\n'+JSON.stringify(proof,null,2)+'\n'}}
 await Promise.all([runVerificationWorker(first.input,{executor,isVerified:()=>true}),runVerificationWorker(first.input,{executor,isVerified:()=>true})])
 assert.equal(calls,1);assert.equal(verificationStatus(version,first.input).status,'already_verified');assert.deepEqual(observed.args.slice(1),['--run','--state-root',first.input.stateRoot]);assert.equal(observed.options.env.CLAUDE_CONFIG_DIR,first.input.profileHome);assert.equal(observed.options.env.AGENT_CHAT_VERIFY_CHILD,'1')
})
test('unknown stdout and rejected proof fail closed with visible private flags and no retry',async t=>{
 for(const stdout of ['unknown private stdout',JSON.stringify({...proof,version:'2.1.999'}),JSON.stringify({...proof,passed:false})]){
  const first=scheduled(fixture(t));const result=await runVerificationWorker(first.input,{executor:async()=>({stdout}),isVerified:()=>false})
  assert.equal(result.status,'failed');assert.match(result.message,/2\.1\.301/);assert.match(result.message,/Operator action/);assert.equal(fs.statSync(result.logPath).mode&0o777,0o600);assert.doesNotMatch(fs.readFileSync(result.logPath,'utf8'),/unknown private stdout/);assert.equal(scheduled(first.input).launched,0)
 }
})
test('spawn failure and crashed worker deadline remain failed without automatic retry',t=>{
 const input=fixture(t);const failed=scheduled(input,{spawnWorker(){throw Error('secret environment')}});assert.equal(failed.result.status,'failed');assert.equal(failed.result.reason,'WORKER_SPAWN_FAILED');assert.equal(scheduled(input).launched,0)
 const next=scheduled(fixture(t),{now:()=>1000});assert.equal(verificationStatus(version,{stateRoot:next.input.stateRoot,now:()=>200000}).status,'running','a retry fits inside the deadline');const expired=verificationStatus(version,{stateRoot:next.input.stateRoot,now:()=>250000});assert.equal(expired.status,'failed');assert.equal(expired.reason,'WORKER_DEADLINE_EXCEEDED');assert.equal(fs.statSync(expired.logPath).mode&0o777,0o600);assert.equal(scheduled(next.input).launched,0)
})
test('corrupt marker and corrupt allowlist fail closed and retain evidence',t=>{
 const input=fixture(t),first=scheduled(input);fs.writeFileSync(first.result.flagPath,'corrupt',{mode:0o600});assert.throws(()=>scheduleVerification(input,{isVerified:()=>false}),/operator recovery/);assert.equal(fs.readFileSync(first.result.flagPath,'utf8'),'corrupt')
 const other=fixture(t);fs.writeFileSync(path.join(other.stateRoot,'claude-versions.json'),'corrupt',{mode:0o600});assert.throws(()=>scheduleVerification(other),/operator recovery/);assert.equal(fs.existsSync(path.join(other.stateRoot,'verification','attention')),true)
})
test('verified versions and recursion guard spend no inference',t=>{
 const input=fixture(t);assert.equal(scheduleVerification(input,{isVerified:()=>true,spawnWorker(){throw Error('must not spawn')}}).status,'already_verified')
 assert.equal(scheduleVerification(input,{env:{AGENT_CHAT_VERIFY_CHILD:'1'},spawnWorker(){throw Error('must not spawn')}}).reason,'VERIFICATION_CHILD')
})

test('asynchronous worker spawn errors become durable flags with a private diagnostic log',t=>{
 const input=fixture(t);let child
 const first=scheduled(input,{spawnWorker(){child=new EventEmitter();child.unref=()=>{};return child}})
 child.emit('error',Error('must never log private arguments'))
 const status=verificationStatus(version,input);assert.equal(status.status,'failed');assert.equal(status.reason,'WORKER_SPAWN_FAILED');assert.equal(fs.statSync(status.logPath).mode&0o777,0o600);assert.doesNotMatch(fs.readFileSync(status.logPath,'utf8'),/private arguments/)
})

test('explicit clear preserves failed marker and log in private history and does not launch',async t=>{
 const first=scheduled(fixture(t));await runVerificationWorker(first.input,{executor:async()=>({stdout:'unknown'}),isVerified:()=>false})
 const previous=fs.readFileSync(first.result.flagPath,'utf8'),log=fs.readFileSync(first.result.logPath,'utf8')
 const cleared=clearFailure(version,first.input);assert.equal(cleared.status,'cleared');assert.equal(cleared.automaticRetryLaunched,false);assert.equal(fs.statSync(cleared.backup).mode&0o777,0o700)
 assert.equal(fs.readFileSync(path.join(cleared.backup,'attempt.json'),'utf8'),previous);assert.equal(fs.readFileSync(path.join(cleared.backup,'diagnostic.log'),'utf8'),log)
 assert.equal(verificationStatus(version,first.input).status,'absent');assert.equal(scheduled(first.input).result.status,'launched')
})
test('clear refuses running and corrupt records and invalid versions',t=>{
 const first=scheduled(fixture(t));assert.throws(()=>clearFailure(version,first.input),/Only a failed/);assert.equal(verificationStatus(version,first.input).status,'running')
 fs.writeFileSync(first.result.flagPath,'corrupt',{mode:0o600});assert.throws(()=>clearFailure(version,first.input),/operator recovery/);assert.equal(fs.readFileSync(first.result.flagPath,'utf8'),'corrupt')
 assert.throws(()=>clearFailure('../escape',first.input),/operator recovery/)
})
test('manual verification success hides old failure without discarding history',async t=>{
 const first=scheduled(fixture(t));await runVerificationWorker(first.input,{executor:async()=>({stdout:'unknown'}),isVerified:()=>false})
 assert.equal(verificationStatus(version,{...first.input,isVerified:()=>true}).status,'already_verified');assert.equal(JSON.parse(fs.readFileSync(first.result.flagPath)).status,'failed')
})
test('operator clear CLI handles only the selected fixture version without model calls',async t=>{
 const first=scheduled(fixture(t));await runVerificationWorker(first.input,{executor:async()=>({stdout:'unknown'}),isVerified:()=>false})
 const module=new URL('./claude-auto-verify.mjs',import.meta.url)
 const result=await new Promise((resolve,reject)=>{const child=spawn(process.execPath,[fileURLToPath(module),'--clear-failure',version,'--state-root',first.input.stateRoot]);let out='';child.stdout.on('data',d=>out+=d);child.once('error',reject);child.once('close',code=>resolve({code,out}))})
 assert.equal(result.code,0);assert.equal(JSON.parse(result.out).status,'cleared');assert.equal(verificationStatus(version,first.input).status,'absent')
})

test('attention sentinel survives overlapping versions and clears only after the last failed attempt is cleared',async t=>{
 const input=fixture(t),first=scheduled(input),other=scheduled({...input,version:'2.1.302'}),attention=path.join(input.stateRoot,'verification','attention')
 assert.equal(fs.statSync(attention).mode&0o777,0o600)
 await runVerificationWorker(first.input,{executor:async()=>({stdout:JSON.stringify(proof)}),isVerified:v=>v===version})
 assert.equal(fs.existsSync(attention),true)
 await runVerificationWorker(other.input,{executor:async()=>({stdout:'unknown'}),isVerified:v=>v===version})
 assert.equal(fs.existsSync(attention),true);clearFailure('2.1.302',input);assert.equal(fs.existsSync(attention),false)
})
test('manual verified stale failures remove attention while corrupt records preserve it',async t=>{
 const first=scheduled(fixture(t)),attention=path.join(first.input.stateRoot,'verification','attention')
 await runVerificationWorker(first.input,{executor:async()=>({stdout:'unknown'}),isVerified:()=>false})
 assert.equal(verificationStatus(version,{...first.input,isVerified:()=>true}).status,'already_verified');assert.equal(fs.existsSync(attention),false)
 fs.writeFileSync(first.result.flagPath,'corrupt',{mode:0o600});assert.equal(refreshVerificationAttention({...first.input,isVerified:()=>true}),true);assert.equal(fs.existsSync(attention),true)
})
const failedRun=(stage,code)=>Object.assign(Error('exit 1'),{code:1,stdout:'Safe notice\n'+JSON.stringify({version,passed:false,failure:{stage,code}},null,2)+'\n'})
test('a timeout under load gets exactly one retry after a pause, and the log names the stage and code',async t=>{
 const first=scheduled(fixture(t));let calls=0;const pauses=[];let verified=false
 const executor=async()=>{calls++;if(calls===1)throw failedRun('native_initial_ready','VERIFICATION_TIMEOUT');verified=true;return {stdout:JSON.stringify(proof,null,2)}}
 const result=await runVerificationWorker(first.input,{executor,isVerified:()=>verified,pause:async ms=>{pauses.push(ms)}})
 assert.equal(calls,2);assert.deepEqual(pauses,[60_000]);assert.equal(result.status,'already_verified')
 assert.deepEqual(JSON.parse(fs.readFileSync(result.logPath,'utf8')).runs,2)
 const again=scheduled(fixture(t));let tries=0
 const stuck=await runVerificationWorker(again.input,{executor:async()=>{tries++;throw failedRun('native_initial_ready','VERIFICATION_TIMEOUT')},isVerified:()=>false,pause:async()=>{}})
 assert.equal(tries,2);assert.equal(stuck.status,'failed')
 const log=JSON.parse(fs.readFileSync(stuck.logPath,'utf8'))
 assert.deepEqual([log.reason,log.failure,log.runs],['VERIFIER_FAILED',{stage:'native_initial_ready',code:'VERIFICATION_TIMEOUT'},2])
})
test('a failure that is not about load is not retried, and free text never reaches the log',async t=>{
 const first=scheduled(fixture(t));let calls=0
 const executor=async()=>{calls++;throw Object.assign(failedRun('native_initial_ready','NATIVE_LOGIN_REQUIRED'),{stdout:'secret token text\n'+JSON.stringify({failure:{stage:'native_initial_ready',code:'NATIVE_LOGIN_REQUIRED'}},null,2)})}
 const result=await runVerificationWorker(first.input,{executor,isVerified:()=>false,pause:async()=>{throw Error('no pause expected')}})
 assert.equal(calls,1);assert.equal(result.status,'failed')
 const log=fs.readFileSync(result.logPath,'utf8')
 assert.deepEqual(JSON.parse(log).failure,{stage:'native_initial_ready',code:'NATIVE_LOGIN_REQUIRED'});assert.doesNotMatch(log,/secret/)
 const odd=scheduled(fixture(t))
 const free=await runVerificationWorker(odd.input,{executor:async()=>{throw Object.assign(Error('x'),{stdout:JSON.stringify({failure:{stage:'Has spaces',code:'leak me'}})})},isVerified:()=>false,pause:async()=>{}})
 assert.equal(JSON.parse(fs.readFileSync(free.logPath,'utf8')).failure,null)
})
