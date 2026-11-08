// lib/cycle.js — the computer-use CYCLE: identity, ownership, and the per-turn opening qualification.
//
// WHY THIS FILE EXISTS (agreed design, 2026-09-13; fixes A + B from the Codex review):
//
//   * A cycle is a fact about the MACHINE. It has an id, an OWNER (the session + agent that is
//     driving) and a state. The owner's identity does NOT include a turn: the same session driving
//     again next turn is still the owner, and a pause keeps its owner.
//   * A TURN is not an opener and not a reset. It only renews that session's *qualification* to open
//     one. The qualification is per (session, agent, turn) and is kept PER IDENTITY, so another
//     session's turn can neither renew it nor overwrite an already-consumed one.
//   * The qualification comes from the CALL ITSELF (`exec.session` / `exec.agent`), never from a
//     remembered `driverSession`: a brand-new session's first real call must be able to open a cycle
//     with no history at all, and another session's lifecycle events must not touch it.
//   * The first call of a turn CONSUMES the qualification even when nothing needs opening, so a late
//     call in the same turn can never try again — and once an exit has been seen in a turn, that turn
//     cannot open a cycle at all. The attempt itself is ONE shared settled-once promise per
//     qualification, so concurrent calls in a turn cannot slip an op into the worker's stdin ahead
//     of the `resume` that opens the cycle (build/test-cycle-gate.mjs measures that ordering).
//   * `ended` is terminal for that id. A new cycle needs a NEW qualification and gets a NEW id.
//     A later turn qualifies naturally; explicit successful owner completion can also requalify
//     that owner in the same turn. Ctrl+Alt+Q stays terminal for its turn. Neither a mouse event
//     nor a late callback can revive an ended cycle.
//
// NO MEMORY BOUND LIVES IN THIS FILE, AND THAT IS DELIBERATE (#5, 2026-09-13). A cap that evicts a
// consumed qualification is not a memory policy, it is a RE-AUTHORIZATION channel: after 64
// identities had come and gone, the oldest one's next call found no record of its consumed turn,
// looked brand new, ran the opener again and opened a cycle over a session that had already ended.
// Each identity keeps exactly ONE small entry — its current turn's qualification — which is the
// minimum this machine must remember to know whether a call may open a cycle. Entries are destroyed
// only on EVIDENCE that the identity is over (`forgetIdentity`, wired to agent/session disposal),
// and a forgotten identity is marked DEAD so a late call from it is refused rather than trusted.
//
// NO IDLE-TIME POLICY LIVES HERE. `openedAt`/`lastAt` are diagnostics only; a paused cycle is never
// transferred to another session because time passed ("暂停只能由人的恢复/终结解除，时间不是授权").
// Ownership is released by FACTS: the owner's turn completing, its agent going idle, its identity
// being disposed, or an exit. The separate leave timer (lib/leave-timer.js) is not an idle timeout:
// it is armed only when a non-computer tool starts while the cycle is open, cancelled by any actual
// computer_* start, retries refusals, and releases only the captured cycle id.

/** Session identity without assuming the host's shape (id may be a string, or a field on an object). */
export function sessionKeyOf (s) {
  if (!s) return null
  if (typeof s === 'string') return s
  return s.id || s.sessionId || s.sessionKey || s.key || null
}

/** Agent identity: the scope routing key is the agent object itself, so prefer its own id. */
export function agentKeyOf (a) {
  if (!a) return null
  if (typeof a === 'string') return a
  return a.id || a.agentId || a.key || null
}

export function createCycleGate ({
  sessionKey = sessionKeyOf,
  agentKey = agentKeyOf,
  now = () => Date.now(),
} = {}) {
  let nextId = 0
  let exitVersion = 0   // bumped by every `ended`: a pending open compares it before/after its await
  /** @type {{id:number, ownerIdent:string|null, ownerLabel:string, ownerSessionKey:string|null, ownerAgentKey:string|null, state:'open'|'paused'|'asking'|'releasing'|'ended', openedAt:number, lastAt:number, endedWhy:string}|null} */
  let cycle = null
  /** qualification PER IDENTITY: ident -> {turn, promise, dead}. One entry per identity, never evicted. */
  const idents = new Map()
  /** sessionKey -> turn generation, bumped ONLY by that session's own turn/start (never evicted) */
  const turns = new Map()
  /** ident -> the turn generation in which an exit was seen: that turn may not open a cycle */
  const endedTurns = new Map()
  const events = []   // bounded transition log for the guards and diagnostics
  const objectIds = new WeakMap()
  let nextObjectId = 0
  const identityKey = (value, preferred, kind) => {
    const key = preferred(value)
    if (key) return String(key)
    if (value && (typeof value === 'object' || typeof value === 'function')) {
      if (!objectIds.has(value)) objectIds.set(value, `${kind}-object-${++nextObjectId}`)
      return objectIds.get(value)
    }
    return null
  }

  const note = (what, detail) => {
    events.push({ at: now(), what, ...(detail || {}) })
    if (events.length > 96) events.shift()
  }

  const identOf = (sessionKeyVal, agentKeyVal) => JSON.stringify([sessionKeyVal, agentKeyVal])

  /** A claim is what the CALL brings: whose call it is, and which of that session's turns it is in. */
  function claim ({ session, agent } = {}) {
    const sk = identityKey(session, sessionKey, 'session')
    const ak = identityKey(agent, agentKey, 'agent')
    const turn = (sk && turns.get(sk)) || 0
    const ident = identOf(sk, ak)
    return {
      sessionKey: sk,
      agentKey: ak,
      turn,
      ident,
      // Ownership identity (no turn) and qualification identity (with turn) are DIFFERENT things.
      label: `${sk || 'unknown-session'}/${ak || 'unknown-agent'}`,
      qualKey: `${ident}#t${turn}`,
    }
  }

  /** Renewed by THAT session's turn/start only. Another session's event must not touch it (B). */
  function noteTurnStart (session) {
    const sk = identityKey(session, sessionKey, 'session')
    if (!sk) return 0
    const n = (turns.get(sk) || 0) + 1
    turns.set(sk, n)
    note('turn-start', { session: sk, turn: n })
    return n
  }

  const isLive = (c) => !!c && c.state !== 'ended'
  const ownedBy = (c, cl) => !!c && c.ownerIdent === cl.ident
  const ownerLabel = () => (cycle ? `${cycle.ownerLabel}#${cycle.id}` : 'none')

  function rememberEndedTurn (cl) {
    if (!cl) return
    endedTurns.set(cl.ident, cl.turn)
    note('ended-in-turn', { ident: cl.ident, turn: cl.turn })
  }

  /**
   * An identity is OVER (its agent/session was disposed). This is the only way an entry is destroyed,
   * and the entry is left as a TOMBSTONE rather than deleted: forgetting it would make a late call
   * from a dead execution look brand new — and "brand new" is exactly what may open a cycle.
   */
  function forgetIdentity ({ session, agent } = {}) {
    const cl = claim({ session, agent })
    const e = idents.get(cl.ident) || { turn: cl.turn, promise: null }
    e.dead = true
    idents.set(cl.ident, e)
    let released = false
    if (isLive(cycle) && cycle.ownerIdent === cl.ident) released = mark('ended', { why: 'owner identity disposed' })
    note('identity-forgotten', { ident: cl.ident, released })
    return { ident: cl.ident, released }
  }

  /**
   * The ONE entry point every computer_* call goes through.
   * Throws (tagged `dshCycleRefusal`) when another LIVE cycle owns this machine: that is a refusal,
   * not a warning — lib/tools.js rethrows it so the call fails loudly instead of driving anyway.
   */
  function open (cl, openFn) {
    if (!cl.sessionKey && !cl.agentKey) {
      const err = new Error('COMPUTER_OWNER_REQUIRED: computer-use requires a stable session or agent identity; no operation was dispatched.')
      err.dshCycleRefusal = true
      err.code = 'COMPUTER_OWNER_REQUIRED'
      err.outcome = 'not-dispatched'
      throw err
    }
    // A live cycle with NO owner is a pause/ask that arrived before any call claimed the machine.
    // Ownership is free: the next real call adopts it. Only a cycle owned by a DIFFERENT session is
    // a refusal.
    if (isLive(cycle) && cycle.ownerIdent === null) {
      cycle.ownerIdent = cl.ident
      cycle.ownerLabel = cl.label
      cycle.ownerSessionKey = cl.sessionKey
      cycle.ownerAgentKey = cl.agentKey
      note('adopted-ownerless', { id: cycle.id, by: cl.label, state: cycle.state })
    }
    if (isLive(cycle) && !ownedBy(cycle, cl)) {
      const err = new Error(
        `this machine is owned by another computer-use cycle (owner ${cycle.ownerLabel}, cycle ` +
        `#${cycle.id}, state ${cycle.state}) — a session that is not the owner must not drive it. ` +
        'Keep this task pending until the owner finishes or explicitly releases computer use, then retry.')
      err.dshCycleRefusal = true
      note('refused-foreign', { owner: cycle.ownerLabel, id: cycle.id, by: cl.label })
      throw err
    }
    if (isLive(cycle) && (cycle.state === 'releasing' || cycle.terminating)) {
      const err = new Error('COMPUTER_CYCLE_RELEASING: the owning agent is releasing computer use. Wait for release to finish before starting a fresh cycle.')
      err.dshCycleRefusal = true; err.code = 'COMPUTER_CYCLE_RELEASING'; err.outcome = 'not-dispatched'
      throw err
    }

    // ONE qualification per (session, agent, turn), kept per identity and NEVER evicted.
    let e = idents.get(cl.ident)
    if (e && e.dead) {
      const err = new Error(
        `this computer-use execution identity is over (${cl.label}) — its agent or session was ` +
        'disposed, so a late call from it may not open a cycle. Start the work in a live session.')
      err.dshCycleRefusal = true
      note('refused-dead-identity', { ident: cl.ident })
      throw err
    }
    if (!e || e.turn !== cl.turn) {
      e = { turn: cl.turn, promise: null, dead: false }
      idents.set(cl.ident, e)
    }
    if (e.promise) return e.promise     // already consumed this turn: nothing new is created

    // FIRST call of this (session, agent, turn).
    if (endedTurns.get(cl.ident) === cl.turn) {
      // An exit was seen inside THIS turn: a late call may not open a new cycle. The call itself is
      // not refused — observation still works, and a driving op is refused by the worker, whose own
      // record is still on disk and whose message names the cycle.
      e.promise = Promise.resolve({ opened: false, reason: 'the cycle was ended in this turn' })
      note('blocked-after-end', { ident: cl.ident, turn: cl.turn })
      return e.promise
    }

    // Ownership is RESERVED synchronously, before any await: otherwise two concurrent calls could
    // both see "no cycle" and both believe they opened one. A NEW id is created only here — on the
    // first call of a turn — never by a late call, and never for a live cycle that just changes hands.
    if (!isLive(cycle)) {
      cycle = {
        id: ++nextId, ownerIdent: cl.ident, ownerLabel: cl.label,
        ownerSessionKey: cl.sessionKey, ownerAgentKey: cl.agentKey,
        state: 'open', openedAt: now(), lastAt: now(), endedWhy: '',
      }
      note('opened', { id: cycle.id, owner: cl.label })
    } else {
      cycle.lastAt = now()      // diagnostics only: no policy reads this
    }

    // THE OPENING IS VALIDATED ON BOTH SIDES OF ITS AWAIT (#6, 2026-09-13). Capturing the exit
    // version before the opener runs is not enough: the opener can take arbitrarily long (a worker
    // spawn, a slow stdin write), and an exit that lands IN THAT WINDOW must void the opening even
    // though `openFn` — and its `resume` op — already went out. A pending open whose cycle ended
    // underneath it reports `voided`, never "opened", and the caller's next call in this turn still
    // awaits the same settled promise rather than trying again.
    const openedVersion = exitVersion
    const openedId = cycle.id
    // CHECK ON BOTH SIDES OF THE OPENER (#6). The first check runs BEFORE `openFn` is called at all:
    // an exit that landed while this call was queued must mean no opener is even attempted — no
    // `resume` op, no worker call, no external side effect to undo. The second check runs after the
    // opener's await, because the opener itself can take arbitrarily long (a worker spawn, a slow
    // stdin write) and an exit inside THAT window has to void the opening too.
    const voided = (when) => ({ opened: false, voided: true, reason: `an exit landed ${when}` })
    // THE MINIMAL FIX (#7, Codex review 2026-09-13): the pre-check and the CALL to openFn are one
    // synchronous block — no `.then`, no `await` between them. They used to be separated by
    // `return Promise.resolve().then(() => openFn())`, and that microtask gap was the bug: an exit
    // that had ALREADY happened before openFn ran still got an opener started (its side effect went
    // out, and only the result was voided afterwards).
    //
    // What is NOT required, and deliberately not done: making a caller's later microtask win the
    // race. Microtasks are FIFO, so an end signalled after `open()` returns may legitimately land
    // after the opener has started — "opener runs, then the exit voids its result" is a legal order,
    // and forcing it the other way would need a macrotask delay on the cycle-opening path. The two
    // checks below are exactly the two things that must hold: an ALREADY-ended cycle starts nothing
    // (pre-check), and an opener that is still in flight when the exit lands is voided (post-await).
    e.promise = Promise.resolve()
      .then(() => {
        if (exitVersion !== openedVersion || !cycle || cycle.id !== openedId || cycle.state === 'ended') {
          note('open-cancelled-before-run', { key: cl.qualKey, exitVersion, was: openedVersion })
          return voided('before this cycle was opened')
        }
        const started = (typeof openFn === 'function') ? openFn() : undefined
        return Promise.resolve(started).then((outcome) => {
          if (exitVersion !== openedVersion || !cycle || cycle.id !== openedId || cycle.state === 'ended') {
            note('open-voided', { key: cl.qualKey, exitVersion, was: openedVersion })
            return voided('while this cycle was being opened')
          }
          note('qualification-used', { key: cl.qualKey, opened: !!(outcome && outcome.opened) })
          return outcome
        })
      })
    // Keep an inert handler: a rejection nobody awaits must never surface as an unhandled rejection
    // inside the host. Callers still see the rejection — that is the point.
    e.promise.catch(() => {})
    return e.promise
  }

  /**
   * Worker/host-derived state. Only these transitions move `state`; `open()` never does.
   * `attribution` names whose turn this transition belongs to (used to block that turn from opening).
   */
  function mark (state, detail) {
    if (!['open', 'paused', 'asking', 'ended'].includes(state)) return false
    const attribution = detail && (detail.session || detail.agent)
      ? claim({ session: detail.session, agent: detail.agent })
      : null
    if (!cycle) {
      // A brake/ask/exit with no cycle yet: the record exists with no owner, so ownership is free
      // until the next real call claims it — which is what "no session owns this machine" means.
      cycle = {
        id: ++nextId, ownerIdent: null, ownerLabel: 'none',
        ownerSessionKey: null, ownerAgentKey: null,
        state, openedAt: now(), lastAt: now(), endedWhy: '',
      }
    } else {
      if (cycle.state === 'ended' && state !== 'ended') return false   // ended is terminal for this id
      cycle.state = state
      cycle.lastAt = now()
    }
    if (state === 'ended') {
      exitVersion++            // every exit invalidates any opening that is still in flight (#6)
      cycle.endedWhy = (detail && detail.why) || ''
      // WHICH TURN SAW THE EXIT: the attributing session's current turn when we were told, else the
      // owner's. That turn's late calls are blocked from opening (above) — no timer involved.
      const sk = (attribution && attribution.sessionKey) || cycle.ownerSessionKey
      const ak = (attribution && attribution.agentKey) || cycle.ownerAgentKey
      if (sk || ak) rememberEndedTurn(claim({ session: sk, agent: ak ? { id: ak } : null }))
    }
    note('state', { id: cycle.id, state, why: (detail && detail.why) || '' })
    return true
  }

  return {
    claim,
    noteTurnStart,
    open,
    // Recheck the original call's claim after every async wait. Re-deriving it
    // would silently give an old tool the identity of a newer turn.
    assertOwnership (cl, expectedCycleId) {
      const currentTurn = (cl.sessionKey && turns.get(cl.sessionKey)) || 0
      if (!isLive(cycle) || cycle.state === 'releasing' || cycle.terminating || !ownedBy(cycle, cl) || cycle.id !== expectedCycleId ||
          cl.turn !== currentTurn || idents.get(cl.ident)?.dead) {
        const err = new Error('COMPUTER_OWNER_CHANGED: this call no longer owns the active computer-use cycle. No further input was dispatched; only the current owner may continue.')
        err.dshCycleRefusal = true
        err.code = 'COMPUTER_OWNER_CHANGED'
        err.outcome = 'not-dispatched'
        throw err
      }
      return true
    },
    // Complete the machine cycle without ending the chat. The intermediate state
    // closes the async gap while the native worker releases its lease.
    beginCompletion (cl, expectedCycleId) {
      this.assertOwnership(cl, expectedCycleId)
      if (cycle.state !== 'open') {
        const err = new Error('COMPUTER_CYCLE_PAUSED: a human pause or active question keeps computer-use ownership; resume it before voluntarily releasing the cycle.')
        err.dshCycleRefusal = true; err.code = 'COMPUTER_CYCLE_PAUSED'; err.outcome = 'not-dispatched'
        throw err
      }
      const token = { cycleId: cycle.id, ident: cl.ident, turn: cl.turn, exitVersion }
      cycle.completion = token
      cycle.state = 'releasing'
      note('completion-started', { id: cycle.id, owner: cl.label })
      return token
    },
    // Host cancellation/disposal ends this turn's right to input immediately,
    // but holds ownership until native cleanup finishes. A manual pause keeps its
    // latch; after R the deferred terminal cleanup runs without waking that task.
    beginTermination (cl, expectedCycleId, why, hold = false) {
      if (!isLive(cycle) || !ownedBy(cycle, cl) || cycle.id !== expectedCycleId) return null
      cycle.terminating = true
      rememberEndedTurn(cl)
      if (hold || cycle.state === 'paused' || cycle.state === 'asking') return { deferred: true }
      if (cycle.state === 'releasing' && cycle.completion) {
        cycle.completion.terminal = true; cycle.completion.why = why
        return { joined: true, token: cycle.completion }
      }
      const token = { cycleId: cycle.id, ident: cl.ident, turn: cl.turn, exitVersion, terminal: true, why }
      cycle.completion = token; cycle.state = 'releasing'
      note('termination-started', { id: cycle.id, owner: cl.label, why })
      return { token }
    },
    finishCompletion (token) {
      if (!cycle || cycle.completion !== token || cycle.state !== 'releasing' ||
          cycle.id !== token.cycleId || exitVersion !== token.exitVersion) return false
      cycle.state = 'ended'
      cycle.endedWhy = token.terminal ? token.why : 'owner completed computer use; chat remains active'
      cycle.lastAt = now()
      cycle.completion = null
      exitVersion++
      const e = idents.get(token.ident)
      if (!token.terminal && e && !e.dead && e.turn === token.turn) e.promise = null
      note('completed', { id: cycle.id, owner: cycle.ownerLabel })
      return true
    },
    cancelCompletion (token) {
      if (!cycle || cycle.completion !== token || cycle.state !== 'releasing' ||
          cycle.id !== token.cycleId || exitVersion !== token.exitVersion) return false
      cycle.state = 'open'; cycle.completion = null
      note('completion-failed', { id: cycle.id })
      return true
    },
    mark,
    forgetIdentity,
    snapshot: () => ({
      id: cycle ? cycle.id : 0,
      state: cycle ? cycle.state : 'none',
      owner: cycle ? cycle.ownerLabel : 'none',
      ownerIdent: cycle ? cycle.ownerIdent : null,
      ownerSessionKey: cycle ? cycle.ownerSessionKey : null,
      ownerAgentKey: cycle ? cycle.ownerAgentKey : null,
      endedWhy: cycle ? cycle.endedWhy : '',
      exitVersion,
      qualifications: [...idents.entries()].map(([ident, e]) => ({ ident, turn: e.turn, used: !!e.promise, dead: !!e.dead })),
      endedTurns: Object.fromEntries(endedTurns),
      turns: Object.fromEntries(turns),
      events: events.slice(),
    }),
    /** Is this claim the owner of the live cycle? (event handlers use it to stay out of others' way) */
    owns: (cl) => ownedBy(cycle, cl),
    isLive: () => isLive(cycle),
    state: () => (cycle ? cycle.state : 'none'),
    /** Bumped by every `ended`: a caller may capture it and re-check before acting on a stale plan. */
    exitVersion: () => exitVersion,
    /** The owning SESSION/AGENT, so host-wide events can be attributed without re-deriving a claim. */
    ownerSessionKey: () => (cycle ? cycle.ownerSessionKey : null),
    ownsAgent: (ak) => !!cycle && !!ak && cycle.ownerAgentKey === ak,
    ownsSession: (sk) => !!cycle && !!sk && cycle.ownerSessionKey === sk,
    /** Release ownership on a FACT (session/agent disposed) — never on elapsed time. */
    release (why) {
      if (!isLive(cycle)) return false
      return mark('ended', { why: why || 'owner released the machine' })
    },
    ownerLabel,
  }
}
