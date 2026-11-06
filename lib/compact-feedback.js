// Small post-action evidence, shared by host/MCP adapters. Never dispatches input,
// retries a read, inventories a UIA tree, or changes the original action receipt.
export const COMPACT_FEEDBACK_BYTES = 6144
export const COMPACT_OBSERVATION_MS = 6000
export const COMPACT_POINT_MS = 5000

const finite = value => typeof value === 'number' && Number.isFinite(value)
const bytes = value => Buffer.byteLength(JSON.stringify(value), 'utf8')
const rectKeys = ['x', 'y', 'width', 'height']
const windowKeys = ['hwnd', 'pid', 'process', 'title', 'class', 'active', 'minimized']
const elementKeys = ['name', 'role', 'controlType', 'automationId', 'className', 'value', 'text', 'enabled', 'isEnabled', 'offscreen', 'isOffscreen', 'editable', 'focused', 'hasKeyboardFocus', 'selected', 'checked', 'toggleState', 'expanded', 'expandCollapseState', 'hwnd', 'pid']

function point (value) {
  if (typeof value === 'string') {
    const parts = value.trim().split(/[,\s]+/)
    if (parts.length !== 2 || parts.some(p => !p)) return null
    value = { x: Number(parts[0]), y: Number(parts[1]) }
  }
  return value && finite(value.x) && finite(value.y) ? { x: Math.round(value.x), y: Math.round(value.y) } : null
}
export function feedbackRegion (value) {
  if (typeof value === 'string') {
    const parts = value.trim().split(/[,\s]+/)
    if (parts.length !== 4 || parts.some(p => !p)) return null
    value = Object.fromEntries(rectKeys.map((k, i) => [k, Number(parts[i])]))
  }
  if (!value || !rectKeys.every(k => finite(value[k])) || value.width <= 0 || value.height <= 0) return null
  return Object.fromEntries(rectKeys.map(k => [k, value[k]]))
}

// A native default verification crop is NOT authorization to narrow vision.
// Only an explicitly requested region changes the automatic image viewport.
export function feedbackViewport (args = {}, receipt = {}) {
  args ||= {}; receipt ||= {}
  const requested = (receipt.verificationSource === 'requested-region' ? feedbackRegion(receipt.verificationRegion) : null) ||
    feedbackRegion(args.verificationRegion)
  if (requested) return { region: rectKeys.map(k => requested[k]).join(','),
    point: { x: Math.floor(requested.x + requested.width / 2), y: Math.floor(requested.y + requested.height / 2) }, source: 'requested-region' }
  const actual = point(receipt)
  if (actual) return { point: actual, source: 'action-receipt' }
  const target = point(args.to) || point(args.at)
  if (target) return { point: { x: target.x + (finite(args.dx) ? args.dx : 0), y: target.y + (finite(args.dy) ? args.dy : 0) }, source: 'requested-point' }
  return { source: 'no-point' }
}

function clipped (value, limit, cuts, path) {
  const text = String(value), raw = Buffer.from(text, 'utf8')
  if (raw.length <= limit) return text
  let end = limit - 3
  while (end > 0 && (raw[end] & 0xc0) === 0x80) end--
  cuts.push(path)
  return raw.subarray(0, end).toString('utf8') + '…'
}
function brief (value, keys, cuts, path, limit = 768) {
  if (!value || typeof value !== 'object') return null
  const result = {}
  for (const key of keys) {
    const item = value[key]
    if (typeof item === 'string') result[key] = clipped(item, limit, cuts, path + '.' + key)
    else if (typeof item === 'boolean' || finite(item) || item === null) result[key] = item
  }
  const rect = feedbackRegion(value.rect || value.bounds)
  if (rect) result.rect = rect
  return result
}

// Budget applies to the ADDED observation envelope, never to an input receipt.
// Whole fields are omitted if needed; a truncated field is never silently complete.
export function limitCompactFeedback (envelope, maxBytes = COMPACT_FEEDBACK_BYTES) {
  const limit = Number.isInteger(maxBytes) && maxBytes >= 1024 ? Math.min(maxBytes, COMPACT_FEEDBACK_BYTES) : COMPACT_FEEDBACK_BYTES
  const result = JSON.parse(JSON.stringify(envelope))
  const omitted = []
  const existing = result.observation?.truncatedFields || []
  const budget = result.budget = { maxBytes: limit, returnedBytes: 0, truncated: existing.length > 0, omittedFields: omitted }
  const fit = () => {
    // returnedBytes is part of its own JSON; stabilize decimal width.
    for (let i = 0; i < 4; i++) budget.returnedBytes = bytes(result)
    return budget.returnedBytes <= limit
  }
  if (fit()) return result
  for (const field of ['ancestors', 'focused', 'element', 'receiver', 'window', 'contextFromAction']) {
    if (result.observation && Object.hasOwn(result.observation, field)) {
      delete result.observation[field]; omitted.push('observation.' + field); budget.truncated = true
      if (fit()) return result
    }
  }
  // Unknown adapter metadata is not allowed to evade the byte contract. Retain
  // the truth that this observation could not fit, rather than cut JSON or paths.
  result.observation = { scope: 'compact', incomplete: true, reason: 'observation exceeded compact byte budget; request feedback full for complete readback' }
  omitted.push('observation'); budget.truncated = true
  if (result.feedback) result.feedback = { kind: result.feedback.kind, detail: 'compact', reason: 'bounded post-action observation' }
  if (!fit()) {
    for (const key of Object.keys(result)) if (!['observation', 'feedback', 'verification', 'budget'].includes(key)) delete result[key]
    if (typeof result.verification === 'string') result.verification = clipped(result.verification, 512, omitted, 'verification')
    fit()
  }
  return result
}

export async function collectCompactState (cu, { args = {}, receipt = {}, checkAllowed = () => {}, archive, now = Date.now } = {}) {
  args ||= {}; receipt ||= {}
  const began = now(), deadline = began + COMPACT_OBSERVATION_MS, cuts = [], failures = []
  const observation = { scope: 'local-post-action', ts: began, elementAvailable: false }
  const raw = { scope: 'local-post-action', ts: began }
  let viewport = feedbackViewport(args, receipt), calls = 0
  const read = async (op, params, cap) => {
    checkAllowed()
    const remaining = Math.floor(deadline - now())
    if (remaining <= 0) throw new Error('compact observation time budget exhausted')
    calls++
    return cu.call(op, params, Math.min(cap, remaining))
  }
  if (!viewport.point) {
    try {
      raw.cursor = await read('cursor', {}, 1000)
      const current = point(raw.cursor)
      if (current) viewport = { point: current, source: 'current-cursor' }
      else failures.push({ channel: 'cursor', error: 'cursor position unavailable' })
    } catch (error) { failures.push({ channel: 'cursor', error: clipped(error.message || error, 320, cuts, 'errors.cursor') }) }
  }
  if (viewport.point) {
    observation.point = { ...viewport.point, source: viewport.source }
    raw.point = observation.point
    if (viewport.source === 'action-receipt' || viewport.source === 'current-cursor') observation.cursor = { ...viewport.point, source: viewport.source }
    try {
      const probe = await read('uiaFromPoint', viewport.point, COMPACT_POINT_MS)
      raw.probe = probe
      observation.window = brief(probe.root, windowKeys, cuts, 'window', 320)
      observation.receiver = brief(probe.receives, windowKeys, cuts, 'receiver', 320)
      observation.element = brief(probe.element, elementKeys, cuts, 'element')
      observation.focused = brief(probe.focused, elementKeys, cuts, 'focused', 320)
      if (typeof probe.typingWouldReach === 'boolean') observation.typingWouldReach = probe.typingWouldReach
      const ancestors = probe.ancestors || probe.element?.ancestors || []
      observation.ancestors = Array.isArray(ancestors) ? ancestors.slice(0, 3).map((a, i) => brief(a, elementKeys, cuts, `ancestors.${i}`, 160)) : []
      if (Array.isArray(ancestors) && ancestors.length > 3) cuts.push('ancestors')
      observation.elementAvailable = !!probe.element
      if (!probe.element) failures.push({ channel: 'uiaFromPoint', error: 'no UIA element at this point; absence does not prove task failure' })
    } catch (error) { failures.push({ channel: 'uiaFromPoint', error: clipped(error.message || error, 320, cuts, 'errors.uiaFromPoint') }) }
  }
  if (!viewport.point) observation.reason = 'No action, witness-region or current-cursor point was available; no UIA tree was read.'
  if (receipt.receiver || receipt.focus || receipt.cursor) observation.contextFromAction = {
    source: 'action-receipt, not an independent post-action read',
    receiver: brief(receipt.receiver, windowKeys, cuts, 'context.receiver', 160),
    focus: brief(receipt.focus, windowKeys, cuts, 'context.focus', 160),
    cursor: point(receipt.cursor),
  }
  if (failures.length) observation.errors = failures
  if (archive && (raw.probe || raw.cursor)) {
    try {
      const archived = await archive({ ...raw, ...(failures.length ? { errors: failures } : {}) })
      const snapshot = typeof archived === 'string' ? archived : archived?.snapshot || archived?.observation
      if (typeof snapshot === 'string' && /^O[\w-]{1,127}$/.test(snapshot)) observation.snapshot = snapshot
      const cache = archived?.cache || archived?.archive
      if (cache && (cache.status === 'memory-only' || cache.reason || cache.fallback)) {
        observation.cache = brief(cache, ['status', 'reason', 'fallback'], cuts, 'cache', 160)
      }
      if (!observation.snapshot) {
        // Once neither disk nor memory retains the evidence, truncation would
        // make the omitted fields irretrievable. Return the existing raw value
        // inline without another probe, input replay, clone or disk attempt.
        observation.cache = { status: 'uncached', reason: cache?.reason || 'cache-unavailable', fallback: 'inline' }
        observation.inlineEvidence = raw
      }
    } catch (error) {
      observation.archiveError = clipped(error.message || error, 240, cuts, 'archiveError')
      observation.cache = { status: 'uncached', reason: 'cache-unavailable', fallback: 'inline' }
      observation.inlineEvidence = raw
    }
  }
  if (cuts.length) observation.truncatedFields = [...new Set(cuts)]
  observation.reads = calls
  observation.elapsedMs = Math.max(0, now() - began)
  observation.limitations = 'A local point/focus read may miss remote or visual changes. It does not verify the task effect; use explicit UIA/visual or application readback when needed.'
  return observation
}
