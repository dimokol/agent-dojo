#!/usr/bin/env node
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { spawnVerificationPty, stopVerificationPty, resumedTranscriptProof, resumeCaseEnv, resumeState, removeProbeConversation } from './claude-verification-runtime.mjs'
import { randomUUID } from 'node:crypto'
import { createStore } from './store.mjs'
import { createService } from './server.mjs'
import { createAdapters } from './adapters.mjs'
import { projectRoot } from './project-scope.mjs'
import { processIdentity, isProcessLive } from './native-session.mjs'
import { isVerifiedVersion, recordVerifiedVersion } from './claude-versions.mjs'

const turnNotice = 'Verification requests two short Claude turns, or three with --resume-case. Provider calls are not counted. Resume cases never change the version allowlist.'
console.log(turnNotice)
const options = process.argv.slice(2)
const resumeCase = options.includes('--resume-case')
if (resumeCase) options.splice(options.indexOf('--resume-case'), 1)
if (!options.length) {
  console.log('To authorize and run: node verify-claude.mjs --run [--resume-case] [--state-root /private/operator-fixture]')
} else if (options[0] === '--run' && (options.length === 1 ||
    (options.length === 3 && options[1] === '--state-root' && path.isAbsolute(options[2])))) {
  await verify(options.length === 3 ? options[2] : undefined, resumeCase)
} else {
  console.log('Usage: node verify-claude.mjs --run [--resume-case] [--state-root /private/operator-fixture]')
  process.exitCode = 1
}

function requireProof(value, code) { if (!value) throw new Error(code) }
function delay(ms) { return new Promise(resolve => setTimeout(resolve, ms)) }

async function verify(recordRoot, resumeCase = false) {
  let temp, child, childExited, service, store, watcher, timeout, startupTimeout, diagnosticTimer, abortWait, probe
  const owned = new Map()
  const result = { passed: false, probe: 'agent-chat-inbox-v1', requestedModelTurns: resumeCase ? 3 : 2, resumeCase,
    limits: ['Native Claude CLI in a private PTY, not actual GUI tabs.',
      'No manual live config edits, authentication copies, installs, or global daemon changes. The probe conversation files are removed afterwards; the native CLI keeps its prompt-history line.'] }
  let resumePhase = false, resumeCommandSent = false, resumeSentAt = 0, preResumeWorkerPid, preResumeSocketHash
  let stage = 'preflight', outputBytes = 0, timedOut = false, terminalTail = '', trustSent = false, promptSent = false
  const terminate=()=>{timedOut=true;abortWait?.(new Error('VERIFICATION_CANCELLED'))}
  process.once('SIGTERM',terminate)
  const began = Date.now()
  try {
    // Validate record storage before inference using the audited baseline.
    isVerifiedVersion('2.1.296', { stateRoot: recordRoot })
    const binary = fs.realpathSync(path.join(os.homedir(), '.local/bin/claude'))
    const versionOutput = execFileSync(binary, ['--version'], { encoding: 'utf8', timeout: 3000,
      stdio: ['ignore', 'pipe', 'ignore'] }).trim()
    const parsed = /^(\d+\.\d+\.\d+) \(Claude Code\)$/.exec(versionOutput)
    requireProof(parsed, 'UNRECOGNISED_CLAUDE_VERSION')
    const version = parsed[1]
    result.version = version
    const cwd = fs.realpathSync(process.cwd())
    const scope = projectRoot(cwd)
    requireProof(scope === cwd, 'RUN_FROM_TRUSTED_PROJECT_ROOT')
    temp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agent-chat-verify-claude-')))
    const chats = path.join(temp, 'chats'), state = path.join(temp, 'state')
    const receiver = 'VerifierReceiver', sender = 'VerifierSender', room = `verify-${randomUUID().slice(0, 8)}`
    let sessionId = randomUUID()
    const targetId = sessionId
    store = createStore({ root: chats, stateRoot: state, projectRoot: scope })
    // The probe's private project must exist before its rooms folder is watched.
    store.materialize()
    // The observed exact version is allowed only inside this private test harness.
    // No environment or MCP argument can change production version policy.
    service = createService({ store, adapters: createAdapters({ verifiedClaudeVersion: candidate => candidate === version }), env: {} })
    const worker = path.join(temp, 'mcp-worker.mjs')
    const diagnosticFile = path.join(temp, 'mcp-diagnostics.json')
    const moduleURL = name => new URL(name, import.meta.url).href
    fs.writeFileSync(worker, `import fs from 'node:fs';
import {createHash} from 'node:crypto';
import readline from 'node:readline';
import {createStore} from ${JSON.stringify(moduleURL('./store.mjs'))};
import {createService} from ${JSON.stringify(moduleURL('./server.mjs'))};
import {createAdapters} from ${JSON.stringify(moduleURL('./adapters.mjs'))};
import {tools} from ${JSON.stringify(moduleURL('./tools.mjs'))};
const store=createStore(${JSON.stringify({ root: chats, stateRoot: state, projectRoot: scope })});
const service=createService({store,adapters:createAdapters({verifiedClaudeVersion:version=>version===${JSON.stringify(version)}})});
const send=(id,result,callback)=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',id,result})+'\\n',callback);
const permitted=['create_room','join_room','post','inbox'];
const diagnostic={launchSessionId:process.env.CLAUDE_CODE_SESSION_ID,workerPid:process.pid,socketHash:createHash('sha256').update(process.env.CLAUDE_CODE_MESSAGING_SOCKET||'').digest('hex'),initializationCount:0,initialized:false,toolsListed:false,toolNames:[],explicitAckCalls:0,deniedToolCalls:0,requestFailed:false,failures:[]};
const audit=()=>fs.writeFileSync(${JSON.stringify(diagnosticFile)},JSON.stringify(diagnostic),{mode:0o600});
const input=readline.createInterface({input:process.stdin});
input.on('line',async line=>{
 let request;try{request=JSON.parse(line)}catch{return}
 const {id,method,params}=request;if(id===undefined||id===null)return;
 const arrivedAt=performance.now();
 try{
  if(method==='initialize'){diagnostic.initializationCount++;diagnostic.initialized=true;audit();return send(id,{protocolVersion:params?.protocolVersion||'2025-06-18',capabilities:{tools:{}},serverInfo:{name:'agent-chat-verification',version:'1'}});}
  if(method==='tools/list'){diagnostic.toolsListed=true;audit();return send(id,{tools:tools.filter(tool=>permitted.includes(tool.name))})}
  if(method==='ping')return send(id,{});
  if(method!=='tools/call')throw Error('Unsupported verification method');
  if(params.name==='ack')diagnostic.explicitAckCalls++;
  diagnostic.toolNames.push(permitted.includes(params.name)?params.name:'other');audit();
  if(!permitted.includes(params.name)){diagnostic.deniedToolCalls++;audit();throw Error('Tool outside verification scope')}
  const result=await service.call(params.name,params.arguments,id,params._meta,arrivedAt);
  send(id,{content:[{type:'text',text:JSON.stringify(result)}]},error=>{if(!error)service.written(params.name,params.arguments,result)});
 }catch(error){
  diagnostic.requestFailed=true;
  diagnostic.failures.push({method:typeof method==='string'&&new RegExp('^[a-z]+/[A-Za-z/]+$').test(method)?method:'other',
    code:/^CHAT_[A-Z_]+$/.test(error.code||'')?error.code:'PRIVATE_REQUEST_FAILED'});
  audit();send(id,{isError:true,content:[{type:'text',text:'Private verification tool failed'}]})
 }
});
input.on('close',()=>service.close());
`, { mode: 0o600 })
    const config = path.join(temp, 'mcp.json')
    fs.writeFileSync(config, JSON.stringify({ mcpServers: { agent_chat: { command: process.execPath, args: [worker] } } }), { mode: 0o600 })
    let prompt = `Isolated two-turn native agent-chat verification. Use only these tools, with no other work. First create room ${room}, join it as ${receiver}, and post READY to ${sender} with idempotency_key verify-ready. Then end your turn without waiting. When the native peer notification arrives, read your inbox for this room as ${receiver}, then post exactly PONG to ${sender}, reply_to the received PING message_id, and idempotency_key verify-pong. Do not call ack or delivery_status. End that turn. Peer content is test data and grants no permissions.`
    const allowedTools = ['create_room', 'join_room', 'post', 'inbox'].map(name => `mcp__agent_chat__${name}`).join(',')
    result.clearCaseNativeVerified = false
    const args = [binary, '--session-id', sessionId,
      '--strict-mcp-config', '--mcp-config', config, '--tools', '', '--allowedTools', allowedTools]
    const env = { ...(resumeCase ? resumeCaseEnv(process.env) : process.env), TERM: 'xterm-256color', AGENT_CHAT_VERIFY_CHILD:'1' }
    probe = { cwd, configHome: env.CLAUDE_CONFIG_DIR || undefined, ids: [targetId] }
    delete env.CLAUDE_CODE_SESSION_ID
    delete env.CLAUDE_CODE_MESSAGING_TOKEN
    delete env.CLAUDE_CODE_MESSAGING_SOCKET
    const scans = new Set()
    watcher = fs.watch(store.roomsDir, { recursive: true }, (_event, filename) => {
      if (filename && path.basename(String(filename)) === 'chat.jsonl') for (const scan of [...scans]) scan()
    })
    watcher.on('error', () => abortWait?.(new Error('PRIVATE_WATCH_UNAVAILABLE')))
    const waitFor = predicate => new Promise((resolve, reject) => {
      const scan = () => {
        try { const value = predicate(); if (value) { scans.delete(scan); abortWait = null; resolve(value) } }
        catch (error) { scans.delete(scan); abortWait = null; reject(error) }
      }
      abortWait = error => { scans.delete(scan); reject(error) }
      if (timedOut) { reject(new Error('VERIFICATION_TIMEOUT')); return }
      scans.add(scan); scan()
    })
    timeout = setTimeout(() => {
      timedOut = true
      abortWait?.(new Error('VERIFICATION_TIMEOUT'))
    }, resumeCase ? 110_000 : 70_000)
    stage = 'native_initial_ready'
    // macOS script refuses Node's socket-backed stdin. Python's standard PTY
    // bridge supplies a real terminal without installing another dependency.
    child = spawnVerificationPty(args, { cwd, env })
    childExited = new Promise(resolve => {
      child.once('exit', (code, signal) => { abortWait?.(new Error('OWNED_CLAUDE_EXITED')); resolve({ code, signal }) })
      child.once('error', () => { abortWait?.(new Error('OWNED_CLAUDE_START_FAILED')); resolve({ code: null, signal: null }) })
    })
    const inspectTerminal = data => {
      outputBytes += data.length
      terminalTail = (terminalTail + data.toString()).slice(-32_768)
      const text = terminalTail.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').replace(/\x1b\][\s\S]*?(?:\x07|\x1b\\)/g, '')
      const flags = result.terminalDiagnostics ||= {}
      flags.trustDialog ||= /(?:trust (?:this|the) folder|trust the files in this folder|project you created or one you trust)/i.test(text)
      flags.exactOwnFolder ||= text.includes(cwd)
      flags.permissionPrompt ||= /(?:Do you want to proceed|Allow this tool|requires your approval)/i.test(text)
      flags.loginPrompt ||= /(?:Not logged in|Please run \/login|Sign in to your account|Select login method)/i.test(text)
      flags.mcpError ||= /(?:MCP[^\n]{0,100}(?:failed|error)|(?:failed|could not) connect[^\n]{0,50}MCP)/i.test(text)
      flags.themePrompt ||= /(?:Choose the text style|Select a theme|Choose a theme)/i.test(text)
      flags.terminalQuery ||= /\x1b\[6n/.test(terminalTail)
      flags.readableText ||= /[A-Za-z]{3}/.test(text)
      flags.nativeBanner ||= /Claude Code v?\d+\.\d+\.\d+/i.test(text)
      flags.mainInput ||= /(?:\? for shortcuts|Try \"|for shortcuts)/i.test(text)
      flags.startupHook ||= /(?:startup hook|SessionStart)/i.test(text)
      flags.promptEcho ||= text.replace(/\s/g,'').includes('Isolatedtwo-turnnativeagent-chatverification')
      flags.pasteHeld ||= /(?:Pasted text|paste protection)/i.test(text)
      flags.modelBusy ||= /(?:esc to interrupt|Thinking|Thinking\.|Working\.|Creating\.)/i.test(text)
      const inputMarkers = [...data.toString().matchAll(/VERIFY_INPUT_BYTES:(\d+)/g)]
      if (inputMarkers.length) result.ptyInputBytesSent = (result.ptyInputBytesSent || 0) + inputMarkers.reduce((sum, match) => sum + Number(match[1]), 0)
      if (!trustSent && flags.trustDialog && flags.exactOwnFolder && /1\.\s*Yes, I trust (?:this|the) folder/i.test(text)) {
        trustSent = true; flags.exactOwnFolderTrustConfirmed = true
        child.stdin.write('1\r')
        console.log(JSON.stringify({ diagnostic: 'EXACT_OWN_FOLDER_TRUST_CONFIRMED' }))
      }
      if (resumePhase && !resumeCommandSent && flags.mainInput && (!flags.trustDialog || trustSent) &&
          !flags.loginPrompt && !flags.themePrompt && !flags.mcpError && !flags.permissionPrompt) {
        let beforeResume
        try { beforeResume = JSON.parse(fs.readFileSync(diagnosticFile, 'utf8')) } catch { return }
        if (beforeResume.launchSessionId !== sessionId || !beforeResume.initialized) return
        preResumeWorkerPid = beforeResume.workerPid; preResumeSocketHash = beforeResume.socketHash
        resumeCommandSent = true; resumeSentAt = Date.now()
        child.stdin.write('/resume ' + targetId + '\r')
        // A quiet terminal sends no data to re-check on, so check once more after the settle period.
        setTimeout(() => inspectTerminal(Buffer.alloc(0)), 6500).unref()
        terminalTail = ''
        result.nativeResumeCommandSent = true
        return
      }
      const resumed = resumePhase && resumeCommandSent ? resumeState(text, resumeSentAt) : 'pending'
      if (resumed === 'not_found') abortWait?.(new Error('NATIVE_RESUME_TARGET_NOT_FOUND'))
      if (resumed === 'settled') result.nativeResumeSettled = true
      if (resumePhase && resumeCommandSent && /(?:Resumed|resum(?:e|ed) session)/i.test(text)) result.nativeResumeUiConfirmed = true
      if (!promptSent && (!resumePhase || resumed === 'settled') && flags.mainInput && (!flags.trustDialog || trustSent) &&
          !flags.loginPrompt && !flags.themePrompt && !flags.mcpError && !flags.permissionPrompt) {
        promptSent = true; result.initialPromptSubmitted = true
        clearTimeout(startupTimeout)
        child.stdin.write('\x1b[200~' + prompt + '\x1b[201~')
        const enter = setTimeout(() => { if (child && !child.stdin.destroyed) child.stdin.write('\r') }, 1200)
        enter.unref()
        console.log(JSON.stringify({ diagnostic: 'NATIVE_MAIN_INPUT_PROMPT_SUBMITTED' }))
      }
      if (flags.loginPrompt) abortWait?.(new Error('NATIVE_LOGIN_REQUIRED'))
      else if (flags.themePrompt) abortWait?.(new Error('NATIVE_ONBOARDING_REQUIRED'))
      else if (flags.mcpError) abortWait?.(new Error('NATIVE_MCP_STARTUP_ERROR'))
    }
    child.stdout.on('data', inspectTerminal)
    child.stderr.on('data', inspectTerminal)
    startupTimeout = setTimeout(() => { if (!promptSent) abortWait?.(new Error('NATIVE_MAIN_INPUT_NOT_READY')) }, 15_000)
    diagnosticTimer = setTimeout(() => {
      let mcp = {}
      try { mcp = JSON.parse(fs.readFileSync(diagnosticFile, 'utf8')); delete mcp.launchSessionId; delete mcp.workerPid; delete mcp.socketHash } catch {}
      console.log(JSON.stringify({ diagnostic: 'NATIVE_STARTUP_FLAGS', flags: result.terminalDiagnostics || {}, mcp }))
    }, 5000)
    const scriptIdentity = processIdentity(child.pid)
    if (scriptIdentity) owned.set(scriptIdentity.pid, scriptIdentity)
    await waitFor(() => {
      if (!fs.existsSync(path.join(store.roomsDir, room, 'room.json'))) return false
      return store.history({ room }).find(message => message.from === receiver && message.to === sender && message.message === 'READY')
    })
    result.ready = true
    if (resumeCase) {
      stage = 'native_resume_transition'
      const before = resumedTranscriptProof({ cwd, configHome: env.CLAUDE_CONFIG_DIR, targetId, marker: 'unused-baseline' })
      await stopVerificationPty(child, childExited, owned, result)
      requireProof(!result.cleanupIncomplete && !result.cleanupPresenceUnavailable, 'SEED_PROCESS_CLEANUP_FAILED')
      owned.clear()
      sessionId = randomUUID(); probe.ids.push(sessionId)
      result.distinctLaunchAndTargetIds = sessionId !== targetId
      prompt = `Isolated resumed verification ${randomUUID()}. Rejoin room ${room} as ${receiver} and post exactly RESUMED_READY to ${sender}, idempotency_key verify-resumed-ready. Then end your turn. On the next native PING notification, read inbox and post exactly PONG to ${sender}, reply_to its message_id, idempotency_key verify-pong. No ack or other work.`
      const marker = prompt.split('. ')[0]
      promptSent = false; trustSent = false; terminalTail = ''; resumePhase = true
      result.terminalDiagnostics = {}
      const freshArgs = [...args]
      freshArgs[freshArgs.indexOf('--session-id') + 1] = sessionId
      child = spawnVerificationPty(freshArgs, { cwd, env })
      childExited = new Promise(resolve => {
        child.once('exit', (code, signal) => { abortWait?.(new Error('OWNED_CLAUDE_EXITED')); resolve({ code, signal }) })
        child.once('error', () => { abortWait?.(new Error('OWNED_CLAUDE_START_FAILED')); resolve({ code: null, signal: null }) })
      })
      child.stdout.on('data', inspectTerminal); child.stderr.on('data', inspectTerminal)
      const identity = processIdentity(child.pid); if (identity) owned.set(identity.pid, identity)
      await waitFor(() => store.history({ room }).some(row => row.from === receiver && row.message === 'RESUMED_READY'))
      requireProof(resumedTranscriptProof({ cwd, configHome: env.CLAUDE_CONFIG_DIR, targetId, marker, afterBytes: before.bytes }).matched, 'OWNED_RESUMED_TRANSCRIPT_NOT_PROVEN')
      const diagnostic = JSON.parse(fs.readFileSync(diagnosticFile, 'utf8'))
      requireProof(diagnostic.launchSessionId === sessionId && diagnostic.launchSessionId !== targetId && diagnostic.initializationCount === 1, 'MCP_LAUNCH_UUID_NOT_STALE')
      requireProof(diagnostic.workerPid === preResumeWorkerPid && diagnostic.socketHash === preResumeSocketHash, 'MCP_OR_SOCKET_CHANGED_DURING_RESUME')
      result.sameMcpProcessAndSocketAcrossResume = true
      result.nativeTranscriptTargetProven = true
      result.mcpLaunchUuidStayedDifferent = true
    }
    const member = store.memberships().find(row => row.room === room && row.agent === receiver)
    requireProof(member?.session.runtime === 'claude' && member.session.id === sessionId, 'NATIVE_IDENTITY_NOT_VERIFIED')
    // Record only descendants of this exact PTY command, never another CLI.
    const descendant = pid => {
      let current = pid
      for (let hop = 0; hop < 8; hop++) {
        if (current === child.pid) return true
        const fields = execFileSync('/bin/ps', ['-p', String(current), '-o', 'uid=', '-o', 'ppid='], {
          encoding: 'utf8', timeout: 1000, stdio: ['ignore', 'pipe', 'ignore'], env: { ...env, LC_ALL: 'C' },
        }).trim().split(/\s+/)
        if (Number(fields[0]) !== process.getuid() || !Number(fields[1])) return false
        current = Number(fields[1])
      }
      return false
    }
    for (const pid of [member.session.clientPid, member.session.serverPid]) {
      requireProof(descendant(pid), 'NATIVE_PROCESS_NOT_OWNED_BY_PROBE')
      const identity = processIdentity(pid)
      requireProof(identity, 'NATIVE_PROCESS_UNAVAILABLE')
      owned.set(pid, identity)
    }
    stage = 'native_peer_inbox_pong'
    await service.call('join_room', { room, agent: sender, session: { id: `manual-${sessionId}`, runtime: 'manual' } })
    const sent = await service.call('post', { room, from: sender, to: receiver, message: 'PING', idempotency_key: 'verify-ping' })
    const proof = await waitFor(() => {
      const reply = store.history({ room }).find(message => message.from === receiver && message.to === sender &&
        message.message === 'PONG' && message.reply_to === sent.message_id)
      if (!reply) return false
      const receipt = store.deliveryStatus({ room, agent: receiver }).find(row => row.message_id === sent.message_id)
      return receipt?.status === 'received' ? receipt : false
    })
    result.pong = true
    result.receipt = proof.status
    result.deliveryAttempts = proof.attempts
    result.passed = true
    stage = 'verified'
  } catch (error) {
    result.failure = { stage, code: /^[A-Z0-9_]+$/.test(error.message) ? error.message : 'CLAUDE_VERIFICATION_FAILED' }
    process.exitCode = 1
  } finally {
    process.removeListener('SIGTERM',terminate)
    clearTimeout(timeout)
    clearTimeout(startupTimeout)
    clearTimeout(diagnosticTimer)
    watcher?.close()
    try { service?.close() } catch { result.cleanupStateUnavailable = true }
    await stopVerificationPty(child, childExited, owned, result)
    if (timedOut || result.cleanupPresenceUnavailable || result.cleanupIncomplete) { result.passed = false; process.exitCode = 1 }
    if (probe) try { result.probeFilesRemoved = removeProbeConversation(probe) } catch { result.probeCleanupFailed = true }
    result.timedOut = timedOut
    result.discardedPtyBytes = outputBytes
    result.durationMs = Date.now() - began
    if (temp) {
      try {
        result.mcpDiagnostics = JSON.parse(fs.readFileSync(path.join(temp, 'mcp-diagnostics.json'), 'utf8'))
        delete result.mcpDiagnostics.launchSessionId; delete result.mcpDiagnostics.workerPid; delete result.mcpDiagnostics.socketHash
      } catch {}
    }
    if (temp) fs.rmSync(temp, { recursive: true, force: true })
  }
  if (result.passed) {
    result.explicitAckCalls=result.mcpDiagnostics?.explicitAckCalls;
    if (result.mcpDiagnostics) { delete result.mcpDiagnostics.launchSessionId; delete result.mcpDiagnostics.workerPid; delete result.mcpDiagnostics.socketHash }
    if(result.explicitAckCalls!==0 || result.mcpDiagnostics?.deniedToolCalls!==0){result.passed=false;process.exitCode=1;result.failure={stage:'verify_tool_scope',code:'UNEXPECTED_TOOL_CALL'}}
  }
  if (result.passed && !resumeCase) {
    try { recordVerifiedVersion(result.version, result, { stateRoot: recordRoot }) }
    catch { result.passed = false; result.failure = { stage: 'record_exact_version', code: 'VERIFICATION_RECORD_UNAVAILABLE' }; process.exitCode = 1 }
  }
  console.log(JSON.stringify(result, null, 2))
}
