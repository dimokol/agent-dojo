import './runtime.mjs'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import { spawn, execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { locked, atomicJson } from './store-files.mjs'
import { isVerifiedVersion } from './claude-versions.mjs'
const execute = promisify(execFile)
const SCRIPT = fileURLToPath(import.meta.url)
const VERIFIER = fileURLToPath(new URL('./verify-claude.mjs', import.meta.url))
const ROOT = path.join(os.homedir(), '.local/state/agent-chat')
const VERSION = /^\d+\.\d+\.\d+$/
// A timeout under load gets one more run after a pause: eight tabs restored at once kept the
// 2.1.304 probe past its 70 s limit, and an hour later the same check passed in 21 s. Each run
// asks for two short model turns, so there is exactly one retry. The deadline covers both runs.
const RETRYABLE = new Set(['VERIFICATION_TIMEOUT', 'NATIVE_MAIN_INPUT_NOT_READY'])
const RETRY_PAUSE = 60_000
const DEADLINE = 95_000 + RETRY_PAUSE + 90_000
// The verifier emits safe diagnostics followed by one final evidence object.
function finalObject(stdout) {
  const start=stdout.lastIndexOf('\n{\n')
  return JSON.parse(start>=0?stdout.slice(start+1):stdout.trim())
}
// Only the verifier's own enumerated stage and code are kept, never free text.
function safeFailure(proof) {
  const {stage,code}=proof?.failure??{}
  return /^[a-z_]{1,64}$/.test(stage??'')&&/^[A-Z0-9_]{1,64}$/.test(code??'')?{stage,code}:null
}
function unavailable() {return Object.assign(Error('Claude automatic verification state unavailable; operator recovery required'),{code:'CHAT_AUTO_VERIFY_UNAVAILABLE'})}
function location(version,stateRoot=ROOT,create=false) {
  if(!VERSION.test(version)||!path.isAbsolute(stateRoot)||path.normalize(stateRoot)!==stateRoot)throw unavailable()
  let current=path.parse(stateRoot).root
  for(const part of stateRoot.slice(current.length).split('/').filter(Boolean)) {
    current=path.join(current,part)
    if(!fs.existsSync(current)) {if(!create)return null;try{fs.mkdirSync(current,{mode:0o700})}catch(error){if(error.code!=='EEXIST')throw unavailable()}}
    const stat=fs.lstatSync(current)
    if(!stat.isDirectory()||stat.isSymbolicLink()||![0,process.getuid()].includes(stat.uid))throw unavailable()
  }
  const rootStat=fs.lstatSync(stateRoot)
  if(rootStat.uid!==process.getuid()||(rootStat.mode&0o777)!==0o700)throw unavailable()
  const dir=path.join(stateRoot,'verification')
  if(!fs.existsSync(dir)){if(!create)return null;try{fs.mkdirSync(dir,{mode:0o700})}catch(error){if(error.code!=='EEXIST')throw unavailable()}}
  const stat=fs.lstatSync(dir)
  if(!stat.isDirectory()||stat.isSymbolicLink()||stat.uid!==process.getuid()||(stat.mode&0o777)!==0o700)throw unavailable()
  return {dir,file:path.join(dir,version+'.json'),log:path.join(dir,version+'.log'),lock:path.join(dir,version)}
}
function read(file) {
  try {
    const stat=fs.lstatSync(file)
    if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1||stat.uid!==process.getuid()||(stat.mode&0o777)!==0o600)throw unavailable()
    const value=JSON.parse(fs.readFileSync(file,'utf8'))
    if(value.schema!==1||!VERSION.test(value.version)||!['running','failed','already_verified'].includes(value.status)||typeof value.attempt!=='string'||!Number.isFinite(value.startedAt)||!Number.isFinite(value.deadlineAt))throw unavailable()
    return value
  }catch(error){if(error.code==='ENOENT')return null;throw unavailable()}
}
function visible(record,paths) {
  return {version:record.version,status:record.status,reason:record.reason??null,flagPath:paths.file,logPath:paths.log,
    message:record.status==='failed'?`Claude ${record.version} verification failed. See ${paths.file} and ${paths.log}. Operator action is required before another attempt.`:undefined}
}
function failureLog(paths,record) {
  try {fs.writeFileSync(paths.log,JSON.stringify({version:record.version,passed:false,reason:record.reason,finishedAt:record.finishedAt})+'\n',{mode:0o600,flag:'wx'})}
  catch(error){if(error.code!=='EEXIST')throw unavailable()}
}
function update(paths,attempt,fn) {
  return locked(paths.lock,()=>{const current=read(paths.file);if(!current||current.attempt!==attempt||current.status!=='running')return current;const next=fn(current);atomicJson(paths.file,next);return next})
}
function attentionFile(paths,needed) {
  const file=path.join(paths.dir,'attention')
  if(needed) {
    try {fs.writeFileSync(file,'Claude verification needs attention.\n',{mode:0o600,flag:'wx'})}
    catch(error){if(error.code!=='EEXIST')throw unavailable()}
    const stat=fs.lstatSync(file)
    if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1||stat.uid!==process.getuid()||(stat.mode&0o777)!==0o600)throw unavailable()
  }else {try {fs.unlinkSync(file)}catch(error){if(error.code!=='ENOENT')throw unavailable()}}
}
export function refreshVerificationAttention({stateRoot=ROOT,isVerified=isVerifiedVersion}={}) {
  const paths=location('0.0.0',stateRoot)
  if(!paths)return false
  return locked(path.join(paths.dir,'attention-mutex'),()=>{
    let needed=false
    for(const name of fs.readdirSync(paths.dir)) {
      if(!/^\d+\.\d+\.\d+\.json$/.test(name))continue
      try {
        const record=read(path.join(paths.dir,name))
        if(record&&name!==record.version+'.json')throw unavailable()
        if(record&&!isVerified(record.version,{stateRoot})&&['running','failed'].includes(record.status))needed=true
      }catch {needed=true}
    }
    attentionFile(paths,needed);return needed
  })
}
export function verificationStatus(version,{stateRoot=ROOT,now=Date.now,isVerified=isVerifiedVersion}={}) {
  const paths=location(version,stateRoot)
  if(!paths)return {version,status:'absent'}
  let record
  try {record=locked(paths.lock,()=>read(paths.file))}catch {refreshVerificationAttention({stateRoot,isVerified});throw unavailable()}
  if(!record)return {version,status:'absent'}
  if(record.version!==version)throw unavailable()
  if(isVerified(version,{stateRoot})){refreshVerificationAttention({stateRoot,isVerified});return {version,status:'already_verified'}}
  if(record.status==='running'&&now()>record.deadlineAt)record=update(paths,record.attempt,current=>({...current,status:'failed',reason:'WORKER_DEADLINE_EXCEEDED',finishedAt:now()}))
  if(record.status==='failed'){failureLog(paths,record);refreshVerificationAttention({stateRoot,isVerified})}
  return visible(record,paths)
}
export function clearFailure(version,{stateRoot=ROOT}={}) {
  const paths=location(version,stateRoot)
  if(!paths)return {version,status:'absent'}
  const cleared=locked(paths.lock,()=>{
    const record=read(paths.file)
    if(!record)return {version,status:'absent'}
    if(record.version!==version||record.status!=='failed')throw Error('Only a failed Claude verification marker can be cleared; running or unknown attempts require operator recovery')
    const history=path.join(paths.dir,'history')
    try {fs.mkdirSync(history,{mode:0o700})}catch(error){if(error.code!=='EEXIST')throw unavailable()}
    const stat=fs.lstatSync(history)
    if(!stat.isDirectory()||stat.isSymbolicLink()||stat.uid!==process.getuid()||(stat.mode&0o777)!==0o700)throw unavailable()
    let logPresent=false
    try {
      const log=fs.lstatSync(paths.log)
      if(!log.isFile()||log.isSymbolicLink()||log.nlink!==1||log.uid!==process.getuid()||(log.mode&0o777)!==0o600)throw unavailable()
      logPresent=true
    }catch(error){if(error.code!=='ENOENT')throw unavailable()}
    const backup=path.join(history,version+'-'+randomUUID());fs.mkdirSync(backup,{mode:0o700})
    const savedLog=path.join(backup,'diagnostic.log')
    if(logPresent)fs.renameSync(paths.log,savedLog)
    try {fs.renameSync(paths.file,path.join(backup,'attempt.json'))}
    catch {if(logPresent)fs.renameSync(savedLog,paths.log);throw unavailable()}
    return {version,status:'cleared',backup,automaticRetryLaunched:false}
  })
  refreshVerificationAttention({stateRoot});return cleared
}
export function scheduleVerification({version,stateRoot=ROOT,cwd,profileHome},{spawnWorker=spawn,isVerified=isVerifiedVersion,now=Date.now,env=process.env}={}) {
  // Child hooks must not recursively launch another verifier.
  if(env.AGENT_CHAT_VERIFY_CHILD==='1')return {version,status:'running',reason:'VERIFICATION_CHILD'}
  const paths=location(version,stateRoot,true)
  try {
    if(isVerified(version,{stateRoot})){refreshVerificationAttention({stateRoot,isVerified});return {version,status:'already_verified'}}
  }catch {
    locked(path.join(paths.dir,'attention-mutex'),()=>attentionFile(paths,true));throw unavailable()
  }
  const existing=verificationStatus(version,{stateRoot,now})
  if(existing.status!=='absent')return existing
  for(const dir of [cwd,profileHome]) {
    if(typeof dir!=='string'||!path.isAbsolute(dir))throw unavailable()
    const stat=fs.lstatSync(dir)
    if(!stat.isDirectory()||stat.isSymbolicLink()||stat.uid!==process.getuid()||stat.mode&0o022)throw unavailable()
  }
  const attempt=randomUUID(),startedAt=now()
  const record={schema:1,version,status:'running',attempt,startedAt,deadlineAt:startedAt+DEADLINE}
  const claimed=locked(path.join(paths.dir,'attention-mutex'),()=>locked(paths.lock,()=>{
    if(read(paths.file))return false
    let fd
    try {fd=fs.openSync(paths.file,'wx',0o600);fs.writeFileSync(fd,JSON.stringify(record)+'\n');fs.fsyncSync(fd);attentionFile(paths,true);return true}
    catch{throw unavailable()}
    finally{if(fd!==undefined)fs.closeSync(fd)}
  }))
  if(!claimed)return verificationStatus(version,{stateRoot,now})
  const input={version,stateRoot,cwd,profileHome,attempt}
  try {
    const child=spawnWorker(process.execPath,[SCRIPT,'--worker',JSON.stringify(input)],{cwd,env:{...env,AGENT_CHAT_VERIFY_CHILD:'1'},detached:true,stdio:'ignore'})
    child.once('error',()=>{try{const failed=update(paths,attempt,current=>({...current,status:'failed',reason:'WORKER_SPAWN_FAILED',finishedAt:now()}));failureLog(paths,failed)}catch{}})
    child.unref()
  }catch {update(paths,attempt,current=>({...current,status:'failed',reason:'WORKER_SPAWN_FAILED',finishedAt:now()}));return verificationStatus(version,{stateRoot,now})}
  return {...visible(record,paths),status:'launched'}
}
export async function runVerificationWorker(input,{executor=execute,isVerified=isVerifiedVersion,now=Date.now,pause=ms=>new Promise(resolve=>setTimeout(resolve,ms))}={}) {
  const {version,stateRoot,cwd,profileHome,attempt}=input
  const paths=location(version,stateRoot)
  if(!paths)throw unavailable()
  const record=locked(paths.lock,()=>{
    const current=read(paths.file)
    if(current?.attempt!==attempt||current.status!=='running'||current.version!==version||current.workerStarted)return null
    const next={...current,workerStarted:true};atomicJson(paths.file,next);return next
  })
  if(!record)return
  if(now()>record.deadlineAt)return verificationStatus(version,{stateRoot,now})
  const run=async()=>{
    let stdout=''
    try {
      const result=await executor(process.execPath,[VERIFIER,'--run','--state-root',stateRoot],{
        cwd,env:{...process.env,CLAUDE_CONFIG_DIR:profileHome,AGENT_CHAT_VERIFY_CHILD:'1'},
        encoding:'utf8',timeout:90_000,maxBuffer:128*1024,killSignal:'SIGTERM',windowsHide:true,
      })
      stdout=result.stdout??''
      const proof=finalObject(stdout)
      const passed=(result.code!==undefined?result.code===0:true)&&proof.version===version&&proof.passed===true&&proof.probe==='agent-chat-inbox-v1'&&proof.requestedModelTurns===2&&proof.ready===true&&proof.pong===true&&proof.receipt==='received'&&proof.explicitAckCalls===0&&isVerified(version,{stateRoot})
      return {passed,reason:passed?null:'VERIFICATION_PROOF_REJECTED',failure:passed?null:safeFailure(proof)}
    }catch(error){
      let failure=null
      try {failure=safeFailure(finalObject(error.stdout??stdout))}catch {}
      return {passed:false,reason:error.killed||error.signal==='SIGTERM'?'VERIFIER_TIMEOUT':'VERIFIER_FAILED',failure}
    }
  }
  let outcome=await run(),runs=1
  if(!outcome.passed&&(RETRYABLE.has(outcome.failure?.code)||outcome.reason==='VERIFIER_TIMEOUT')&&now()+RETRY_PAUSE+90_000<=record.deadlineAt){await pause(RETRY_PAUSE);outcome=await run();runs=2}
  let {passed,reason}=outcome
  // Raw stdout/stderr are discarded. Logs keep scheduler diagnostics and the verifier's stage and code.
  try {fs.writeFileSync(paths.log,JSON.stringify({version,passed,reason:passed?null:reason,...(passed?{}:{failure:outcome.failure}),runs,finishedAt:now()})+'\n',{mode:0o600,flag:'wx'})}
  catch {passed=false;reason='PRIVATE_LOG_UNAVAILABLE'}
  const next=update(paths,attempt,current=>({...current,status:passed?'already_verified':'failed',reason:passed?null:reason,finishedAt:now()}))
  refreshVerificationAttention({stateRoot,isVerified})
  return visible(next,paths)
}
if(process.argv[1]&&path.resolve(process.argv[1])===SCRIPT) {
  try {
    const args=process.argv.slice(2)
    if(args[0]==='--worker'&&args.length===2)await runVerificationWorker(JSON.parse(args[1]))
    else if(args[0]==='--clear-failure'&&(args.length===2||args.length===4&&args[2]==='--state-root')) {
      console.log(JSON.stringify(clearFailure(args[1],args.length===4?{stateRoot:args[3]}:{})))
    }else throw Error('Usage: claude-auto-verify.mjs --clear-failure VERSION [--state-root PRIVATE_DIRECTORY]')
  }catch(error){console.error(error.code==='CHAT_AUTO_VERIFY_UNAVAILABLE'?error.message:'Claude verification operation refused; check command arguments and private state');process.exitCode=1}
}
