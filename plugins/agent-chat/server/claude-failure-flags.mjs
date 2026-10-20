import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { safeFile } from './store-files.mjs'
import { isVerifiedVersion } from './claude-versions.mjs'
import { UUID, readShown, recordShown } from './notice-files.mjs'
export function claudeFailureFlags(stateRoot, now=Date.now()) {
  const directory=path.join(stateRoot,'verification')
  try {
    // Validate the allowlist even when no version attempt could be recorded.
    isVerifiedVersion('2.1.296',{stateRoot})
    const stat=fs.lstatSync(directory)
    if(!stat.isDirectory()||stat.isSymbolicLink()||stat.uid!==process.getuid()||stat.mode&0o077) throw Error('Unsafe verification flags')
    return fs.readdirSync(directory).filter(name=>/^\d+\.\d+\.\d+\.json$/.test(name)).slice(0,128).flatMap(name=>{
      const file=path.join(directory,name);safeFile(file)
      const record=JSON.parse(fs.readFileSync(file,'utf8')), version=name.slice(0,-5)
      if(record.version!==version)throw Error('Invalid verification flag')
      if(isVerifiedVersion(version,{stateRoot}))return []
      if(record.status!=='failed'&&!(record.status==='running'&&record.deadlineAt<now))return []
      const log=path.join(directory,version+'.log')
      return [{version,flagPath:file,logPath:log,message:`Claude ${version} automatic verification failed or stopped. Review ${file} and ${log}; no automatic retry will run.`}]
    })
  }catch(error){if(error.code==='ENOENT')return [];return [{message:'Agent-chat Claude verification flags need operator review; automatic delivery may be paused.'}]}
}
// The attention flag is global, so the prompt hook runs in every session while
// it exists. Each session sees a given set of failures once; delivery_status
// keeps listing them. Without a session id the line always shows.
export function unseenFailureFlags(stateRoot, sessionId, flags=claudeFailureFlags(stateRoot)) {
  if(!flags.length||!UUID.test(sessionId??''))return flags
  const name=`flags-${sessionId}`, seen=createHash('sha256').update(flags.map(flag=>flag.message).join('\n')).digest('hex')+'\n'
  if(readShown(stateRoot,name)===seen)return []
  recordShown(stateRoot,name,seen)
  return flags
}
