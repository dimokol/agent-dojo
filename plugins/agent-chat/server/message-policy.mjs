const broadcasts=new Set(['all','everyone','any','*'])
export const isBroadcast=to=>broadcasts.has(String(to).toLowerCase())
export function postPolicy({to='all',fyi,urgent}) {
 if([fyi,urgent].some(value=>value!==undefined&&typeof value!=='boolean')||fyi===true&&isBroadcast(to)||urgent===true&&!isBroadcast(to))throw Error('invalid wake controls: fyi applies to direct mail; urgent applies to broadcasts')
 return {...(fyi===true?{fyi:true}:{}),...(urgent===true?{urgent:true}:{})}
}
export const shouldWake=message=>isBroadcast(message.to)?message.urgent===true:message.fyi!==true
// A broadcast without a recorded audience (damaged-metadata fallback, older
// writers) is routed later to whoever is joined then, so it must never ring.
export const wakes=message=>shouldWake(message)&&(!isBroadcast(message.to)||Array.isArray(message.audience))
export function readState(status) {
 if(status==='handled')return 'handled'
 if(status==='received'||status==='acked')return 'received'
 if(status==='delivered')return 'delivered'
 return 'unread'
}
