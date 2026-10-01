// test-steer-message-shape.mjs — every `agent.steer()` / `agent.inject()` in this plugin must receive a
// REAL user message, never a bare object.
//
// WHY THIS EXISTS (measured crash, 2026-09-15 — the human's own report: "选1之后崩溃"):
//
//   23:22:23.038  turn-end decision card answered: selected=["继续（按你自己的理解接着干）"]
//   23:22:23.046  turn-end card: the human SELECTED 继续 — steered, a new turn will start
//   23:22:23.039  [session-store] session ...: session/event listener threw:
//                 TypeError: Cannot read properties of undefined (reading 'kind')
//   23:22:23.043  [agent-loop] agent event "agent/inbox/claimed" listener threw: (same TypeError)
//
// The card's branches called `recipient.steer({ text: '继续' })`. `steer` publishes the object into the
// agent's inbox, where the harness's own listeners read it AS A MESSAGE:
//
//   `@deepseek-ai/dsh-tool-jobs/lib/index.js:175`
//     ctx.on("agent/inbox/claimed", ({ agent, message }) => {
//       if (message.source.kind === "user") spentWakes.delete(agent);
//     });
//
// `source` was undefined, so that line threw and the round failed. The plugin's own `try` swallowed it,
// which is why the only visible symptom was a red "本轮运行失败" and no reason.
//
// The rule pinned here is narrow and mechanical: at every steer/inject call site the argument is either
// `buildUserMessage(...)` (which guarantees `{id, role:'user', content, source:{kind:'plugin:<name>',…}}`) or a
// value bound from it. A bare object literal is the regression, and it is what this file exists to stop.
//
//   node build/test-steer-message-shape.mjs [path-to-index.js]
// exit 0 = every call site delivers a real message; exit 1 = at least one is bare.

import { readFileSync } from 'node:fs'

const PLUGIN = process.argv[2] || 'lib/index.js'
const src = readFileSync(PLUGIN, 'utf8')

// Comments AND STRING LITERALS are masked (review finding C). Masking only comments meant a future log
// line containing `steer (` — `log.warn('could not steer (no agent)')` — matched the pattern and became a
// phantom call site whose "argument" is prose: a false failure that invites weakening the rule instead of
// fixing it. Offsets are preserved, so the slice still comes out of the original text.
const MASK = '\u0000'
const maskLiterals = (text) => text
  .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, MASK))
  .replace(/\/\/[^\n]*/g, (m) => m.replace(/[^\n]/g, MASK))
  .replace(/'(?:[^'\\\n]|\\.)*'/g, (m) => m.replace(/[^\n]/g, MASK))
  .replace(/"(?:[^"\\\n]|\\.)*"/g, (m) => m.replace(/[^\n]/g, MASK))
  .replace(/`(?:[^`\\]|\\.)*`/g, (m) => m.replace(/[^\n]/g, MASK))
const stripped = maskLiterals(src)
if (stripped.length !== src.length) { console.error('FAIL: masking changed the source length — offsets would be wrong'); process.exit(1) }

const failures = []

// ---- 1. no `steer`/`inject` may take an object literal ------------------------------------------------
// ONLY the agent surfaces. `inject` is also the name of the cordis dependency API this plugin calls
// before `apply` (`ctx.inject(['agents'], …)`), whose argument is a SERVICE LIST, not a message — an
// earlier version of this scan flagged those four calls and would have been "fixed" by weakening the
// rule instead of tightening the pattern. So `inject` counts only as a member call (`x.inject(...)`),
// while `steer` counts either way.
// The pattern matches the IDENTIFIER TOO (`ctx.inject(`, `recipient.steer(`), because that is the only
// way to see whether a dot precedes the name. Two traps were hit and fixed here, both by measurement:
//   * `(?<![.\w$])` — the `.` in the lookbehind excluded the very shape this plugin uses
//     (`agent.steer(...)`), so the scan found ZERO call sites and silently checked nothing;
//   * `[\w$]+\.inject` — `+` is greedy ACROSS LINES, so `ctx.inject(\n ['agents'], …)` matched the
//     bracket expression and reported a cordis service list as a bad message argument.
const patterns = [/[\w$]*inject\s*\(/g, /[\w$]*steer\s*\(/g]
let sites = 0
const scan = (text, onSite) => {
  for (const re of patterns) {
    re.lastIndex = 0
    let hit
    while ((hit = re.exec(text)) !== null) onSite(hit, text)
  }
}
// SLICE TO THE MATCHING PAREN, NOT THE FIRST ONE (review finding C). `text.indexOf(')', open)` stops at
// the first `)` anywhere after the call, so `agent.steer(await buildMessage(x))` or any multi-line call
// was reported as an unrecognised shape — a false failure that invites weakening the rule.
const argOf = (text, open) => {
  let depth = 0
  for (let i = open; i < text.length; i++) {
    const c = text[i]
    if (c === '(') depth++
    else if (c === ')') { depth--; if (depth === 0) return text.slice(open + 1, i).trim() }
  }
  return text.slice(open + 1).trim()
}
scan(stripped, (hit, text) => {
  const ident = hit[0].slice(0, hit[0].indexOf('(')).trim()
  const open = hit.index + hit[0].length - 1          // the '(' itself
  const arg = argOf(text, open)
  const line = text.slice(0, hit.index).split('\n').length
  // CLASSIFY BY ARGUMENT, NOT BY THE CALLEE (review finding C — the third pattern bug). The previous
  // version asked "is the character before `(` a dot?", which is ALWAYS false — the character before a
  // call's `(` is the last letter of its name — so EVERY `inject` site was skipped, including
  // `agent.inject({text:…})`, the identical crash on the other API. Cordis is distinguishable by its
  // argument (a service list) and by its receiver, so both are allowed to excuse a call; nothing else is.
  if (ident === 'inject') {
    const receiver = text.slice(0, hit.index).match(/[\w$.]*$/)[0]
    const isCordis = arg.startsWith('[') || receiver === 'ctx' || /(?:^|\.)ctx\.?$/.test(receiver)
    if (isCordis) return
  }
  sites++
  if (arg === '') { failures.push(`line ${line}: a steer/inject call with no argument`); return }
  if (arg.startsWith('{')) { failures.push(`line ${line}: a BARE OBJECT is handed to a message API — the harness reads message.source.kind and will throw (the 2026-09-15 crash): ${arg.slice(0, 60)}`); return }
  if (/^buildUserMessage\s*\(/.test(arg) || /^buildMessage\s*\(/.test(arg)) return
  if (/^(?:await\s+)?buildUserMessage/.test(arg)) return
  if (/^[A-Za-z_$][\w$.\[\]]*$/.test(arg)) return      // a bound value, e.g. `recipient.steer(msg)` or `agent.steer(msg)`
  failures.push(`line ${line}: unrecognised argument shape to a message API — ${arg.slice(0, 60)}`)
})

// A GUARD THAT FINDS NOTHING MUST FAIL. The scans above were silently vacuous once (the lookbehind
// excluded every real call site); `sites === 0` is the counterweight that makes "found nothing" loud.
if (sites === 0) failures.push('the scan found ZERO steer/inject call sites — the patterns no longer match how this plugin calls the agent API, so nothing was checked')

// ---- 2. the message builder itself must produce a `source` with a kind ---------------------------------
const build = src.slice(src.indexOf('async function buildUserMessage'), src.indexOf('async function buildUserMessage') + 2000)
// THE KIND IS PINNED TO THE V4 PRODUCER-OWNED NAME, NOT THE RETIRED WRAPPER (2026-09-30). The host's
// native v4 admission REFUSES `kind === 'plugin'` outright —
//   SessionFormatError: format v4 message requires a producer-owned source kind
// — so a guard pinning the old literal kept a value the host rejects GREEN, and the human saw
// "本轮运行失败" on every round that steered a notice. `producerKind()` (the migrator's own rule) maps a
// plugin to `plugin:<name>` and drops the `plugin` field; the mutation below reverts to the wrapper and
// MUST turn this guard red.
if (!/source\s*=\s*\{[^}]*kind:\s*'plugin:dsh-computer-use'/.test(build)) failures.push('buildUserMessage does not set source.kind to the producer-owned v4 kind (plugin:dsh-computer-use) — the inbox listener and v4 admission both read exactly that field')
if (!/role:\s*'user'/.test(build)) failures.push("buildUserMessage does not set role:'user'")
if (!/content/.test(build)) failures.push('buildUserMessage does not set content')
if (!/typeof createUserMessage === 'function'/.test(build)) failures.push('buildUserMessage calls the imported constructor without checking it is a function (a wrong export would throw instead of falling back)')

// ---- 3. the card's branches must go through it ----------------------------------------------------------
// ASSERTED ON THE RAW SOURCE, because the literal text IS the subject here — the scan above masks string
// literals (deliberately), so a masked copy cannot be searched for `'继续'`. Each branch is pinned by the
// builder call that carries its form tag, which a `Promise.resolve({text})` detour cannot satisfy.
if (!/buildUserMessage\(\s*'继续'\s*,\s*'turn-end-card'/.test(src)) failures.push("the 继续 branch does not build a real message through buildUserMessage('继续', 'turn-end-card', …)")
if (!/buildUserMessage\(\s*out\.custom\s*,\s*'turn-end-strategy'/.test(src)) failures.push('the typed-strategy branch does not build a real message')
if (!/buildUserMessage\(\s*lateText\s*,\s*'turn-end-late'/.test(src)) failures.push('the late-answer branch does not build a real message')
// …and no branch may keep a bare object beside them.
if (/\.steer\(\s*\{/.test(stripped) || /\.inject\(\s*\{/.test(stripped)) failures.push('a steer/inject call with an object literal survives elsewhere in the file')

// ---- mutation self-test ---------------------------------------------------------------------------------
// THE MUTANT RUNS THE SAME SCANNER AS THE REAL RUN (a mutation proven by a second, weaker copy of the rule
// is not a proof — that mistake was already made once in this repo). `sites` is not asserted here; a
// mutation that removes call sites entirely is caught by the `sites === 0` rule in the real run.
const mutants = [
  { name: 'the 继续 branch goes back to a bare object', find: /void buildUserMessage\('继续', 'turn-end-card', 'the human chose 继续 at the turn-end card'\)/, with: "void Promise.resolve({ text: '继续' })" },
  { name: 'the strategy branch goes back to a bare object', find: /buildUserMessage\(out\.custom, 'turn-end-strategy'/, with: 'Promise.resolve({ text: out.custom })' },
  { name: 'the builder reverts to the retired plugin wrapper (v4 refuses it)', find: "source = { kind: 'plugin:dsh-computer-use', form, ...(detail ? { summary: detail } : {}) }", with: "source = { kind: 'plugin', plugin: 'dsh-computer-use', form, ...(detail ? { summary: detail } : {}) }" },
  { name: 'the inject path is handed a bare object', find: 'else { agent.inject(msg);', with: "else { agent.inject({ text: msg });" },
]
let caught = 0
for (const mu of mutants) {
  const mutant = src.replace(mu.find, mu.with)
  if (mutant === src) { console.error(`MUTATION NOT CAUGHT: "${mu.name}" did not apply — the anchor moved`); process.exit(1) }
  const mStripped = maskLiterals(mutant)
  const bad = []
  scan(mStripped, (hit, text) => {
    const open = hit.index + hit[0].length - 1
    const a = argOf(text, open)
    const ident = hit[0].slice(0, hit[0].indexOf('(')).trim()
    if (ident === 'inject') {
      const receiver = text.slice(0, hit.index).match(/[\w$.]*$/)[0]
      if (a.startsWith('[') || receiver === 'ctx' || /(?:^|\.)ctx\.?$/.test(receiver)) return
    }
    if (a.startsWith('{')) { bad.push('bare object'); return }
    if (/^Promise\.resolve\(\{/.test(a)) { bad.push('bare object via Promise.resolve'); return }
    if (/^buildUserMessage\s*\(/.test(a) || /^buildMessage\s*\(/.test(a) || /^[A-Za-z_$][\w$.\[\]]*$/.test(a)) return
    bad.push('unrecognised: ' + a.slice(0, 40))
  })
  const builderBad = !/source\s*=\s*\{[^}]*kind:\s*'plugin:dsh-computer-use'/.test(mutant.slice(mutant.indexOf('async function buildUserMessage'), mutant.indexOf('async function buildUserMessage') + 2000))
  const branchBad = !/buildUserMessage\(\s*'继续'\s*,\s*'turn-end-card'/.test(mStripped) ||
    !/buildUserMessage\(\s*out\.custom\s*,\s*'turn-end-strategy'/.test(mStripped)
  if (bad.length === 0 && !builderBad && !branchBad) { console.error(`MUTATION NOT CAUGHT: "${mu.name}" left the guard GREEN`); process.exit(1) }
  caught++
}

for (const f of failures) console.error('FAIL: ' + f)
if (failures.length) { console.error(`\nFAILED — ${failures.length} message-shape violation(s) over ${sites} call sites`); process.exit(1) }
console.log(`ok test-steer-message-shape — all ${sites} steer/inject call sites deliver a real user message ` +
  `(id/role/content/source{kind}), the builder's shape is pinned, and all ${caught} mutations turn the guard red`)
