const broadcasts=new Set(['all','everyone','any','*'])
export const isBroadcast=to=>broadcasts.has(String(to).toLowerCase())
// fyi on a broadcast names the default (it waits), so it is accepted and not
// stored: older releases refuse a broadcast record that carries fyi.
export function postPolicy({to='all',fyi,urgent}) {
 if([fyi,urgent].some(value=>value!==undefined&&typeof value!=='boolean')||fyi===true&&urgent===true||urgent===true&&!isBroadcast(to))throw Error('invalid wake controls: urgent applies to broadcasts; a message is fyi or urgent but not both')
 return {...(fyi===true&&!isBroadcast(to)?{fyi:true}:{}),...(urgent===true?{urgent:true}:{})}
}
// A model's broadcast must say whether it wakes anyone. Checked where a model
// posts, not in the store, so imports from older peers and internal posts pass.
export function requireBroadcastIntent({to='all',fyi,urgent}) {
 postPolicy({to,fyi,urgent})
 if(isBroadcast(to)&&fyi!==true&&urgent!==true)throw Error('a broadcast must say whether it wakes anyone: set to for a peer who should act, urgent: true to wake everyone joined, or fyi: true for a note that may wait')
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
