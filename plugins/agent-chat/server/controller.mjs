import { wakes, readState } from './message-policy.mjs'
// A post causes one bounded delivery attempt. There is no idle timer or model loop.
// cancelGraceMs: how long a cancelled delivery gets to finish the step it's in. A Codex presence
// check can't be cancelled and takes up to 3 s, so the grace covers it.
export function createController({ store, adapters, dispatchTimeoutMs = 20_000, cancelGraceMs = 5_000 }) {
  return {
    async dispatch(room) {
      const results = []
      // Only an already registered logical Codex session can be rearmed. This
      // also repairs records closed by an older MCP-process liveness check on
      // an ordinary later post, without an MCP reconnect or model rejoin.
      if (adapters.alive) for (const member of store.memberships()) {
        if (member.room !== room || member.joined || member.left_reason !== 'session_closed' || member.session.runtime !== 'codex' || !Object.values(member.deliveries).some(receipt=>receipt.status==='pending')) continue
        try {
          if (await adapters.alive(member.session, store.projectRoot)) {
            const { serverPid, serverStart, ...session } = member.session
            store.join({ room, agent: member.agent, session })
          }
        } catch { /* Unknown presence retains mail without granting a new owner. */ }
      }
      await Promise.all(store.members({ room }).map(async member => {
        const identity = { room, agent: member.agent, sessionId: member.session.id, participantId:member.participant_id }
        const inbox = store.pending(identity)
        const pending = inbox.filter(message => message.delivery.status === 'pending' && wakes(message))
        // FYI mail never rings; the next real ring counts it, by ID only.
        const quiet = inbox.filter(message => !wakes(message) && readState(message.delivery.status) === 'unread')
        const fyi = quiet.length ? { fyi: { count: quiet.length, message_ids: quiet.slice(0, 50).map(message => message.id) } } : {}
        // One doorbell directs the receiver to the entire durable inbox.
        if (!pending.length) return
        const ids = store.claim({ ...identity, message_ids: pending.map(message => message.id) })
        if (!ids.length) {
          results.push({ agent: member.agent, transport: 'pending', detail: 'Awaiting receipt or automatic ring budget; unread mail is retained.' })
          return
        }
        const claimId = store.assertMember(room, member.agent, member.session.id,member.participant_id).deliveries[ids[0]].claim_id
        let outcome, timer
        const cancellation = new AbortController()
        try {
          const delivery = adapters.deliver({ session: member.session,
            messages: pending.filter(message => ids.includes(message.id)), ...fyi, room, project: store.project,
            agent: member.agent, projectRoot: store.projectRoot, signal:cancellation.signal })
          outcome = await Promise.race([delivery, new Promise(resolve => { timer = setTimeout(() => { cancellation.abort(); resolve(null) }, dispatchTimeoutMs) })])
          // Cancelled at the deadline, an adapter that sent nothing yet answers at once. Recording
          // that as notified would hold the member silent for the whole ring-claim window.
          if (outcome === null) {
            const settled = await Promise.race([delivery, new Promise(resolve => { timer = setTimeout(resolve, cancelGraceMs, null) })])
            outcome = settled?.attempted === false ? settled : { status: 'pending', detail: 'Delivery deadline reached; outcome uncertain, inbox retained.' }
          }
        } catch { outcome = { status: 'pending', detail: 'Delivery outcome uncertain; inbox retained.' } }
        finally { clearTimeout(timer) }
        // Uncertain writes are not retried automatically. A receiver can still fetch and ack.
        // An explicit retry can duplicate a doorbell, never a canonical message ID.
        try {
          const updated = store.updateDelivery({ ...identity, message_ids: ids, expected_claim_id: claimId, status: outcome.attempted === false ? 'pending' : 'notified', error: outcome.detail, release_claim: outcome.attempted === false })
          if (outcome.offline && updated.length) store.deactivateSession(member.session.id, member.session)
        } catch {
          // Membership may have left while native I/O was active. Claimed records remain durable.
        }
        results.push({ agent: member.agent, message_ids: ids, transport: outcome.status, detail: outcome.detail })
      }))
      return results
    },
    retry(identity, message_ids) {
      store.updateDelivery({ ...identity, message_ids, status: 'pending' })
      return this.dispatch(identity.room)
    },
  }
}
