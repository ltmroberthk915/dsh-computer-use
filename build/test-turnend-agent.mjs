// test-turnend-agent.mjs — the turn-end decision card MUST name its caller agent.
//
// WHY THIS EXISTS (2026-09-15, measured on the live host, not reasoned about):
//
//   22:57:16.836  [I] [dsh-computer-use] turn-end card: NO ANSWER (NO_PROVIDER) — nothing steered, …
//   22:57:18.980  [I] [dsh-computer-use] Desktop already in front for pending question
//                                            (1 question(s): computer_use_turn_end); not raising
//
// The branch fired, the raiser worked, and the human still saw NOTHING, because the question never
// reached a browser answerer:
//
//   @deepseek-ai/dsh-api-remotes/lib/index.js:115-119
//     return ctx.on(event, function (request, next) {
//       const carrierAgent = carrierKeyOf(this);
//       if (carrierAgent === void 0) return next();          // agent-less ⇒ NOT forwarded
//       const agent = request.agent;
//       if (agent === void 0 || agent !== carrierAgent) throw new TypeError(…)
//
// and the card itself is the client answerer `dsh-client-ui-user-questions/lib/client.js:880`
// (`ctx.remote.$on("user-questions/request", …)`), which only ever sees forwarded requests.
// `dsh-user-questions/README.zh.md:41` states the rule: "Web 回答者只接收带 Agent scope 的请求；不含
// agent 的程序化请求仍会交给本地未限定 scope 的 waterfall listener，若无人接受则以 NO_PROVIDER 失败."
//
// So `asker.ask({questions})` — which is what shipped — cannot work, no matter how correct the rest
// of the path is. The host's own `ask_user_question` always passes `agent: exec.agent`.
//
// The guard is deliberately STATIC plus MUTATION-TESTED: a "did the card render?" assertion cannot be
// written against a real browser here, but the ONE line whose absence caused the failure can be
// pinned exactly, and every assertion below is proven able to go red.
//
//   node build/test-turnend-agent.mjs [path-to-index.js]
// exit 0 = the card names a verified live root agent; exit 1 = at least one rule is broken.

import { readFileSync } from 'node:fs'
import { maskChecked } from './mask-comments.mjs'

const PLUGIN = process.argv[2] || 'lib/index.js'
const src = readFileSync(PLUGIN, 'utf8')

// ---- MATCHING RUNS ON COMMENT-MASKED TEXT (review finding, 2026-09-16) --------------------------------
// `src` stays raw because MUTATIONS must be applied to real text; every rule and every slice below reads
// `code`, where comments are masked out. This file pins string LITERALS as well as code (`asker.ask({`,
// `agent: rp.agent,`), and this repository's habit is to quote code inside its comments — so on raw text a
// rule could be satisfied by a comment describing the code that had since been deleted. `mask-comments.mjs`
// holds the scanner and the reasons it preserves strings and offsets; it is shared, not copied.
const code = maskChecked(src, PLUGIN)

// Only the ask-at-turn-end body is in scope. Slicing keeps an unrelated `agent:` elsewhere in a
// 1380-line file from satisfying any assertion below.
const START = code.indexOf('async function askAtTurnEnd')
if (START < 0) { console.error('FAIL: askAtTurnEnd is gone from ' + PLUGIN); process.exit(1) }
const END = code.indexOf('\n  }', code.indexOf('const out = await Promise.race', START))
const body = code.slice(START, END > START ? END : undefined)

// Every rule sees BOTH slices: `b` is the ask body, `s` the whole plugin. Rules that pin module-level
// structure read `s` — and the mutation loop feeds the mutant through BOTH, or a rule reading the
// pristine `src` would stay green on a mutation it is supposed to catch (measured: four rules did).
const checks = []
const add = (name, run, brks) => checks.push({ name, run, brks })

// ---- 1. THE REQUEST CARRIES AN AGENT ------------------------------------------------------------------
add('the turn-end request names an agent (this is the NO_PROVIDER fix itself)',
  (s) => {
    const call = s.indexOf('asker.ask({')
    if (call < 0) return 'asker.ask({…}) is gone'
    const head = s.slice(call, s.indexOf('questions:', call))
    if (!/agent:/.test(head)) return 'the request has no `agent` — the forwarder drops it (next()) and the card can never render (NO_PROVIDER)'
    if (/agent:\s*undefined\b/.test(head)) return 'the request explicitly names `undefined` as its agent'
    if (!/rp\.agent/.test(head)) return 'the request does not use the resolved agent'
    return null
  },
  [{ name: 'the agent is dropped from the request', find: 'agent: rp.agent,', with: '' },
    { name: 'the agent is named as undefined', find: 'agent: rp.agent,', with: 'agent: undefined,' }])

// ---- 2. THE AGENT IS VERIFIED AGAINST THE REGISTRY ----------------------------------------------------
// `ask()` validates it (`dsh-user-questions/lib/index.js:56-60`): CALLER_NOT_LIVE when it is not the
// registry's exact instance, DELEGATED_CALLER when it is not a live root. Both fail the SAME silent
// way the bug above did, so "we passed something" is not good enough.
add('the agent is resolved through the registry, not assumed',
  (s) => {
    if (!/rootAgentFor\s*\(/.test(s)) return 'the request does not resolve its agent through rootAgentFor()'
    return null
  },
  [{ name: 'the agent is taken raw instead of resolved', find: /const rp = rootAgentFor\(session, bus\.agent\)/, with: 'const rp = { agent: bus.agent, ask: true, reason: "verified" }' }])

add('the resolver can refuse a candidate the registry does not recognise as a live root',
  (_b, s) => {
    const i = s.indexOf('const rootAgentFor =')
    if (i < 0) return 'rootAgentFor() is gone'
    const fn = s.slice(i, s.indexOf('\n  }', i))
    if (!/agents\.roots\(\)/.test(fn)) return 'the resolver never asks the registry for its roots'
    if (!/agents\.get\(\s*a\.id\s*\)\s*===\s*a/.test(fn)) return 'the resolver never checks the EXACT live instance (CALLER_NOT_LIVE)'
    if (!/isRoot/.test(fn) || !/roots\.includes\(a\)/.test(fn)) return 'the resolver never checks that the candidate is a root (DELEGATED_CALLER)'
    if (!/ofSession\(candidate\)/.test(fn)) return 'the resolver never checks WHICH session the root belongs to — a live root of another chat would be accepted (measured defect, 2026-09-15)'
    if (!/const ofSession = \(a\) => !!a &&/.test(fn)) return 'the session test can be truthy-but-wrong: it never coerces its result to a boolean'
    if (!/sameSession\(/.test(fn)) return 'the resolver has no way to find the root that owns this session'
    return null
  },
  [{ name: 'the resolver stops checking liveness', find: /agents\.get && agents\.get\(a\.id\) === a/, with: 'true' },
    { name: 'the resolver stops checking rootness', find: 'const isRoot = (a) => !!a && roots.includes(a)', with: 'const isRoot = () => true' },
    { name: 'the resolver stops checking the session', find: 'const ofSession = (a) => !!a &&', with: 'const ofSession = (a) => true &&' }])

add('a substituted agent is always reported (a fallback must never look like the normal path)',
  (_b, s) => {
    if (!/rp\.reason !== 'verified'/.test(s)) return 'nothing distinguishes a verified caller from a substituted one'
    return null
  },
  [{ name: 'the substitution warning is silenced', find: /if \(rp\.reason !== 'verified'\)/, with: 'if (false)' }])

// ---- 3. THE SERVICE THAT MAKES THE CHECK POSSIBLE IS READ -------------------------------------------
// TWO RULES, because there are two ways to get this wrong and only one of them is dangerous:
//   * `agents` in the SAME inject list as `userQuestions` is the coupling that must never exist — a
//     missing registry would leave the fiber INACTIVE and that callback would never run, so the
//     pre-existing `computer_ask` would silently lose its `asker`;
//   * `agents` read on its own is fine and desirable: it SELF-HEALS a registry that appears late
//     (review re-audit E1), because a listed service that never appears only leaves THAT callback unrun.
// The `asker` assignment must stay out of the second injection, or the coupling returns in disguise.
add('the agents registry is never coupled to the question service',
  (_b, s) => {
    if (/ctx\.inject\(\s*\[[^\]]*'userQuestions'[^\]]*'agents'/.test(s)) return '`userQuestions` and `agents` share one inject list — a missing registry would stop the callback that assigns `asker` from ever running'
    if (!/agents = qctx\.get\('agents'\)/.test(s)) return 'the registry is not read through the non-fatal ctx.get — rootAgentFor() would always fall back'
    const second = s.slice(s.indexOf("ctx.inject(['agents']"))
    const bodyEnd = second.indexOf('})')
    if (bodyEnd > 0 && second.slice(0, bodyEnd).includes('asker')) return 'the self-healing agents injection also assigns `asker`, reintroducing the coupling'
    return null
  },
  [{ name: 'the registry is injected instead of read', find: "agents = qctx.get('agents')", with: "agents = qctx.agents" },
    { name: 'the two services are coupled in one inject list', find: "ctx.inject(['userQuestions'], (qctx) => {", with: "ctx.inject(['userQuestions', 'agents'], (qctx) => {" }])

// ---- 4. THE ASKER ROUND TRIP LEAVES A TRACE ----------------------------------------------------------
// The client resolves this waterfall only on the ANSWER (`dsh-client-ui-user-questions/lib/client.js`
// :113-119), so this line proves "the answerer accepted and settled the request" — precisely what a
// NO_PROVIDER never reaches. Its absence next to a failure is what tells the next round whether the
// request reached a browser answerer at all. (An earlier comment here claimed it proved a card was
// RENDERED before the human touched anything; the reviewer showed that was false and the claim was
// corrected in the plugin — a witness that overstates itself is worse than none.)
add('a settled ask says so in the log',
  (_b, s) => {
    if (!/turn-end decision card answered:/.test(s)) return 'a settled ask leaves no trace — a NO_PROVIDER and an answered card are indistinguishable again'
    return null
  },
  [{ name: 'the answer trace is removed', find: /log\.info\(`turn-end decision card answered: selected=/, with: 'log.info(`turn-end decision card selected=' }])

// ---- 5. THE CALL SITE ITSELF, NOT JUST THE RESOLVER (review finding 7, 2026-09-15) -------------------
// Two regressions passed every guard in this repo before this rule existed, because the rules above only
// proved the resolver was CALLED and that an agent appeared SOMEWHERE before `questions:`:
//   (a) `agent: rp.ask ? rp.agent : undefined` — the regexes still matched, and the substitution cases
//       silently went back to an agent-less request, i.e. exactly NO_PROVIDER again;
//   (b) `const rp = bus.agent ? { agent: bus.agent, ask: true } : rootAgentFor(...)` — the resolver is
//       still "called" in the text, so rule 2 was satisfied while every call bypassed it.
add('the registry-verified agent is the one actually passed, unconditionally',
  (s) => {
    const call = s.indexOf('asker.ask({')
    if (call < 0) return 'asker.ask({…}) is gone'
    const head = s.slice(call, s.indexOf('questions:', call))
    if (!/agent:\s*rp\.agent\s*,/.test(head)) return 'the request does not hand ask() the resolved agent — the substitution path can silently ask with no agent (NO_PROVIDER)'
    if (/rp\.ask\s*\?/.test(head)) return 'the agent is passed conditionally — the cases the resolver substituted for would ask with no agent'
    return null
  },
  [{ name: 'the agent is passed conditionally again', find: 'agent: rp.agent,', with: 'agent: rp.ask ? rp.agent : undefined,' }])

add('every turn-end resolution goes through the registry resolver',
  (_b, s) => {
    if (/bus\.agent\s*\?\s*\{\s*agent:\s*bus\.agent/.test(s)) return 'a call-site shortcut hands bus.agent to ask() without the registry ever vouching for it'
    if (!/const rp = rootAgentFor\(session, bus\.agent\)/.test(s)) return 'the resolution call itself changed shape; the guards no longer pin what runs'
    return null
  },
  [{ name: 'the call site bypasses the resolver', find: 'const rp = rootAgentFor(session, bus.agent)', with: 'const rp = bus.agent ? { agent: bus.agent, ask: true, reason: "verified" } : rootAgentFor(session, bus.agent)' }])

// ---- 6. AN UNVOUCHED AGENT IS NEVER HANDED TO ask() --------------------------------------------------
// `ask()` accepts a live root of ANY session, so a candidate the resolver refused would still raise the
// card — in the WRONG CHAT. The refusal must therefore be enforced here and not merely labelled.
add('a refused agent stops the ask instead of reaching ask()',
  (s) => {
    if (!/if \(!rp\.ask \|\| !rp\.agent\)/.test(s)) return 'the ask is not gated on the resolver VOUCHING for the agent (a live root of another chat would raise the card there)'
    const gate = s.indexOf('if (!rp.ask || !rp.agent)')
    const call = s.indexOf('asker.ask({')
    if (gate > 0 && call > 0 && gate > call) return 'the voucher gate sits AFTER the ask — it cannot prevent it'
    return null
  },
  [{ name: 'the voucher gate is removed', find: /if \(!rp\.ask \|\| !rp\.agent\) \{/, with: 'if (false) {' }])

// ---- 7. A LATE ANSWER MUST ACTUALLY BE LATE (measured defect, 2026-09-15 23:40) ----------------------
// `asked.then(...)` was attached inside the timeout branch but UNCONDITIONALLY, so an on-time click ran the
// late handler too — host log, the human's own click:
//   23:40:12.584 answered: selected=["继续…"]  /  23:40:12.585 answered LATE … (same millisecond)
// One click was handled twice; with the old bare-object steer both copies crashed. The handler must be
// gated on the race having actually timed out.
add('the late-answer handler only runs for an answer that was actually late',
  (s) => {
    if (!/const settledLate = !!out\.timedOut/.test(s)) return 'nothing records that the race timed out, so a late handler cannot tell a late answer from an on-time one'
    const handler = s.indexOf('void asked.then((late) => {')
    if (handler < 0) return 'the late handler is gone (fine only if late answers are handled elsewhere)'
    const head = s.slice(handler, handler + 260)
    if (!/if \(!settledLate\) return/.test(head)) return 'the late handler is unconditional again — an on-time answer would be steered a second time'
    return null
  },
  [{ name: 'the late guard is dropped', find: '          if (!settledLate) return\n', with: '' }])

// ---- run, then prove each assertion can fail ----------------------------------------------------------
// THE MUTANT IS RE-SLICED BEFORE IT IS FED TO A RULE (review finding 6, 2026-09-15). Passing the whole
// mutant file as the "ask body" made rule 1's mutation proof VACUOUS: the first `asker.ask({` in a
// whole file is `askOne`'s, which legitimately carries an agent, so a mutation that broke the turn-end
// call site was "caught" by matching a different call site — including for the exact regression this
// file exists for. A guard whose mutation proof is vacuous is the bug the guard was written to prevent.
const sliceBody = (text) => {
  const start = text.indexOf('async function askAtTurnEnd')
  if (start < 0) return null
  const race = text.indexOf('const out = await Promise.race', start)
  const end = race > start ? text.indexOf('\n  }', race) : -1
  return text.slice(start, end > start ? end : undefined)
}

const failures = []
for (const c of checks) {
  const bad = c.run(body, code)
  if (bad) failures.push(`${c.name} — ${bad}`)
}

let mutations = 0
const mutationFailures = []
for (const c of checks) {
  for (const m of c.brks || []) {
    mutations++
    const mutant = String(m.with).match(/^\d+$/) ? null : src.replace(m.find, m.with)
    if (mutant === null || mutant === src) { mutationFailures.push(`${c.name}: mutation "${m.name}" did not apply`); continue }
    // The mutant is masked BEFORE slicing: a mutation that moves code into a comment must not be able to
    // keep a rule green through the comment it just created.
    const mutantCode = maskChecked(mutant, PLUGIN + ' (mutant: ' + m.name + ')')
    const mutantBody = sliceBody(mutantCode)
    if (!mutantBody) { mutationFailures.push(`${c.name}: mutation "${m.name}" destroyed the ask body (the slice no longer resolves)`); continue }
    const still = c.run(mutantBody, mutantCode)
    if (!still) mutationFailures.push(`${c.name}: mutation "${m.name}" left the guard GREEN`)
  }
}

for (const f of mutationFailures) console.error('MUTATION NOT CAUGHT: ' + f)
for (const f of failures) console.error('FAIL: ' + f)

if (failures.length || mutationFailures.length) {
  console.error(`\nFAILED — ${failures.length} rule(s) broken, ${mutationFailures.length} mutation(s) uncaught`)
  process.exit(1)
}
console.log(`ok test-turnend-agent — the turn-end card names a verified live root agent, a refused agent is never asked with, ` +
  `the card's branches build real messages, a settled ask leaves a trace, and all ${mutations} mutations are caught by ` +
  `actually re-running the guard against the mutant`)
