// The 100 s leave timer is the deterministic backstop behind the cycle-boundary skill.
// It must never release a newer cycle, never arm for a foreign caller, never consume a refused
// release, and never add a model/tool round trip for a quick read→compute→type helper.
import assert from 'node:assert/strict'
import { createLeaveTimer, LEAVE_TOOL_EXEMPT } from '../lib/leave-timer.js'

const GRACE = 100_000
const RETRY = 10_000
const ownerExec = (name = 'pwsh') => ({ name, session: 'S', agent: { id: 'A' } })
const foreignExec = (name = 'pwsh') => ({ name, session: 'X', agent: { id: 'B' } })

function harness ({ releaseImpl } = {}) {
  let now = 0
  let state = 'open'
  let cycleId = 1
  const timers = new Set()
  const calls = []
  const notices = []
  const setTimer = (fn, ms) => { const t = { at: now + ms, fn, unref () {} }; timers.add(t); return t }
  const clearTimer = t => timers.delete(t)
  const advance = ms => {
    const end = now + ms
    for (;;) {
      const due = [...timers].filter(t => t.at <= end).sort((a, b) => a.at - b.at)[0]
      if (!due) break
      timers.delete(due)
      now = due.at
      due.fn()
    }
    now = end
  }
  const sessionKey = e => (typeof e === 'object' ? e?.id || e?.sessionId || null : e || null)
  const agentKey = e => (typeof e === 'object' ? e?.id || e?.agentId || null : null)
  const claimOf = e => ({
    sessionKey: sessionKey(e?.session) || sessionKey(e?.sessionId) || sessionKey(e?.agent?.session) || null,
    agentKey: agentKey(e?.agent) || agentKey(e?.agentId) || null,
    ident: `${sessionKey(e?.session) || ''}/${agentKey(e?.agent) || ''}`,
  })
  const gate = {
    isLive: () => state === 'open' || state === 'paused',
    state: () => state,
    snapshot: () => ({ id: cycleId }),
    ownsAgent: ak => ak === 'A',
    ownsSession: sk => sk === 'S',
  }
  const timer = createLeaveTimer({
    gate, claimOf, graceMs: GRACE, retryMs: RETRY, setTimer, clearTimer,
    log: { info () {}, warn () {} },
    notice: (...args) => { notices.push(args) },
    release: (exec, why, automatic, expected) => {
      calls.push({ exec, why, automatic, expected })
      return releaseImpl ? releaseImpl(calls.length, { exec, why, automatic, expected }) : { released: true }
    },
  })
  return { timer, calls, notices, advance, setState: s => { state = s }, setCycleId: id => { cycleId = id } }
}

const t = (name, fn) => {
  try { fn(); console.log(`  ok ${name}`) } catch (error) { console.error(`  FAIL ${name}: ${error.message}`); process.exitCode = 1 }
}

t('a quick helper inside the grace never releases; an owner computer start cancels', () => {
  const h = harness()
  h.timer.observe(ownerExec())
  h.advance(GRACE - 1)
  assert.equal(h.calls.length, 0)
  h.timer.cancel(ownerExec('computer_state'))
  h.advance(GRACE * 2)
  assert.equal(h.calls.length, 0)
})

t('a computer call cancels before its approval window, so the grace cannot fire underneath it', () => {
  const h = harness()
  h.timer.observe(ownerExec())
  h.advance(90_000)
  h.timer.observe(ownerExec('computer_state')) // pre-execute, approval pending
  h.advance(GRACE * 2)
  assert.equal(h.calls.length, 0)
})

t('the timer re-arms after a cancel and fires exactly once', () => {
  const h = harness()
  h.timer.observe(ownerExec())
  h.timer.cancel(ownerExec('computer_state'))
  h.timer.observe(ownerExec())
  h.advance(GRACE)
  assert.equal(h.calls.length, 1)
  assert.equal(h.calls[0].expected.cycleId, 1)
  assert.equal(h.calls[0].expected.claim.agentKey, 'A')
  assert.equal(h.calls[0].expected.claim.sessionKey, 'S')
})

t('no reset while continuously away: the first leave starts the grace', () => {
  const h = harness()
  h.timer.observe(ownerExec())
  h.advance(GRACE - 10)
  h.timer.observe(ownerExec('web_fetch'))
  h.advance(10)
  assert.equal(h.calls.length, 1)
})

t('exempt local bookkeeping never arms, even for a long think', () => {
  const h = harness()
  for (const name of ['todo_write', 'read', 'write', 'run_code', 'ask_user_question', 'terminal_read']) {
    assert.equal(LEAVE_TOOL_EXEMPT.has(name), true)
    h.timer.observe(ownerExec(name))
  }
  h.advance(GRACE * 3)
  assert.equal(h.calls.length, 0)
})

t('foreign callers cannot arm, cancel, or release the owner cycle', () => {
  const h = harness()
  h.timer.observe(foreignExec())
  h.advance(GRACE)
  assert.equal(h.calls.length, 0)
  h.timer.observe(ownerExec())
  h.timer.cancel(foreignExec('computer_state'))
  h.advance(GRACE)
  assert.equal(h.calls.length, 1)
})

t('a paused cycle is not armed, and an already-armed timer cannot release through a pause', () => {
  const h = harness({ releaseImpl: () => ({ released: false, reason: 'paused' }) })
  h.setState('paused')
  h.timer.observe(ownerExec())
  h.advance(GRACE)
  assert.equal(h.calls.length, 0)
  h.setState('open')
  h.timer.observe(ownerExec())
  h.advance(GRACE)
  assert.equal(h.calls.length, 1)
  h.advance(RETRY)
  assert.equal(h.calls.length, 2) // a refused release is retried, not consumed
})

t('a refusal that later succeeds retries and stops', () => {
  let releases = 0
  const h = harness({ releaseImpl: () => (++releases === 1 ? { released: false, reason: 'in-flight' } : { released: true }) })
  h.timer.observe(ownerExec())
  h.advance(GRACE)
  assert.equal(h.calls.length, 1)
  h.advance(RETRY)
  assert.equal(h.calls.length, 2)
  h.advance(RETRY * 3)
  assert.equal(h.calls.length, 2)
})

t('a stale cycle/owner change stops retrying and never touches the new cycle', () => {
  const h = harness({ releaseImpl: () => { const e = new Error('owner changed'); e.code = 'COMPUTER_OWNER_CHANGED'; throw e } })
  h.timer.observe(ownerExec())
  h.advance(GRACE)
  assert.equal(h.calls.length, 1)
  h.setCycleId(2)
  h.advance(RETRY * 3)
  assert.equal(h.calls.length, 1)
})

t('turn end, agent disposal and plugin disposal clear the timer', () => {
  const h = harness()
  h.timer.observe(ownerExec())
  h.timer.onTurnEnd({ id: 'S' })
  h.advance(GRACE)
  assert.equal(h.calls.length, 0)
  h.timer.observe(ownerExec())
  h.timer.onAgentDisposed({ id: 'A' })
  h.advance(GRACE)
  assert.equal(h.calls.length, 0)
  h.timer.observe(ownerExec())
  h.timer.dispose()
  h.advance(GRACE)
  assert.equal(h.calls.length, 0)
})

t('a successful automatic release emits one visible notice', () => {
  const h = harness()
  h.timer.observe(ownerExec())
  h.advance(GRACE)
  assert.equal(h.calls.length, 1)
  assert.equal(h.notices.length, 1)
})

t('grace 0 disables the timer completely', () => {
  const h = harness()
  const disabled = createLeaveTimer({
    gate: { isLive: () => true, state: () => 'open', snapshot: () => ({ id: 1 }), ownsAgent: () => true, ownsSession: () => true },
    claimOf: () => ({ agentKey: 'A', sessionKey: 'S' }),
    release: () => { throw new Error('must not release') },
    graceMs: 0, setTimer: () => { throw new Error('must not arm') },
  })
  disabled.observe(ownerExec())
  assert.equal(h.calls.length, 0)
})

if (process.exitCode) process.exit(process.exitCode)
console.log('ok test-leave-timer — 100 s leave timer is owner-scoped, cancellable, retries refusals, and never releases a newer cycle')
