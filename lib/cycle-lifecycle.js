// Finishing desktop work releases the machine without cancelling the conversation.
export function createCycleLifecycle ({ gate, cu, claimOf, owner, paused, inFlight, ownershipOf = () => null }) {
  const refusal = reason => ({ released: false, reason, conversationContinues: true })
  let pendingCompletion = null

  async function release (exec, why = 'desktop work finished', automatic = false, expected) {
    if (!gate.isLive()) return { released: false, alreadyReleased: true, conversationContinues: true }
    const ownership = expected || ownershipOf(exec) || { claim: claimOf(exec), cycleId: gate.snapshot().id }
    const { claim, cycleId } = ownership
    gate.assertOwnership(claim, cycleId)
    if (paused() || cu.exited || cu.cooperation?.active) return refusal('a manual pause, question, exit, or active human handoff still owns this cycle')
    if (inFlight() > (automatic ? 0 : 1)) return refusal('computer-use calls are still in flight')
    const token = gate.beginCompletion(claim, cycleId)
    try {
      const result = await cu.calm({ beforeDispatch: () => {
        const current = gate.snapshot()
        if (current.id !== token.cycleId || current.state !== 'releasing' || current.ownerIdent !== token.ident ||
            current.exitVersion !== token.exitVersion) {
          throw Object.assign(new Error('COMPUTER_OWNER_CHANGED: this cleanup no longer owns the releasing cycle; no cleanup was dispatched.'),
            { code: 'COMPUTER_OWNER_CHANGED', outcome: 'not-dispatched' })
        }
      } })
      if (result?.released === false || paused() || cu.exited) {
        gate.cancelCompletion(token)
        return refusal(result?.reason || 'a newer pause or exit superseded completion')
      }
      const released = gate.finishCompletion(token)
      return { released, ...(released ? {} : { reason: 'a newer cycle state superseded completion' }),
        conversationContinues: true, cycleEnded: released,
        message: released ? 'Computer-use control and monitoring released. Continue the conversation normally; a later required desktop call may acquire a fresh cycle.' : 'The current cycle state remains authoritative.' }
    } catch (error) {
      gate.cancelCompletion(token)
      throw error
    }
  }

  function settle () {
    if (!pendingCompletion || inFlight() !== 0) return null
    const pending = pendingCompletion
    try { gate.assertOwnership(pending.ownership.claim, pending.ownership.cycleId) }
    catch { pendingCompletion = null; return null } // Old events cannot close a newer turn or cycle.
    if (paused() || cu.exited) { pendingCompletion = null; return null }
    if (cu.cooperation?.active) return null // Handback will drain this same captured completion.
    pendingCompletion = null
    return release(pending.exec, pending.why, true, pending.ownership)
  }

  function requestCompletion (exec, why) {
    if (!exec?.agent || paused() || !gate.isLive() || gate.state() !== 'open') return null
    pendingCompletion = { exec, why, ownership: { claim: claimOf(exec), cycleId: gate.snapshot().id } }
    return settle()
  }

  function completeTurn (session, kind = 'completed') {
    if (kind === 'aborted' || kind === 'interrupted' || !gate.ownsSession(claimOf({ session }).sessionKey)) return null
    const exec = owner()
    return requestCompletion(exec, `owner turn ${kind}`)
  }

  function idle (agent) {
    if (!agent || !gate.ownsAgent(claimOf({ agent }).agentKey)) return null
    return requestCompletion(owner(), 'owner finished desktop work')
  }

  return { release, completeTurn, idle, settle }
}
