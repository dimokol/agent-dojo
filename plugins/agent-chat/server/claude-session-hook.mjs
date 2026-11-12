#!/usr/bin/env node
import './runtime.mjs'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { observeClaudeLifecycle, resolveClaudeConversation, lifecycleProjectRoot, pruneClaudeLifecycle, clearRegistrationRetry } from './claude-lifecycle.mjs'
import { unseenFailureFlags } from './claude-failure-flags.mjs'
import { createStore, defaultChatRoot } from './store.mjs'
import { createAdapters, validateSession } from './adapters.mjs'
import { createController } from './controller.mjs'
import { isProcessLive } from './native-session.mjs'
import { scheduleVerification, verificationStatus } from './claude-auto-verify.mjs'
import { isVerifiedVersion, installedClaudeVersion } from './claude-versions.mjs'
import { ensureDirectory, safeFile, atomicJson, unsafeFolderLine } from './store-files.mjs'
import { projectNoticeId, dailyOrphanLine, sessionUnreadLine, noticeDirectory } from './notices.mjs'
import { claudeProfileHome, UUID, pruneHousekeeping, readShown, recordShown } from './notice-files.mjs'

const SCRIPT=fileURLToPath(import.meta.url)
const stateRoot=process.env.AGENT_CHAT_STATE_ROOT || path.join(os.homedir(),'.local/state/agent-chat')
const chatRoot=process.env.AGENT_CHAT_ROOT || defaultChatRoot()
const context=messages=>messages.length?{systemMessage:messages.join('\n'),hookSpecificOutput:{hookEventName:process.argv.includes('--flags')?'UserPromptSubmit':'SessionStart',additionalContext:messages.join('\n')}}:{}
const currentVersion=()=>installedClaudeVersion()
// What failed, in words the user and the model can act on. Never error text.
const failedStep={input:'the start-up details were incomplete',project:'the project check (git) failed or timed out',
  profile:'the Claude profile folder failed its safety check',process:'the process check (ps, lsof) failed or timed out',
  socket:"this tab's messaging socket failed its safety check",record:'the registration file could not be written',restore:'restoring its rooms failed'}
export function registrationFailureLine(stage,source) {
  if(stage==='install')return 'Agent-chat needs the native Claude Code install (~/.local/bin/claude); this one can\'t be registered or woken. Claude startup continues; existing permissions are unchanged.'
  // After /clear the tab's record still names the earlier conversation, so its rooms keep ringing
  // here until the tab restarts. A fork (--fork-session) is a new process with no earlier record.
  const rooms=source==='clear'
    ?'Until it registers (at the next prompt or agent-chat call), agent-chat still treats this tab as the conversation before /clear, and that conversation\'s rooms keep ringing here.'
    :'It tries again at the next prompt, and any agent-chat call registers it too; mail is kept.'
  return `Agent-chat could not register this tab: ${failedStep[stage]??'an unexpected error'}. ${rooms} Claude startup continues; existing permissions are unchanged.`
}
function shownToday(name,now=Date.now()) {
  const last=Date.parse(readShown(stateRoot,name)?.trim())
  if(last<=now&&now-last<86_400_000)return true
  recordShown(stateRoot,name,new Date(now).toISOString()+'\n');return false
}
// The latest failure, and every failure in history.jsonl: a burst of restored tabs used to leave
// one record. A later success leaves them: they are dated.
function recordFailure(stage,source) {
  try {
    const directory=path.join(stateRoot,'lifecycle-failures');ensureDirectory(directory)
    const row={message:registrationFailureLine(stage,source),stage:failedStep[stage]||stage==='install'?stage:'unexpected',source:source??null,at:new Date().toISOString(),
      ...(UUID.test(process.env.CLAUDE_CODE_SESSION_ID??'')?{launch:process.env.CLAUDE_CODE_SESSION_ID}:{})}
    atomicJson(path.join(directory,'latest.json'),row)
    const history=path.join(directory,'history.jsonl')
    try {if(fs.statSync(history).size>131_072)fs.renameSync(history,history+'.1')}catch{}
    fs.appendFileSync(history,JSON.stringify(row)+'\n',{mode:0o600})
  }catch{}
}
// A tab whose registration failed is retried at its next prompt. The prompt hook runs only behind a
// gate file, so the failure leaves one for this launch; success removes both.
const retryFiles=launch=>({marker:path.join(stateRoot,'lifecycle-failures',`pending-${launch}.json`),gate:path.join(noticeDirectory(stateRoot),`session-${launch}.registration.gate`)})
function markForRetry(stage) {
  const launch=process.env.CLAUDE_CODE_SESSION_ID
  if(!UUID.test(launch??'')||stage==='install'||stage==='input')return
  try {
    const {marker,gate}=retryFiles(launch)
    ensureDirectory(path.dirname(marker));ensureDirectory(path.dirname(gate))
    atomicJson(marker,{stage,at:new Date().toISOString(),tries:0})
    fs.writeFileSync(gate,'',{mode:0o600})
  }catch{}
}
const clearRetry=launch=>clearRegistrationRetry(stateRoot,launch)
// "Checking" is true only before or during the one attempt; a failed attempt
// is reported by the failure line and never retried automatically.
export function verificationNotice(getVersion=currentVersion,verified=version=>isVerifiedVersion(version,{stateRoot}),status=version=>verificationStatus(version,{stateRoot}).status) {
  try {
    const version=getVersion()
    if(verified(version)||!['absent','running'].includes(status(version)))return []
    return [`Agent-chat is checking Claude ${version} once in the background. Failures appear under ${path.join(stateRoot,'verification')} and at the next prompt.`]
  }catch {return ['Agent-chat registration is queued. The Claude version check is unavailable; review automatic verification separately.']}
}
// A tab reopened under another account can start before the tab it replaces
// has exited, and a live owner is a conflict. Try again while one remains, so
// the rooms come back once the old process is gone. The worker runs detached.
export async function restoreUntilFree(attempt,{tries=8,delayMs=750,sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms))}={}) {
  let result=attempt();const restored=[...result.restored]
  for(let i=1;i<tries&&result.conflicts.length;i++){await sleep(delayMs);result=attempt();restored.push(...result.restored)}
  return {restored,conflicts:result.conflicts}
}
async function restore(task) {
  const session=validateSession(task.observation.session)
  // null: this conversation is no longer current in that tab, nothing to restore.
  if(resolveClaudeConversation(session,{stateRoot,projectRoot:task.projectRoot})!==session.conversationId) return
  // Verification records its own failure flag. Registration is independent of it.
  try {scheduleVerification({version:currentVersion(),stateRoot,cwd:task.projectRoot,profileHome:session.profileHome})} catch {}
  const store=createStore({root:chatRoot,stateRoot,projectRoot:task.projectRoot})
  // Only the tab's own observed version is recorded; delivery reads the live process otherwise.
  const result=await restoreUntilFree(()=>store.restoreClaude({...task.observation,session},isProcessLive))
  const controller=createController({store,adapters:createAdapters({stateRoot})})
  await Promise.all([...new Set(result.restored.map(row=>row.room))].map(room=>controller.dispatch(room)))
}
async function worker(file) {
  try {
    safeFile(file)
    const task=JSON.parse(fs.readFileSync(file,'utf8'))
    try {await registerWithRetry(()=>restore(task),{delayMs:1000})}
    catch {recordFailure('restore',task.observation?.source)}
  } finally {try {fs.unlinkSync(file)} catch {}}
  // Housekeeping only: a failed pass removes nothing and the next tab start retries it.
  try {pruneClaudeLifecycle({stateRoot})} catch {}
  try {pruneHousekeeping(stateRoot)} catch {}
}
// fork opens a new conversation and the lifecycle applies the /clear rule to
// it. compact keeps the conversation: nothing to restore, replay or check again.
export function sessionStartPlan(input) {
  const source=input?.source
  return {source,restore:source!=='compact',orphans:source==='startup'}
}
// Drain past the limit without buffering: closing early would hand Claude an EPIPE.
async function readInput(limit) {
  let text='',over=false
  for await(const chunk of process.stdin){if(!over)text+=chunk;if(text.length>limit){over=true;text=''}}
  return over?null:text
}
// Notices are hints. A missing, damaged or unsafe file prints nothing.
function orphanNotice(projectRoot) {
  try {return [dailyOrphanLine({stateRoot,projectId:projectNoticeId(chatRoot,projectRoot)})].filter(Boolean)}catch{return []}
}
function unreadNotice(input) {
  try {return [sessionUnreadLine({stateRoot,profileHome:claudeProfileHome(),conversationId:input?.session_id})].filter(Boolean)}catch{return []}
}
// A chat folder others can read stops the MCP server, and /mcp only says it failed. Say why at
// start, where the user sees it. A missing folder is fine: the first room creates it.
export function unsafeChatRootLine(root=chatRoot) {
  try {
    const stat=fs.lstatSync(root)
    if(stat.isDirectory()&&!stat.isSymbolicLink()&&stat.uid===process.getuid()&&!(stat.mode&0o077))return []
  } catch {return []}
  return [unsafeFolderLine(root)]
}
// Up to three attempts a second apart: a burst of tabs starting together is the usual cause, and
// one retry wasn't enough at load 18 to 45. No new attempt once the hook has run for retryBeforeMs,
// so startup stays inside Claude's 60 s hook timeout even with git's 10 s bound.
const hookStarted=performance.now()
export async function registerWithRetry(attempt,{delayMs=1000,retryBeforeMs=30_000,attempts=3,started=hookStarted}={}) {
  for(let tried=1;;tried++) {
    try {return await attempt()}
    catch(error) {
      if(tried>=attempts||performance.now()-started>retryBeforeMs)throw error
      await new Promise(resolve=>setTimeout(resolve,delayMs))
    }
  }
}
// The tab's registration: project, lifecycle record, then a detached worker restores its rooms.
async function register(input,plan,messages,retry={}) {
  const withSource=error=>{throw Object.assign(error,{source:plan.source})}
  const projectRoot=await registerWithRetry(()=>{
    try {return lifecycleProjectRoot(input.cwd)}catch(error){throw Object.assign(error,{stage:error.stage??'project'})}
  },retry).catch(withSource)
  if(plan.orphans)messages.push(...orphanNotice(projectRoot))
  const observation=await registerWithRetry(()=>observeClaudeLifecycle({...input,source:plan.source},process.env,{stateRoot,projectRoot,scope:()=>projectRoot}),retry)
    .catch(withSource)
  if(!observation)return false
  const directory=path.join(stateRoot,'hook-tasks');ensureDirectory(directory)
  const file=path.join(directory,randomUUID()+'.json')
  atomicJson(file,{observation,projectRoot})
  const env={...process.env};delete env.CLAUDE_CODE_MESSAGING_TOKEN
  const child=spawn(process.execPath,[SCRIPT,'--work',file],{env,detached:true,stdio:'ignore'})
  child.on('error',()=>{try{fs.unlinkSync(file)}catch{}});child.unref()
  return true
}
// At the prompt after a failed start, one more attempt. Any agent-chat call also registers the tab.
async function retryAtPrompt(input) {
  const launch=process.env.CLAUDE_CODE_SESSION_ID
  if(!UUID.test(launch??'')||!UUID.test(input?.session_id??''))return []
  const {marker}=retryFiles(launch)
  let tries
  try {safeFile(marker);tries=JSON.parse(fs.readFileSync(marker,'utf8')).tries??0}catch{return []}
  // Three prompts at most: a cause that lasts would otherwise slow every prompt. The MCP server
  // keeps retrying on agent-chat calls.
  if(tries>=3){clearRetry(launch);return []}
  try {atomicJson(marker,{...JSON.parse(fs.readFileSync(marker,'utf8')),tries:tries+1})}catch{}
  try {
    await register({session_id:input.session_id,cwd:input.cwd,source:'resume',hook_event_name:'SessionStart'},{source:'resume',restore:true,orphans:false},[],{attempts:1})
    clearRetry(launch)
    return ['Agent-chat registered this tab now, after its start-up attempt failed. Its rooms are back.']
  } catch(error) {
    // The start-up line already said it failed; repeating it at every prompt is noise.
    recordFailure(error?.stage,'resume')
    if(error?.stage==='install')clearRetry(launch)
    return []
  }
}
// Compaction keeps the conversation and its rooms, but the summary can drop which alias and rooms
// the session had: one session denied being the orchestrator after ten compactions.
function compactReminder(input) {
  try {
    if(!UUID.test(input?.session_id??''))return []
    const projectRoot=lifecycleProjectRoot(input.cwd)
    const store=createStore({root:chatRoot,stateRoot,projectRoot})
    if(!store.materialized)return []
    const rows=store.memberships().filter(member=>member.joined&&member.session.runtime==='claude'&&(member.session.conversationId??member.session.id)===input.session_id)
    if(!rows.length)return []
    return [`agent-chat: after compaction, this session is still ${rows.map(row=>`${row.agent} in room ${row.room}`).join(', ')}. Use that name to post, and read inbox there when mail wakes you.`]
  } catch {return []}
}
// The launch UUID, like the prompt guard's gate; /clear keeps the session.
const sessionKey=input=>[process.env.CLAUDE_CODE_SESSION_ID,input?.session_id].find(id=>typeof id==='string'&&UUID.test(id))
async function main(messages) {
  if(process.env.AGENT_CHAT_VERIFY_CHILD==='1')return
  if(process.argv[2]==='--work'){await worker(process.argv[3]);return}
  const prompt=process.argv[2]==='--flags',text=await readInput(prompt?1048576:65536)
  let input=null,invalid=null
  try {input=JSON.parse(text)}catch(error){invalid=error}
  messages.push(...unseenFailureFlags(stateRoot,sessionKey(input)).map(flag=>flag.message))
  if(!prompt)messages.push(...unsafeChatRootLine())
  if(prompt){
    messages.push(...await retryAtPrompt(input))
    messages.push(...unreadNotice(input))
    process.stdout.write(JSON.stringify(context(messages)));return
  }
  if(text===null)throw Object.assign(Error('Hook input too large'),{stage:'input'})
  if(invalid)throw Object.assign(invalid,{stage:'input'})
  const plan=sessionStartPlan(input)
  if(!plan.restore){messages.push(...(plan.source==='compact'?compactReminder(input):[]));process.stdout.write(JSON.stringify(context(messages)));return}
  // Every failure from here on carries the start's source, so the line can say what happens to
  // the rooms of a cleared conversation.
  if(!await register(input,plan,messages))return
  if(UUID.test(process.env.CLAUDE_CODE_SESSION_ID??''))clearRetry(process.env.CLAUDE_CODE_SESSION_ID)
  messages.push(...verificationNotice())
  process.stdout.write(JSON.stringify(context(messages)))
}
if(process.argv[1]&&path.resolve(process.argv[1])===SCRIPT) {
  const messages=[]
  try {await main(messages)}
  catch(error) {
    recordFailure(error?.stage,error?.source??null)
    if(!process.argv.includes('--flags'))markForRetry(error?.stage)
    // An unsupported install fails the same way at every start, so it is named once a day.
    const quiet=error?.stage==='install'&&shownToday('unsupported-install')
    process.stdout.write(JSON.stringify(context([...messages,...(quiet?[]:[registrationFailureLine(error?.stage,error?.source)])])))
  }
}
