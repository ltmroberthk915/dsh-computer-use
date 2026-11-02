// Keep ownership reserved until cancelled/disposed native work has drained.
export function createTerminalCleanup ({ gate, cu, claimOf, owner, paused, report }) {
  let pending = null, running = null
  const failure = error => report?.(error)
  function drain () {
    if (!pending || running) return running
    const request = pending, snapshot = gate.snapshot()
    if (!gate.isLive() || snapshot.id !== request.cycleId || snapshot.ownerIdent !== request.claim.ident) {
      pending = null
      return null
    }
    const started = gate.beginTermination(request.claim, request.cycleId, request.why, paused())
    if (!started || started.deferred) return null
    if (started.joined) { pending = null; return null }
    const beforeDispatch = () => {
      const current = gate.snapshot()
      if (current.id !== request.cycleId || current.state !== 'releasing' || current.ownerIdent !== request.claim.ident) {
        const error = new Error('terminal cleanup was superseded before native dispatch')
        error.code = 'COMPUTER_OWNER_CHANGED'
        throw error
      }
    }
    running = Promise.resolve().then(async () => {
      try {
        beforeDispatch()
        const result = await cu.calm({ beforeDispatch })
        if (result?.released === false || paused()) {
          gate.cancelCompletion(started.token)
          return false
        }
        const ended = gate.finishCompletion(started.token)
        if (pending === request) pending = null
        return ended
      } catch (error) {
        gate.cancelCompletion(started.token)
        failure(error)
        return false
      } finally { running = null }
    })
    return running
  }
  return {
    request (why, exec = owner()) {
      const snapshot = gate.snapshot(), claim = claimOf(exec)
      if (!gate.isLive() || snapshot.ownerIdent !== claim.ident) return null
      pending = { claim, cycleId: snapshot.id, why }
      cu.cancelInputs?.()
      return drain()
    },
    resumePending () {
      if (!pending) return false
      drain()
      return true
    },
    forget () { pending = null },
  }
}
