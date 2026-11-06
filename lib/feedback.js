import { readFileSync } from 'node:fs'

// Transport capability and grounding are separate evidence. Route exceptions
// are dated data, can be replaced in settings, and expire.
export const DEFAULT_FEEDBACK_RULES = Object.freeze(JSON.parse(readFileSync(new URL('./feedback-routes.json', import.meta.url), 'utf8')))
export function feedbackRoute (exec) {
  const routed = exec?.agent?.session?.requestHeader?.()?.config
  return {
    provider: routed?.provider ?? exec?.agent?.options?.provider,
    model: routed?.model ?? exec?.agent?.options?.model,
  }
}

export function visionEvidence (exec, { rules = DEFAULT_FEEDBACK_RULES, adapterVersion = 'unversioned', now = Date.now() } = {}) {
  const route = feedbackRoute(exec)
  for (const rule of [...(Array.isArray(rules) ? rules : [])].reverse()) {
    const tested = Date.parse(rule.testedAt), expires = Date.parse(rule.expiresAt)
    if (rule.provider !== route.provider || rule.model !== route.model ||
        rule.adapterVersion !== adapterVersion || !Number.isFinite(tested) || !Number.isFinite(expires) ||
        tested > now || expires <= now || expires <= tested || !['failed', 'verified'].includes(rule.grounding)) continue
    // Unversioned historical tests may select a conservative text fallback,
    // but cannot certify the current adapter's visual grounding.
    if (rule.grounding === 'verified' && adapterVersion === 'unversioned') continue
    return { grounding: rule.grounding, adapterVersion, testedAt: rule.testedAt, expiresAt: rule.expiresAt,
      reason: rule.reason || 'configured route evidence' }
  }
  return { grounding: 'unverified', adapterVersion, reason: 'no current matching grounding record' }
}

export function unverifiedVisionRoute (exec, options) {
  return visionEvidence(exec, options).grounding === 'failed'
}

export function selectFeedbackDetail (requested, fallback = 'compact') {
  const detail = requested ?? fallback
  if (!['compact', 'full', 'none'].includes(detail)) throw Object.assign(new Error('feedback must be compact, full or none'),
    { code: 'INVALID_FEEDBACK', outcome: 'not-dispatched' })
  return detail
}

export async function feedbackPolicy (ctx, exec, enabled = true, options = {}) {
  const route = feedbackRoute(exec)
  const detail = selectFeedbackDetail(options.detail, 'full')
  if (!enabled || detail === 'none' || exec?.signal?.aborted) return { kind: null, detail, reason: exec?.signal?.aborted ? 'cancelled' : !enabled ? 'disabled' : 'feedback-none' }
  let active
  try {
    if (route.provider && route.model) active = await ctx.get?.('llm')?.resolveModelInfo?.(route.provider, route.model, exec?.signal)
  } catch { /* missing capability evidence selects text, not silence */ }
  if (exec?.signal?.aborted) return { kind: null, reason: 'cancelled' }
  const evidence = visionEvidence(exec, { ...options, adapterVersion: active?.adapterVersion || 'unversioned' })
  const base = { route, detail, ...evidence }
  if (evidence.grounding === 'failed') return { ...base, kind: 'state', reason: 'current grounding record requires UIA/text readback' }
  if (!active) return { ...base, kind: 'state', reason: 'model-capabilities-unavailable' }
  if (!active.inputModalities?.includes('image')) return { ...base, kind: 'state', reason: 'model-text-only' }
  if (!ctx.get?.('attachments')?.saveImage) return { ...base, kind: 'state', reason: 'attachments-unavailable' }
  return { ...base, kind: 'image', reason: 'image transport declared; inspect returned evidence to verify effect' }
}

export async function feedbackMode (ctx, exec, enabled = true, options) {
  return (await feedbackPolicy(ctx, exec, enabled, options)).kind
}

export const feedbackActions = new Set([
  'computer_click', 'computer_type', 'computer_key', 'computer_move',
  'computer_drag', 'computer_scroll', 'computer_select',
])

export const feedbackVerification = 'Inspect this post-action observation before claiming the task effect. An input receipt alone is not verification. If observation failed, inspect before repeating the input.'
