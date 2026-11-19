import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { restoreClaudeMemberships, rememberClaudeMembership } from './claude-memberships.mjs'
import { identifier, slug, roomFromTitle, checkRoomFolder, canonicalRoot, projectStateKey, migrateProjectState, ensureDirectory, readJson, atomicJson, append, locked, projectDirectory, predictProjectDirectory } from './store-files.mjs'
import { createLogReader } from './canonical-log.mjs'
import { distribution } from './distribution.mjs'
import { syncNotices, syncNameCache } from './notices.mjs'
import { members as memberRows, unreadReport as unreadRows, sentReport, absentReason, receiptView } from './chat-queries.mjs'

import { validState, stateDamage } from './store-schema.mjs'
import { participantId, initializeParticipants, nameOwner, registerParticipant, renameParticipant, adoptClosedName, adoptClosedNameAsRename, reclaimRetired, settleParked, takeBackName, carryOverClear, adoptUnresolved, completed } from './participant-identity.mjs'
import { postPolicy, isBroadcast, wakes, readState } from './message-policy.mjs'
import { migrateReadIndex, compactReadIndex, recipientStates, directTarget } from './read-index.mjs'
import { isDismissed, dismissMail } from './dismissals.mjs'
import { hasModeBits } from './platform.mjs'

// A doorbell nobody answered (a lost frame, a tab that closed mid-turn) must
// not silence later mail for good. After this long it stops gating, and the
// next ring names the new mail while the inbox returns everything open.
export const staleRingMs = 15 * 60_000
// The MCP server and the SessionStart hook must agree on the chat root, so both fall back to
// this one when AGENT_CHAT_ROOT is unset.
export const defaultChatRoot = () => path.join(os.homedir(), ...distribution.chatRoot)

function validatePost({ room, from, to = 'all', channel = 'main', message, reply_to, idempotency_key, fyi, urgent }) {
  identifier(room, 'room'); identifier(from, 'from'); identifier(channel, 'channel')
  if (!isBroadcast(to)) identifier(to, 'to')
  if (typeof message !== 'string' || !message.trim() || message.length > 200_000) throw new Error('message must contain 1 to 200000 characters')
  if (reply_to !== undefined && reply_to !== null && (typeof reply_to !== 'string' || reply_to.length > 128)) throw new Error('invalid reply_to')
  if (idempotency_key !== undefined && (typeof idempotency_key !== 'string' || !idempotency_key || idempotency_key.length > 200)) throw new Error('invalid idempotency_key')
  return { room, from, to, channel, message, reply_to, idempotency_key, policy: postPolicy({ to, fyi, urgent }) }
}

export function createStore({ root: givenRoot, projectRoot, stateRoot = path.join(givenRoot, '.runtime'), now = Date.now }) {
  const root = canonicalRoot(givenRoot)
  ensureDirectory(stateRoot)
  if (hasModeBits(fs.statSync(stateRoot), 0o077)) throw new Error('operational state directory must be private')
  migrateProjectState(givenRoot, projectRoot, stateRoot)
  const privateDir = path.join(stateRoot, 'projects', projectStateKey(givenRoot, projectRoot))
  let derivedFailureReported = false
  // A directory where no room is ever used leaves no trace. Without a project folder or private
  // state, both are created by the first change, not when a session starts: every Claude and
  // Codex start in any folder used to add an empty project folder to the chat root.
  let { project, dir, claimed } = predictProjectDirectory(path.resolve(root), projectRoot)
  let roomsDir = path.join(dir, 'rooms'), materialized = false
  const materialize = () => {
    if (materialized) return
    ;({ project, dir } = projectDirectory(path.resolve(root), projectRoot, path.join(stateRoot, 'locks')))
    roomsDir = path.join(dir, 'rooms')
    ensureDirectory(roomsDir); ensureDirectory(privateDir)
    if (hasModeBits(fs.statSync(privateDir), 0o077)) throw new Error('delivery directory must be private')
    materialized = true
  }
  // Another session's store may have created this project since, or another project may have
  // claimed the guessed folder name; until it exists, every check guesses again.
  const present = () => {
    if (materialized) return true
    if (!fs.existsSync(privateDir)) {
      ;({ project, dir, claimed } = predictProjectDirectory(path.resolve(root), projectRoot))
      roomsDir = path.join(dir, 'rooms')
      if (!claimed) return false
    }
    materialize()
    return true
  }
  if (claimed) materialize(); else present()
  const statePath = path.join(privateDir, 'state.json')
  const lockPath = path.join(privateDir, '.lock')
  const stamp = () => new Date(now()).toISOString()
  const paths = (room) => {
    identifier(room, 'room')
    const variant = (present() ? fs.readdirSync(roomsDir) : []).find(name => name !== room && name.toLowerCase() === room.toLowerCase())
    if (variant) throw new Error(`room case variant conflicts with ${variant}`)
    const roomDir = path.join(roomsDir, room)
    if (fs.existsSync(roomDir)) checkRoomFolder(room, roomDir)
    return { dir: roomDir, meta: path.join(roomDir, 'room.json'), log: path.join(roomDir, 'chat.jsonl'), md: path.join(roomDir, 'chat.md') }
  }
  const { records, indexed } = createLogReader(room => paths(room).log)
  // A folder this project hasn't claimed may be another project's of the same name: nothing in it counts.
  const roomExists = (room) => present() && Boolean(readJson(paths(room).meta, null))
  const makeRoom = (room, title) => {
    const p = paths(room)
    ensureDirectory(p.dir)
    const created = new Date().toISOString()
    atomicJson(p.meta, { id: room, title, created })
    append(p.md, `# ${title}\n\n_room \`${room}\` · created ${created}_\n`)
    return { room, title, created }
  }
  const logOrNull = room => { try { return records(room) } catch { return null } }
  // A damaged log can't prove the name has no open mail, so it keeps the reservation.
  const unreadName = (state, name, id) => Object.entries(state.rooms).some(([room,rs])=>logOrNull(room)?.some(message=>
    message.to.toLowerCase()===name.toLowerCase() && !isBroadcast(message.to) &&
    (rs.delivery_owners?.[message.id]?.participant_id ?? message.to_id ?? rs.legacy_recipients?.[message.id])===id && !isDismissed(rs,message,id) &&
    ![...Object.values(rs.members),...Object.values(rs.retired_members??{})].some(member=>member.participant_id===id&&(completed(member.deliveries[message.id])||(!member.deliveries[message.id]&&(member.received_cursor??0)>=message.cursor)))) ?? true)
  const owner = (state,name) => nameOwner(state,name,now(),(name,id)=>unreadName(state,name,id))
  // `resolved`: the recipient was just assigned, so a watermark past the message proves nothing.
  const enqueue = (state, room, member, messages, resolved = false) => {
    for (const message of messages) {
      const rs=state.rooms[room], broadcast=isBroadcast(message.to)
      let target=directTarget(rs, message), assigned=false
      // A name nobody owned when the mail came gets its owner now: no watermark covers this mail yet.
      if(!broadcast&&!target) {
        target=owner(state,message.to)?.id
        if(target){(rs.legacy_recipients??={})[message.id]=target;assigned=true}
      }
      const sender=message.from_id ?? owner(state,message.from)?.id
      // A recorded audience is final: a later joiner or rejoiner never inherits that broadcast.
      const recipient=broadcast ? (Array.isArray(message.audience) ? message.audience.includes(member.participant_id) : member.joined && message.cursor>member.after_cursor) : target===member.participant_id
      if ((resolved || assigned || message.cursor > (member.received_cursor ?? 0)) && sender!==member.participant_id && recipient && !member.deliveries[message.id] && !isDismissed(rs,message,member.participant_id)) {
        member.deliveries[message.id] = { status: 'pending', attempts: 0, updated: stamp() }
      }
    }
  }
  const preserveUnconfirmed = member => {
    for (const receipt of Object.values(member.deliveries)) if (!['delivered', 'acked', 'received', 'handled'].includes(receipt.status)) {
      receipt.status = 'pending'; delete receipt.claim_id; delete receipt.ring_at
    }
  }
  // Until the project exists, a transaction runs on an empty state; only a real change creates it.
  const transact = (callback, mapping) => {
    if (!present()) {
      const state = { version: 1, rooms: {} }
      initializeParticipants(state, now(), mapping); migrateReadIndex(state)
      const before = JSON.stringify(state), result = callback(state)
      if (JSON.stringify(state) === before) return result
      materialize()
    }
    return lockedTransact(callback, mapping)
  }
  const lockedTransact = (callback, mapping) => locked(lockPath, () => {
    let state
    try { state = readJson(statePath, { version: 1, rooms: {} }) } catch { throw stateDamage() }
    if (!validState(state)) throw stateDamage()
    const before = JSON.stringify(state)
    initializeParticipants(state,now(),mapping)
    for (const [room, roomState] of Object.entries(state.rooms)) {
      let messages
      try { messages = records(room); delete roomState.log_error }
      catch { roomState.log_error = 'Canonical log needs recovery'; continue }
      for(const message of messages)if(!message.to_id&&!isBroadcast(message.to)&&!roomState.legacy_recipients?.[message.id]) {
        const target=owner(state,message.to)?.id
        if(!target)continue
        ;(roomState.legacy_recipients??={})[message.id]=target
        // A name can gain its owner after the mail was routed (a rename onto it).
        // Not while upgrading: that resolves every old message at once, and
        // received mail pruned into received_cursor must stay received.
        const member=state.read_index===1&&Object.values(roomState.members).find(row=>row.participant_id===target)
        if(member)enqueue(state,room,member,[message],true)
      }
      // A log replaced by a shorter copy: cursors past its end would hide new mail as already routed
      // or received. A log that is briefly missing reads as empty and must not reset anything.
      if (messages.length < roomState.routed_cursor && fs.existsSync(paths(room).log)) {
        roomState.routed_cursor = messages.length
        for (const row of [...Object.values(roomState.members), ...Object.values(roomState.retired_members ?? {})])
          for (const key of ['after_cursor', 'received_cursor', 'legacy_cursor']) if (row[key] > messages.length) row[key] = messages.length
      }
      const added = messages.slice(roomState.routed_cursor)
      if (added.length) {
        for (const member of Object.values(roomState.members)) enqueue(state,room,member,added)
        roomState.routed_cursor = messages.length
      }
    }
    migrateReadIndex(state)
    const result = callback(state)
    if (JSON.stringify(state) !== before) {
      const sender = message => message.from_id ?? owner(state, message.from)?.id
      for (const [room, roomState] of Object.entries(state.rooms)) {
        // Routing failed for this room in this transaction; its log may have completed since.
        if (roomState.log_error) continue
        let messages
        try { messages = records(room) } catch { continue }
        compactReadIndex(roomState, messages, indexed(room), { now: now(), sender })
      }
      atomicJson(statePath, state)
      // Derived hint files; each reports its own failure and never fails the write. A cause that
      // lasts would keep them stale, so the first failure goes to stderr (the MCP log), once.
      const derived = [syncNotices({ stateRoot, projectId: path.basename(privateDir), state, now: now(), records }), syncNameCache({ stateRoot, state })]
      const failure = derived.find(result => result?.error)?.error
      if (failure && !derivedFailureReported) {
        derivedFailureReported = true
        process.stderr.write(`Agent-chat could not update its unread notices or name cache (${failure}); mail and inboxes are unaffected. Check that the agent-chat state folder and its notices folder are yours and closed to other users.\n`)
      }
    }
    return result
  })
  // Another participant's hold on a name: 'live' (joined somewhere), 'closed', 'reserved' (an
  // old name kept for whoever renamed away from it), or null when the name is free or our own.
  const nameHold = (state, id, name) => {
    const holder = nameOwner(state, name, now(), (name, id) => unreadName(state, name, id))
    if (!holder || holder.id === id) return null
    if (state.nameOwners[String(name).toLowerCase()].retired_at !== undefined) return 'reserved'
    return Object.values(state.rooms).some(rs => Object.values(rs.members).some(member => member.participant_id === holder.id && member.joined)) ? 'live' : 'closed'
  }
  const requireMember = (state, room, agent, sessionId, participant_id) => {
    identifier(room, 'room'); identifier(agent, 'agent')
    const id=participant_id??owner(state,agent)?.id
    const member = Object.values(state.rooms[room]?.members??{}).find(row=>row.participant_id===id)
    if (!member?.joined || member.session.id !== sessionId) throw new Error('session is not joined as this agent')
    return member
  }
  const receiptRows = (state, room, agent) => {
    const rows = []
    for (const [roomId, rs] of Object.entries(state.rooms)) {
      if (room && roomId !== room) continue
      for (const member of Object.values(rs.members)) {
        if (agent && member.participant_id !== owner(state,agent)?.id) continue
        for (const [message_id, receipt] of Object.entries(member.deliveries)) rows.push({ room: roomId, agent: member.agent, sessionId: member.session.id, participant_id: member.participant_id, joined: member.joined, message_id, ...receiptView(receipt), read_state: readState(receipt.status) })
      }
    }
    return rows
  }
  const appendPost = (args, state) => locked(path.join(privateDir, `room-${args.room}`), () => {
    const { room, from, to, channel, message, reply_to, idempotency_key, policy } = args
    if (!roomExists(room)) makeRoom(room, room)
    const old = records(room)
    // Without state (the canonical-only fallback) the sender name is the only identity.
    const previous = idempotency_key && old.find(record => (state && record.from_id ? record.from_id===owner(state,from)?.id : record.from === from) && record.idempotency_key === idempotency_key)
    if (previous) {
      // The wake policy is part of the message; a retry can never change it.
      if (previous.to !== to || previous.channel !== channel || previous.message !== message || (previous.reply_to ?? null) !== (reply_to ?? null) ||
          ['fyi', 'urgent'].some(key => (previous[key] === true) !== (policy[key] === true))) throw new Error('idempotency key reused with different message')
      return { room, message_id: previous.id, cursor: previous.cursor, duplicate: true }
    }
    const from_id = state ? owner(state, from)?.id ?? null : undefined
    // The canonical record names its broadcast audience, so recovery after a
    // crash before the metadata write routes it to exactly these members.
    const audience = state && isBroadcast(to) ? Object.values(state.rooms[room]?.members ?? {}).filter(member =>
      member.joined && member.participant_id !== from_id && member.after_cursor <= old.length).map(member => member.participant_id) : undefined
    const record = { ...(state?{from_id,to_id:isBroadcast(to)?null:owner(state,to)?.id??null}:{}), id: crypto.randomUUID(), ts: new Date().toISOString(), from, to, channel, reply_to: reply_to ?? null, message, ...policy, ...(audience ? { audience } : {}), ...(idempotency_key ? { idempotency_key } : {}) }
    append(paths(room).log, JSON.stringify(record) + '\n')
    const current = records(room)
    if (state) {
      const rs = state.rooms[room] ||= { routed_cursor: 0, members: {} }
      for (const member of Object.values(rs.members)) enqueue(state,room,member,current.slice(rs.routed_cursor))
      rs.routed_cursor = current.length
    }
    // JSONL is authoritative. A derived failure must not make a durable post look unsent.
    let transcript_error
    try { append(paths(room).md, `\n### ${from} → ${to} · ${record.ts} · id ${record.id}\n\n${message}\n`) }
    catch { transcript_error = 'Derived transcript could not be updated; canonical post is durable' }
    return { room, message_id: record.id, cursor: current.length, ...(transcript_error ? { transcript_error } : {}) }
  })
  return {
    restoreClaude(observation, isLive) {
      const session=observation?.session
      if(session?.runtime!=='claude'||!session.conversationId||typeof isLive!=='function') throw new Error('Validated Claude lifecycle observation required')
      return transact(state=>restoreClaudeMemberships(state,observation,{isLive,preserveUnconfirmed,now:now(),records}))
    },
    // A /clear the server noticed before its hook restored anything (participant-identity.mjs).
    carryOverClear(session,clearedFrom) {
      if(session?.runtime!=='claude'||!session.conversationId||!clearedFrom?.length)return []
      return transact(state=>carryOverClear(state,session,clearedFrom,now(),records))
    },
    // The conversation a tab switched to takes back its rows and name (participant-identity.mjs).
    takeBackName(session) {
      if(session?.runtime!=='claude'||!session.conversationId)return []
      return transact(state=>[...adoptUnresolved(state,session,now(),records,preserveUnconfirmed),...takeBackName(state,session,now(),records)])
    },
    chooseDefaultName(session,suggested,nativeName) {
      return transact(state=>{
        const existing=state.participants[participantId(session)]
        if(existing?.name)return structuredClone(existing)
        const source=nativeName?'native':'default', base=slug(nativeName||suggested||session.runtime,55)
        let name=base
        for(let n=2;isBroadcast(name)||owner(state,name);n++)name=`${base}-${n}`
        return {name,source}
      })
    },
    participants() { return transact(state=>structuredClone(Object.values(state.participants))) },
    // The name a join under `asked` gives this session: a /name name stays, an earlier name of
    // this same session addresses it without renaming it back, a name another live session holds
    // or another session reserved is not taken, anything else (a closed session's name included)
    // is the new name. An unnamed session asking for a live session's name is refused.
    joinName(session,asked) {
      return transact(state=>{
        const current=state.participants[participantId(session)], hold=nameHold(state,participantId(session),asked)
        if(!current?.name) {
          if(hold==='live')throw new Error(`${asked} belongs to another live session; join under another name`)
          return {name:asked}
        }
        if(current.name===asked)return {name:asked}
        const kept=reason=>({name:current.name,requested:asked,note:`kept ${current.name}; ${reason}`})
        if(current.source==='explicit')return {name:current.name,requested:asked,note:`kept your /name name ${current.name}; you asked for ${asked}`}
        const held=state.nameOwners?.[String(asked).toLowerCase()]
        if(held?.participant_id===current.id&&held.retired_at!==undefined)return kept(`${asked} is an earlier name of this session`)
        if(hold==='live')return kept(`${asked} belongs to another live session`)
        if(hold==='reserved')return kept(`${asked} is reserved for its previous owner`)
        return {name:asked,rename:true,note:`renamed from ${current.name}`}
      })
    },
    canonicalSessionName(session) { return transact(state=>structuredClone(state.participants[participantId(session)]??null)) },
    migrateParticipantNames(mapping) { return transact(state=>structuredClone(state.participants),mapping) },
    renameSession({room,agent,sessionId,participantId: id,name,source='agent'}) {
      return transact(state=>{
        const member=requireMember(state,room,agent,sessionId,id)
        return renameParticipant(state,member.participant_id,name,{now:now(),source,unread:(name,id)=>unreadName(state,name,id)})
      })
    },
    get project() { return project }, get dir() { return dir }, get roomsDir() { return roomsDir }, get materialized() { return present() }, materialize,
    statePath, root: path.resolve(root), projectRoot: fs.realpathSync(projectRoot), stateRoot,
    createRoom({ room, title }) {
      if (typeof title !== 'string' || !title.trim() || title.length > 200) throw new Error('title must contain 1 to 200 characters')
      // The name is settled before anything is made, so a refused one leaves no project behind.
      const named = room ? identifier(room, 'room') : roomFromTitle(title)
      materialize()
      return transact(() => {
        let id = named
        if (room && roomExists(id)) throw new Error('room already exists')
        const base = id
        for (let n = 2; roomExists(id); n++) id = `${base}-${n}`
        return makeRoom(id, title.trim())
      })
    },
    listRooms() {
      return transact(() => (present() ? fs.readdirSync(roomsDir, { withFileTypes: true }) : []).filter((entry) => entry.isDirectory()).flatMap((entry) => {
        let meta
        try { meta = readJson(paths(entry.name).meta, null) }
        catch (error) {
          if (error.code === 'CHAT_ROOM_UNSAFE') return [{ room: entry.name, damaged: true, error: error.message }]
          throw error
        }
        if (!meta) return []
        let messages
        try { messages = records(entry.name) }
        catch { return [{ room: meta.id, title: meta.title, created: meta.created, messages: null, last_ts: null, error: 'Canonical log needs recovery' }] }
        return [{ room: meta.id, title: meta.title, created: meta.created, messages: messages.length, last_ts: messages.at(-1)?.ts || null }]
      }))
    },
    post(args) {
      const validated = validatePost(args)
      // No project yet means no members: refuse before the project is made.
      if (args.sessionId !== undefined && !present()) throw new Error('session is not joined as this agent')
      materialize()
      let posted
      try {
        return transact(state => {
          if (args.sessionId !== undefined) validated.from=requireMember(state, validated.room, validated.from, args.sessionId,args.participantId).agent
          return posted = appendPost(validated, state)
        })
      } catch (error) {
        // The log line is durable; the next transaction routes it from routed_cursor.
        if (!posted) throw error
        return { ...posted, state_error: 'Delivery state could not be saved; the post is durable and will be routed on the next operation' }
      }
    },
    // Internal recovery path. The facade must authorize an already bound sender
    // before using this; damaged metadata cannot establish a new identity.
    postCanonicalOnly(args) { const validated = validatePost(args); materialize(); return appendPost(validated) },
    history({ room, channel, limit = 200 }) {
      identifier(room, 'room'); if (channel) identifier(channel, 'channel')
      if (!Number.isInteger(limit) || limit < 1 || limit > 10000) throw new Error('invalid history limit')
      return transact(() => present() ? structuredClone(records(room).filter((record) => !channel || record.channel === channel).slice(-limit)) : [])
    },
    // create: a title to make the room with if it doesn't exist. The name is checked first, so a
    // join that fails leaves no room behind.
    // rename: a session that already has another name takes this one in every room (the server
    // decides when, see joinName).
    join({ room, agent, session, after_cursor, create, rename = false }) {
      identifier(room, 'room'); identifier(agent, 'agent')
      if (isBroadcast(agent)) throw new Error('agent alias is reserved for broadcasts')
      if (!session || typeof session.id !== 'string' || !session.id || session.id.length > 300 || typeof session.runtime !== 'string' || !session.runtime || (session.endpoint !== undefined && (typeof session.endpoint !== 'string' || !session.endpoint))) throw new Error('session id and runtime required; endpoint must be a nonempty string if provided')
      if (session.pid !== undefined && (!Number.isInteger(session.pid) || session.pid <= 0)) throw new Error('session pid must be a positive integer')
      if (session.profileHome !== undefined && (typeof session.profileHome !== 'string' || !session.profileHome)) throw new Error('invalid profileHome')
      if (after_cursor !== undefined && (!Number.isInteger(after_cursor) || after_cursor < 0)) throw new Error('invalid after_cursor')
      if (create !== undefined && (typeof create !== 'string' || !create.trim() || create.length > 200)) throw new Error('title must contain 1 to 200 characters')
      if (create !== undefined) materialize()
      return transact((state) => {
        const missing = !roomExists(room)
        if (missing && create === undefined) throw new Error('room does not exist')
        const messages = missing ? [] : records(room)
        const rs = state.rooms[room] ||= { routed_cursor: messages.length, members: {} }
        // Parked mail goes to its owner before this join enqueues anything from the log.
        settleParked(state,now(),records)
        const current=state.participants[participantId(session)]
        if(rename&&current?.name&&current.name!==agent&&!(nameHold(state,current.id,agent)==='closed'&&adoptClosedNameAsRename(state,session,agent,now(),records)))
          renameParticipant(state,current.id,agent,{now:now(),unread:(name,id)=>unreadName(state,name,id)})
        adoptClosedName(state,session,agent,now(),records)
        const participant=registerParticipant(state,session,agent,now(),(name,id)=>unreadName(state,name,id))
        const previous = rs.members[agent]
        const sameIdentity = previous?.participant_id === participant.id
        if (previous?.joined && !sameIdentity) throw new Error('agent alias already joined by another session; leave it explicitly')
        if (missing) makeRoom(room, create.trim())
        // Metadata comes from the validating facade. A PID records identity, not proven liveness.
        const metadata = { ...session }
        rememberClaudeMembership(state,{room,agent,session})
        if (sameIdentity && previous.joined) {
          previous.session = metadata
          reclaimRetired(state, participant.id, metadata, now(), records)
          return structuredClone(previous)
        }
        const sameSession = sameIdentity
        const inherited = structuredClone(previous?.deliveries ?? {})
        if (!sameSession || previous?.session.serverPid !== metadata.serverPid || previous?.session.serverStart !== metadata.serverStart) for (const receipt of Object.values(inherited)) {
          if (!['delivered', 'acked', 'received', 'handled'].includes(receipt.status)) { receipt.status = 'pending'; delete receipt.claim_id }
        }
        const member = { agent, participant_id:participant.id, owner_since:participant.owner_since, session: metadata, joined: true, after_cursor: after_cursor ?? previous?.after_cursor ?? messages.length, deliveries: inherited, received_cursor: previous?.received_cursor ?? 0, ring_times: previous?.ring_times ?? [], ...(previous?.legacy_cursor !== undefined ? { legacy_cursor: previous.legacy_cursor } : {}) }
        rs.members[agent] = member
        enqueue(state,room,member,messages)
        for(const [other,otherState] of Object.entries(state.rooms))if(other!==room&&!Object.values(otherState.members).some(row=>row.participant_id===participant.id)) {
          let log
          // A damaged room gets no placeholder; its mail for this name comes back when the name joins it.
          try { log = records(other) } catch { continue }
          const unclaimed={...structuredClone(member),joined:false,after_cursor:log.length,received_cursor:0,deliveries:{},ring_times:[]}
          delete unclaimed.legacy_cursor
          enqueue(state,other,unclaimed,log)
          if(Object.keys(unclaimed.deliveries).length)otherState.members[agent]=unclaimed
        }
        reclaimRetired(state, participant.id, metadata, now(), records)
        return structuredClone(member)
      })
    },
    assertMember(room, agent, sessionId, participantId) { return transact((state) => structuredClone(requireMember(state, room, agent, sessionId, participantId))) },
    leave({ room, agent, sessionId, participantId }) {
      return transact((state) => { const member = requireMember(state, room, agent, sessionId, participantId); member.joined = false; member.left_reason = 'explicit'; rememberClaudeMembership(state,{room,agent:member.agent,session:member.session},false); preserveUnconfirmed(member); return { room, agent, joined: false } })
    },
    deactivateSession(sessionId, expected = {}, reason = 'session_closed') {
      return transact(state => {
        for (const rs of Object.values(state.rooms)) for (const member of Object.values(rs.members)) {
          if (member.joined && member.session.id === sessionId && Object.entries(expected).every(([key, value]) => member.session[key] === value)) {
            member.joined = false; member.left_reason = reason
            preserveUnconfirmed(member)
          }
        }
      })
    },
    memberships() {
      return transact(state => Object.entries(state.rooms).flatMap(([room, rs]) => Object.values(rs.members).map(member => ({ room, ...structuredClone(member) }))))
    },
    members({ room }) {
      identifier(room, 'room')
      return transact((state) => Object.values(state.rooms[room]?.members || {}).filter((member) => member.joined).map((member) => structuredClone(member)))
    },
    // Read-only reports for the members and unread tools. isLive must be synchronous.
    memberReport({ room, isLive, isClosed }) { identifier(room, 'room'); return transact(state => memberRows(state, room, now(), isLive, records, isClosed)) },
    unreadReport() { return transact(state => unreadRows(state, now(), records)) },
    pending({ room, agent, sessionId, participantId }) {
      return transact((state) => {
        const member = requireMember(state, room, agent, sessionId, participantId)
        reclaimRetired(state, member.participant_id, member.session, now(), records)
        return structuredClone(records(room).filter((record) => member.deliveries[record.id] && !['acked', 'received', 'handled'].includes(member.deliveries[record.id].status)).map((record) => ({ ...record, delivery: { ...member.deliveries[record.id] } })))
      })
    },
    ack({ room, agent, sessionId, participantId, message_ids }) {
      return this.updateDelivery({ room, agent, sessionId, participantId, message_ids, status: 'acked' })
    },
    // explain: return { ids, held } so an empty claim says why ('budget' or 'not_read_since_last_ring').
    claim({ room, agent, sessionId, participantId, message_ids, explain = false }) {
      if (!Array.isArray(message_ids) || !message_ids.length || message_ids.some((id) => typeof id !== 'string')) throw new Error('message_ids required')
      return transact((state) => {
        const member = requireMember(state, room, agent, sessionId, participantId)
        const claimed = [], held = reason => explain ? { ids: claimed, held: reason } : claimed
        const ring_at = now()
        member.ring_times = (member.ring_times ?? []).filter(time => time > ring_at - 600_000)
        state.ring_times = (state.ring_times ?? []).filter(time => time > ring_at - 600_000)
        if (member.ring_times.length >= 30 || state.ring_times.length >= 120) return held('budget')
        // Gate only doorbells whose content has not been returned to the agent.
        // An inbox result may be its last call, so delivered cannot block new mail.
        if (Object.values(member.deliveries).some(receipt => ['dispatching', 'notified'].includes(receipt.status) &&
            !(ring_at - (receipt.ring_at ?? Date.parse(receipt.updated)) >= staleRingMs))) return held('not_read_since_last_ring')
        const claim_id = crypto.randomUUID()
        const byId = indexed(room)
        for (const id of new Set(message_ids)) {
          const receipt = member.deliveries[id]
          if (!receipt) throw new Error('message not pending for this session')
          // Non-waking mail stays pending in the inbox, whatever the caller asks.
          const record = byId.get(id)
          if (!['pending', 'failed'].includes(receipt.status) || !record || !wakes(record)) continue
          // The durable claim never expires into an automatic retry: a crash has uncertain effects.
          receipt.status = 'dispatching'; receipt.claim_id = claim_id; receipt.ring_at = ring_at
          receipt.updated = stamp(); receipt.attempts++
          delete receipt.state; delete receipt.reason; delete receipt.detail
          claimed.push(id)
        }
        if (claimed.length) { member.ring_times.push(ring_at); state.ring_times.push(ring_at) }
        return held(undefined)
      })
    },
    // outcome: { state, reason?, detail? } from a delivery attempt. A reset to pending or a ring in
    // flight without one drops the old outcome; a read keeps how the mail got there.
    updateDelivery({ room, agent, sessionId, participantId, message_ids, status, error, outcome, release_claim = false, expected_claim_id }) {
      if (!['pending', 'dispatching', 'notified', 'delivered', 'failed', 'acked', 'received', 'handled'].includes(status)) throw new Error('invalid delivery status')
      if (!Array.isArray(message_ids) || !message_ids.length || message_ids.some((id) => typeof id !== 'string')) throw new Error('message_ids required')
      return transact((state) => {
        const member = requireMember(state, room, agent, sessionId, participantId)
        for (const id of message_ids) if (!member.deliveries[id]) throw new Error('message not pending for this session')
        if (expected_claim_id && message_ids.some(id => member.deliveries[id].claim_id !== expected_claim_id)) return []
        // Inbox delivery is stronger evidence than a delayed transport outcome.
        if(expected_claim_id&&message_ids.some(id=>['delivered','acked','received','handled'].includes(member.deliveries[id].status)))release_claim=false
        if (release_claim) {
          const stamps = new Set(message_ids.map(id => member.deliveries[id].ring_at))
          for (const stamp of stamps) {
            const index = member.ring_times?.indexOf(stamp) ?? -1
            if (index >= 0) member.ring_times.splice(index, 1)
            const projectIndex = state.ring_times?.indexOf(stamp) ?? -1
            if (projectIndex >= 0) state.ring_times.splice(projectIndex, 1)
          }
        }
        for (const id of new Set(message_ids)) {
          const receipt = member.deliveries[id]
          if(expected_claim_id&&receipt.status==='delivered'&&['pending','dispatching','notified','failed'].includes(status))continue
          if (['acked', 'received', 'handled'].includes(receipt.status) && status !== 'handled') continue
          receipt.status = status; receipt.updated = stamp()
          if (release_claim) { delete receipt.claim_id; delete receipt.ring_at }
          if (status === 'delivered' && !receipt.claim_id) receipt.attempts++
          if (error) receipt.error = String(error).slice(0, 1000); else delete receipt.error
          if (outcome) {
            receipt.state = outcome.state
            for (const field of ['reason', 'detail']) if (outcome[field]) receipt[field] = String(outcome[field]).slice(0, 1000); else delete receipt[field]
          } else if (['pending', 'dispatching', 'notified', 'failed'].includes(status)) { delete receipt.state; delete receipt.reason; delete receipt.detail }
        }
        // Old received and handled entries are compacted on write (read-index.mjs).
        const wanted = new Set(message_ids)
        return receiptRows(state, room, member.agent).filter((row) => wanted.has(row.message_id))
      })
    },
    // Only on the user's request. The caller needs no membership here and gets none: by is its
    // participant id, by_name its name. The recipient must not be joined anywhere in the project.
    dismiss({ room, agent, participantId: by, recipient, message_ids }) {
      identifier(room, 'room'); identifier(agent, 'agent'); identifier(recipient, 'recipient')
      if (typeof by !== 'string' || !by) throw new Error('invalid dismiss caller')
      if (message_ids !== undefined && (!Array.isArray(message_ids) || !message_ids.length || message_ids.some(id => typeof id !== 'string'))) throw new Error('invalid message_ids')
      return transact(state => {
        if (!roomExists(room)) throw new Error('room does not exist')
        // A room nobody joined or posted in through the store holds no open mail.
        const rs = state.rooms[room]
        if (!rs) { if (message_ids) throw new Error('message not open for this recipient'); return { room, recipient, dismissed: 0, message_ids: [] } }
        const messages = records(room)
        const sender = message => message.from_id ?? owner(state, message.from)?.id
        const ids = dismissMail(state, room, messages, { by, byName: state.participants[by]?.name ?? agent, recipient, recipientId: owner(state, recipient)?.id ?? null,
          messageIds: message_ids, rows: message => recipientStates(state, rs, message, sender(message)), at: stamp() })
        return { room, recipient, dismissed: ids.length, message_ids: ids }
      })
    },
    // Per-recipient read state for each message, including recipients without an entry.
    readStates({ room, message_id }) {
      identifier(room, 'room')
      return transact(state => records(room).filter(message => message_id === undefined || message.id === message_id).flatMap(message =>
        recipientStates(state, state.rooms[room], message, message.from_id ?? owner(state, message.from)?.id).map(row => ({ room, message_id: message.id, cursor: message.cursor, ...row }))))
    },
    // Mail this joined session sent in the room, newest last, with each recipient's state.
    sentStatus({ room, agent, sessionId, participantId }) {
      return transact(state => sentReport(state, room, requireMember(state, room, agent, sessionId, participantId).participant_id, records))
    },
    // The current name of whoever owns `name` now: a renamed session for its reserved old name.
    ownerName(name) { identifier(name, 'agent'); return transact(state => owner(state, name)?.name ?? null) },
    // 'closed' or 'not_in_room', for direct mail to a name that is not joined in the room.
    absentReason({ room, name }) {
      identifier(room, 'room'); identifier(name, 'agent')
      return transact(state => absentReason(state, state.rooms[room], owner(state, name)?.id))
    },
    deliveryStatus({ room, agent } = {}) {
      if (room) identifier(room, 'room'); if (agent) identifier(agent, 'agent')
      return transact((state) => receiptRows(state, room, agent))
    },
  }
}
