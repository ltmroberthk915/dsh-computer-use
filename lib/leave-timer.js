// lib/leave-timer.js — the deterministic backstop for a cycle that is left open.
//
// WHY THIS EXISTS (2026-11-08). The skill's cycle-boundary rule is a decision rule, not an
// enforcement mechanism: an agent can copy a desktop artifact and then run a long shell/network
// command without releasing. The desktop lease then stays open, the border stays lit and every
// other agent is blocked. The plugin already sees every top-level tool call, so when the agent
// stays away from the desktop for long enough we release the lease ourselves.
//
// WHAT THIS IS NOT. It is not an idle timeout: mere thinking never arms it, and a paused/asking
// cycle is never released by time. It is armed only when a tool that is not part of the desktop
// block starts, then cancelled by any later computer_* call. A quick read → compute → type flow
// therefore never releases, while a six-minute publish releases after the grace. Ownership is
// captured at arm time and passed to release as the expected cycle, so a late timer can never
// release a newer cycle. A refused release (pause/handoff/in-flight) is retried instead of being
// silently consumed.

/** Local bookkeeping / cheap inspection helpers that must not arm the leave timer. */
export const LEAVE_TOOL_EXEMPT = new Set([
  'todo_write',
  'read',
  'write',
  'edit',
  'glob',
  'grep',
  'run_code', // may wrap computer_* calls; the block-boundary skill covers that host shape
  'ask_user_question',
  'terminal_read',
  'terminal_list',
  'terminal_close',
])

/** Desktop observation helpers: using one means the agent is still in the desktop block. */
const DESKTOP_HELPERS = new Set(['see_now', 'read_image'])

export function createLeaveTimer ({
  gate,
  claimOf,
  release,
  graceMs = 100_000,
  retryMs = 10_000,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  log = { info () {}, warn () {} },
  notice = () => {},
} = {}) {
  let timer = null
  let retryTimer = null
  let armed = null
  let pending = null
  let disposed = false

  const unref = t => { try { t?.unref?.() } catch { /* host timer */ } }
  const stop = t => { try { if (t) clearTimer(t) } catch { /* already gone */ } }
  const isLive = () => !disposed && !!gate?.isLive?.()
  const isOpen = () => isLive() && gate?.state?.() === 'open'
  const owned = claim => !!claim && (
    (!!claim.agentKey && !!gate?.ownsAgent?.(claim.agentKey)) ||
    (!!claim.sessionKey && !!gate?.ownsSession?.(claim.sessionKey))
  )
  const dropTimer = () => { stop(timer); timer = null }
  const dropRetry = () => { stop(retryTimer); retryTimer = null }

  function clear () {
    dropTimer()
    dropRetry()
    armed = null
    pending = null
  }

  function cancel (exec) {
    if (!armed && !pending && !timer && !retryTimer) return
    if (exec) {
      let claim
      try { claim = claimOf(exec) } catch { return }
      if (!owned(claim)) return // a foreign/denied computer call must not cancel the owner's timer
    }
    clear()
    log.info?.('computer-use: leave timer cancelled by desktop activity')
  }

  function scheduleRetry () {
    if (disposed || retryTimer || !pending || !isLive()) return
    retryTimer = setTimer(() => {
      retryTimer = null
      attempt()
    }, retryMs)
    unref(retryTimer)
  }

  function attempt () {
    if (disposed || !pending || !isLive()) return
    const p = pending
    let result
    try {
      result = release(p.exec, p.why, true, p.expected)
    } catch (error) {
      return failed(error)
    }
    if (result && typeof result.then === 'function') result.then(done, failed)
    else done(result)
  }

  function done (result) {
    if (disposed || !pending) return
    if (result?.released) {
      const finished = pending
      pending = null
      dropRetry()
      log.info?.('computer-use: leave timer released the desktop lease')
      try {
        const out = notice(
          'computer-use: 桌面租约已自动释放（离开桌面超过 100 秒）。下一次操作会重新观察；旧 mark 已失效。',
          'computer-use: lease expired',
          { agent: finished?.exec?.agent },
        )
        out?.catch?.(() => {})
      } catch { /* a notice must never break the timer */ }
      return
    }
    log.info?.(`computer-use: leave timer release refused (${result?.reason || 'no reason'})`)
    scheduleRetry()
  }

  function failed (error) {
    if (disposed) return
    if (error?.code === 'COMPUTER_OWNER_CHANGED') {
      // The captured cycle is gone or a newer one exists; this timer must never touch it.
      pending = null
      dropRetry()
      log.info?.('computer-use: leave timer discarded (cycle/owner changed)')
      return
    }
    log.warn?.(`computer-use: leave timer release failed (${error?.message || error})`)
    scheduleRetry()
  }

  function fire () {
    timer = null
    if (disposed || !armed || !isLive()) { armed = null; return }
    pending = armed
    armed = null
    attempt()
  }

  function arm (exec) {
    if (disposed || armed || pending || timer || !graceMs || !isOpen()) return
    let claim
    try { claim = claimOf(exec) } catch { return }
    if (!owned(claim)) return // global hook: only the owner's own leaving starts a timer
    const cycle = gate?.snapshot?.()
    if (!cycle || !Number.isInteger(cycle.id)) return
    armed = {
      exec,
      expected: { claim, cycleId: cycle.id },
      why: `left desktop for ${exec.name}`,
    }
    timer = setTimer(fire, graceMs)
    unref(timer)
    log.info?.(`computer-use: leave timer armed for ${graceMs} ms (${exec.name})`)
  }

  function observe (exec) {
    if (disposed || !exec || typeof exec.name !== 'string') return
    // A computer_* call — including one waiting in the approval card — means the agent is still on
    // the desktop, so the leave grace must not fire underneath it. A denied call can cancel too;
    // the next non-desktop top-level call arms a fresh grace. onStart() also cancels, idempotently,
    // once the approved tool really begins.
    if (exec.name.startsWith('computer_') || DESKTOP_HELPERS.has(exec.name)) {
      cancel(exec)
      return
    }
    if (LEAVE_TOOL_EXEMPT.has(exec.name)) return
    arm(exec)
  }

  function retryNow () {
    if (!pending || retryTimer || disposed || !isLive()) return
    attempt()
  }

  function onTurnEnd (session) {
    if (!isLive()) { clear(); return }
    let claim
    try { claim = claimOf({ session }) } catch { return }
    if (owned(claim)) clear()
  }

  function onAgentDisposed (agent) {
    if (!isLive()) { clear(); return }
    let claim
    try { claim = claimOf({ agent }) } catch { return }
    if (owned(claim)) clear()
  }

  function dispose () {
    disposed = true
    clear()
  }

  return { observe, cancel, clear, retryNow, onTurnEnd, onAgentDisposed, dispose }
}
