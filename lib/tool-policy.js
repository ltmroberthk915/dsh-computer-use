// tool-policy.js — the user's OFF switch for the high-risk tool surface (feature B: 安全子集).
//
// A DENY-list, not an allow-list, on purpose. The tool surface moves (28 names → 17 on 2026-09-13,
// renames since); an allow-list would default every NEW or renamed tool to disabled and break the
// agent silently — the exact stale-list failure that once made policy.js deny its own tools. A
// deny-list can only REMOVE capability the user named explicitly, so a stale, half-edited or
// typo-ridden config degrades to "everything still works", never to "the agent is blind".
//
// THE BRAKE IS NOT CONFIGURABLE (hard safety constraint, same doctrine as policy.js and
// skill-gate.js): `computer_ask` — the human's question card — and `computer_ctrl`'s
// stop/exit/release — the manual brake, the abort, and the release of desktop control — are exempt
// BEFORE the deny-list is ever consulted. A switch that can block the brake is worse than no
// switch: the operator who most needs the machine stopped must never find the stop disabled by the
// very config that was meant to make things safer. `computer_ctrl` is action-shaped; when the
// caller cannot see the action the WHOLE tool is exempt, because we cannot prove the call is not
// the brake — and guessing wrong here is the one error this module must never make.
//
// Pure functions, zero dependencies, no global state, and no opinion about registration
// (不改注册面): this module never unregisters anything. The wiring decides whether a refusal
// surfaces as a {kind:'deny'} in tools/pre-execute or as a thrown not-dispatched error in
// tools.js's reg() wrapper.

// Shape-only, deliberately. This layer cannot know which names actually exist (keeping the tool
// list in sync is policy.js's documented burden); it only filters "looks like one of ours" and
// DROPS the rest, so a typo'd config entry degrades to "not disabled" instead of throwing at load
// time. Note the regex needs at least one [a-z_] after the prefix: 'computer_' alone is invalid.
const TOOL_NAME = /^computer_[a-z_]+$/

// computer_ctrl actions that ARE the safety direction. Everything else it does (hold, free,
// calibrate, indicator, selftest, acknowledge, recover) is operator-neutral and may be listed.
const BRAKE_ACTIONS = new Set(['stop', 'exit', 'release'])

function isBrake (name, action) {
  // The ask card is brake-like wholesale: it actuates nothing, it summons the human.
  if (name === 'computer_ask') return true
  if (name === 'computer_ctrl') {
    // undefined / null / '' means the caller could not resolve an action — treat the call as the
    // brake rather than the reverse; the asymmetry IS the safety property.
    const act = typeof action === 'string' && action !== '' ? action : undefined
    return act === undefined || BRAKE_ACTIONS.has(act)
  }
  return false
}

/** @returns {string[]} trimmed, de-duplicated, shape-valid tool names; everything else is dropped */
// The host's schemastery resolves volatile config fields into frozen cells ({get, write}),
// not plain arrays. Unwrap LAZILY at read time: this keeps both shapes working (pure arrays
// in tests/older hosts, cells on the current host), sees live settings edits on every call,
// and never writes back to config — an eager normalize-and-assign would destroy the cell
// reference and silently zero the user's deny-list.
const unwrapVolatile = (value) => (value && typeof value.get === 'function' ? value.get() : value)

export function normalizeDisabledTools (value) {
  value = unwrapVolatile(value)
  if (!Array.isArray(value)) return []
  if (!Array.isArray(value)) return []
  const seen = new Set()
  for (const item of value) {
    if (typeof item !== 'string') continue
    const name = item.trim()
    if (!TOOL_NAME.test(name)) continue
    seen.add(name)
  }
  return [...seen]
}

/**
 * Deny-list lookup. `action` is optional and only refines computer_ctrl (its brake actions are
 * never disable-able); omit it when the call site knows only the tool name — then computer_ctrl as
 * a whole stays available, by design.
 * @returns {boolean} true only when `name` is deny-listed AND not on the safety direction
 */
export function disabledTool (name, config, action) {
  if (typeof name !== 'string') return false
  if (isBrake(name, action)) return false
  // Re-normalize defensively: hand-edited settings JSON is not guaranteed to have passed through
  // normalizeDisabledTools, and this must never throw on a dirty config.
  return normalizeDisabledTools(config?.disabledTools).includes(name)
}

/**
 * @returns {Error|null} the refusal to surface when `name` is disabled; null when it may run.
 * Carries code/outcome in the same shape as tools.js's TARGET_NOT_OBSERVED refusal, so the host
 * renders a disabled tool exactly like any other "never reached the machine" verdict.
 */
export function refusalFor (name, config, action) {
  if (!disabledTool(name, config, action)) return null
  // Built fresh per call on purpose: callers attach context to the error, and a shared instance
  // would leak that context into every later refusal.
  return Object.assign(new Error(`TOOL_DISABLED: ${name} is disabled by configuration`), {
    code: 'TOOL_DISABLED',
    outcome: 'not-dispatched',
  })
}
