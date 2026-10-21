#!/usr/bin/env node
import './runtime.mjs'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { observeClaudeLifecycle, resolveClaudeConversation, lifecycleProjectRoot, pruneClaudeLifecycle } from './claude-lifecycle.mjs'
import { unseenFailureFlags } from './claude-failure-flags.mjs'
import { createStore, defaultChatRoot } from './store.mjs'
import { createAdapters, validateSession } from './adapters.mjs'
import { createController } from './controller.mjs'
import { isProcessLive } from './native-session.mjs'
import { scheduleVerification, verificationStatus } from './claude-auto-verify.mjs'
import { isVerifiedVersion, installedClaudeVersion } from './claude-versions.mjs'
import { ensureDirectory, safeFile, atomicJson, unsafeFolderLine } from './store-files.mjs'
import { projectNoticeId, dailyOrphanLine, sessionUnreadLine } from './notices.mjs'
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
    ?'Until this tab restarts, agent-chat still treats it as the conversation before /clear, and that conversation\'s rooms keep ringing here.'
    :'Rooms joined before this start need join_room again; their mail is kept.'
  return `Agent-chat could not register this tab: ${failedStep[stage]??'an unexpected error'}. ${rooms} Claude startup continues; existing permissions are unchanged.`
}
function shownToday(name,now=Date.now()) {
  const last=Date.parse(readShown(stateRoot,name)?.trim())
  if(last<=now&&now-last<86_400_000)return true
  recordShown(stateRoot,name,new Date(now).toISOString()+'\n');return false
}
// The latest failure, for diagnosis. A later success leaves it: it is dated.
function recordFailure(stage,source) {
  try {
    const directory=path.join(stateRoot,'lifecycle-failures');ensureDirectory(directory)
    atomicJson(path.join(directory,'latest.json'),{message:registrationFailureLine(stage,source),stage:failedStep[stage]||stage==='install'?stage:'unexpected',source:source??null,at:new Date().toISOString()})
  }catch{}
}
// "Checking" is true only before or during the one attempt; a failed attempt
// is reported by the failure line and never retried automatically.
export function verificationNotice(getVersion=currentVersion,verified=version=>isVerifiedVersion(version,{stateRoot}),status=version=>verificationStatus(version,{stateRoot}).status) {
  try {
    const version=getVersion()
    if(verified(version)||!['absent','running'].includes(status(version)))return []
    return [`Agent-chat is checking Claude ${version} once in the background. Failures appear under ${path.join(stateRoot,'verification')} and at the next prompt.`]
  }catch {return ['Agent-chat registration is queued. The Claude version check is unavailable; review automatic verification separately.']}
}
async function restore(task) {
  const session=validateSession(task.observation.session)
  // null: this conversation is no longer current in that tab, nothing to restore.
  if(resolveClaudeConversation(session,{stateRoot,projectRoot:task.projectRoot})!==session.conversationId) return
  // Verification records its own failure flag. Registration is independent of it.
  try {scheduleVerification({version:currentVersion(),stateRoot,cwd:task.projectRoot,profileHome:session.profileHome})} catch {}
  const store=createStore({root:chatRoot,stateRoot,projectRoot:task.projectRoot})
  // Only the tab's own observed version is recorded; delivery reads the live process otherwise.
  const result=store.restoreClaude({...task.observation,session},isProcessLive)
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
// One retry after a short pause: a burst of tabs starting together is the
// usual cause, and the second attempt then passes. No retry once the hook has
// run for retryBeforeMs, so startup stays well inside Claude's hook timeout.
const hookStarted=performance.now()
export async function registerWithRetry(attempt,{delayMs=500,retryBeforeMs=10_000,started=hookStarted}={}) {
  try {return await attempt()}
  catch(error) {
    if(performance.now()-started>retryBeforeMs)throw error
    await new Promise(resolve=>setTimeout(resolve,delayMs));return await attempt()
  }
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
    messages.push(...unreadNotice(input))
    process.stdout.write(JSON.stringify(context(messages)));return
  }
  if(text===null)throw Object.assign(Error('Hook input too large'),{stage:'input'})
  if(invalid)throw Object.assign(invalid,{stage:'input'})
  const plan=sessionStartPlan(input)
  if(!plan.restore){process.stdout.write(JSON.stringify(context(messages)));return}
  // Every failure from here on carries the start's source, so the line can say what happens to
  // the rooms of a cleared conversation.
  const withSource=error=>{throw Object.assign(error,{source:plan.source})}
  const projectRoot=await registerWithRetry(()=>{
    try {return lifecycleProjectRoot(input.cwd)}catch(error){throw Object.assign(error,{stage:error.stage??'project'})}
  }).catch(withSource)
  if(plan.orphans)messages.push(...orphanNotice(projectRoot))
  const observation=await registerWithRetry(()=>observeClaudeLifecycle({...input,source:plan.source},process.env,{stateRoot,projectRoot,scope:()=>projectRoot}))
    .catch(withSource)
  if(!observation)return
  const directory=path.join(stateRoot,'hook-tasks');ensureDirectory(directory)
  const file=path.join(directory,randomUUID()+'.json')
  atomicJson(file,{observation,projectRoot})
  const env={...process.env};delete env.CLAUDE_CODE_MESSAGING_TOKEN
  const child=spawn(process.execPath,[SCRIPT,'--work',file],{env,detached:true,stdio:'ignore'})
  child.on('error',()=>{try{fs.unlinkSync(file)}catch{}});child.unref()
  messages.push(...verificationNotice())
  process.stdout.write(JSON.stringify(context(messages)))
}
if(process.argv[1]&&path.resolve(process.argv[1])===SCRIPT) {
  const messages=[]
  try {await main(messages)}
  catch(error) {
    recordFailure(error?.stage,error?.source??null)
    // An unsupported install fails the same way at every start, so it is named once a day.
    const quiet=error?.stage==='install'&&shownToday('unsupported-install')
    process.stdout.write(JSON.stringify(context([...messages,...(quiet?[]:[registrationFailureLine(error?.stage,error?.source)])])))
  }
}
