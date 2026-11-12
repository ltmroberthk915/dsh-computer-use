// approval-env.js — the approval-channel facts this gate is allowed to act on.
//
// WHY THIS MODULE EXISTS (measured, 2026-11-12)
// The policy gate used to answer `{kind:'ask'}` for a high-risk key in `autonomous` mode and
// hand it to the host. The host's approval service has two policies:
//
//   * `ask`   — an answerer may put a card in front of the human (the host logs approval/asked
//               + approval/decided and routes it to the UI);
//   * `never` — NOTHING is asked. `ApprovalService.decide()` returns `'rejected'` immediately,
//               the tool layer maps that to `the user rejected tool "computer_key"`, and the
//               model/human read a refusal that never happened. DSH selects this policy for the
//               `danger-full-access` permission preset ("Full file access without approval
//               prompts"), i.e. exactly the mode a human picks to say "stop asking me".
//
// So the plugin has to settle its OWN asks against the channel it actually has, which needs
// two facts about the CALLING session:
//
//   1. the effective APPROVAL POLICY (`ask` | `never`);
//   2. the effective SANDBOX MODE (`danger-full-access` is the human's explicit
//      "this machine is pre-authorized" grant; see lib/policy.js applyApprovalChannel()).
//
// Reading them must never throw into the gate, and a service that is absent, remounted, or
// answers with an unknown shape leaves the fact UNKNOWN — unknown keeps the conservative path
// (`ask` stays `ask`), because guessing "full access" is the one guess that must never happen.
//
// The lookup is layered because a host may compose only some of these rows:
//   sandbox   : sandboxPolicy.resolve({session}).mode      (authoritative, per session)
//             → permissionPresets.permissionState(session).sandbox
//             → the durable session record, NARROWING ONLY   (lib/host-debug.js helper)
//   approval  : approval.effectivePolicy(session)          (authoritative, per session)
//
// Both entering facts must be proven LIVE, because either one can widen what the machine does:
// "full access" suppresses a prompt, and "policy never" declares that no prompt can be shown.
// Two deliberate omissions follow from that:
//   * `shell.sandboxMode` is NOT consulted. It is the DEPLOYMENT default, not the session's
//     effective mode, so a host launched with full access would report full access for a session
//     the human had switched back to workspace-write.
//   * the durable session record may only NARROW the sandbox and is never read for the approval
//     policy. It is a throttled cache (writeEveryEvents / writeIntervalMs), so right after
//     switching away from full access it can still say "danger-full-access", and right after an
//     approval-policy change it can still say "never"; a cache must never manufacture either
//     grant, only remove one.
//
// `sources` names which layer answered, so a later failure is diagnosable from one log line.

export const SANDBOX_MODES = Object.freeze(['read-only', 'workspace-write', 'danger-full-access'])
export const APPROVAL_POLICIES = Object.freeze(['ask', 'never'])

const isSandboxMode = (value) => typeof value === 'string' && SANDBOX_MODES.includes(value)
const readService = (ctx, name) => {
  try { return typeof ctx?.get === 'function' ? ctx.get(name) : undefined } catch { return undefined }
}

/**
 * Resolve the approval-channel facts for one call.
 * @param {object} request
 * @param {object} [request.ctx] the plugin context; `get(name)` is optional and never trusted to throw
 * @param {object|string|null} [request.session] the calling Agent's session object
 * @param {string|null} [request.sessionId] the calling session id (disk fallback only)
 * @param {((id: string|null) => object|null)|null} [request.durablePermission] optional disk reader
 * @returns {{approvalPolicy: ('ask'|'never'|null), sandbox: (string|null),
 *   promptsAvailable: boolean, fullAccess: boolean, sources: string[]}}
 */
export function readApprovalEnv ({ ctx, session = null, sessionId = null, durablePermission = null } = {}) {
  const sources = []
  let approvalPolicy = null
  let sandbox = null
  const usable = session !== null && session !== undefined

  // Every member read goes through this: a service whose property GETTER throws must leave the
  // fact unknown, not turn every computer_* call into "computer-use policy error" (that would be
  // a fail-closed denial of working calls, i.e. a denial-of-service on the gate itself).
  const member = (service, name) => {
    try { return service == null ? undefined : service[name] } catch { return undefined }
  }

  const approval = readService(ctx, 'approval')
  if (usable) {
    const effectivePolicy = member(approval, 'effectivePolicy')
    if (typeof effectivePolicy === 'function') {
      try {
        const policy = effectivePolicy.call(approval, session)
        if (APPROVAL_POLICIES.includes(policy)) { approvalPolicy = policy; sources.push('approval.effectivePolicy') }
      } catch { /* unknown policy keeps the conservative path */ }
    }
  }

  const sandboxPolicy = readService(ctx, 'sandboxPolicy')
  if (usable) {
    const resolve = member(sandboxPolicy, 'resolve')
    if (typeof resolve === 'function') {
      try {
        const mode = resolve.call(sandboxPolicy, { session })?.mode
        if (isSandboxMode(mode)) { sandbox = mode; sources.push('sandboxPolicy.resolve') }
      } catch { /* fall through to the next layer */ }
    }
  }

  if (sandbox === null) {
    const presets = readService(ctx, 'permissionPresets')
    if (usable) {
      const permissionState = member(presets, 'permissionState')
      if (typeof permissionState === 'function') {
        try {
          const state = permissionState.call(presets, session)
          if (isSandboxMode(state?.sandbox)) { sandbox = state.sandbox; sources.push('permissionPresets.permissionState') }
        } catch { /* fall through */ }
      }
    }
  }

  if (sandbox === null && typeof durablePermission === 'function') {
    try {
      const record = durablePermission(sessionId)
      // Narrowing only: a throttled cache may say "full access" after the human left it, so it
      // can never be the evidence FOR an execution grant — only against one.
      if (isSandboxMode(record?.sandbox) && record.sandbox !== 'danger-full-access') {
        sandbox = record.sandbox
        sources.push('session-record')
      }
    } catch { /* unknown stays unknown */ }
  }

  return {
    approvalPolicy,
    sandbox,
    // No policy means no proof that prompts are unavailable: keep asking.
    promptsAvailable: approvalPolicy !== 'never',
    fullAccess: sandbox === 'danger-full-access',
    // A delegated child inherits its parent's sandbox mode and has its approval policy pinned to
    // `never` by @deepseek-ai/dsh-subagent. Neither fact is the human's grant: the human granted
    // THIS conversation, not an arbitrary child that decides to drive the desktop on its own.
    delegated: readDelegation(session),
    sources,
  }
}

/**
 * Is this session a delegated child rather than the human's own conversation?
 *
 * The header is the host's own durable identity (`@deepseek-ai/dsh-session` validates
 * `origin: "subagent"`, `parentSession`, `delegationDepth`, `isSeeded`). Three real shapes exist:
 *
 *   * the human's own session      — no parent fields (`delegationDepth: 0`);
 *   * a delegated subagent child   — `origin:"subagent"` + `delegationDepth: 1` + `parentSession`
 *                                    (all 260 child headers on this machine have all three);
 *   * a FORK of the human's own conversation (sidebar "fork") — `parentSession` + `isSeeded:true`
 *                                    and NO origin/delegationDepth. That is still the human's own
 *                                    conversation: it must keep the grant its parent had, not be
 *                                    refused as if a subagent had asked.
 *
 * So `origin`/`delegationDepth` decide, and a bare `parentSession` only counts as a child when
 * the session is not seeded from its parent (the legacy child shape). A missing header on a live
 * session cannot prove it is the human's, and is treated as delegated.
 */
export function readDelegation (session) {
  try {
    if (session === null || session === undefined) return false
    const header = session.header
    if (header === null || header === undefined) return true
    if (typeof header !== 'object') return true
    if (header.origin === 'subagent') return true
    const depth = header.delegationDepth
    if (typeof depth === 'number' && Number.isFinite(depth) && depth > 0) return true
    if (typeof header.parentSession === 'string' && header.parentSession.length > 0) {
      return header.isSeeded !== true
    }
    return false
  } catch { return true }
}

/** One-line, secret-free summary for logs and diagnostics. */
export function describeApprovalEnv (env) {
  if (!env || typeof env !== 'object') return 'approval=? sandbox=?'
  return `approval=${env.approvalPolicy ?? '?'} sandbox=${env.sandbox ?? '?'}` +
    (env.delegated === true ? ' delegated' : '') +
    (env.sources?.length ? ` (from ${env.sources.join('+')})` : '')
}
