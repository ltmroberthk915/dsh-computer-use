// build/test-ask-merge.mjs
//
// THE MERGED QUESTION PATH (merge-design.md §6: G1, G2 static half, G3, G4, G6).
//
// Why a NEW file instead of more checks in test-ask-invariants.mjs: that file is organised as "the
// three features added on 2026-09-12" and its comment-stripper, harness and mutation style are tuned
// for invariant-per-pattern checks. These four guards are a joint statement about ONE rewrite — the
// worker lost its clock, the core gained a two-op transaction, and the tool gained a deadline order —
// and they read better (and mutate more precisely) as one coherent group. G5's static half lives in
// test-monitor-lifetime.mjs, next to the SyncFromFile invariants it belongs with; the two EXECUTABLE
// guards are test-ask-release.mjs and test-ask-orphan.mjs.
//
// Every check is { name, fn(text) -> null | reason, brk: [find, with] }. `brk` MUST make the check
// fail; the self-test asserts that, and a mutation that changes nothing is reported as a test bug.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8')
const SRC = {
  worker: read('lib/core/worker.cs'),
  core: read('lib/core/index.js'),
  tools: read('lib/tools.js'),
  plugin: read('lib/index.js'),
}

/**
 * Remove comments, PRESERVING newlines (so slice windows stay meaningful). A guard that matches raw
 * text can be satisfied by a COMMENT quoting the code — see the 2026-09-13 R1 self-test miss.
 * String / char / verbatim literals are copied through untouched.
 */
function stripComments (src) {
  let out = ''
  let i = 0
  const n = src.length
  const keepNewlines = (from, to) => { for (let k = from; k < to; k++) if (src[k] === '\n') out += '\n' }
  while (i < n) {
    const c = src[i]
    const d = src[i + 1]
    if (c === '/' && d === '/') { const t0 = i; while (i < n && src[i] !== '\n') i++; keepNewlines(t0, i); continue }
    if (c === '/' && d === '*') { const t0 = i; i += 2; while (i < n && !(src[i] === '*' && src[i + 1] === '/')) i++; i = Math.min(n, i + 2); keepNewlines(t0, i); continue }
    if (c === '@' && d === '"') {
      out += '@"'; i += 2
      while (i < n) {
        if (src[i] === '"') { if (src[i + 1] === '"') { out += '""'; i += 2; continue } out += '"'; i++; break }
        out += src[i]; i++
      }
      continue
    }
    if (c === '"' || c === "'" || c === '`') {
      out += c; i++
      while (i < n) {
        if (src[i] === '\\') { out += src[i] + (src[i + 1] === undefined ? '' : src[i + 1]); i += 2; continue }
        out += src[i]
        if (src[i] === c) { i++; break }
        i++
      }
      continue
    }
    out += c
    i++
  }
  return out
}

const CODE = Object.fromEntries(Object.entries(SRC).map(([k, v]) => [k, stripComments(v)]))

const CS_END = '\n        }'
/** Slice from `sig` to the first `end` at/after it (the slice INCLUDES `end`). */
function sliceRange (text, sig, end) {
  const i = text.indexOf(sig)
  if (i < 0) return null
  const j = text.indexOf(end, i + sig.length)
  if (j < 0) return null
  return { start: i, end: j + end.length, text: text.slice(i, j + end.length) }
}

const BEGIN_ASK = 'static Dictionary<string, object> BeginAskOp(Dictionary<string, object> a)'
const END_ASK_OP = 'static Dictionary<string, object> EndAskOp(Dictionary<string, object> a)'

const CHECKS = [
  // ------------------------------------------------------------------ G1
  {
    name: 'G1: the ask op cannot hold the worker — BeginAskOp has no loop and no clock read, and `case "ask"` is gone',
    file: 'worker',
    fn: (s) => {
      const body = sliceRange(s, BEGIN_ASK, CS_END)
      if (!body) return 'BeginAskOp not found — the non-blocking half of the ask is gone'
      // Thread.Sleep inside the raise sequence is allowed and expected: it is a fixed, bounded cost
      // of raising the window, not a wait for a human. What must be absent is any LOOP and any READ
      // OF A CLOCK — the two things verify4 §3.B measured as "a second op written to stdin is never
      // answered" and "the caller's timeout kills the worker while it still holds the brake".
      for (const [token, why] of [
        ['while (', 'a wait loop — the single-threaded op loop would be occupied for the whole question'],
        ['for (', 'a loop — the op that raises the brake must return at once'],
        ['Environment.TickCount', 'a clock — the worker no longer decides when a question ends'],
        ['LastInputTick()', 'the system input sampler — an answer is data from the card now, not "some input happened"'],
      ]) {
        if (body.text.includes(token)) return `BeginAskOp contains ${token}: ${why}`
      }
      if (/case "ask":/.test(s)) return 'the dispatcher still has a one-shot `case "ask"` — a second, unbounded wait path is reachable again'
      return null
    },
    brk: [/\n(\s*)Panic\.EngageAsk\(q\);/, '\n$1Panic.EngageAsk(q);\n$1while (unchecked(Environment.TickCount - 0) < 60000) { Thread.Sleep(40); }'],
  },

  // ------------------------------------------------------------------ G2 (static half)
  {
    name: 'G2a: endAsk sits in the finally of the try that contains beginAsk',
    file: 'core',
    fn: (s) => {
      // The scope is ask()'s own body, cut at the method's closing brace. A lazy `[\s\S]*?\n  \}`
      // would happily run PAST ask() to the next such line elsewhere in the file, and then an
      // `endAsk` that had escaped the finally would still look contained. `\n  }` finds the first
      // closing brace at the method's own indentation, which is exactly the end of ask().
      const m = sliceRange(s, 'async ask (opts = {})', '\n  }')
      if (!m) return 'ask() not found'
      const body = m.text
      const begin = body.indexOf("this.call('beginAsk'")
      if (begin < 0) return 'ask() never calls beginAsk — the brake would never be raised'
      // The OUTER finally — `\n    } finally {`, at the method's own body indentation. A bare
      // `} finally {` would find the first one ANYWHERE after beginAsk, including the inner
      // `try { const beforeRelease = … } catch` block, and then an `endAsk` that had escaped the
      // outer finally would still measure as inside it (found while building this guard's mutation).
      const fin = body.indexOf('\n    } finally {', begin)
      if (fin < 0) return 'there is no finally after beginAsk'
      const end = body.indexOf("this.call('endAsk'", begin)
      if (end < 0) return 'ask() never calls endAsk — an ending with no release is the defect this merge removes'
      if (end < fin) return 'endAsk is NOT inside the finally of the try that contains beginAsk — a throw, an abort or the deadline would leave the brake up'
      return null
    },
    // MOVE the call out of the `finally`: replace the outer `} finally {` with `}` (closing the try)
    // and open a fresh block for the callback. The callback and every other statement stay where they
    // are, but `endAsk` is now lexically OUTSIDE the try/finally. (Closing a brace on the line ABOVE
    // the call does NOT work: it changes the brace count but leaves the call in the same block, and a
    // guard that fires on a brace count is not measuring containment.)
    brk: [/\n    \} finally \{\n/, '\n    }\n    {\n'],
  },
  {
    name: 'G2b: EVERY endAsk call forbids the kill (killOnTimeout false), and a missing answerer is refused',
    file: 'core',
    fn: (s) => {
      const calls = [...s.matchAll(/this\.call\('endAsk'[^)]*\)/g)].map((m) => m[0])
      if (calls.length === 0) return 'no endAsk call found'
      for (const c of calls) {
        if (!/,\s*(false|0)\s*\)$/.test(c)) {
          return `an endAsk call does not carry a falsy killOnTimeout: ${c} — killing the worker here deletes no STOP file, i.e. it ends a question with the brake still up`
        }
      }
      if (!/if \(typeof opts\.onAsk !== 'function'\)/.test(s)) {
        return 'a missing answer channel is not refused — a caller could raise a brake nothing will ever release'
      }
      return null
    },
    brks: [
      { find: /this\.call\('endAsk', \{ askId, via, keepPause \}, END_ASK_DEADLINE_MS, \/\* killOnTimeout \*\/ false\)/, with: "this.call('endAsk', { askId, via, keepPause }, END_ASK_DEADLINE_MS, true)", whole: true },
      { find: /if \(typeof opts\.onAsk !== 'function'\)/, with: 'if (false)', whole: true },
    ],
  },

  // ------------------------------------------------------------------ G3
  {
    name: 'G3: the core ask deadline is a literal, strictly below the tool deadline, and neither is derived from the other',
    file: 'tools',
    fn: (s, all) => {
      const core = all.core
      const m = /const ASK_DEADLINE_MS = (\d[\d_]*)/.exec(core)
      if (!m) return 'ASK_DEADLINE_MS not found, or it is not a bare numeric literal (an expression could be derived from the tool timeout again)'
      const askDeadline = Number(m[1].replace(/_/g, ''))
      const slice = computerAskSlice(s)
      if (!slice) return "the computer_ask registration could not be sliced out — re-anchor this guard"
      const t = /timeoutMs: (\d[\d_]*)\b/.exec(slice)
      if (!t) return 'the computer_ask registration declares no numeric timeoutMs (or declares it through an expression)'
      const toolTimeout = Number(t[1].replace(/_/g, ''))
      if (!(askDeadline < toolTimeout - 2000)) {
        return `ASK_DEADLINE_MS (${askDeadline}) is not at least 2 s below the tool deadline (${toolTimeout}) — the coupling that killed the worker mid-question (measured 15.58 s)`
      }
      if (/timeoutMs: P\('number'/.test(slice)) {
        return 'the computer_ask schema advertises a timeoutMs parameter again — the model could set a number that nothing enforces (the tools.js:420 lie)'
      }
      return null
    },
    brks: [
      { file: 'core', find: /const ASK_DEADLINE_MS = 15_000/, with: 'const ASK_DEADLINE_MS = 4_000_000' },
      { file: 'tools', find: /timeoutMs: 3_600_000,/, with: 'timeoutMs: 10_000,' },
      { file: 'tools', find: /question: P\('string', 'the one short question to put in front of the human', \{ required: true \}\),/, with: "question: P('string', 'the one short question to put in front of the human', { required: true }),\n      timeoutMs: P('number', 'how long to wait')," },
    ],
  },

  // ------------------------------------------------------------------ G4
  {
    name: 'G4: no clock anywhere in the question path, on either side of the wire',
    file: 'worker',
    fn: (s, all) => {
      // (i) both ops are clock-free, and neither runs a loop. `Thread.Sleep(` is asserted only for
      // `EndAskOp` — inside `BeginAskOp` it is the fixed, bounded cost of raising the window (the
      // restore beat and the Electron beat), which merge-design.md §6 G1 explicitly allows; what must
      // not exist in EITHER op is a loop or a read of a clock.
      for (const sig of [BEGIN_ASK, END_ASK_OP]) {
        const body = sliceRange(s, sig, CS_END)
        if (!body) return `${sig} not found`
        const tokens = sig === END_ASK_OP
          ? ['LastInputTick()', 'Environment.TickCount', 'Thread.Sleep(', 'while (']
          : ['LastInputTick()', 'Environment.TickCount', 'while (']
        for (const token of tokens) {
          if (body.text.includes(token)) return `${sig.split(' ').pop()} contains ${token} — the question path has no clock and no wait any more`
        }
      }
      // (ii) the schema parameter is gone for good.
      const slice = computerAskSlice(all.tools)
      if (!slice) return 'the computer_ask registration could not be sliced out'
      if (/timeoutMs: P\(/.test(slice)) return 'the computer_ask schema advertises timeoutMs again — it was never enforced (P() only builds the JSON-Schema node)'
      // (iv) and no prose promises a clock the code does not have.
      if (/default 60|cap 60000|responded:false|5 s|5 秒/.test(slice)) {
        return 'the computer_ask description still promises a countdown ("default 60" / "responded:false" / "5 s") — the worker has no clock at all'
      }
      // (iv) THE DERIVED DEADLINE MUST NOT COME BACK. Read the CORE's declaration (this check's own
      // `s` is worker.cs), and scope it to the declaration rather than the whole file:
      // `computer-use-core` legitimately contains `?? 5000` elsewhere (`waitForIdle`'s stable-wait
      // default), and a whole-file search would fire on a method this merge never touched.
      //
      // THE TEST IS "THE VALUE IS *ONLY* A NUMERIC LITERAL", NOT "IT DOES NOT MENTION `??`/`opts.`"
      // (audit finding, 2026-09-15). The old clause was LINE-scoped and enumerated the two ways to
      // derive it that the pre-merge code happened to use, so a derived value written across two lines
      // stayed GREEN — a whitelist of forbidden spellings is not a requirement. merge-design.md §6 G3
      // asked for exactly this: "require `ASK_DEADLINE_MS` to be a numeric literal (bare
      // digits/underscores, not an expression)". The arithmetic below is unaffected: it only needs the
      // declaration to be a literal, which is the whole point of "neither is derived from the other".
      const core = all.core
      const decl = /const ASK_DEADLINE_MS = ([^\n]*)/.exec(core)
      if (!decl) return 'the core ask deadline ASK_DEADLINE_MS is gone — the deadline this whole ordering depends on must exist'
      const value = decl[1].replace(/[;\s]+$/, '').trim()
      if (!/^\d[\d_]*$/.test(value)) {
        return `the core ask deadline is COMPUTED, not a literal (found \`${value}\`) — it must be a bare number, or an edit to the tool timeout silently inverts the order that produced the measured 15.58 s kill`
      }
      return null
    },
    brks: [
      { file: 'core', find: /const ASK_DEADLINE_MS = 15_000/, with: 'const ASK_DEADLINE_MS = (opts.timeoutMs ?? 5000) + 10_000' },
      // THE TWO-LINE SPELLING OF THE SAME MUTATION — this is the one the line-scoped clause missed.
      // It must be caught by "the value is only a literal", not by a list of banned tokens.
      { file: 'core', find: /const ASK_DEADLINE_MS = 15_000/, with: 'const ASK_DEADLINE_MS =\n  (opts.timeoutMs ?? 5000)\n  + 10_000' },
      { file: 'tools', find: /question: P\('string', 'the one short question to put in front of the human', \{ required: true \}\),/, with: "question: P('string', 'the one short question to put in front of the human', { required: true }),\n      timeoutMs: P('number', 'how long to wait (default 60000, cap 60000)')," },
      { file: 'worker', find: /\n(\s*)Panic\.EngageAsk\(q\);/, with: '\n$1Panic.EngageAsk(q);\n$1while (unchecked(Environment.TickCount - 0) < 60000) { Thread.Sleep(40); }' },
    ],
  },

  // ------------------------------------------------------------------ G6
  {
    name: 'G6: neither ask reply can carry a timeoutMs field again',
    file: 'worker',
    fn: (s) => {
      for (const sig of [BEGIN_ASK, END_ASK_OP]) {
        const body = sliceRange(s, sig, CS_END)
        if (!body) return `${sig} not found`
        if (/"timeoutMs"/.test(body.text)) {
          return `${sig.split(' ').pop()} returns a "timeoutMs" field — verify4 D7: the model was handed \`timeoutMs: 0\` while the doc comment promised it waited that long`
        }
      }
      return null
    },
    brk: [/"caretDiag", CaretDiag,/, '"caretDiag", CaretDiag,\n                "timeoutMs", 0,'],
  },
  {
    // G8 — THE CARD'S CHOICE MUST NOT BE INVERTIBLE BY EDITING ONE STRING.
    //
    // (Added after the independent D3 audit, 2026-09-15. It found NO guard anywhere pinned either the
    // option order or the label text, and the ONLY behavioural guard on this path stubs
    // `selected: []` — so it can only ever exercise the empty-selection⇒release branch. That left the
    // human's most safety-critical answer, "keep the brake", resting on two facts nothing checked:
    // that the recommended option is ② 放你走 (the human's explicit D3 choice, made after being shown
    // that "② first" and "the recommended one is badged" can only hold on the SAME option), and that
    // `keepPause` is keyed on the ① label — the option NOT carrying the badge.)
    name: 'G8: the card lists the recommended ② first, and keepPause is keyed on ①',
    file: 'plugin',
    fn: (s) => {
      const mStop = /const STOP_LABEL = '([^']+)'/.exec(s)
      const mGo = /const GO_LABEL = '([^']+)'/.exec(s)
      if (!mStop || !mGo) return 'the two card labels are gone — computer_ask has no choices to offer'
      const STOP = mStop[1]; const GO = mGo[1]
      if (!GO.includes('(Recommended)')) return 'the recommended badge is not on ② 放你走 — the human chose ② as the promoted option, and the client badges whichever label ENDS "(Recommended)" (client.js:651,683)'
      if (STOP.includes('(Recommended)')) return 'the recommended badge is on ① 让你停 — that is the pre-decision state; the promoted choice must be ②, not the one that keeps the brake'
      const i = s.indexOf("id: 'computer_ask'")
      if (i < 0) return "the computer_ask question block could not be found in the plugin"
      // LASTIndex, not indexOf: `}],` first occurs INSIDE the options array (`...'(Recommended)' },\n
      // { label: ... }]`), so a first match would cut the slice in half and the guard would report a
      // missing options array — measured, that is exactly how this check failed on its first run.
      const j = s.lastIndexOf('}],')
      if (j < i) return 'the computer_ask question block could not be sliced'
      const o = /options:\s*\[([\s\S]*?)\]/.exec(s.slice(i, j + 3))
      if (!o) return 'the computer_ask options array is gone'
      const order = [...o[1].matchAll(/label:\s*([A-Z_]+)/g)].map((x) => x[1])
      if (order.length !== 2) return `expected exactly 2 options, found ${order.length}`
      if (order[0] !== 'GO_LABEL') return `the card lists ${order[0]} first — the human's D3 decision is ② 放你走 first, and LISTED FIRST is what puts the badge at the top because the client renders in array order`
      // The pairing that actually protects the brake: the answer is compared against the ① label, so the
      // badge suffix must NOT ride on ① (a client that normalised labels would otherwise turn choosing
      // "stop" into a RELEASE). This is the assertion the audit asked for.
      if (!/keepPause:\s*selected\.includes\(STOP_LABEL\)/.test(s)) {
        return 'keepPause is no longer keyed on selected.includes(STOP_LABEL) — the pause decision must come from the ① option the human clicked, and nothing else in this file compares against either label'
      }
      return null
    },
    brks: [
      { file: 'plugin', find: /options: \[\{ label: GO_LABEL[\s\S]*?\{ label: STOP_LABEL[^\]]*\]/, with: "options: [{ label: STOP_LABEL, description: 'x' },\n            { label: GO_LABEL, description: 'y' }]" },
      { file: 'plugin', find: /const GO_LABEL = '([^']+)\(Recommended\)'/, with: "const GO_LABEL = '$1'" },
      { file: 'plugin', find: /keepPause: selected\.includes\(STOP_LABEL\)/, with: 'keepPause: selected.includes(GO_LABEL)' },
    ],
  },
  {
    // G9 — A BRAKE MUST STOP THE AGENT, NOT ONLY THE MACHINE (2026-09-15).
    //
    // The human's brake engaged the brake and steered a "WRAP UP" notice, but `agent.steer` only lands
    // at a step boundary and observation stayed legal while paused — so the agent always had one more
    // legal move and kept taking it. The human's own words, twice: "卡停就是让你停住, 关键是你没停啊?".
    // The fix refuses EVERY computer_* call at the one door they all use (`reg` in tools.js) and puts
    // the wrap-up directive IN the refusal, so it arrives as the result of the call already in flight.
    name: 'G9: a paused cycle refuses every driving call at the door, and never the safety direction',
    file: 'plugin',
    fn: (s, all) => {
      const t = all.tools
      // (i) the door refuses.
      // EVERY clause below is anchored from the `if (hooks && hooks.askBlocked)` GUARD, not from the
      // first occurrence of the name: the explanatory comment above the door mentions it first, and a
      // window measured from a bare name match searched prose (measured — that is what left this
      // clause unable to fail). The mutation replaces the guard line, so anchoring there is what makes
      // "the refusal is unreachable" detectable at all.
      const door = t.indexOf('if (hooks && hooks.askBlocked)')
      if (door < 0) return 'tools.js has no `if (hooks && hooks.askBlocked)` door — nothing stops the agent taking one more step while the brake is up'
      // THE WINDOW IS THE DOOR'S OWN BODY, DELIMITED BY ITS `throw err`, not a fixed character count.
      // A 700-char window ran PAST the door and picked up the PRE-EXISTING cancellation refusal further
      // down tools.js, which carries the same `err.dshCycleRefusal = true` and `throw err` — so a door
      // that computed `why` and merely logged it still matched, and this clause could not fail
      // (independent audit, 2026-09-15). Ending the window at the door's own throw makes those markers
      // the door's OWN, which is the only reading under which the clause means anything.
      const throwAt = t.indexOf('throw err', door)
      if (throwAt < 0) return 'the door never throws — a computed refusal with no throw disables the whole fix'
      const dtxt = t.slice(door, throwAt + 'throw err'.length)
      if (!/why = hooks\.askBlocked\(def\.name\)/.test(dtxt)) return 'the door does not pass the tool NAME to askBlocked, so the safety-direction exemption cannot be decided'
      if (!/err\.dshCycleRefusal = true/.test(dtxt)) {
        return 'the pause refusal is not marked as a refusal — a plain error reads as a hiccup and invites a retry'
      }
      // (ii) it fires ONLY while paused, and names the reason. BOTH clauses are matched against a
      // region that CONTAINS the refusal string, because `/brakeWhy/` alone is satisfied by the
      // `let brakeWhy` declaration at the top of apply() — a guard that a declaration can satisfy is
      // not pinning the refusal at all (audit, 2026-09-15).
      const refusalAt = s.indexOf('WRAP UP NOW')
      if (refusalAt < 0) return 'the refusal does not carry the wrap-up directive, so the fix is a wall with no instruction'
      const refusal = s.slice(Math.max(0, refusalAt - 1500), refusalAt + 200)
      if (!/if \(st !== 'paused'\) return null/.test(refusal)) return 'askBlocked does not gate on the cycle actually being paused — it would refuse calls on a live cycle'
      if (!/brakeWhy/.test(refusal)) return 'the refusal cannot state WHY the brake is up — the one fact a wrapping-up agent would otherwise observe to learn'
      // (iii) THE SAFETY DIRECTION IS NEVER GATED (exit/stop/acknowledge/recover + the card).
      // Anchored at the line START and at `) return null`, so appending `|| toolName === '...'` — which
      // would widen the exemption — cannot satisfy it (audit, 2026-09-15).
      if (!/^\s*if \(toolName === 'computer_ctrl' \|\| toolName === 'computer_ask'\) return null\s*$/m.test(s)) {
        return 'the safety-direction tools are not exempt on their OWN line — a pause would block computer_ctrl (exit/stop/acknowledge/recover) or computer_ask, which must keep working while stopped'
      }
      // (iv) THE AGENT'S OWN TEMPORARY PAUSE MUST STAY RECOVERABLE. `recover` needs a successful
      // observation first (worker.cs RecoveryPermit.Observed), so refusing observation during a
      // temporary pause turned `temporary:true` into a one-way door to the human's Ctrl+Alt+R — the
      // regression the audit made blocker 1 of this change.
      if (!/const agentOwnPause = !!temporaryPause/.test(s)) return "askBlocked cannot tell the agent's own temporary pause from a human brake"
      if (!/if \(agentOwnPause\) \{[\s\S]{0,400}?if \(OBSERVATION\) return null/.test(s)) {
        return "the agent's own temporary pause does NOT exempt observation — recover's Observed requirement can never be met, so temporary:true becomes a one-way door"
      }
      return null
    },
    brks: [
      { file: 'tools', find: /if \(hooks && hooks\.askBlocked\) \{/, with: 'if (false) {' },
      { file: 'tools', find: /err\.dshCycleRefusal = true/, with: 'err.dshCycleRefusal = false' },
      { file: 'plugin', find: /^\s*if \(toolName === 'computer_ctrl' \|\| toolName === 'computer_ask'\) return null\s*$/m, with: 'if (false) return null' },
      { file: 'plugin', find: /if \(st !== 'paused'\) return null/, with: 'if (st !== "never") return null' },
      { file: 'plugin', find: /if \(agentOwnPause\) \{[\s\S]{0,500}?if \(OBSERVATION\) return null/, with: 'if (agentOwnPause) { if (false) return null' },
      { file: 'plugin', find: /const agentOwnPause = !!temporaryPause/, with: 'const agentOwnPause = false' },
    ],
  },
]

/** The `computer_ask` registration, from `name: 'computer_ask'` to the end of that `reg({...})` call. */
function computerAskSlice (s) {
  const i = s.indexOf("name: 'computer_ask'")
  if (i < 0) return null
  const j = s.indexOf('\n  })', i)
  return j < 0 ? null : s.slice(i, j)
}

const run = (check, text, all) => check.fn(text, all)

const failures = []
let caught = 0
let breakers = 0

// The stripper must not move a line or remove nothing, or every slice above would be a lie.
for (const [k, v] of Object.entries(SRC)) {
  if (CODE[k].split('\n').length !== v.split('\n').length) failures.push(`self-test BUG: the comment stripper changed the line count of ${k}`)
  if (CODE[k].length >= v.length) failures.push(`self-test BUG: the comment stripper removed nothing from ${k}`)
}

const ALL = CODE
for (const c of CHECKS) {
  // `target` is the file the CHECK declares; `bfile` is the file a MUTATION touches. They differ for
  // a cross-file check (G4's schema clause lives in tools.js while its clock clause lives in
  // worker.cs), and conflating them makes a mutation in one file "verify" a check on another.
  const target = c.file || 'tools'
  const bad = run(c, ALL[target], ALL)
  if (bad) failures.push(`${target}: ${bad}`)

  const brks = (c.brks || (c.brk ? [c.brk] : [])).map((b) => (Array.isArray(b) ? { find: b[0], with: b[1] } : b))
  if (brks.length === 0) { failures.push(`${target}: ${c.name} — has no self-test mutation`); continue }
  for (const b of brks) {
    const bfile = b.file || target
    breakers++
    const re = b.find instanceof RegExp ? new RegExp(b.find.source, b.find.flags.includes('g') ? b.find.flags : b.find.flags + 'g') : null
    if (re) re.lastIndex = 0
    const present = re ? re.test(SRC[bfile]) : SRC[bfile].includes(b.find)
    if (!present) { failures.push(`${bfile}: self-test cannot mutate "${c.name}" — the anchor is gone`); continue }
    if (re) re.lastIndex = 0
    const mutated = re ? SRC[bfile].replace(re, b.with) : SRC[bfile].split(b.find).join(b.with)
    if (mutated === SRC[bfile]) { failures.push(`${bfile}: self-test BUG — the mutation for "${c.name}" changed nothing`); continue }
    const mAll = { ...ALL, [bfile]: stripComments(mutated) }
    // The check runs against the file it DECLARES (`c.file`), reading the mutated file through `all`.
    // Indexing the mutant by `bfile` here would silently run a `file: 'worker'` check against the
    // tools source whenever the mutation lives elsewhere — a guard that reports green on the wrong
    // file (found while wiring G4's cross-file mutation).
    const verdict = run(c, mAll[target], mAll)
    if (process.env.DSH_CU_GUARD_DEBUG) console.error(`[dbg] ${c.name} | mutated=${bfile} | target=${target} | verdict=${verdict}`)
    if (verdict === null) failures.push(`${bfile}: self-test FAILED — the guard accepted "${c.name}" broken (mutation was applied to ${bfile})`)
    else caught++
  }
}

if (caught !== breakers) failures.push(`self-test: only ${caught}/${breakers} mutations were caught`)

if (failures.length) {
  console.error('FAIL test-ask-merge')
  for (const f of failures) console.error('  ' + f)
  process.exit(1)
}
console.log(`ok test-ask-merge — G1/G2(static)/G3/G4/G6/G8/G9 hold across 4 files (${caught}/${breakers} mutations caught by the self-test)`)
