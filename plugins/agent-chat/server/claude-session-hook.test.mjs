import test from 'node:test'
import { distribution } from './distribution.mjs'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {execFileSync} from 'node:child_process'
import {fileURLToPath} from 'node:url'
import {claudeFailureFlags} from './claude-failure-flags.mjs'
import {verificationNotice} from './claude-session-hook.mjs'
test('a version lookup failure after spawning reports queued registration accurately',()=>{
 const messages=verificationNotice(()=>{throw Error('installation moved')})
 assert.equal(messages.length,1)
 assert.match(messages[0],/registration is queued/)
 assert.doesNotMatch(messages[0],/registration is unavailable|checking Claude/)
 assert.deepEqual(verificationNotice(()=> '2.1.301',()=>true),[])
})
const script=fileURLToPath(new URL('./claude-session-hook.mjs',import.meta.url))
function fixture(t) {
  const stateRoot=fs.mkdtempSync(path.join(os.tmpdir(),'hook-entry-'))
  t.after(()=>fs.rmSync(stateRoot,{recursive:true,force:true}))
  return stateRoot
}
test('verification children skip both lifecycle registration and another verifier before any state write',t=>{
  const stateRoot=path.join(fixture(t),'absent')
  const result=execFileSync(process.execPath,[script],{input:'{invalid hook data',env:{...process.env,AGENT_CHAT_VERIFY_CHILD:'1',AGENT_CHAT_STATE_ROOT:stateRoot},encoding:'utf8',timeout:1500})
  assert.equal(result,'');assert.equal(fs.existsSync(stateRoot),false)
})
test('a background failure appears at the next prompt with exact version and private log path',t=>{
  const stateRoot=fixture(t),directory=path.join(stateRoot,'verification')
  fs.mkdirSync(directory,{mode:0o700})
  fs.writeFileSync(path.join(directory,'2.1.999.json'),JSON.stringify({schema:1,version:'2.1.999',status:'failed',reason:'VERIFIER_FAILED',attempt:'fixture',startedAt:1,deadlineAt:2}),{mode:0o600})
  const stdout=execFileSync(process.execPath,[script,'--flags'],{env:{...process.env,AGENT_CHAT_STATE_ROOT:stateRoot,AGENT_CHAT_VERIFY_CHILD:''},encoding:'utf8',timeout:1500})
  const message=JSON.parse(stdout)
  assert.equal(message.hookSpecificOutput.hookEventName,'UserPromptSubmit')
  assert.match(message.systemMessage,/Claude 2.1.999 automatic verification failed/)
  assert.ok(message.systemMessage.includes(path.join(directory,'2.1.999.log')))
  assert.equal(claudeFailureFlags(stateRoot).length,1)
})
test('damaged flag contents are never echoed and cannot make startup fail',t=>{
  const stateRoot=fixture(t),directory=path.join(stateRoot,'verification')
  fs.mkdirSync(directory,{mode:0o700})
  fs.writeFileSync(path.join(directory,'2.1.999.json'),'{secret-fixture-do-not-echo',{mode:0o600})
  const stdout=execFileSync(process.execPath,[script,'--flags'],{env:{...process.env,AGENT_CHAT_STATE_ROOT:stateRoot,AGENT_CHAT_VERIFY_CHILD:''},encoding:'utf8',timeout:1500})
  assert.match(stdout,/operator review/);assert.doesNotMatch(stdout,/secret-fixture/)
})

test('a corrupt allowlist remains visible even before any version attempt exists',t=>{
 const stateRoot=fixture(t),directory=path.join(stateRoot,'verification')
 fs.mkdirSync(directory,{mode:0o700})
 fs.writeFileSync(path.join(directory,'attention'),'pending',{mode:0o600})
 fs.writeFileSync(path.join(stateRoot,'claude-versions.json'),'{secret-fixture-do-not-echo',{mode:0o600})
 const stdout=execFileSync(process.execPath,[script,'--flags'],{env:{...process.env,AGENT_CHAT_STATE_ROOT:stateRoot,AGENT_CHAT_VERIFY_CHILD:''},encoding:'utf8',timeout:1500})
 assert.match(stdout,/operator review/)
 assert.doesNotMatch(stdout,/secret-fixture/)
 assert.equal(claudeFailureFlags(stateRoot).length,1)
})

// Package D: notices, fork and compact.
import {sessionStartPlan,registerWithRetry,registrationFailureLine} from './claude-session-hook.mjs'
import {projectNoticeId,noticeDirectory} from './notices.mjs'
import {claudeParticipantId} from './notice-files.mjs'
import {createStore} from './store.mjs'
// These tests cover the version gate, which the plugin ships switched off; turn it on here so a
// plain `node --test` passes too. Read at call time, so setting it after the imports is enough.
process.env.AGENT_CHAT_VERSION_CHECK = 'on'
const CONVERSATION='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',OTHER='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
function noticeFixture(t){
  const dir=fs.realpathSync(fixture(t)),stateRoot=path.join(dir,'state'),chats=path.join(dir,'chats'),project=path.join(dir,'project'),profile=path.join(dir,'profile')
  for(const directory of [stateRoot,project,profile])fs.mkdirSync(directory,{mode:0o700})
  fs.mkdirSync(noticeDirectory(stateRoot),{mode:0o700})
  // A suite run inside Claude Code must not pass its live session to the hook:
  // registration would succeed against the real CLI and launch a verifier.
  const inherited=Object.fromEntries(Object.entries(process.env).filter(([name])=>!name.startsWith('CLAUDE_CODE_')))
  const env={...inherited,AGENT_CHAT_STATE_ROOT:stateRoot,AGENT_CHAT_ROOT:chats,CLAUDE_CONFIG_DIR:profile,AGENT_CHAT_VERIFY_CHILD:''}
  const run=(args,input,extra={})=>execFileSync(process.execPath,[script,...args],{input:typeof input==='string'?input:JSON.stringify(input),env:{...env,...extra},encoding:'utf8',timeout:5000})
  return {dir,stateRoot,chats,project,profile,run}
}
const start=(f,source)=>({session_id:CONVERSATION,source,hook_event_name:'SessionStart',cwd:f.project})
test('startup prints the project orphan line once; resume, clear and fork do not',t=>{
  const f=noticeFixture(t),oldest=new Date(Date.now()-50*3600000).toISOString()
  fs.writeFileSync(path.join(noticeDirectory(f.stateRoot),`project-${projectNoticeId(f.chats,f.project)}.orphans`),JSON.stringify({schema:1,count:3,oldest_at:oldest}),{mode:0o600})
  const startup=JSON.parse(f.run([],start(f,'startup')))
  assert.equal(startup.hookSpecificOutput.hookEventName,'SessionStart')
  assert.equal(startup.systemMessage.split('\n').filter(line=>line.startsWith('agent-chat:')).join('\n'),`agent-chat: 3 unread messages to closed sessions, oldest 2d; to review, run ${distribution.unreadCommand} or ask the agent to call agent-chat's unread tool`)
  for(const source of ['resume','clear','fork'])assert.doesNotMatch(f.run([],start(f,source)),/closed sessions/)
})
test('compact keeps the conversation: no restore, registration task or version notice',t=>{
  const f=noticeFixture(t)
  assert.equal(f.run([],start(f,'compact')),'{}')
  for(const directory of ['hook-tasks','lifecycle'])assert.equal(fs.existsSync(path.join(f.stateRoot,directory)),false)
})
test('fork follows the /clear rule: new conversation, no rooms inherited',t=>{
  assert.deepEqual(sessionStartPlan({source:'startup'}),{source:'startup',restore:true,orphans:true})
  assert.deepEqual(sessionStartPlan({source:'fork'}),{source:'fork',restore:true,orphans:false},'the lifecycle records fork itself')
  assert.deepEqual(sessionStartPlan({source:'compact'}),{source:'compact',restore:false,orphans:false})
  const f=noticeFixture(t),store=createStore({root:f.chats,projectRoot:f.project,stateRoot:f.stateRoot})
  store.createRoom({room:'setup',title:'setup'})
  const client={runtime:'claude',id:'11111111-1111-4111-8111-111111111111',profileHome:f.profile,clientPid:4242,clientStart:'fixture',endpoint:'/fixture/socket'}
  store.join({room:'setup',agent:'Original',session:{...client,conversationId:CONVERSATION}})
  const plan=sessionStartPlan({source:'fork'})
  const result=store.restoreClaude({session:{...client,conversationId:OTHER,lifecycle:true},source:plan.source,previousConversationId:CONVERSATION},()=>true)
  assert.deepEqual(result.restored,[])
  assert.deepEqual(store.memberships().map(row=>[row.agent,row.joined,row.left_reason]),[['Original',false,'conversation_changed']])
})
test('the prompt path prints this session\'s unread line only when its notice exists',t=>{
  const f=noticeFixture(t),file=path.join(noticeDirectory(f.stateRoot),claudeParticipantId(f.profile,CONVERSATION)+'.unread')
  const prompt=session_id=>({session_id,hook_event_name:'UserPromptSubmit',prompt:'hello',cwd:f.project})
  assert.equal(f.run(['--flags'],prompt(CONVERSATION)),'{}')
  fs.writeFileSync(file,JSON.stringify({schema:1,rooms:[{room:'setup',count:2}]}),{mode:0o600})
  const message=JSON.parse(f.run(['--flags'],prompt(CONVERSATION)))
  assert.equal(message.hookSpecificOutput.hookEventName,'UserPromptSubmit')
  assert.equal(message.systemMessage,'agent-chat: 2 unread in setup')
  assert.equal(message.hookSpecificOutput.additionalContext,'agent-chat: 2 unread in setup')
  assert.equal(f.run(['--flags'],prompt(OTHER)),'{}','another conversation in the same launch sees nothing')
  assert.equal(f.run(['--flags'],JSON.stringify(prompt(CONVERSATION)).replace('hello','x'.repeat(2*1024*1024))),'{}','oversized input skips the notice, never fails')
})

test('the version notice says checking only while a check is absent or running',()=>{
  const notice=status=>verificationNotice(()=>'2.1.301',()=>false,()=>status)
  for(const status of ['absent','running'])assert.match(notice(status).join('\n'),/checking Claude 2\.1\.301 once in the background/)
  assert.deepEqual(notice('failed'),[],'a failed check is reported by the failure line, never as still checking')
  assert.match(verificationNotice(()=>'2.1.301',()=>false,()=>{throw Error('state unavailable')}).join('\n'),/version check is unavailable/)
})
const LAUNCH='11111111-1111-4111-8111-111111111111',LAUNCH2='22222222-2222-4222-8222-222222222222',LAUNCH3='33333333-3333-4333-8333-333333333333'
test('the failure line shows once per session; another session or a new failure shows it again, and the flag stays for delivery_status',t=>{
  const f=noticeFixture(t),directory=path.join(f.stateRoot,'verification')
  fs.mkdirSync(directory,{mode:0o700});fs.writeFileSync(path.join(directory,'attention'),'pending',{mode:0o600})
  const fail=version=>fs.writeFileSync(path.join(directory,version+'.json'),JSON.stringify({schema:1,version,status:'failed',reason:'VERIFIER_FAILED',attempt:'fixture',startedAt:1,deadlineAt:2}),{mode:0o600})
  const prompt=launch=>f.run(['--flags'],{session_id:CONVERSATION,hook_event_name:'UserPromptSubmit',prompt:'hi',cwd:f.project},{CLAUDE_CODE_SESSION_ID:launch})
  fail('2.1.999')
  assert.match(prompt(LAUNCH),/Claude 2\.1\.999 automatic verification failed/)
  assert.equal(prompt(LAUNCH),'{}','later prompts in the same session stay quiet')
  assert.match(prompt(LAUNCH2),/2\.1\.999/,'another session sees it once')
  fail('2.1.998')
  assert.match(prompt(LAUNCH),/2\.1\.998/,'a new failure shows again')
  assert.match(f.run([],start(f,'startup'),{CLAUDE_CODE_SESSION_ID:LAUNCH3}),/2\.1\.999/)
  assert.equal(prompt(LAUNCH3),'{}','startup already showed it to this session')
  assert.equal(claudeFailureFlags(f.stateRoot).length,2,'delivery_status still lists every failure')
  for(const name of fs.readdirSync(path.join(f.stateRoot,'shown')))assert.equal(fs.statSync(path.join(f.stateRoot,'shown',name)).mode&0o777,0o600)
})
test('a second startup the same day stays quiet about orphan mail',t=>{
  const f=noticeFixture(t),oldest=new Date(Date.now()-50*3600000).toISOString()
  const flag=path.join(noticeDirectory(f.stateRoot),`project-${projectNoticeId(f.chats,f.project)}.orphans`)
  fs.writeFileSync(flag,JSON.stringify({schema:1,count:3,oldest_at:oldest}),{mode:0o600})
  assert.match(f.run([],start(f,'startup')),/3 unread messages to closed sessions/)
  assert.doesNotMatch(f.run([],start(f,'startup')),/closed sessions/)
  assert.ok(fs.existsSync(flag),'the flag stays; /unread still lists everything')
})

test('a failed registration says which step failed and records it for diagnosis',t=>{
  const f=noticeFixture(t)
  const out=JSON.parse(f.run([],start(f,'startup')))
  // Under a native Claude Code the fixture fails at its fake socket; with none above it (CI), at the install check.
  assert.match(out.systemMessage,/Agent-chat could not register this tab: (this tab's messaging socket failed its safety check|the process check \(ps, lsof\) failed or timed out)\. Rooms joined before this start need join_room again; their mail is kept\.|^Agent-chat needs the native Claude Code install/)
  const record=JSON.parse(fs.readFileSync(path.join(f.stateRoot,'lifecycle-failures','latest.json'),'utf8'))
  assert.ok(['socket','process','install'].includes(record.stage))
  assert.equal(fs.statSync(path.join(f.stateRoot,'lifecycle-failures','latest.json')).mode&0o777,0o600)
})
test('registration retries once after a short pause, then reports the failure',async()=>{
  let calls=0
  assert.equal(await registerWithRetry(()=>{if(++calls===1)throw Error('busy');return 'ok'},{delayMs:1,started:performance.now()}),'ok')
  assert.equal(calls,2)
  calls=0
  await assert.rejects(registerWithRetry(()=>{calls++;throw Error('down')},{delayMs:1,started:performance.now()}),/down/)
  assert.equal(calls,2)
})

test('an unsupported Claude install is named plainly, without the rejoin advice',()=>{
  assert.match(registrationFailureLine('install'),/^Agent-chat needs the native Claude Code install \(~\/\.local\/bin\/claude\); this one can't be registered or woken\./)
  assert.doesNotMatch(registrationFailureLine('install'),/join_room/)
})
