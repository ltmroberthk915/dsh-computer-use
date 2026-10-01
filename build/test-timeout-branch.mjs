// test-timeout-branch.mjs — the 60 s timer must BRANCH: a declared recommendation is executed, no
// recommendation means the timer touches nothing. And the card must SAY which of the two it will do.
//
// THE HUMAN'S RULE, in their own words (2026-09-15):
//   1. "如果60s没回复，超时之后自动进行分支判断，是否必须终结还是按照你自己的理解继续"
//   2. "如果你有推荐选项就走推荐，如果没有推荐选项就停。而不是所有情况都一定有推荐选项，因为有些问题你确实
//      是没有办法替我执行选择."
//
// The shipped code implemented NEITHER: the timer always made no decision, and the card claimed the timer
// would "按停处理" — a sentence that was wrong about the timer (it made no decision at all) and, worse,
// promised "我**不会在无人看管时自己开新回合**" even in the mode where it does open one. The human read the
// card and asked why it contradicted what they had designed. This file pins the three pieces that must
// agree: the recommendation, the card text, and the timer's action.
//
// WHY STATIC AND NOT EXECUTED: reaching this branch in Node needs `Promise.race` to time out, which needs
// the turn-end card to have been offered — i.e. a live computer-use cycle opened through a real worker
// round trip. `probe-card-loop.mjs` documents that gap. What CAN be pinned exactly is the decision
// structure and its three anchors, each with a mutation that turns it red.
//
//   node build/test-timeout-branch.mjs [path-to-index.js]
// exit 0 = the branch and the text are both complete; exit 1 = one of them regressed.

import { readFileSync } from 'node:fs'
import { MASK, maskChecked } from './mask-comments.mjs'

const PLUGIN = process.argv[2] || 'lib/index.js'
const src = readFileSync(PLUGIN, 'utf8')

const failures = []
const checks = []
const add = (name, run, brks, target) => checks.push({ name, run, brks, target })

// ---- COMMENTS ARE MASKED BEFORE ANY CHECK RUNS (review finding, 2026-09-16) ---------------------------
// This repository's style is to QUOTE CODE INSIDE ITS COMMENTS — the kernel32 fix quotes the declaration it
// is explaining, three lines above the declaration itself. A rule matching raw text can therefore be
// satisfied by prose while the code it protects is gone, which is precisely how this file's own 3d rule
// first passed while two of its mutations changed nothing. `mask-comments.mjs` holds the scanner and the
// reasons it is a scanner; it is shared with `test-turnend-agent.mjs` rather than copied, because a second
// copy is a second thing to drift.
const maskComments = (text) => maskChecked(text, PLUGIN)


// ---- 1. the recommendation is decided in ONE place, before the card is built ---------------------------
add('the card declares its recommendation (or declares that it has none)',
  (s) => {
    if (!/const recommend = recommendContinueNow\(kind, session\)/.test(s)) {
      return 'the recommendation is not resolved once, before the card is built — the timer would be making a fresh judgement while nobody watches'
    }
    return null
  },
  [{ name: 'the card stops carrying a recommendation', find: /const recommend = recommendContinueNow\(kind, session\)/, with: 'const recommend = null' }])

// ---- 2. THE TIMER BRANCHES: recommended → execute; none → touch nothing --------------------------------
add('the timer executes a declared recommendation',
  (s) => {
    const at = s.indexOf('if (out.timedOut) {')
    if (at < 0) return 'the timeout branch is gone entirely'
    const body = s.slice(at, s.indexOf('\n      }', at))
    if (!/if \(recommend\) \{/.test(body)) return 'the timeout branch no longer distinguishes a card WITH a recommendation from one without'
    if (!/buildUserMessage\(RECOMMEND_CONTINUE, 'turn-end-timeout'/.test(body)) return 'the recommended option is not delivered as a real message (see the 2026-09-15 bare-object crash)'
    if (!/recommendReason/.test(body)) return 'the log cannot say WHY the timer decided — the reason captured with the decision is not reported'
    // BRANCH ASSOCIATION, by ORDER inside the recommended branch: the fire-time re-check must precede the
    // execution, so a swapped (or re-check-less) branch is red.
    const recheck = body.indexOf('cu.stopped || brakeLatch()')
    const execute = body.indexOf('executing the RECOMMENDED option')
    if (recheck < 0 || execute < 0) return 'the recommended branch lost its re-check or its execution'
    if (execute < recheck) return 'the recommendation is executed BEFORE the fire-time re-check — a withdrawn recommendation would still run'
    return null
  },
  [{ name: 'the recommended path is dead', find: 'if (recommend) {', with: 'if (false) {' },
    { name: 'the branches are swapped', find: /if \(recommend\) \{/, with: 'if (!recommend) {' }])

// ---- 3. A RECOMMENDATION IS DECIDED BY THE TASK SITUATION, NOT BY A COUNTER ---------------------------
// The first implementation capped consecutive continuations with a config number. The human rejected that in
// one sentence: "由且仅由问题任务的情形决定，而不是几次 … 不应该这样硬编码设计." So the rules below pin the
// SITUATION as the input, and pin the ABSENCE of any budget — a counter is exactly what would creep back in.
add('the recommendation is read from the task situation, not from a count',
  (s) => {
    const at = s.indexOf('const recommendContinueNow =')
    if (at < 0) return 'recommendContinueNow() is gone — the recommendation is now unconditional'
    const body = s.slice(at, s.indexOf('\n  }', at))
    if (!/kind \|\| 'completed'\) !== 'completed'/.test(body)) return 'an ERRORED turn would now carry a recommendation — the one case where continuing is least defensible'
    // The gate is written `if (cu.stopped || brakeLatch()) return RECOMMEND_STOP` — a positive test that
    // returns the refusal. Asserting for `!cu.stopped` (the shape of an earlier revision) was silently
    // false against the real code, so the rule named a failure that did not exist.
    if (!/if \(cu\.stopped \|\| brakeLatch\(\)\) return RECOMMEND_STOP/.test(body)) return 'a recommendation can be declared while the machine is stopped or a brake is engaged'
    // POLARITY, not just presence (review E5): the mapping now lives in ONE helper, so the rule pins that
    // helper's direction and forbids an inverted ternary at a call site.
    if (!/const continueOrStop = \(session\) => \(stalledNow\(session\) \? RECOMMEND_STOP : RECOMMEND_CONTINUE\)/.test(s)) return 'the continue/stop mapping is missing or inverted — the branch would continue exactly when the task did nothing'
    if (/stalledNow\(session\) \? RECOMMEND_CONTINUE/.test(body)) return 'a call site inverts the polarity again — the one mapping must stay in continueOrStop()'
    if (!/turnEndTimeoutAction !== 'recommended'/.test(body)) return "the setting is ignored — 'stop' could never be chosen"
    // A COUNTER MUST NOT COME BACK. A bare name match is not enough: the file legitimately NAMES the
    // rejected setting inside the comment that explains why it was removed. What matters is whether it is
    // USED, so the test is a property read, a call, a declaration, or an arithmetic use — never prose.
    if (/\bautoContinue\w*\s*[.(\[]|(?:const|let|var)\s+\w*[Bb]udget\w*\s*=|\w*[Bb]udget\w*\s*[-+*/]?=|\+\+\s*\w*[Cc]ount/.test(s)) {
      return 'an executable continuation counter/budget is back in the file — the branch must depend on the task situation, not on how many times'
    }
    return null
  },
  [{ name: 'an errored turn is recommended again', find: /\(kind \|\| 'completed'\) !== 'completed'\) return RECOMMEND_STOP/, with: 'false) return RECOMMEND_STOP' },
    { name: 'a brake no longer refuses the recommendation', find: /if \(cu\.stopped \|\| brakeLatch\(\)\) return RECOMMEND_STOP/, with: 'if (false) return RECOMMEND_STOP' },
    { name: 'the stop setting is ignored', find: "config.turnEndTimeoutAction !== 'recommended'", with: 'false' },
    { name: 'the continue/stop mapping is inverted', find: 'const continueOrStop = (session) => (stalledNow(session) ? RECOMMEND_STOP : RECOMMEND_CONTINUE)', with: 'const continueOrStop = (session) => (stalledNow(session) ? RECOMMEND_CONTINUE : RECOMMEND_STOP)' }])

// ---- 3b. WHERE THE SITUATION IS WRITTEN (moved to the DISPATCH DOOR, 2026-09-16) -----------------------
// The first version wrote it in `tools/pre-execute`, which runs BEFORE every refusal (ownership, voided
// opening, cancellation, brake/policy) — so a denied or refused call could claim the task was in motion.
// The mirror error was worse: a HIGH-RISK actuation the human APPROVED reads as `kind: 'ask'` at the policy
// door, so the timer would silently never recommend exactly when a dangerous action had just been allowed.
// It is now written by `tools.js`'s `hooks.onDispatch`, called at the last statement before the tool body.
add('the situation is written at the dispatch door, and seq records EVERY computer_* dispatch',
  (s) => {
    if (!/onDispatch: \(exec\) => \{/.test(s)) return 'the onDispatch hook is gone — the situation has no honest writer'
    const at = s.indexOf('onDispatch: (exec) => {')
    const body = s.slice(at, s.indexOf('\n    },', at))
    if (!/if \(!exec \|\| typeof exec\.name !== 'string' \|\| !exec\.name\.startsWith\('computer_'\)\) return/.test(body)) {
      return 'the hook does not guard against a missing exec / a non-computer_ tool'
    }
    // ---- THE ORDER IS THE CONTRACT (rewritten 2026-09-16, and this guard USED TO PIN THE BUG) --------
    // The previous version demanded `if (!exec || !isDrivingCall(...)) return` as the hook's FIRST line —
    // i.e. it required that a non-driving call be dropped before anything was recorded, and its mutation
    // was literally named "the situation counts observation as work". That is how a WRONG BELIEF becomes
    // permanent: the code and the guard agreed with each other while both were wrong, and they took the
    // observation-only rule down with them (`seq` was empty by construction on exactly the turn that rule
    // was written for, so it could never fire — dead code that read as working).
    // What is true: `seq` is the turn's SIGNATURE and records every `computer_*` dispatch, while `action`
    // is the narrower claim "something was ACTUATED" and may only be set past the driving check. The three
    // indices below pin that order, and each of the three mutations breaks it differently.
    const push = body.indexOf('turnSituation.seq.push(')
    const drive = body.indexOf('isDrivingCall(exec.name, exec.arguments || {})')
    const act = body.indexOf('turnSituation.action = true')
    if (push < 0) return 'the turn signature is never recorded — an observation-only turn would have an empty sequence and the rule written for it could never fire'
    if (drive < 0) return 'the situation is marked without checking that the call actually DRIVES the machine — observation would count as work'
    if (act < 0) return 'nothing marks the task as mid-motion, so no card can ever recommend anything'
    if (!(push < drive && drive < act)) return 'the signature must be recorded for EVERY computer_* dispatch, while `action` may only be set past the driving check'
    if (!/turnSituation\.reason = /.test(body)) return 'the situation carries no reason, so a log line cannot say WHY the timer decided'
    // The writer must NOT be back at the policy door.
    if (/policyDecision\([\s\S]{0,900}?turnSituation\.action = true/.test(s)) return 'the situation is written at the POLICY door again — refusals happen after that point'
    if (!/turnSituation\.action = false/.test(s)) return 'nothing resets the situation — it would accumulate across turns'
    return null
  },
  [{ name: 'the signature stops recording observation turns (the observation rule goes dead again)', find: /turnSituation\.seq\.push\(`\$\{exec\.name\}`\)/, with: 'void 0' },
    { name: 'the situation counts observation as work', find: /if \(!isDrivingCall\(exec\.name, exec\.arguments \|\| \{\}\)\) return/, with: 'if (!exec) return' },
    { name: 'the hook stops guarding a missing exec', find: /if \(!exec \|\| typeof exec\.name !== 'string' \|\| !exec\.name\.startsWith\('computer_'\)\) return/, with: 'if (false) return' },
    // `\r?\n` on EVERY multi-line anchor: this file was rewritten once with CRLF endings and four
    // mutations silently stopped applying — an anchor that depends on the line ending is a guard that can
    // go quiet without failing.
    { name: 'the situation is never reset per turn', find: /turnSituation\.action = false\r?\n(\s+)turnSituation\.reason/, with: 'turnSituation.reason' }])

// ---- 3c. A TURN THAT NEVER TOUCHED THE MACHINE IS NOT A SUSPENSION (2026-09-16) ------------------------
// THE DEATH LOOP, measured: eleven cards in two and a half minutes, every one `kind=error`, because the
// account was out of credit and EVERY turn died at step 1 (`Insufficient Balance`, QUOTA/402). Each death
// ended a turn, the gate asked for a decision about a machine that had not been touched, the human
// answered, and their answer started another turn that died identically. The human's report was two words:
// "不断弹卡片". `turnSituation.seq` answers it directly — empty means this turn never reached the machine,
// so there is no cycle decision to make. A billing error belongs to the host's own "本轮运行失败", not to a
// three-option card about the machine.
add('the turn-end card fires only for a turn that actually touched the machine',
  (s) => {
    // ---- THE PREDICATE IS EXECUTED, NOT MERELY MATCHED (2026-09-16) ----------------------------------
    // Matching its characters cannot tell `seq.length > 0` from `seq.length === 0` if the surrounding
    // text is rewritten, and this one predicate is the whole difference between "no card" and the death
    // loop. So it is extracted and RUN against the three cases that matter.
    const m = s.match(/const touched = (.+)\r?\n/)
    if (!m) return 'the touched predicate is not where this probe can reach it — the gate has no record of whether the turn reached the machine'
    let evaluate
    try {
      evaluate = new Function('situationIsMine', 'turnSituation', 'session', `return (${m[1]})`)
    } catch (e) { return `the touched predicate does not even evaluate: ${e.message}` }
    const call = (mine, seq) => evaluate(() => mine, { seq }, 'sess-A')
    if (call(true, []) !== false) return 'a turn that dispatched NO computer_* call would raise a card — that is the 402 death loop (eleven cards in two and a half minutes)'
    if (call(true, ['computer_state']) !== true) return 'a turn that OBSERVED the machine still touched it and must be able to raise a card'
    if (call(false, ['computer_shot']) !== false) return "another session's dispatch is not this turn's work"
    const at = s.indexOf('const touched = situationIsMine(session)')
    const before = s.slice(at, s.indexOf('diagTurnEnd(`FIRED', at))
    if (!/!cu\.stopped && !brakeLatch\(\) && touched\)/.test(before)) {
      return 'the gate computes `touched` and then does not require it — a turn that never reached the machine still raises the card'
    }
    if (!/SKIPPED[\s\S]{0,260}?touched=\$\{touched\}/.test(s)) {
      return 'the skip line does not report whether the turn touched the machine, so "the card did not fire" has no written answer again'
    }
    return null
  },
  [{ name: 'the card fires for turns that never touched the machine again (the 402 death loop)', find: /!cu\.stopped && !brakeLatch\(\) && touched\) \{/, with: '!cu.stopped && !brakeLatch()) {' },
    { name: 'the predicate is inverted (only UNTOUCHED turns raise a card)', find: 'const touched = situationIsMine(session) && turnSituation.seq.length > 0', with: 'const touched = situationIsMine(session) && turnSituation.seq.length === 0' },
    { name: 'the predicate is stubbed true (every turn end raises a card again)', find: 'const touched = situationIsMine(session) && turnSituation.seq.length > 0', with: 'const touched = true' },
    { name: 'the skip line stops reporting the reason', find: 'touched=${touched} seq=${turnSituation.seq.length} ', with: '' }])

// Attention is now a separate module; its native identity/foreground behavior is
// exercised by test-attention.mjs. This guard protects the plugin's actual wiring.
add('the attention implementation is wired into the plugin',
  (s) => {
    if (!s.includes("import { installHumanAttention } from './attention.js'"))
      return 'the production attention module is no longer imported';
    if (!s.includes('return installHumanAttention(ctx, log)'))
      return 'the plugin no longer installs attention with its actual context and logger';
    return null;
  },
  [{ name: 'attention installation is removed', find: 'return installHumanAttention(ctx, log)', with: 'return null' },
   { name: 'attention import is removed', find: "import { installHumanAttention } from './attention.js'", with: '' }]);

// ---- the dispatch door must be WIRED in tools.js, not merely declared here ---------------------------
// This rule reads a SECOND file, and its mutation is applied to THAT file — a mutation expressed against the
// plugin source could not break a `tools.js` call even if it "applied", so `target: 'tools'` is honoured by
// the runner below instead of pretending.
const TOOLS = PLUGIN.replace(/index\.js$/, 'tools.js')
add('the dispatch door is wired in tools.js, not just declared',
  (t) => {
    if (typeof t !== 'string') return 'the runner did not hand this rule a text'
    if (!/hooks\.onDispatch\(exec\)/.test(t)) return 'tools.js never calls hooks.onDispatch — the situation would never be written'
    const call = t.indexOf('hooks.onDispatch(exec)')
    const inner = t.indexOf('const out = await inner(args, exec)')
    if (inner < 0 || call > inner) return 'tools.js calls onDispatch AFTER the tool body — it would mark calls that did not happen yet'
    if (!/if \(hooks && hooks\.onDispatch\)/.test(t)) return 'tools.js calls onDispatch without checking that hooks itself exists — registerTools is legal without one, and that threw into a dispatch'
    return null
  },
  [{ name: 'tools.js stops calling the hook', target: 'tools', find: 'hooks.onDispatch(exec)', with: 'void 0' },
    { name: 'the hook is called after the tool body', target: 'tools', find: /if \(hooks && hooks\.onDispatch\)[^\n]*\n        const out = await inner\(args, exec\)/, with: 'const out = await inner(args, exec)\n        if (hooks && hooks.onDispatch) { try { hooks.onDispatch(exec) } catch { } }' }],
  'tools')

// ---- 3d. THE STAGNATION SIGNATURE, AND THE OBSERVATION-ONLY CASE (2026-09-16) --------------------------
// The human rejected a COUNTER, so the loop guard has to be a COMPARISON. And a turn that only looked has no
// dispatch, so the situation gate alone would refuse to recommend on a turn that is plainly mid-task.
add('a repeated situation is not progress',
  (s) => {
    const at = s.indexOf('const stalledNow =')
    if (at < 0) return 'the stagnation signature is gone — a task that repeats the same step has nothing stopping it'
    const body = s.slice(at, s.indexOf('\n  const noteDrive', at))
    if (!/lastDrive\.seq\.join\('>'\) === turnSituation\.seq\.join\('>'\)/.test(body)) return 'the signature does not compare the two sequences — it compares something else'
    if (!/!humanAnsweredSince/.test(body)) return 'the signature does not yield to a human who has answered — the rule would overrule the person'
    if (!/situationIsMine\(session\)/.test(body)) return 'the signature is not scoped to the session that produced it'
    if (!/noteDrive\(\)/.test(s)) return 'the signature is never recorded, so nothing can ever match it'
    if (/lastDrive\.(count|n|times)\b|\+\+\s*lastDrive/.test(s)) return 'the signature became a counter — that is the design the human rejected'
    return null
  },
  [{ name: 'a repeat is no longer recognised', find: /lastDrive\.seq\.join\('>'\) === turnSituation\.seq\.join\('>'\)/, with: 'false' },
    { name: 'the signature ignores the human', find: /!humanAnsweredSince && situationIsMine\(session\)/, with: 'situationIsMine(session)' },
    { name: 'the signature is never recorded', find: /noteDrive\(\)\n/, with: '' }])

add('an observation-only turn after a driving one is still treated as mid-task',
  (s) => {
    const at = s.indexOf('const recommendContinueNow =')
    const body = s.slice(at, s.indexOf('\n  }', at))
    if (!/if \(lastTurnDrove && turnSituation\.seq\.length > 0\)/.test(body)) return 'an observation-only turn never gets a recommendation — a plain screenshot would silently end the chain'
    if (!/lastTurnDrove = turnSituation\.action/.test(s)) return "the previous turn's drive state is not carried forward, so `lastTurnDrove` can never be true"
    return null
  },
  [{ name: 'an observation-only turn loses its recommendation', find: /if \(lastTurnDrove && turnSituation\.seq\.length > 0\)/, with: 'if (false)' },
    { name: 'the carried drive state is never set', find: 'lastTurnDrove = turnSituation.action', with: 'lastTurnDrove = false' }])

// ---- 3c. THE SHIPPED DEFAULT STAYS CONSERVATIVE --------------------------------------------------------
// web/headless do not override this key, so the schema default IS what they do.
add('the shipped default stays conservative',
  (s) => {
    if (!/turnEndTimeoutAction[\s\S]{0,700}?\.default\('stop'\)/.test(s)) return "turnEndTimeoutAction no longer defaults to 'stop' — a fresh install would start unattended turns"
    return null
  },
  [{ name: 'the timeout action defaults to recommended', find: "]).default('stop')", with: "]).default('recommended')" }])

add('the situation is trusted only for the session that produced it',
  (s) => {
    if (!/turnSituation\.owner = sessionKey\(session\)/.test(s)) return 'the situation does not record WHOSE turn it describes — a host-wide turn/start would let another chat set it'
    if (!/if \(!situationIsMine\(session\)\) return RECOMMEND_STOP/.test(s)) return 'the recommendation does not check that the situation belongs to THIS session'
    const decl = s.indexOf('const situationIsMine =')
    const use = s.indexOf('if (!situationIsMine(session))')
    if (decl < 0 || use < 0 || decl > use) return 'situationIsMine is used before it is declared (TDZ at run time)'
    return null
  },
  [{ name: 'the situation is trusted machine-wide again', find: /if \(!situationIsMine\(session\)\) return RECOMMEND_STOP/, with: 'if (false) return RECOMMEND_STOP' },
    { name: 'the situation stops recording its owner', find: 'turnSituation.owner = sessionKey(session)', with: 'turnSituation.owner = null' }])

// ---- 3b. THE FIRE-TIME RE-CHECK (review A(ii)) ---------------------------------------------------------
// The gate above is evaluated ~60 s before the timer fires. A human ESC in that window sets `cu.stopped`
// and the STOP latch, and Ctrl+Alt+Q writes EXITED. Without a re-check the timer would still steer 继续 and
// wake a turn that can only produce refusals — while the card had promised the recommendation would run.
add('a brake that lands during the 60 s wait withdraws the recommendation',
  (s) => {
    const at = s.indexOf('if (out.timedOut) {')
    if (at < 0) return 'the timeout branch is gone'
    const body = s.slice(at, s.indexOf('\n      }', at))
    const recheck = body.indexOf('cu.stopped || brakeLatch()')
    const fire = body.indexOf('executing the RECOMMENDED option')
    if (recheck < 0) return 'the recommendation is executed without re-checking the machine state at fire time'
    if (fire < 0) return 'the recommended option is never executed at all'
    if (recheck > fire) return 'the re-check sits AFTER the continuation was already executed — it cannot prevent it'
    if (!/the recommendation is WITHDRAWN/.test(body)) return 'the withdrawal is silent — a human who braked mid-wait would see nothing saying their brake won'
    return null
  },
  // The anchor carries surrounding context ON PURPOSE: `if (cu.stopped || brakeLatch())` also appears in
  // `recommendContinueNow`, and `src.replace(/…/)` (no `g`) hits the FIRST match. Anchored on the log line
  // that only the fire-time branch contains, the mutation can only land here.
  [{ name: 'the fire-time re-check is removed', find: /if \(cu\.stopped \|\| brakeLatch\(\)\) \{\n(\s+)log\.warn\('turn-end decision card timed out/, with: "if (false) {\n$1log.warn('turn-end decision card timed out" }])

// ---- 4. THE CARD CANNOT PROMISE THE WRONG THING --------------------------------------------------------
add('the card text matches the branch that will actually run',
  (s) => {
    const at = s.indexOf("question: (kind === 'error'")
    if (at < 0) return 'the card question is gone'
    const q = s.slice(at, s.indexOf('options:', at))
    if (!/recommend\s*\n?\s*\?/.test(q) && !/\(recommend/.test(q)) return 'the card text does not branch on whether a recommendation exists'
    if (!/我走标着「推荐」的那一项/.test(q)) return 'the card does not tell the human that the timer will take the recommended option'
    if (!/不做决定、也不动机器/.test(q)) return 'the card does not tell the human that without a recommendation the timer touches nothing'
    // THE LIE THAT WAS SHIPPED: a blanket claim that the timer always stops, present regardless of mode.
    if (/我先按「停」处理/.test(s)) return 'the text that claimed the timer "按停处理" is back — the timer never makes that decision'
    if (/不会在无人看管时自己开新回合/.test(s)) return 'the text promising "no unattended turn" is back — false in the mode where the timer continues'
    return null
  },
  [{ name: 'the card stops branching on the recommendation', find: /\(recommend\n/, with: '(false\n' }])

add('the recommended option is marked on the card, so "走推荐" is unambiguous',
  (s) => {
    // Split into two assertions: matching the whole template literal in one regex is a quoting minefield
    // (and PowerShell interpolates `${…}` inside double quotes, which silently mangled this line once).
    if (!/o\.label === recommend/.test(s)) return 'the options are not filtered against the recommendation'
    if (!/description: .【推荐】/.test(s)) return 'the recommended option is not marked — the human cannot tell which one the timer will take'
    return null
  },
  [{ name: 'the recommendation marker is removed', find: 'description: `【推荐】${o.description}`', with: 'description: o.description' }])

// ---- run, then prove each assertion can fail -----------------------------------------------------------
// EVERY rule gets the WHOLE file, in both parameters. The runner originally passed a sliced ask body as
// the first argument while the rules read the second — so `s` was `undefined`, `.test()` threw, and the
// throw was swallowed into a FAIL that named the rule rather than the runner. A guard whose harness feeds
// it the wrong text is the same class of bug as a guard that cannot fail.
for (const c of checks) {
  const bad = c.run(maskComments(c.target === 'tools' ? readFileSync(TOOLS, 'utf8') : src))
  if (bad) failures.push(`${c.name} — ${bad}`)
}
let mutations = 0
const mutationFailures = []
// A mutation may target a DIFFERENT file (`target: 'tools'`). Its mutant text is passed to the rule as the
// first parameter, while the second stays the plugin source — so a rule that reads a sibling file must read
// the mutant it was given, which is why the tools rule takes `_b` and re-reads, and why the mutation would
// otherwise be unprovable (a plugin-only mutation cannot break a `tools.js` call site).
const toolsSrc = readFileSync(TOOLS, 'utf8')
for (const c of checks) {
  for (const m of c.brks || []) {
    mutations++
    const base = m.target === 'tools' ? toolsSrc : src
    const mutant = base.replace(m.find, m.with)
    if (mutant === base) { mutationFailures.push(`${c.name}: mutation "${m.name}" did not apply — the anchor moved`); continue }
    const still = c.run(maskComments(mutant))
    if (!still) mutationFailures.push(`${c.name}: mutation "${m.name}" left the guard GREEN`)
  }
}

// ---- THE MASKING ITSELF IS PROVEN, NOT ASSUMED ---------------------------------------------------------
// A masking step that changes no verdict is decoration. This constructs the exact defect the masking exists
// to stop: a pinned declaration DELETED from the code and re-inserted as a COMMENT. On raw text the rule
// still finds its anchor (which is how this file's own 3d rule first passed while two of its mutations
// changed nothing); on masked text it cannot. Both halves are asserted, so the demonstration cannot rot
// into "the mutant was broken for an unrelated reason".
{
  const PIN = 'return installHumanAttention(ctx, log)'
  const rule = checks.find((c) => c.name.includes('attention implementation'))
  if (!rule) { console.error('FAIL: the attention wiring rule is gone — this demonstration has nothing to prove'); process.exit(1) }
  const defective = `// ${PIN}\n` + src.replace(PIN, '')
  if (defective === src || !defective.includes(PIN)) {
    console.error('FAIL: could not construct the "a comment satisfies the guard" scenario — the anchor did not apply')
    process.exit(1)
  }
  if (rule.run(defective)) {
    console.error('FAIL: the scenario is not the one being demonstrated — the rule was already red on raw text')
    process.exit(1)
  }
  if (!rule.run(maskComments(defective))) {
    console.error('FAIL: a pinned declaration deleted from the CODE and left in a COMMENT still satisfies the guard — the masking is not protecting this rule')
    process.exit(1)
  }
}

for (const f of mutationFailures) console.error('MUTATION NOT CAUGHT: ' + f)
for (const f of failures) console.error('FAIL: ' + f)
if (failures.length || mutationFailures.length) {
  console.error(`\nFAILED — ${failures.length} rule(s) broken, ${mutationFailures.length} mutation(s) uncaught`)
  process.exit(1)
}
console.log(`ok test-timeout-branch — the 60 s timer branches (recommended → executed as a real message, none → ` +
  `touches nothing), the recommendation is read from the TASK SITUATION and never from a counter, the card text ` +
  `names which branch will run and the option itself is marked; all ${mutations} mutations turn the guard red`)
