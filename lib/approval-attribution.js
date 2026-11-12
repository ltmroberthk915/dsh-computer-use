// Compatibility with hosts that conflate policy refusals and answerer refusals.
// Delegate first so the host still owns every approval and durable audit pair.
//
// The host's `serviceAsk` maps a non-grant to a reason string. One of those strings —
// `the user rejected tool "X"` — is produced for BOTH a real human "no" and the deterministic
// auto-reject of the `never` approval policy, where no prompt was ever shown. This seam repairs
// the `never` case and only that wording: it runs only for computer_* tools, only after the host
// ran, and only by replacing the reason — the outcome, the borrowed signal and the
// approval/asked + approval/decided audit pair stay the host's. A rejection under the `ask`
// policy is left as a channel rejection without any claim about who answered (the answerer may
// be the human card or the Auto reviewer).
//
// 2026-11-12: the seam must also INSTALL reliably. A plugin applied before the tool registry is
// mounted has no `serviceAsk` to wrap, so it used to degrade to a warning in a log nobody reads
// and the misleading host wording reached the model. The registry is now also awaited through
// `ctx.inject`, installs are ref-counted per service (an out-of-order/FIFO unload can no longer
// leave a dead wrapper installed), and the returned status object (`installed` / `reason` /
// `rewrites`) is reported in the gate's own diagnostics so "seam never installed" is a visible
// fact rather than a guess.

const LEGACY_USER_REJECTION = /^the user rejected tool "([^"]*)"$/

// Identity that survives a TRACED PROXY. `ctx.get('tools')` hands out a fresh proxy on every
// call, so a WeakMap keyed on the object it returned can never dedupe two installs. The entry is
// carried on the wrapper function we install as the service's own `serviceAsk`, and read back
// through that property's DESCRIPTOR value — a plain function reference the proxy forwards — so
// two fibers wrapping one registry share one entry and restore it exactly once.
const OWNER = Symbol.for('dsh-computer-use.approval-attribution')

function installedEntry (tools) {
  try {
    const value = Object.getOwnPropertyDescriptor(tools, 'serviceAsk')?.value
    return typeof value === 'function' && value[OWNER] ? value[OWNER] : null
  } catch { return null }
}

/**
 * One install leaves. The wrapper is removed only when the LAST install leaves, and only if the
 * service still holds our wrapper — a host that replaced `serviceAsk` afterwards keeps its own.
 */
function release (entry) {
  entry.refs -= 1
  if (entry.refs > 0) return
  const tools = entry.tools
  try {
    if (Object.getOwnPropertyDescriptor(tools, 'serviceAsk')?.value !== entry.wrapped) return
    if (entry.ownDescriptor) Object.defineProperty(tools, 'serviceAsk', entry.ownDescriptor)
    else delete tools.serviceAsk
  } catch { /* a failed restore must never break disposal */ }
}

export function installApprovalAttribution (ctx, log) {
  const state = { installed: false, reason: 'unknown', entry: null }
  // `rewrites` follows whichever seam this install ended up sharing.
  Object.defineProperty(state, 'rewrites', { get: () => state.entry?.rewrites ?? 0, enumerable: true })

  const attach = (tools) => {
    if (!tools || typeof tools.serviceAsk !== 'function') return false
    const existing = installedEntry(tools)
    if (existing) {
      existing.refs += 1
      ctx.effect(() => () => release(existing))
      state.entry = existing
      state.installed = true
      state.reason = 'installed'
      return true
    }
    const entry = { refs: 1, rewrites: 0, tools, original: tools.serviceAsk, ownDescriptor: Object.getOwnPropertyDescriptor(tools, 'serviceAsk'), wrapped: null }
    entry.wrapped = async function (exec, ask) {
      let policy = null
      if (exec?.name?.startsWith('computer_') && exec.agent) {
        // Every member read is guarded: a service whose getter throws must leave the policy
        // unknown (say less), never reject the host's approval call.
        try {
          const approval = this.ctx?.get?.('approval')
          const effectivePolicy = approval?.effectivePolicy
          if (typeof effectivePolicy === 'function') policy = effectivePolicy.call(approval, exec.agent.session)
        } catch { /* unknown policy: say less, not more */ }
      }
      const result = await entry.original.call(this, exec, ask)
      if (!exec?.name?.startsWith('computer_') || result?.decision?.kind !== 'deny') return result
      if (!LEGACY_USER_REJECTION.test(String(result.decision.reason ?? ''))) return result
      entry.rewrites += 1
      const reason = (policy === 'never'
        ? `tool "${exec.name}" requires approval, but approval prompts are disabled in this session (approval policy: never); the request was automatically rejected without asking the user`
        : `approval for tool "${exec.name}" was rejected by the approval channel`) +
        (ask?.reason ? `; approval required because: ${ask.reason}` : '')
      return { ...result, decision: { ...result.decision, reason } }
    }
    entry.wrapped[OWNER] = entry
    ctx.effect(() => {
      tools.serviceAsk = entry.wrapped
      return () => release(entry)
    })
    state.entry = entry
    state.installed = true
    state.reason = 'installed'
    log.info('approval attribution: installed for computer-use; host approvals and audit retained')
    return true
  }

  let mounted = null
  try { mounted = typeof ctx?.get === 'function' ? ctx.get('tools') : null } catch { mounted = null }
  if (attach(mounted)) return state
  // Not mounted yet: wait for the registry rather than warning into the void. `inject` runs the
  // callback as soon as the service exists, including immediately when it already does; the
  // reason is set BEFORE registering so a synchronous callback cannot be overwritten by it.
  if (typeof ctx?.inject === 'function') {
    state.reason = 'awaiting-tools'
    try {
      ctx.inject(['tools'], (child) => {
        let tools = null
        try { tools = child?.tools ?? (typeof child?.get === 'function' ? child.get('tools') : null) } catch { tools = null }
        if (attach(tools)) return
        state.reason = 'unavailable'
        log.warn('approval attribution: tools service arrived without a serviceAsk seam')
      })
      return state
    } catch { /* fall through to the warning */ }
  }
  state.reason = 'unavailable'
  log.warn('approval attribution: host compatibility seam unavailable')
  return state
}
