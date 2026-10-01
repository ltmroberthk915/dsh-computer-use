// test-turnend-rootagent.mjs — EXECUTE `rootAgentFor()` against a stubbed agent registry.
//
// WHY EXECUTION AND NOT JUST A STATIC GUARD: `test-turnend-agent.mjs` pins the SHAPE of the fix
// (the request names an agent, the resolver checks liveness, rootness and session, the agents registry
// is read non-fatally). Shape is not behaviour. `ask()` validates the agent it is handed and throws
// CALLER_NOT_LIVE / DELEGATED_CALLER — two more silent, card-less failures that look exactly like the
// NO_PROVIDER this fix exists for. So this file lifts the REAL function text out of the plugin and runs
// it against a stubbed registry, including every case where the answer must be a REFUSAL.
//
// WHAT THIS FILE DOES *NOT* CLAIM (corrected after review finding 8 — the earlier header claimed
// DELEGATED_CALLER was "handled", which was false): the resolver AVOIDS that error by refusing to ask,
// it does not make a subagent-driven cycle reachable. In the real registry a child owns its own session
// (`dsh-agent/lib/index.js:477-480` enforces `agent.id === agent.session.id`), so a subagent's caller
// can never be resolved to a root of the ending session and the card is refused — logged, not raised.
//
// The extraction is anchored and brace-matched on COMMENT- AND STRING-STRIPPED source, and every
// scenario asserts the `{agent, ask, reason}` contract, so a rewrite that changes the contract fails
// here instead of on a human's screen.
//
//   node build/test-turnend-rootagent.mjs [path-to-index.js]
// exit 0 = the resolver behaves; exit 1 = it does not.

import { readFileSync } from 'node:fs'

const PLUGIN = process.argv[2] || 'lib/index.js'
const src = readFileSync(PLUGIN, 'utf8')

// ---- lift the function ------------------------------------------------------------------------------
// Anchor on the INDENTED declaration (the plugin always declares it with two leading spaces). An
// unanchored match could hit the same text quoted inside a comment — the plugin's own comments quote
// code, and a guard that pins prose is a guard that cannot fail for the right reason.
const ANCHOR = '\n  const rootAgentFor = (session, candidate) => {'
const at = src.indexOf(ANCHOR)
if (at < 0) { console.error('FAIL: the indented rootAgentFor() declaration is not in ' + PLUGIN); process.exit(1) }
// THE BRACE SCAN RUNS ON COMMENT- AND STRING-STRIPPED SOURCE (review finding 13). The raw text is
// full of braces in prose and in string literals ("…{answered:false}…"), and a stray `}` would close
// the body EARLY and silently, leaving the scenarios to run against a truncated function and report
// success. Blanks preserve offsets, so the slice still comes out of the ORIGINAL text.
const MASK = '\u0000'
const stripped = src
  .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, MASK))
  .replace(/\/\/[^\n]*/g, (m) => m.replace(/[^\n]/g, MASK))
  .replace(/'(?:[^'\\\n]|\\.)*'/g, (m) => m.replace(/[^\n]/g, MASK))
  .replace(/"(?:[^"\\\n]|\\.)*"/g, (m) => m.replace(/[^\n]/g, MASK))
  .replace(/`(?:[^`\\]|\\.)*`/g, (m) => m.replace(/[^\n]/g, MASK))
if (stripped.length !== src.length) { console.error('FAIL: the masking step changed the source length — offsets would be wrong'); process.exit(1) }
const open = stripped.indexOf('{', at + ANCHOR.length - 1)
let depth = 0, close = -1
for (let i = open; i < stripped.length; i++) {
  const c = stripped[i]
  if (c === '{') depth++
  else if (c === '}') { depth--; if (depth === 0) { close = i; break } }
}
if (close < 0 || open < 0) { console.error('FAIL: unbalanced braces in rootAgentFor()'); process.exit(1) }
const bodyText = src.slice(open + 1, close)
// A truncated body would still "run", so refuse a slice that lost its own tail, and refuse one that
// swallowed the rest of the file.
if (!/return\s*\{[^}]*reason:/.test(bodyText)) { console.error('FAIL: the lifted body does not contain the resolver\'s return contract — the slice is wrong'); process.exit(1) }
if (/async function askAtTurnEnd/.test(bodyText)) { console.error('FAIL: the lifted body ran past the function into the next one'); process.exit(1) }

// The real function closes over `agents` (module scope) and `sameSession` (apply scope). Rebinding
// those two names is the whole seam.
const build = (agentsStub, sameSessionStub) =>
  new Function('agents', 'sameSession', `return (session, candidate) => {${bodyText}}`)(agentsStub, sameSessionStub)

const failures = []
const scenario = (name, fn) => {
  try { const bad = fn(); if (bad) failures.push(`${name} — ${bad}`) }
  catch (e) { failures.push(`${name} — threw ${e && e.message}`) }
}

// ---- a registry stub shaped like @deepseek-ai/dsh-agent AgentRegistry -------------------------------
const mkRegistry = (entries) => {
  const store = new Map(entries.map((a) => [a.id, a]))
  return {
    store,
    get: (id) => store.get(id),
    roots: () => entries.filter((a) => a.owner === undefined),
  }
}
const sameSession = (a, b) => {
  const k = (s) => (!s ? null : typeof s === 'string' ? s : (s.id || s.sessionId || s.key || null))
  const ka = k(a), kb = k(b)
  return a === b || (ka !== null && kb !== null && ka === kb)
}

const S1 = { id: 'session-1' }, S2 = { id: 'session-2' }
const root1 = { id: 'a1', session: S1 }
const root2 = { id: 'a2', session: S2 }
const child = { id: 'a3', session: S1, owner: root1 }

// NOTE ON THE CONTRACT: the resolver returns `{agent, ask, reason}`. `ask` is a BOOLEAN, not a note
// string, because "may this agent be handed to ask()" and "which note to log" stopped being the same
// question: `other-session-root` labels BOTH the correct substitution (askable) and the refusal of the
// original candidate (not askable). Every scenario therefore asserts `ask` first and `reason` second.

// 1. the ordinary case: the tool caller IS the live root of this session.
scenario('a live root caller is accepted as-is (no substitution)', () => {
  const r = build(mkRegistry([root1, root2]), sameSession)(S1, root1)
  if (r.ask !== true) return 'refused an agent that is the live root of this very session'
  if (r.agent !== root1) return 'substituted an agent that needed no substitution'
  if (r.reason !== 'verified') return `reason was ${r.reason}, expected verified`
  return null
})

// 2. the caller is ANOTHER session's live root. The registry would accept it (live + root) and the card
//    would appear in someone else's chat, so the resolver must substitute the root that owns THIS one.
scenario('a caller from another session is replaced, never used', () => {
  const r = build(mkRegistry([root1, root2]), sameSession)(S1, root2)
  if (r.agent === root2) return 'would have raised the card in another session\'s chat'
  if (r.agent !== root1) return 'did not substitute the root that DOES own this session'
  if (r.ask !== true) return 'refused an ask it can answer with the correct root'
  if (r.reason !== 'other-session-root') return `reason was ${r.reason}, expected other-session-root`
  return null
})

// 2b. ANOTHER session's root with NO usable replacement: the ask must be REFUSED, not attempted.
//     This is review finding 2 — the previous version returned this candidate and `ask()` accepted it.
scenario('another session\'s root is refused outright when nothing replaces it', () => {
  const r = build(mkRegistry([root2]), sameSession)(S1, root2)   // no root owns S1
  if (r.ask !== false) return 'vouched for an agent that belongs to a different session — the card would open in the wrong chat'
  if (!/other-session-root/.test(r.reason)) return `reason was ${r.reason}`
  return null
})

// 3. a DISPOSED caller (not the registry's exact instance) must fall back to the live root of the
//    same session — this is CALLER_NOT_LIVE prevention.
scenario('a dead caller falls back to the live root of its own session', () => {
  const ghost = { id: 'a1', session: S1 }               // same id, different object
  const r = build(mkRegistry([root1, root2]), sameSession)(S1, ghost)
  if (r.agent !== root1) return 'did not recover the live instance'
  if (r.ask !== true) return 'refused a caller it could replace with the live root'
  if (r.reason !== 'registry-root-by-session') return `reason was ${r.reason}`
  return null
})

// 4. THE DANGEROUS ONE: the caller is an OWNED child (a subagent). TWO FACTS, both measured, and the
//    second one is a LIMITATION this file must not pretend away:
//    (a) THE REAL REGISTRY FORBIDS THE STUB'S SHAPE: `agent.id === agent.session.id` is enforced
//        (`dsh-agent/lib/index.js:477-480`), and a child owns its OWN session — it can never carry the
//        parent's session id. So a real subagent gives match=0, not match=1.
//    (b) THEREFORE a subagent-driven cycle CANNOT raise this card: the resolver refuses (ask:false) and
//        the call site logs the refusal instead of asking. `ask()` would have thrown DELEGATED_CALLER —
//        a silent no-card failure — so refusing is the honest outcome, but it means DELEGATED_CALLER is
//        NOT "handled" here; it is avoided, and the case is still unreachable for the human. The file
//        header said the opposite before review finding 8; that claim was false and is corrected here.
//    WHAT IS ASSERTED is the safety property only: an OWNED agent is never vouched for, and no child is
//    ever handed to ask(). Whether a replacement root exists is a separate question (asserted in 4b).
scenario('no owned child agent is ever vouched for', () => {
  const child2 = { id: 'a4', session: S1, owner: root1 }        // non-realistic shape, see (a)
  const r = build(mkRegistry([root1, child2]), sameSession)(S1, child2)
  if (r.agent === child2 && r.ask === true) return 'handed ask() a child agent (DELEGATED_CALLER)'
  const real = { id: 'a5', session: { id: 'session-child' }, owner: root1 }   // realistic: own session id
  const r2 = build(mkRegistry([root1, real]), sameSession)(S1, real)          // a root DOES own S1 here
  if (r2.agent === real && r2.ask === true) return 'handed ask() an owned child instead of the session root'
  if (r2.ask === true && r2.agent !== root1) return `vouched for ${r2.agent.id} instead of the session root`
  // with NO root owning the session, the owned child must be refused outright
  const r3 = build(mkRegistry([real]), sameSession)(S1, real)
  if (r3.ask !== false) return 'vouched for an owned child when no root owned the session'
  return null
})

// 4b. a subagent that DOES resolve to its owning root is the good case, but only when the child carries
//     the parent's session — which the real registry forbids, so this documents the intended shape
//     rather than a reachable path. Asserted so the substitution branch stays covered.
scenario('a caller replaced by its session root is asked through that root', () => {
  const ghostChild = { id: 'a6', session: S1, owner: root1 }
  const r = build(mkRegistry([root1, ghostChild]), sameSession)(S1, ghostChild)
  if (r.ask !== true) return 'refused a caller it could have replaced with the session root'
  if (r.agent !== root1) return 'did not substitute the session root'
  if (r.reason !== 'registry-root-by-session') return `reason was ${r.reason}`
  return null
})

// 5. TWO ROOTS CANNOT SHARE A SESSION in the real registry (`dsh-agent:477-480` rejects duplicate ids),
//    so `match` is only ever 0 or 1 and this ambiguity is unreachable today. It is asserted anyway as
//    defence in depth: if the registry ever allowed it, guessing would put the card in an arbitrary chat.
scenario('ambiguity is refused, not guessed (unreachable in today\'s registry — asserted as defence)', () => {
  const twin = { id: 'a9', session: S1 }
  const r = build(mkRegistry([twin, root1]), sameSession)(S1, { id: 'ghost', session: S1 })
  if (r.ask === true) return 'guessed a root while two claimed the session'
  if (!/match=2/.test(r.reason)) return `reason does not report the ambiguity: ${r.reason}`
  return null
})

// 6. no registry at all: the ask must be REFUSED (an agent-less request can only end in NO_PROVIDER).
scenario('a missing registry refuses the ask instead of sending an unanswerable one', () => {
  for (const stub of [null, undefined, {}, { roots: 'not-a-function' }]) {
    const r = build(stub, sameSession)(S1, root1)
    if (r.ask !== false) return 'claimed a voucher with no registry'
    if (!/no-registry/.test(r.reason)) return `reason was ${r.reason}`
  }
  return null
})

// 7. a throwing registry must not throw INTO the host (this runs inside a session event handler).
scenario('a throwing registry is contained', () => {
  const boom = { get () { throw new Error('registry is disposed') }, roots () { throw new Error('registry is disposed') } }
  const r = build(boom, sameSession)(S1, root1)
  if (r.ask !== false) return 'vouched for an agent while the registry was throwing'
  if (!/resolve-threw/.test(r.reason)) return `reason was ${r.reason}`
  return null
})

// 8. no candidate and no registry match: nothing to name — the caller must be able to tell why.
scenario('no candidate is reported as no-candidate', () => {
  const r = build(mkRegistry([root2]), sameSession)(S1, null)
  if (r.agent !== null) return 'invented an agent'
  if (r.ask !== false) return 'vouched for a null agent'
  if (!/no-candidate/.test(r.reason)) return `reason was ${r.reason}`
  return null
})

// 9. a live root that is NOT accepted must be refused with the reason a human can act on.
scenario('a live instance that is not a root is refused as not-a-root', () => {
  const orphan = { id: 'a5', session: S1, owner: {} }            // owned ⇒ not in roots()
  const r = build(mkRegistry([orphan]), sameSession)(S1, orphan)
  if (r.ask !== false) return 'vouched for an agent that is not a live root'
  if (!/not-a-root/.test(r.reason)) return `reason was ${r.reason}`
  return null
})

for (const f of failures) console.error('FAIL: ' + f)
if (failures.length) { console.error(`\nFAILED — ${failures.length} scenario(s) against the real function text`); process.exit(1) }
console.log('ok test-turnend-rootagent — rootAgentFor() executed against a stubbed registry: 10 scenarios covering the ' +
  'silent failures ask() would reject (CALLER_NOT_LIVE, DELEGATED_CALLER — avoided by refusing, NOT made reachable), ' +
  'the wrong-chat refusal, and the ambiguity it must not guess')
