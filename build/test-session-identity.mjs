// test-session-identity.mjs — EXECUTE the session-identity helpers the whole turn-end decision rests on.
//
// WHY THIS EXISTS: `sameSession()` is the foundation of every "is this MY session?" decision in the
// plugin — `rootAgentFor`'s `ofSession`, the turn-end branch's ownership test, the `agent/status idle`
// discrimination. Until now it was only ever INSPECTED, never run, and a helper was already found
// broken exactly that way in this repo (`rootAgentFor` marked another session's root as `verified`).
//
// The specific hazard this file pins: `sameSession` compares two keys with
//     return ka !== null && kb !== null && ka === kb
// If `sessionKey` ever returned `undefined` instead of `null` for a shapeless object, that line would
// report `undefined === undefined` — i.e. EVERY pair of shapeless sessions would look like the SAME
// session. That is not a theoretical worry: `sessionKey` reads `s.id || s.sessionId || s.key || null`,
// so the guarantee lives entirely in one `|| null`, and one edit removes it silently.
//
//   node build/test-session-identity.mjs [path-to-index.js]
// exit 0 = the helpers behave; exit 1 = they do not.

import { readFileSync } from 'node:fs'

const PLUGIN = process.argv[2] || 'lib/index.js'
const src = readFileSync(PLUGIN, 'utf8')

// ---- lift the three helpers as one contiguous block --------------------------------------------------
const START = '\n  const sessionKey = (s) => {'
const at = src.indexOf(START)
if (at < 0) { console.error('FAIL: the session identity helpers are not in ' + PLUGIN); process.exit(1) }
const END = src.indexOf('\n  let inFlight', at)
if (END < 0) { console.error('FAIL: could not find the end of the session identity block'); process.exit(1) }
const block = src.slice(at, END)

for (const needle of ['const sessionKey', 'const sameSession', 'const describeSession']) {
  if (!block.includes(needle)) { console.error(`FAIL: the lifted block is missing ${needle} — the slice no longer covers the helpers`); process.exit(1) }
}
if (/bus\s*=/.test(block)) { console.error('FAIL: the lifted block ran past the helpers into the bus state'); process.exit(1) }

const { sessionKey, sameSession, describeSession } =
  new Function(`${block}\n  return { sessionKey, sameSession, describeSession }`)()

const failures = []
const check = (name, got, want) => {
  const ok = Object.is(got, want)
  if (!ok) failures.push(`${name} — got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`)
}

// ---- sessionKey --------------------------------------------------------------------------------------
check('sessionKey(null)', sessionKey(null), null)
check('sessionKey(undefined)', sessionKey(undefined), null)
check('sessionKey("")', sessionKey(''), null)
check('sessionKey("s-1")', sessionKey('s-1'), 's-1')
check('sessionKey({id})', sessionKey({ id: 's-1' }), 's-1')
check('sessionKey({sessionId})', sessionKey({ sessionId: 's-2' }), 's-2')
check('sessionKey({key})', sessionKey({ key: 'k-1' }), 'k-1')
// THE ONE THAT MATTERS: a shapeless object must yield NULL, not undefined.
check('sessionKey({}) is null (an undefined here would make all shapeless sessions look identical)', sessionKey({}), null)
check('sessionKey({id: 0}) is null (a falsy id must not become "0"-ish identity)', sessionKey({ id: 0 }), null)
check('sessionKey({id: ""}) is null', sessionKey({ id: '' }), null)

// ---- sameSession -------------------------------------------------------------------------------------
const S1 = { id: 'session-1' }
const S1b = { id: 'session-1' }
const S2 = { id: 'session-2' }
check('sameSession is reflexive on identity', sameSession(S1, S1), true)
check('sameSession(null, null)', sameSession(null, null), true)
check('sameSession(undefined, undefined)', sameSession(undefined, undefined), true)
// NOT an assertion that nullish inputs should MATCH — they should not, and the real function returns
// false here. Nullish values are the plugin's internal "no session" sentinel, so "no session" is not
// "the same session as no session"; asserting otherwise would pin a behaviour nobody wants. What is
// asserted is the direction that matters: keylessness must never CREATE a match.
check('sameSession(null, undefined) — both keyless, NOT a match', sameSession(null, undefined), false)
// The true case is identity, which is what the plugin actually relies on (the same object handed twice).
check('sameSession(S1, S1) on the same object', sameSession(S1, S1), true)
check('sameSession({id:1},{id:1})', sameSession(S1, S1b), true)
check('sameSession({id:1},{id:2})', sameSession(S1, S2), false)
check('sameSession("session-1", {id:"session-1"}) — string vs object', sameSession('session-1', S1), true)
check('sameSession("session-1", "session-2")', sameSession('session-1', 'session-2'), false)

// THE FALSE-POSITIVE GUARD: two shapeless sessions are NOT the same session.
check('sameSession({}, {}) is FALSE (a true here would merge every shapeless session)',
  sameSession({}, {}), false)
check('sameSession({}, {id:"s"}) is FALSE', sameSession({}, { id: 's' }), false)
check('sameSession({foo:1}, null) is FALSE', sameSession({ foo: 1 }, null), false)
check('sameSession(null, {id:"s"}) is FALSE', sameSession(null, S1), false)

// Cross-shape: the SAME logical id reached through different fields must still match — `ofSession` feeds
// `a.session || a.sessionId` while the event side may hand `s.id`.
check('sameSession({id:"x"}, {sessionId:"x"})', sameSession({ id: 'x' }, { sessionId: 'x' }), true)
check('sameSession({id:"x"}, {key:"x"})', sameSession({ id: 'x' }, { key: 'x' }), true)

// ---- describeSession ---------------------------------------------------------------------------------
check('describeSession(null)', describeSession(null), 'unknown')
check('describeSession(undefined)', describeSession(undefined), 'unknown')
check('describeSession("s-1")', describeSession('s-1'), 's-1')
check('describeSession({id:"s-1"})', describeSession({ id: 's-1' }), 's-1')
check('describeSession({}) names the shape, never "unknown"',
  describeSession({}), '<Object>')

for (const f of failures) console.error('FAIL: ' + f)
if (failures.length) { console.error(`\nFAILED — ${failures.length} session-identity assertion(s)`); process.exit(1) }

// ---- mutation self-test: the guard must be able to fail ----------------------------------------------
const mutants = [
  { name: 'sessionKey returns undefined instead of null for a shapeless object', find: 'return s.id || s.sessionId || s.key || null', with: 'return s.id || s.sessionId || s.key' },
  { name: 'sameSession drops the null guard', find: 'return ka !== null && kb !== null && ka === kb', with: 'return ka === kb' },
  { name: 'sameSession claims every pair identical', find: 'if (a === b) return true', with: 'return true' },
]
let caught = 0
for (const m of mutants) {
  const mutantBlock = block.replace(m.find, m.with)
  if (mutantBlock === block) { console.error(`MUTATION NOT CAUGHT: "${m.name}" did not apply — the anchor moved`); process.exit(1) }
  const h = new Function(`${mutantBlock}\n  return { sessionKey, sameSession, describeSession }`)()
  const red =
    Object.is(h.sessionKey({}), null) === false ||
    h.sameSession({}, {}) !== false ||
    h.sameSession(S1, S2) !== false ||
    Object.is(h.sessionKey(null), null) === false
  if (!red) { console.error(`MUTATION NOT CAUGHT: "${m.name}" left the guard GREEN`); process.exit(1) }
  caught++
}

console.log(`ok test-session-identity — the real sessionKey/sameSession/describeSession run: ` +
  `${failures.length === 0 ? 'all assertions hold' : 'FAILED'}, including the false-positive guard that a shapeless ` +
  `session is never "the same session" as another, and all ${caught} mutations turn it red`)
