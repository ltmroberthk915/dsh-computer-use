import { installApprovalAttribution } from './approval-attribution.js'
import { HOST_DEBUG_FILE, noteHostBlocked, readHostDebug, sessionPermission, writeHostDebug } from './host-debug.js'
import { installHumanAttention } from './attention.js'
// dsh-computer-use — DSH Cordis plugin
//
// Native DSH integration for computer use. Mirrors the @anweat/dsh-browser
// plugin pattern: settings registration, a pure-function policy gate hooked
// into tools/pre-execute, and defineTool() registrations from
// @deepseek-ai/dsh-tools. All heavy lifting lives in
// @dsh/computer-use-core (native worker + SoM + audit).
//
// Approval mapping (see lib/policy.js):
//   read-only      → observation only, actuation denied
//   standard       → observation allowed, every actuation asks (harness approval UI)
//   autonomous     → actuation allowed except high-risk ops (still asks)
//   unrestricted   → everything allowed (worker failsafe corner + rate limit remain)
//
// `ask` is only honoured when the session CAN ask. Under the host's `never` approval policy —
// the one the danger-full-access preset selects — an ask is settled by policy.js instead:
// full access runs it under the human's standing grant, every other sandbox refuses and names
// the unavailable channel. It is never forwarded to a host that would answer `the user rejected
// tool "..."` on the user's behalf (measured 2026-11-12).
//
// Two out-of-band behaviours live here rather than in the tool layer, because both are
// triggered by things that happen while the MODEL is not calling anything:
//
//   1. THE BRAKE IS ANNOUNCED INTO THE SESSION. The native worker's low-level keyboard hook
//      fires the instant the human hits ESC / Ctrl+Alt+Q and writes an unsolicited NDJSON
//      event; that event is steered into the running session, so the model learns it was
//      stopped mid-turn instead of on the human's NEXT message (2026-09-13 requirement).
//      It cannot go through `tools/pre-execute`: PreToolDecision is {kind:'allow'|'deny'|'ask'}
//      only — that hook has no message channel at all.
//   2. THE ACTIVITY BORDER IS CUT INSTANTLY WHEN THE TURN ENDS (`agent/status` → idle), so a
//      lingering blue border can never claim the machine is still being driven.

import { defineTool } from '@deepseek-ai/dsh-tools'
import Schema from '@deepseek-ai/schemastery'
import { ComputerUse } from './core/index.js'
import { policyDecision, HIGH_RISK_NOTE, ACTUATION_TOOLS } from './policy.js'
import { readApprovalEnv, describeApprovalEnv } from './approval-env.js'
import { acknowledge, isAcked, ACK_HINT, isDrivingCall } from './skill-gate.js'
import { mkDataDir, snapshotPath, installAudit, appendGate, gateArgSummary, redactReasonText } from './audit.js'
import { registerTools, isCycleStateOnly } from './tools.js'
import { installToolExposure, ACTIVATION_TOOL } from './exposure.js'
import { scopeOf } from '@deepseek-ai/dsh-scope'
import { createCycleGate, agentKeyOf } from './cycle.js'
import { recoveryProblem } from './recovery.js'
import { createCycleLifecycle } from './cycle-lifecycle.js'
import { createLeaveTimer } from './leave-timer.js'
import { createTerminalCleanup } from './terminal-cleanup.js'
import fs from 'node:fs'

/**
 * Build a REAL user message for `agent.steer()` / `agent.inject()`.
 *
 * WHY THIS IS A MODULE-LEVEL FUNCTION AND NOT AN INLINE OBJECT (measured crash, 2026-09-15). The
 * turn-end card's 继续 / custom-text branches used to call `recipient.steer({ text: '继续' })` — a bare
 * object with no `source`. `steer` puts the message straight into the agent's inbox, and the harness's
 * own listeners read it as a UserMessage:
 *
 *   `@deepseek-ai/dsh-tool-jobs/lib/index.js:175`
 *     if (delivery === "wakeup") ctx.on("agent/inbox/claimed", ({ agent, message }) => {
 *       if (message.source.kind === "user") spentWakes.delete(agent);
 *     });
 *
 * With `source` undefined that line throws, the delivery dies, and the human sees the round fail —
 * measured, twice, immediately after selecting 继续:
 *   `[session-store] session/event listener threw: TypeError: Cannot read properties of undefined (reading 'kind')`
 *   `[agent-loop]   agent event "agent/inbox/claimed" listener threw: TypeError: ... reading 'kind'`
 * Both were swallowed by this plugin's own `try`, so the ONLY symptom was "选1之后崩溃".
 *
 * The shape is the one the harness itself uses (`createUserMessage({content, source})` → a message with
 * `{id, role:'user', content, source}`); the dynamic import is tried first so the real constructor owns
 * identity and freezing, and the hand-built fallback keeps the SAME four fields — the field that must
 * never be missing is `source.kind`. This function was previously nested inside `apply()` and used only
 * by `notice()`; it moved here so the card's branches cannot drift back to a bare object.
 */
async function buildUserMessage (text, form, detail) {
  // THE PRODUCER-OWNED V4 KIND (2026-09-30). Session format v4 REFUSES the retired plugin wrapper —
  // native admission throws `SessionFormatError: format v4 message requires a producer-owned source kind`
  // for `kind === 'plugin'`, which killed every round that steered a notice ("本轮运行失败"). The v3→v4
  // migrator lifts exactly this record with `rewritePluginSource()`: `producerKind()` maps a plugin to
  // `plugin:<name>` and the `plugin` field is DROPPED. Keep this literal in step with that function.
  const source = { kind: 'plugin:dsh-computer-use', form, ...(detail ? { summary: detail } : {}) }
  const content = [{ type: 'text', text }]
  try {
    const { createUserMessage } = await import('@deepseek-ai/dsh-llm')
    if (typeof createUserMessage === 'function') return createUserMessage({ content, source })
  } catch { /* the host may not resolve the package for plugins; the fallback below is equivalent */ }
  return { id: `cua-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`, role: 'user', content, source }
}
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// isDrivingCall lives in skill-gate.js (not here) so the guard can IMPORT it and test the
// classification behaviourally — including the rule that a batch is driving only if something inside
// it drives, which a text match could never check.

// ---- THE ONE QUESTION PATH (merge-design.md §1, §5.3 items 16-17) -------------------------------
//
// Before this, `computer_ask` and `ask_user_question` were two different questions: the first
// blocked the NATIVE worker in a clock-driven wait loop (and a caller-side timeout could kill that
// worker while the brake was still up — the measured leak), the second put a card in the chat. Now
// the worker only ENGAGES the brake (`beginAsk`) and RELEASES it (`endAsk`) — no clock, no loop, no
// wait — and the waiting happens on the client-UI card, with the release guaranteed by the `finally`
// in `ComputerUse.ask`. `ask_user_question` is untouched: both surfaces render the same card.
//
// THE ANSWER CHANNEL, AND WHERE IT LIVES. `askHuman` is the ONE orchestration both tool surfaces
// share (`computer_ask` and `computer_batch`). It reads the lazily-injected service at CALL time —
// never capturing it early — so a `ctx.inject(['userQuestions'], …)` callback that lands after this
// module was applied is still picked up.
let asker = null

/**
 * Put ONE question on the shared client-UI card and wait for the human, with no countdown.
 *
 * @returns {Promise<{answered:boolean, keepPause:boolean, selected?:string[], custom?:string, reason?:string}>}
 *   `keepPause` is the HUMAN's decision and the only thing that decides whether the brake stands:
 *   true when they chose `① 让你停`, false for every other ending (②, a typed custom answer, a
 *   dismissed card, an aborted turn, the tool deadline, a failed question channel).
 */
async function askOne (question, exec) {
  if (!asker || typeof asker.ask !== 'function') {
    throw new Error('the question UI is unavailable (userQuestions not injected)')
  }
  // CAPTURE BOTH SYNCHRONOUSLY, BEFORE ANY await — the host requires the exact live agent object,
  // and reading it after an await can hand the service an agent that has already moved on.
  const agent = exec && exec.agent
  const signal = exec && exec.signal
  // D3: the card carries the two choices as ORDINARY OPTIONS. Which one is listed first and which one
  // the client badges "(Recommended)" is the human's decision, recorded with the labels below. (This
  // comment used to assert "① first and badged" — it was left behind by the reordering and contradicted
  // the code underneath it, which is exactly the kind of stale prose a reader trusts instead of reading on.)
  //
  // THE HUMAN SELECTS AN OPTION AND THEN CONFIRMS — this is NOT a one-click answer. Measured in
  // `dsh-client-ui-user-questions/lib/client.js` (v of this deploy): an option is a `role="radio"`
  // in a `role="radiogroup"` (`:648`,`:655`) whose click only calls `choose(label)` (`:659-661`) —
  // a DRAFT edit; the answer is sent by the footer primary button (`:776-781` → `continueFlow`
  // `:559-570` → `submitDrafts` `:530-557`), or by Enter in the custom box once the draft is
  // complete (`:580-584`,`:662-666`). The one-click path in that file belongs to the `plan-review`
  // presentation (`:264-325`), which we do not use. Consequence for the labels below: they have to
  // read as a CHOICE THE HUMAN CONFIRMS, not as a button that acts on its own.
  // D3, AS DECIDED BY THE HUMAN (2026-09-15): **② 放你走 is listed FIRST and carries the
  // `(Recommended)` badge.** The client numbers options by POSITION (`client.js:671-673`) and badges
  // whichever label ends `(Recommended)` (`:651,683`), so "② first" and "the recommended one is badged"
  // can only both hold on the SAME option — that is this option, not ①. The human was offered both
  // readings and chose: keep driving is the promoted choice; keeping the brake (①) is the deliberate act.
  // Consequence: the number the card shows beside this option is 1 while its label still says ②. The
  // LABEL is what the answer carries back and what `keepPause` is keyed on below, so the mismatch is
  // cosmetic — do not "fix" it by renumbering or by reordering the array.
  const STOP_LABEL = '① 让你停（机器停住，等你 Ctrl+Alt+R 才继续）'
  const GO_LABEL = '② 放你走（放开刹车，我继续干）(Recommended)'
  const release = (extra) => ({ answered: false, keepPause: false, ...extra })

  // THE ANSWER MUST BE ABLE TO END WHEN THE HOST ABORTS THE CALL — and THIS RACE IS LOAD-BEARING,
  // NOT BELT-AND-BRACES. Do not "simplify" it away.
  //
  // MEASURED (merge-abort-evidence.md §0.2, V1/V2 both YES): `ctx.userQuestions.ask()` does NOT race
  // the signal itself. `dsh-user-questions/lib/index.js:53` pre-checks `signal.aborted` ONCE at entry
  // and `:73-78` only RE-LABELS a rejection afterwards — the service never aborts a pending
  // waterfall. "A cancelled turn ⇒ ASK_ABORTED" is therefore a property of the forwarded client
  // answerer and its transport, not of the seam: the host-side abort becomes a `{type:"cancel",
  // eventId}` frame (dsh-api-gateway/lib/index.js:649-673) that makes the client abort a locally
  // created controller the card listens to (dsh-api-gateway/lib/client.js:622-633). V1 confirms the
  // other half: the fused `exec.signal` really is aborted by a turn cancel
  // (dsh-api-session-controller:872-877 → dsh-agent-loop:798-804 → :1118 → :517-523 →
  // dsh-tools:3180-3192). So WITHOUT this race a cancelled turn would leave the brake up until the
  // human pressed Ctrl+Alt+R — the exact leak this merge removes. Whichever settles first wins.
  let onAbort = null
  const aborted = new Promise((resolve) => {
    if (!signal) return
    if (signal.aborted) { resolve(release({ reason: 'aborted' })); return }
    onAbort = () => resolve(release({ reason: 'aborted' }))
    try { signal.addEventListener('abort', onAbort, { once: true }) } catch { onAbort = null }
  })
  try {
    const reply = await Promise.race([
      asker.ask({
        questions: [{
          id: 'computer_ask',
          question,
          header: 'computer-use 正在提问',
          // ORDER IS SIGNIFICANT: ② first, per the human's D3 choice. The client renders in array
          // order and numbers by position, so this is what puts ② (with its badge) at the top.
          options: [{ label: GO_LABEL, description: 'The brake is released and the agent keeps driving.' },
            { label: STOP_LABEL, description: 'The machine stays stopped until you press Ctrl+Alt+R.' }],
        }],
        ...(agent !== undefined ? { agent } : {}),
        ...(signal !== undefined ? { signal } : {}),
      }),
      aborted,
    ])
    // An abort can win the race with a `undefined`-shaped reply; treat anything without `answers`
    // as "no answer came back" rather than reading a field off nothing.
    const answer = reply && Array.isArray(reply.answers) ? reply.answers[0] : null
    if (!answer) return release({ reason: 'aborted' })
    const selected = Array.isArray(answer.selected) ? answer.selected : []
    const custom = typeof answer.custom === 'string' && answer.custom.trim() !== '' ? answer.custom : undefined
    // THE PAUSE DECISION IS "IS THE ① LABEL IN `selected`" — never "did anything come back".
    // Three ways an answer arrives that are NOT a choice between ① and ②, and all three RELEASE:
    //   * a TYPED custom answer — client.js:546 makes a custom answer supersede `selected` in
    //     single-select, so `selected` is `[]` and the text is all there is. The human is talking to
    //     the agent; an unanswered brake would freeze the machine while they watch it.
    //   * a SKIP ("跳过此问题", client.js:585-595) — one click, and it auto-submits with
    //     `{selected: []}` and no custom text. An empty selection is not ①.
    //   * anything else with an empty selection, for the same reason: absent is not chosen.
    return { answered: true, keepPause: selected.includes(STOP_LABEL), selected, ...(custom === undefined ? {} : { custom }) }
  } catch (e) {
    // Every rejection here is a NO-ANSWER ending, and every one of them RELEASES the brake (a
    // dismissal is not an answer; the two explicit options are how the human chooses "stop"):
    //   * ASK_CANCELLED — the card's ✕ / 放弃整组问题 (client.js:136-142).
    //   * ASK_ABORTED   — the request was aborted (client.js:102-107), or aborted before it started.
    //   * NO_PROVIDER   — no answerer accepted the request in this profile.
    //   * DELEGATED_CALLER — THE CALLER IS AN OWNED CHILD AGENT. dsh-user-questions:56-60 refuses a
    //     question outright when the agent supplied is not a live runtime ROOT, and its own text says
    //     what to do instead: "human interaction is unavailable while the calling agent is owned by
    //     another live agent; include the unresolved question or decision in the child agent's final
    //     result". A subagent turn therefore CANNOT ask: we release the brake and hand back a reason
    //     that says so PLAINLY — never a silent `answered:false` the model could read as "the human
    //     ignored me". (`CALLER_NOT_LIVE` is mapped to the same sentence: it means the agent we were
    //     handed is not the live caller, so no human interaction is possible either.)
    const code = (e && e.code) || 'ask-error'
    return release({ reason: code === 'ASK_CANCELLED' ? 'cancelled'
      : code === 'ASK_ABORTED' ? 'aborted'
        : (code === 'DELEGATED_CALLER' || code === 'CALLER_NOT_LIVE')
            ? 'delegated: human interaction is unavailable while the calling agent is owned by another live agent — a subagent CANNOT ask the human; put the unresolved question or decision in the child agent\'s own final result and let the parent ask'
            : code })
  } finally {
    if (onAbort && signal) { try { signal.removeEventListener('abort', onAbort) } catch { /* already gone */ } }
  }
}

// Ctrl+Alt+Q's latch deliberately OUTLIVES the process (every fresh worker adopts the marker on
// disk). That is what makes an exit hold across restarts — and it is exactly why the TURN BOUNDARY
// has to be the thing that clears it, and why nothing else may (a stray op used to do it).
function exitRecordPath () {
  try {
    // Same override the worker honours (DSH_COMPUTER_USE_EXIT_FILE), so a test can point the whole
    // latch at an isolated directory and never touch the live record in %LOCALAPPDATA%.
    const env = process.env.DSH_COMPUTER_USE_EXIT_FILE
    if (env) return env
    const base = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local')
    return path.join(base, 'dsh-computer-use', 'EXITED')
  } catch { return null }
}

function exitedLatch () {
  try {
    const p = exitRecordPath()
    return !!p && fs.existsSync(p)
  } catch { return false }
}

// The RECORD ITSELF, not just its existence: the opener hands this text to the worker, which refuses
// to clear anything that no longer matches it. A Q that lands between this read and the worker's
// compare is therefore never silently undone (#6).
function exitRecordText () {
  try {
    const p = exitRecordPath()
    return p && fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : ''
  } catch { return '' }
}

// The OTHER latch, the one nothing may ever clear except the human: the brake the worker persists
// while `_engaged`/`_stopped` are up (ESC, the human-presence monitor, an interrupted turn, an ask).
// Read with the same precedence as the worker's own `ResolveStopPath()`, so the plugin cannot be
// looking at a different file than the process it is about to talk to. This is a READ ONLY — the
// plugin has no business writing or deleting a brake (see ensureCycle: it must refuse to run while
// one is up, and `resume` is the only op it may send).
function brakeLatch () {
  try {
    const env = process.env.DSH_COMPUTER_USE_STOP_FILE
    if (env) return fs.existsSync(env)
    const base = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local')
    return fs.existsSync(path.join(base, 'dsh-computer-use', 'STOP'))
  } catch { return false }
}

// EVERY pause that needs a human must put Desktop IN FRONT, not just the approval ones.
//
// WHY THIS WAS BROADENED (human report, 2026-09-14): "我的界面只能看到你卡了一样，但根本就不知道
// 原来是需要我输入东西". An `ask_user_question` card (and an approval card) is rendered in the DSH
// chat, but if the human is working in another app the window never comes forward — so from their
// side the agent simply FREEZES with no visible reason, and the turn stalls until they happen to
// look. A pending input is useless if it is behind another window.
//
// COVERAGE — every surface where an agent turn blocks on a human:
//   * `user-questions/request` — the waterfall `ctx.userQuestions.ask()` runs; this is what
//     `ask_user_question` blocks on, and it is the ONLY path a question card can take (read from
//     @deepseek-ai/dsh-user-questions). Fires for every question surface, whatever the UI.
//   * `approval/asked` — a Host tool approval, the pre-existing case. Kept unchanged.
//   Both listeners are installed on the ROOT ctx AND inside the desktopRuntime-injected child,
//   because a scoped waterfall (`scopeTarget(agent, agent)`) is delivered to the matching scope:
//   whichever of the two sees it raises the window, and a dedupe window makes the pair idempotent.
//
// HOW: the launcher's own `desktopRuntime.show()` path (restore + show + focus). It is called ONLY
// when Desktop is not already the foreground window, so a human already looking at the chat is
// never yanked around — the point is to make a queue visible, not to steal focus on every card.
// This function NEVER answers, resumes, approves, or rejects anything: it only raises a window.
function enableHumanAttention (ctx, log) {
  return installHumanAttention(ctx, log)
}

// THE BUNDLED SKILL IS REGISTERED WITH THE HOST, NOT MERELY SHIPPED (2026-10-01).
//
// WHY THIS EXISTS: `skill-gate.js` refuses every DRIVING call until the session produces the receipt
// phrase that exists only inside `skills/computer-use/SKILL.md`. Shipping that file inside the
// package does NOT make it readable: the host's only discovery path is
// `@deepseek-ai/dsh-skill-filesystem`, which scans `<project>/.dsh/skills`,
// `<project>/.agents/skills`, configured custom dirs, `<dshHome>/skills` and `<agentsHome>/skills` —
// never `node_modules`. So a user who installs this plugin without ALSO copying the skill into
// `<dshHome>/skills` gets driving tools locked by a receipt from a manual that nothing serves, and
// the gate's own hint points at a path no provider can read. That is a release-breaking trap, and the
// host has a documented seam for exactly this case: `ctx.skills.register()` contributes an in-memory
// ("embedded") skill whose body is served from this package.
//
// WHY NOT IN `inject`: a service listed in `inject` that never resolves leaves the whole fiber
// INACTIVE and `apply` never runs at all (see the long note under `export const inject` below). The
// skill is an enhancement, never a precondition for the tools, so it goes through the same lazy
// `ctx.inject` seam the question service uses and degrades to one log line when the service is absent.
//
// A FILESYSTEM COPY STILL WINS WHERE ONE EXISTS: the registry resolves one name per layer by rank, so
// an existing `<dshHome>/skills/computer-use` keeps serving whatever the user has there and this
// registration only fills the gap where nothing else serves it. The body is re-read from disk on every
// activation, so the registered manual and the shipped file cannot drift apart.
const SKILL_DIR_URL = new URL('../skills/computer-use/', import.meta.url)

/** Split a SKILL.md's YAML frontmatter from its body, reading the flat scalar keys this needs. */
function splitSkillFile (raw) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*\r?\n?/.exec(raw)
  if (!match) return { data: {}, body: raw }
  const data = {}
  for (const line of match[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z][A-Za-z0-9_-]*):[ \t]*(.*)$/.exec(line)
    // An empty value is a nested block (mapping or sequence), not a scalar this reader needs.
    if (kv && kv[2] !== '') data[kv[1]] = kv[2].trim().replace(/^(['"])([\s\S]*)\1$/, '$2')
  }
  return { data, body: raw.slice(match[0].length) }
}

/**
 * Contribute the bundled `computer-use` skill to the host's skill registry when one is mounted.
 * Never throws into activation: a missing registry, an unreadable file or absent frontmatter leaves
 * the tools exactly as they were and says so in the log.
 */
function registerBundledSkill (ctx, log) {
  ctx.inject(['skills'], (sctx) => {
    const skills = sctx.skills
    if (!skills || typeof skills.register !== 'function') {
      log.warn('skills service is mounted but exposes no register() — the bundled computer-use skill stays unregistered; copy skills/computer-use into $DSH_HOME/skills to serve it from disk')
      return
    }
    const skillFile = fileURLToPath(new URL('SKILL.md', SKILL_DIR_URL))
    let raw
    try {
      raw = fs.readFileSync(skillFile, 'utf8')
    } catch (e) {
      log.warn(`bundled skill unreadable at ${skillFile} (${e.message}) — copy skills/computer-use into $DSH_HOME/skills to serve it from disk`)
      return
    }
    const { data, body } = splitSkillFile(raw)
    if (!data.name || !data.description) {
      log.warn(`bundled skill ${skillFile} lacks name/description frontmatter — not registered`)
      return
    }
    try {
      skills.register({
        name: data.name,
        description: data.description,
        ...(data.whenToUse ? { whenToUse: data.whenToUse } : {}),
        source: 'bundled',
        content: body,
        resourceBase: { kind: 'directory', path: fileURLToPath(SKILL_DIR_URL) },
      })
      log.info(`registered bundled skill '${data.name}' from ${fileURLToPath(SKILL_DIR_URL)}`)
    } catch (e) {
      log.warn(`skill registration refused for '${data.name}': ${e.message}`)
    }
  })
}

export const name = 'dsh-computer-use'
// `userQuestions` is the client-UI capability seam the question CARD comes from — the same one
// `ask_user_question` blocks on (merge-design.md §5.3 item 16). It is declared as an unconditional
// service by `@deepseek-ai/dsh-base` (`dsh-base/cordis.patch.yml`), which every profile this plugin
// is deployed to lists in `dsh.profile.bundles`, so injecting it cannot fail to resolve. Registering
// the tool through it is what makes `computer_ask`'s question appear on the SAME card, answered by
// the same UI, with the same no-countdown wait.
export const inject = ['tools', 'userQuestions']
export const Config = Schema.object({
  enabled: Schema.boolean().default(true).description('enable the computer-use toolset'),
  progressiveTools: Schema.boolean().default(true).description('expose desktop execution tools only to Agents that load/activate computer-use; brakes remain available'),
  actionFeedback: Schema.boolean().default(true).description('automatic post-input observation; per-call feedback can explicitly select compact, full or none'),
  actionFeedbackDetail: Schema.union([Schema.const('compact'), Schema.const('full'), Schema.const('none')]).default('compact').description('compact bounds local text readback to 6 KiB; vision keeps its image and crops only an explicitly requested verificationRegion. full retains complete route-specific feedback'),
  feedbackRules: Schema.array(Schema.object({
    provider: Schema.string().required(), model: Schema.string().required(),
    adapterVersion: Schema.string().required().description('exact adapter version, or unversioned for a conservative failed-test fallback'),
    grounding: Schema.union([Schema.const('failed'), Schema.const('verified')]).required(),
    testedAt: Schema.string().required(), expiresAt: Schema.string().required(), reason: Schema.string(),
  })).default(undefined).description('optional dated route grounding evidence; defaults to bundled expiring records; [] removes historical overrides'),
  automationMode: Schema.union([
    Schema.const('read-only').description('observation only'),
    Schema.const('standard').description('actuations require approval'),
    Schema.const('autonomous').description('actuations allowed, high-risk still asks'),
    Schema.const('unrestricted').description('everything allowed'),
  ]).default('standard').description('automation mode (mirrors dsh-browser)'),
  dryRun: Schema.boolean().default(false).description('simulate actuations, log only'),
  maxActionsPerMinute: Schema.number().default(60).description('core-level actuation rate limit'),
  workerExe: Schema.string().default('').description('explicit worker.exe path; empty = autodiscover/compile'),
  snapshotDir: Schema.string().default('').description('screenshot dir; empty = $DSH_HOME/data/computer-use/shots'),
  annotateMarks: Schema.boolean().default(true).description('draw SoM boxes on screenshots'),
  // Compatibility with saved settings only. Silence/elapsed time never ends a computer-use cycle.
  calmAfterMs: Schema.number().default(0).description('legacy setting; ignored — silence never ends a cycle'),
  // Narrow, explicit exception to the no-idle-timeout rule: armed by LEAVING the desktop for a
  // non-computer tool, cancelled by any computer_* call; 0 disables it. See lib/leave-timer.js.
  leaveDesktopGraceMs: Schema.number().default(100_000).description('release the desktop lease after this long away for another tool; 0 disables'),
  // Compatibility with saved settings; automatic completion has no question or timer.
  turnEndTimeoutAction: Schema.union([
    Schema.const('stop').description('legacy value; ignored'),
    Schema.const('recommended').description('legacy value; ignored'),
  ]).default('stop').description('legacy setting; ignored — ordinary completion releases computer use automatically'),
})

// ---- host-driving debug gates: the settings page talks to this same-origin route ----
// GET  returns the two gates' state for a session; POST writes ONLY the debug switch. Neither gate
// can be flipped from a tool call: the route is host-side and the switch is a file a tool cannot
// write (the agent has no filesystem tool that could reach it without the user seeing it in
// tool output; see lib/host-debug.js for the contract).
function installHostDebugRoute (ctx, log) {
  if (typeof ctx?.inject !== 'function') return
  ctx.inject(['webServer'], (sctx) => {
    try {
      sctx.effect(() => sctx.webServer.register({
        kind: 'prefix',
        path: '/api/computer-use/host-debug',
        handler: (req, res) => handleHostDebug(req, res, sctx),
      }), 'dsh-computer-use: host-debug settings route')
    } catch (e) { log.info('[dsh-computer-use] host-debug route not mounted: ' + (e?.message ?? e)) }
  })
}

function handleHostDebug (req, res, sctx) {
  const send = (code, body) => { try { res.statusCode = code; res.setHeader('content-type', 'application/json; charset=utf-8'); res.end(JSON.stringify(body)) } catch { } }
  try {
    let connection = null
    try { connection = sctx.get('connection') } catch { connection = null }
    const rejection = connection && typeof connection.requestRejection === 'function' ? connection.requestRejection(req) : null
    if (rejection) { send(403, { error: 'rejected by host', detail: String(rejection) }); return }
    const url = new URL(req.url, 'http://127.0.0.1')
    const sid = url.searchParams.get('session') || process.env.DSH_SESSION_ID || null
    const status = () => {
      const debug = readHostDebug()
      const perm = sessionPermission(sid)
      return { enabled: debug.enabled, since: debug.since, lastBlockedAt: debug.lastBlockedAt, session: perm, ready: debug.enabled && perm.fullAccess }
    }
    if (req.method === 'GET') { send(200, status()); return }
    if (req.method === 'POST') {
      const chunks = []
      req.on('data', (c) => { if (chunks.length < 64) chunks.push(c) })
      req.on('end', () => {
        try {
          const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
          if (typeof body.enabled !== 'boolean') { send(400, { error: 'enabled must be a boolean' }); return }
          writeHostDebug(body.enabled)
          send(200, status())
        } catch (e) { send(400, { error: String(e?.message ?? e) }) }
      })
      return
    }
    send(405, { error: 'GET or POST' })
  } catch (e) { send(500, { error: String(e?.message ?? e) }) }
}

// ---- gate notice: one card, not a stream of them --------------------------------------------
// A refused host-driving call is the moment the human can act, and the tool error alone is easy to
// miss inside a long turn. This pops ONE ask card (10-minute dedupe, never blocks the failed tool
// call) that names both gates and where to open them. It is a NOTICE: choosing "去开启" only tells
// the human where the switch is — the plugin must never flip either gate itself.
let gateNoticeAt = 0
let gateNoticePending = false
function notifyHostGate (log) {
  try {
    if (gateNoticePending) return
    if (Date.now() - gateNoticeAt < 10 * 60_000) return
    if (!asker || typeof asker.ask !== 'function') return
    gateNoticePending = true
    gateNoticeAt = Date.now()
    Promise.resolve()
      .then(() => asker.ask({
        questions: [{
          id: 'computer_use_host_gate',
          header: '电脑操控 · 调试门禁',
          question: '检测到自迭代调试被门禁拦住：需要 ① 本对话为「完全权限」，② 在 设置 → 电脑操控（调试） 中手动打开调试模式。两项都满足后，AI 才能点击/输入 Harness 自身的窗口。',
          options: [
            { label: '我去开启调试模式', description: '打开 设置 → 电脑操控（调试） 并切换开关；本对话还需保持「完全权限」。' },
            { label: '先不开启，做别的', description: 'AI 继续只读观察 Harness，不驱动它；关闭/最小化宿主始终禁止。' },
          ],
        }],
      }))
      .catch(() => { })
      .finally(() => { gateNoticePending = false })
  } catch { gateNoticePending = false }
}

export function apply (ctx, config) {
  const log = ctx.logger('dsh-computer-use')
  if (process.env.DSH_COMPUTER_USE_KILL === '1') {
    log.warn('DSH_COMPUTER_USE_KILL=1 — plugin disabled by kill switch')
    return
  }
  if (!config.enabled) return
  // Kept in scope: the gate's diagnostics report whether the legacy-attribution seam is live,
  // because "the misleading wording reached the model" and "the seam was never installed" are
  // different bugs and the next report must not have to guess which one happened.
  const approvalSeam = installApprovalAttribution(ctx, log)
  // Harness compatibility: several fixtures evaluate this module with the `import` lines stripped
  // and only a fixed argument list (test-cycle-no-timeout and friends). `typeof <binding>` is safe
  // even when the binding was stripped, so the debug-gate wiring degrades to "not mounted" there
  // instead of throwing a ReferenceError — the production module always has the real imports.
  try { if (typeof installHostDebugRoute === 'function') installHostDebugRoute(ctx, log) } catch { }
  registerBundledSkill(ctx, log)
  enableHumanAttention(ctx, log)
  // THE QUESTION SERVICE, INJECTED LAZILY (merge-design.md §5.3 item 16 — defence in depth).
  // `inject` above already guarantees the service before `apply` runs; going through `ctx.inject` as
  // well means the tool does not depend on which of the two orderings the host happened to pick, and
  // that a service arriving later still lands. `enableHumanAttention` uses the same pattern for
  // `desktopRuntime` just above.
  ctx.inject(['userQuestions'], (qctx) => {
    asker = qctx.userQuestions
    if (!asker || typeof asker.ask !== 'function') log.warn('userQuestions injected but exposes no ask() — computer_ask cannot put a question on the card')
  })

  // settings card (restart-applies) — same shape dsh-pocket/dsh-browser use
  ctx.inject(['settings'], (ctx2) => {
    ctx2.settings.register('computer-use', Config, { applies: 'restart' })
  })

  const dataDir = mkDataDir(config.snapshotDir)
  // The two host-driving gates are resolved PER CALL: the debug switch is hot (a settings toggle
  // needs no restart), and gate 1 is the CALLING conversation's own policy, not the host's.
  const gateSessionId = (context) => {
    try {
      return context?.sessionKey || (typeof context?.session === 'string' ? context.session : context?.session?.id) ||
        context?.sessionId || process.env.DSH_SESSION_ID || null
    } catch { return process.env.DSH_SESSION_ID || null }
  }
  const cu = new ComputerUse({
    workerExe: config.workerExe || undefined,
    dryRun: config.dryRun,
    kickoffRequired: config.automationMode !== 'read-only',
    rateLimit: { max: config.maxActionsPerMinute, windowMs: 60_000 },
    log: (m) => log.info(m),
    hostDebugFile: typeof HOST_DEBUG_FILE === 'function' ? HOST_DEBUG_FILE() : '',
    hostGate: typeof readHostDebug === 'function' && typeof sessionPermission === 'function'
      ? (context) => {
          try { return { debug: readHostDebug().enabled, full: sessionPermission(gateSessionId(context)).fullAccess } } catch { return null }
        }
      : null,
    onHostBlocked: typeof noteHostBlocked === 'function'
      ? () => { try { noteHostBlocked() } catch { } notifyHostGate(log) }
      : null,
  })
  const detachAudit = installAudit(cu, dataDir)

  // ---- the live agent of the session that drives this machine ------------------------------
  // Captured from the tool execution itself (`exec.agent` is the live Agent object); a session
  // only ever gets here by having called a computer_* tool.
  const bus = { agent: null, driverSession: null }

  // Telling sessions apart without assuming the host's shape: an id may be the session object
  // itself, a string, or a field on it. We only ever see it through these helpers.
  const sessionKey = (s) => {
    if (!s) return null
    if (typeof s === 'string') return s
    return s.id || s.sessionId || s.key || null
  }
  const sameSession = (a, b) => {
    if (a === b) return true
    const ka = sessionKey(a), kb = sessionKey(b)
    return ka !== null && kb !== null && ka === kb
  }
  const describeSession = (s) => {
    if (!s) return 'unknown'
    const k = sessionKey(s)
    if (k) return String(k)
    return '<' + ((s.constructor && s.constructor.name) || typeof s) + '>'
  }
  let inFlight = 0
  // Ctrl+Alt+Q cancels the turn ON PURPOSE. The abort that follows must never be mistaken for
  // the human hitting the stop button — that rule below re-armed the brake and left the red
  // border burning on screen after an exit (reported 2026-09-12).
  let selfAbortUntil = 0
  // Did THIS TURN already receive the "read the procedure" nudge? Reset at turn/start — the manual
  // is per-turn knowledge, not per-session state.
  let nudgedTurn = false
  // Did THIS TURN already open a computer-use cycle? Reset at turn/start, next to nudgedTurn —
  // same reason, same axis: a cycle belongs to a turn, not to a session.
  // NOTE (2026-09-13): the module-wide `cycleOpenedThisTurn` boolean is GONE. It was reset by ANY
  // session's turn/start (a host-wide event) and never set on the normal path, so it both leaked
  // across sessions and failed to stop a same-turn resurrection. lib/cycle.js now keeps the
  // qualification per (session, agent, turn) and consumes it on the first call of that turn.

  // ---- OPENING THE CYCLE WHERE THE CALL ACTUALLY HAPPENS ----------------------------------------
  //
  // THE BUG THIS EXISTS FOR (measured 2026-09-13, host log dsh-2026-09-13.log): a machine-wide
  // `%LOCALAPPDATA%\dsh-computer-use\EXITED` record outlives every process, and exactly ONE thing
  // clears it — the worker op `resume`. The plugin used to send that op only from the `turn/start`
  // branch below, gated on the turn belonging to `bus.driverSession`, which is only ever set by a
  // PREVIOUS session's tool call. So a BRAND-NEW session's first turn always failed `mine`:
  //   01:17:44.287  EXITED written (Ctrl+Alt+Q)
  //   01:19:51.641  a new session started its first turn — bus.driverSession still named the OLD
  //                 session → mine === false → resume() never sent
  //   01:19:55.033  its first computer_* call finally set bus.driverSession (too late: the boundary
  //                 had already passed)
  //   01:21:34.627  its first DRIVING call was refused: CYCLE-ENDED — and the agent then told the
  //                 human "you pressed Ctrl+Alt+Q".
  // A new session could therefore NEVER re-open computer use, and the turn boundary — a host-wide
  // event that says nothing about who is about to touch this machine — was the wrong place to decide.
  //
  // The right place is the call that is about to reach the worker. `ensureCycle` is awaited from the
  // ONE dispatch point every computer_* invocation passes through exactly once (lib/tools.js, the
  // `reg()` wrapper around every tool's execute), BEFORE the op is written to the worker's stdin, so
  // the ordering is enforced by an `await` in the same async chain rather than by a race between a
  // host event and a tool call. The latch makes it once per turn.
  //
  // A BRAKE IS NOT AN EXITED LATCH (hard rule — a human's brake must never be cleared by this):
  //   * only `resume` may be sent, and the worker's `resume` is `Panic.AgentCalling()`, which
  //     touches the EXITED latch ONLY — it does not clear `_engaged`/`_stopped` and does not delete
  //     the STOP file, so Ctrl+Alt+R stays the human's alone;
  //   * and this refuses to run at all while a brake is up (`cu.stopped` from the worker's `panic`
  //     event, or the persisted STOP latch), because the core's `resume()` also mirrors the state
  //     locally (`this.stopped = false`) — calling it under a brake would drift the plugin's view
  //     from the worker's while the worker still refused every actuation.
  // THE CYCLE GATE (2026-09-13, A+B from the Codex review). lib/cycle.js holds identity, ownership
  // and the per-turn qualification; this file only feeds it events and asks it, at the ONE dispatch
  // point every computer_* call passes through, whether this call may drive.
  const gate = createCycleGate({ sessionKey, agentKey: agentKeyOf, now: () => Date.now() })
  const pendingApprovals = new Set()
  let unknownApproval = false, recoveryEpoch = 0, temporaryPause = null
  // WHY THE BRAKE IS UP, kept so a refused call can say it (see `hooks.askBlocked` below). The worker
  // already sends the reason with the `panic` event; this holds it from that moment until the brake is
  // released, because by the time a call is refused the event itself is long gone.
  let brakeWhy = ''
  const recoveryBlocked = (exec) => recoveryProblem(temporaryPause, claimOf(exec), gate.snapshot(),
    pendingApprovals.size > 0 || unknownApproval, cu.exited || exitedLatch())

  // Is the machine PAUSED or ASKING right now? Three independent witnesses, because any one of them
  // can be missing: the core's mirror of the worker's brake (`cu.stopped`), the persisted STOP latch
  // every process obeys, and the gate's own state derived from the panic/ask events. A pause is the
  // human holding the machine: the cycle, its owner and the red border stay until they resume or end
  // it, so nothing that "cleans up idleness" may touch it (F1 — both the idle signal and its
  // watchdog used to).
  const pausedOrAsking = () => {
    try {
      const st = gate.state()
      return st === 'paused' || st === 'asking' || cu.stopped === true || brakeLatch()
    } catch { return false }
  }

  // The claim a call brings — its OWN session and agent. NOT `bus.driverSession`: that is written
  // only by a previous call, and gating on it is exactly why a brand-new session could never open a
  // cycle (measured 01:19:51: `mine === false`, resume never sent, its first driving call refused).
  const claimOf = (exec) => {
    const s = (exec && (exec.session || exec.sessionId)) ||
      (exec && exec.agent && (exec.agent.session || exec.agent.sessionId)) || null
    return gate.claim({ session: s, agent: exec && exec.agent })
  }

  const callOwners = new WeakMap()
  const ensureCycle = async (exec) => {
    const cl = claimOf(exec)
    // `gate.open` RESERVES ownership synchronously and THROWS for a foreign claim, so reaching the
    // line below means this call is the owner — and only then is the machine's mailbox rebound.
    const pending = gate.open(cl, async () => {
      if (!cu.exited && !exitedLatch()) return { opened: false, reason: 'nothing to open' }
      if (cu.stopped || brakeLatch()) {
        // A BRAKE IS NOT AN EXITED LATCH: the plugin must never clear a human's brake, and the
        // core's resume() would drift `cu.stopped` while the worker still refused every actuation.
        log.warn('not opening a cycle: a brake is engaged (only the human\'s Ctrl+Alt+R releases it)')
        return { opened: false, reason: 'brake' }
      }
      // The record we are about to clear, quoted exactly, so the worker can refuse if a NEWER one
      // appeared while this op was on its way (an exit during a worker spawn or a stdin write).
      const expect = exitRecordText()
      // Rejections ride the SHARED qualification promise: every later call in this turn awaits the
      // same outcome instead of retrying it into a resurrection.
      const cycleId = gate.snapshot().id
      const openingContext = { signal: exec?.signal, cycleId, sessionKey: cl.sessionKey, agentKey: cl.agentKey,
        assertOwnership: () => gate.assertOwnership(cl, cycleId) }
      const resume = async () => {
        await cu.resume(expect)
      }
      if (cu.withInputContext) await cu.withInputContext(openingContext, resume)
      else await resume()
      if (!cu.exited && !exitedLatch()) {
        log.info('opened a new computer-use cycle for this turn (cleared the Ctrl+Alt+Q record left by an earlier cycle)')
        return { opened: true }
      }
      // Still a record after a resume that reported success: someone wrote a new one in between.
      log.warn('a computer-use exit record is still present after resume — a newer exit stands; the call that follows will be refused')
      return { opened: false, reason: 'a newer exit record stands' }
    })
    if (exec && typeof exec === 'object') callOwners.set(exec, { claim: cl, cycleId: gate.snapshot().id })
    // THE MACHINE'S MAILBOX BELONGS TO THE OWNER (integration bug, 2026-09-13). Binding it in
    // `tools/pre-execute` meant EVERY caller rebound it — including one the gate was about to refuse
    // as foreign — so a Ctrl+Alt+Q could cancel the wrong session while the real owner kept working
    // (they also got the pause/ask/R messages). It is rebound here, where ownership is actually
    // taken, and nowhere else; caller-scoped prompts name their own agent explicitly.
    if (gate.owns(cl)) {
      if (exec && exec.agent) bus.agent = exec.agent
      if (cl.sessionKey) bus.driverSession = cl.sessionKey
    }
    return pending
  }

  const lifecycle = createCycleLifecycle({
    gate, cu, claimOf, owner: () => ({ session: bus.driverSession, agent: bus.agent }),
    paused: pausedOrAsking, inFlight: () => inFlight,
    ownershipOf: exec => exec && typeof exec === 'object' ? callOwners.get(exec) : null,
  })
  const leaveTimer = createLeaveTimer({
    gate, claimOf, log,
    notice: (...args) => notice(...args),
    graceMs: config.leaveDesktopGraceMs,
    setTimer: setTimeout, clearTimer: clearTimeout,
    release: (exec, why, automatic, expected) => lifecycle.release(exec, why, automatic, expected),
  })
  cu.on('handoff', () => {
    lifecycle.settle()?.catch(error => log.warn(`computer-use handback completion failed: ${error.message}`))
    leaveTimer.retryNow()
  })

  const terminalCleanup = createTerminalCleanup({
    gate, cu, claimOf, owner: () => ({ session: bus.driverSession, agent: bus.agent }),
    paused: pausedOrAsking, report: error => log.warn(`computer-use terminal cleanup failed: ${error.message}`),
  })
  const hooks = {
    contextOf: (exec) => {
      const owner = exec && typeof exec === 'object' ? callOwners.get(exec) : null
      return owner ? { cycleId: owner.cycleId, sessionKey: owner.claim.sessionKey, agentKey: owner.claim.agentKey } : {}
    },
    assertOwnership: (exec) => {
      const owner = exec && typeof exec === 'object' ? callOwners.get(exec) : null
      if (!owner) {
        const error = new Error('COMPUTER_OWNER_REQUIRED: this call has no computer-use ownership claim; no input was dispatched.')
        error.code = 'COMPUTER_OWNER_REQUIRED'; error.outcome = 'not-dispatched'; error.dshCycleRefusal = true
        throw error
      }
      gate.assertOwnership(owner.claim, owner.cycleId)
    },
    releaseCycle: (exec, why) => { leaveTimer.clear(); return lifecycle.release(exec, why) },
    onStart: (exec) => {
      inFlight++
      leaveTimer.cancel(exec)
      if (isCycleStateOnly(exec?.name, exec?.arguments)) {
        callOwners.set(exec, { claim: claimOf(exec), cycleId: gate.snapshot().id })
      }
    },
    onEnd: () => {
      inFlight = Math.max(0, inFlight - 1)
      lifecycle.settle()?.catch(error => log.warn(`computer-use deferred completion failed: ${error.message}`))
      leaveTimer.retryNow()
    },
    // ---- THE WRAP-UP DIRECTIVE (2026-09-15) --------------------------------------------------------
    // WHAT WENT WRONG. A human brake (ESC, a mouse shake, the wheel, typing outside the host) engaged
    // the brake and steered a "WRAP UP NOW" notice into the turn — but `agent.steer` only delivers at a
    // STEP BOUNDARY, so a turn already inside a long or in-flight call never read it, and OBSERVATION
    // calls kept succeeding while paused (`worker.cs:2401`: "the brake stops CONTROL, not
    // OBSERVATION"). The result the human actually saw, twice, in their own words: "卡停就是让你停住,
    // 关键是你没停啊? 你还在思考中啊" — the brake stopped the MACHINE while the agent kept walking,
    // because there was always one more legal step to take.
    //
    // THE FIX IS NOT TO CANCEL THE TURN (that was offered and rejected): the human's design is
    // "让我在知道我触发红框暂停之后快速收尾" — wrap up QUICKLY, not die silently. So every computer_*
    // call made while the brake is up is refused AT THE ONLY DOOR THEY ALL USE (registerTools' `reg`),
    // and the refusal itself carries the wrap-up directive. The instruction therefore arrives as the
    // RESULT of the call the model is already making — no step boundary to wait for, nothing to miss.
    //
    // Observations are refused too, deliberately. Leaving them open is what made "wrap up" optional:
    // the model could always take one more look, and did. The cost is real and accepted — the agent
    // cannot inspect the frozen screen to describe it — so the refusal names the brake's reason, which
    // is the one fact it would have gone looking for.
    //
    // `asking` is NOT refused: a question is the safety direction and the card is the answer surface.
    // `ended` is left to the cycle gate, which already owns that verdict.
    // SAFETY-DIRECTION EXEMPTIONS, and they are NOT optional: `computer_ctrl`, `computer_ask` and
    // `computer_batch` all go through the SAME `reg` wrapper, so a blanket refusal while paused would
    // have blocked the very tools the human needs in a stop — `computer_ctrl`'s `exit` (Ctrl+Alt+Q's
    // twin), its `stop`, and the `acknowledge` read-receipt — plus the question card itself. The skill
    // states the rule plainly: observation may be gated, the safety direction never is.
    askBlocked: (toolName) => {
      // SAFETY-DIRECTION TOOLS ARE NEVER GATED: `computer_ctrl` carries exit/stop/acknowledge/recover
      // and `computer_ask` is the question card. All three of these (plus `computer_batch`, which
      // reaches the same HANDLERS map) go through the one `reg` door, so a blanket refusal would have
      // blocked exactly what must keep working while stopped — the skill states the rule plainly.
      if (toolName === 'computer_ctrl' || toolName === 'computer_ask') return null
      // ONLY DRIVING IS REFUSED — the allowlist is the OBSERVATION tools, and everything else falls
      // through to be refused. (First shipped as "refuse everything", which was a REGRESSION the
      // independent audit caught: the AGENT'S OWN temporary pause also lands here, and `recover`
      // requires a successful observation first — `worker.cs` `RecoveryPermit.Observed` is set only by
      // windows/uia/capture/uiaFromPoint, and the worker answers `read the current target state after
      // this pause first` without it. Refusing observation turned `computer_ctrl{temporary:true}` into
      // a one-way door whose only exit was the human's Ctrl+Alt+R, while the text blamed the human.)
      // `computer_wait` and a clipboard READ are not observation ops in the worker's sense, but they
      // actuate nothing either, so they are deliberately left legal: refusing them would add no safety
      // and would hide the reason the agent is stopped.
      const OBSERVATION = toolName === 'computer_shot' || toolName === 'computer_state' ||
        toolName === 'computer_marks' || toolName === 'computer_uia'
      const st = gate.state()
      if (st !== 'paused') return null
      const agentOwnPause = !!temporaryPause
      if (agentOwnPause) {
        // An agent-owned diagnostic pause: observation must stay legal (it is how `recover` becomes
        // reachable), and actuation stays refused. The exit route is named because it is a credential,
        // and losing it really does leave only the human's Ctrl+Alt+R.
        if (OBSERVATION) return null
        return 'this is YOUR OWN temporary pause (computer_ctrl{temporary:true}) — actuation is refused ' +
          'until you release it. Observe the target, confirm the blocker is gone, then call ' +
          "computer_ctrl{action:'recover', pauseId:'<the credential your stop returned>'}. " +
          'Only a human Ctrl+Alt+R can release it if that credential is lost.'
      }
      if (OBSERVATION) {
        return 'the human has STOPPED this machine — ' + (brakeWhy || 'a brake is engaged') + '. ' +
          'Nothing will be dispatched, not even a look at the screen, so do not try. ' +
          'WRAP UP NOW in one or two sentences: what was interrupted and the exact state you left it in. ' +
          'Then stop and wait. Do NOT retry, do NOT start anything new, do NOT end the session, and do ' +
          'not ask the human to resume — Ctrl+Alt+R is theirs and it will wake you with "继续".'
      }
      return 'the human has STOPPED this machine — ' + (brakeWhy || 'a brake is engaged') + '. ' +
        'Nothing that drives it will be dispatched, so do not try. ' +
        'WRAP UP NOW in one or two sentences: what was interrupted and the exact state you left it in. ' +
        'Then stop and wait. Do NOT retry, do NOT start anything new, do NOT end the session, and do ' +
        'not ask the human to resume — Ctrl+Alt+R is theirs and it will wake you with "继续".'
    },
    // THE ANSWER CHANNEL (merge-design.md §5.4 item 23). It must exist BEFORE the first
    // `<ctx.tools.register>` call, because `computer_ask`'s handler reaches it — so it is assigned
    // here, where `hooks` is built, exactly like `temporaryStop`/`recover` below. It reads the
    // lazily-injected `asker` at CALL time (inside askOne), never at build time, so a
    // `ctx.inject(['userQuestions'])` callback that lands later is still picked up.
    askHuman: (question, info, exec) => askOne(question, exec),
    temporaryStop: async (exec, why) => {
      const claim = claimOf(exec), cycle = gate.snapshot(), epoch = recoveryEpoch
      if (!claim.sessionKey || !claim.agentKey || !gate.owns(claim) || cycle.state !== 'open' ||
          pendingApprovals.size || unknownApproval || exec?.signal?.aborted) {
        throw new Error('temporary pause requires the active owner and no pending approval; use ordinary stop for a handover')
      }
      const result = await cu.panic(why, true)
      if (result.pauseId && epoch === recoveryEpoch && gate.owns(claim) && gate.snapshot().id === cycle.id) {
        temporaryPause = { pauseId: result.pauseId, cycleId: cycle.id, ownerIdent: claim.ident }
      }
      return result
    },
    recover: async (exec, pauseId) => {
      const problem = recoveryBlocked(exec)
      if (problem || pauseId !== temporaryPause?.pauseId || exec?.signal?.aborted) {
        return { recovered: false, reason: problem || 'stale credential or cancelled call' }
      }
      const epoch = recoveryEpoch
      const result = await cu.recover(pauseId)
      if (result.recovered) {
        if (epoch !== recoveryEpoch || recoveryBlocked(exec) || exec?.signal?.aborted) {
          // An approval or Host interruption arrived while the native reply was in flight.
          if (!cu.exited && !exitedLatch()) await cu.panic('recovery superseded by a newer Host state')
          return { recovered: false, reason: 'a newer Host state kept the machine paused' }
        }
        gate.mark('open', { why: 'verified recovery of the owner agent temporary pause' })
        temporaryPause = null
      }
      return result
    },
  }

  // The brake must look and behave like a brake even if nothing is being driven right now.
  // The message SHAPE lives in `buildUserMessage` at module scope, because getting it wrong is a
  // measured crash (see that function): `agent.steer` publishes into the agent inbox, and the harness's
  // own listeners read `message.source.kind`.
  const buildMessage = (text, summary) => buildUserMessage(text, 'notice', summary)

  // Coalesce notices: the same kind at most once every 4 s. A burst of cards in the conversation
  // is itself a failure mode (reported 2026-09-12: seven injected cards in a row, "非常混乱") —
  // ESC, Ctrl+Alt+Q and the turn-cancel each emit an event, and the human often presses several.
  let lastNoticeKey = ''
  let lastNoticeAt = 0
  const notice = async (text, summary, opts) => {
    const nowMs = Date.now()
    if (summary === lastNoticeKey && nowMs - lastNoticeAt < 4000) {
      log.info(`notice coalesced (${summary})`)
      return
    }
    lastNoticeKey = summary
    lastNoticeAt = nowMs
    // WHO RECEIVES IT (integration bug, 2026-09-13). `bus.agent` is the MACHINE's event recipient and
    // is bound to the cycle's OWNER; a caller-scoped message (the procedure nudge, the acknowledge
    // receipt) passes its own agent explicitly, because those are addressed to the caller — but they
    // must never move the machine's mailbox. `opts.agent` is that explicit address, and it is read
    // here, synchronously, so a later await cannot re-route a message already being delivered.
    const agent = (opts && opts.agent) || bus.agent
    if (!agent) { log.info(`brake notice (no live agent captured yet): ${summary}`); return }
    const msg = await buildMessage(text, summary)
    const wake = !!(opts && opts.wake)
    // THE LAST ASYNC BOUNDARY BEFORE DELIVERY (boundary bug, 2026-09-13). `buildMessage` awaits a
    // dynamic import, so a caller's `valid` predicate is re-checked HERE — after every await and
    // immediately before the steer/inject. A Ctrl+Alt+Q that lands while a "继续" is being built must
    // invalidate it: otherwise the human ends the session and the agent is woken anyway by the wake
    // that was already in flight (measured: steer called once with the gate correctly `ended`).
    if (opts && typeof opts.valid === 'function') {
      let ok = false
      try { ok = !!opts.valid() } catch { ok = false }
      if (!ok) { log.info(`notice dropped at delivery: the state changed while it was being built (${summary})`); return }
    }
    try {
      // Shape copied from the in-tree `dsh-tool-jobs` notifier: a RUNNING agent is steered (it
      // is heading for a step boundary anyway, so the notice is read at the next step of the
      // SAME turn, without a human message); an IDLE agent gets a silent inject, because
      // steering an idle agent wakes the driver and would start — and bill — a whole new turn.
      //
      // `wake` INVERTS that default on purpose, and only Ctrl+Alt+R uses it. After a brake the
      // turn is over — the agent wrapped up and stopped — so a silent inject left the human
      // stuck: the red border went away, nothing was running, and the only way to get the agent
      // moving again was to type a message by hand. The human's spec (2026-09-12): "我
      // CTRL+ALT+R 之后，相当于是在和你的对话框里直接输'继续'两个字". Steering an idle agent is
      // EXACTLY that — it starts a turn — so R now wakes the agent instead of merely informing it.
      if (wake || agent.status === 'running') { agent.steer(msg); log.info(`steered${wake ? ' (wake)' : ''}: ${summary}`) }
      else { agent.inject(msg); log.info(`injected (idle): ${summary}`) }
    } catch (e) { log.warn(`could not deliver the brake notice: ${e.message}`) }
  }

  // The brake. WHO caused it is carried by `why` — do not name a key here: the same brake also
  // is reserved for a durable manual/explicit pause. Ordinary physical activity
  // travels through the core handoff state and never injects a wrap-up notice.
  // Secure-desktop transitions (UAC / lock screen, human request 2026-11-04): the worker already
  // refuses to dispatch while it stands; the card tells the human what only they can do, and the
  // cleared card tells them work has resumed on its own. No cycle state is touched here — this is
  // a WAIT, not a pause: ownership, lease and lights all stay exactly as they were.
  cu.on('secure', (e) => {
    if (e && e.why === 'active') {
      notice(
        '系统确认弹窗（UAC/锁屏）已出现 — AI 已暂停键鼠派发。需要你手动完成系统确认；确认后桌面恢复时，AI 会自动继续。' +
        'Secure desktop detected — input dispatch paused until you answer the system prompt.',
        'computer-use: secure desktop', { agent: bus.agent }).catch(() => {})
    } else {
      notice(
        '系统确认已结束 — 桌面恢复，AI 自动继续键鼠操作。Secure desktop cleared — dispatch resumed automatically.',
        'computer-use: secure desktop cleared', { agent: bus.agent }).catch(() => {})
    }
  })

  cu.on('panic', (e) => {
    // NO calm() HERE (F1, 2026-09-13). calm in the worker is `CycleLit=false; Disarm(); Glow.Kill()`:
    // on a PAUSE it ended the cycle the pause is supposed to keep alive, dropped the monitors, and
    // made `probe` report a dead cycle — while the red border survived anyway, because Engage had
    // already set `_stoppedMode` and the render loop derives want=4 from it. A pause keeps the
    // cycle, its ownership and the human's Ctrl+Alt+R; it is not a cycle end.
    gate.mark('paused', { why: (e && e.why) || 'panic' })
    // REMEMBER THE REASON for `hooks.askBlocked`: the panic event is consumed here and cannot be
    // replayed when a later call is refused, and the brake's reason is the one thing a wrapping-up
    // agent would otherwise have made a (now-refused) observation to find out.
    brakeWhy = (e && e.why) || 'the human stopped the machine'
    if (e && e.pauseId) {
      // This was requested by the active agent; its tool result carries the credential.
      // Do not inject WRAP UP / wait-for-human instructions into its diagnostic work.
      return
    }
    recoveryEpoch++; temporaryPause = null
    notice(
      `COMPUTER USE STOPPED — ${(e && e.why) || 'unknown reason'}. ` +
      'Every actuation is refused and the screen border is red until a human resumes with Ctrl+Alt+R. ' +
      'WRAP UP NOW in one or two sentences: what was interrupted and the exact state you left it in. ' +
      'Then stop working and wait. Do not retry, do not start anything new, and do not call resume yourself. ' +
      'Write that state line so it can be resumed FROM — Ctrl+Alt+R will wake you with "继续". ' +
      '(The human can also press Ctrl+Alt+Q to end the session outright.)',
      // The summary is a COALESCING KEY and a card title, not a diagnosis: name the EVENT, never
      // a key. It read "computer-use aborted (ESC)" until 2026-09-13, when the human's own log
      // showed a wall of abort cards labelled ESC whose real reason was `vk 0xA4` (left Alt, i.e.
      // their Ctrl+Alt+R re-arm) — the label had been lying about the mouse monitor and the
      // keyboard monitor for a whole session, exactly what the comment above warns against.
      'computer-use aborted')
  })
  // Ctrl+Alt+R is the human's 继续 key: it must WAKE the agent, not merely clear the border.
  // Before 2026-09-12 it only cleared the border, so after a mouse-shake brake the human was left
  // holding a dead turn and had to type a message by hand to get the agent moving again — their
  // own report: "再按 CTRL+ALT+R 只是消除红框，没有办法继续注入 prompt 激活你了".
  // A wake that costs one turn is the POINT here; everything else still gets the silent inject.
  // THE AGENT ASKED A QUESTION (2026-09-12). The worker has stopped the machine and raised the
  // fast-breathing red border; the QUESTION itself is no longer injected here as a notice — the
  // client-UI CARD is the answer surface now (merge-design.md §5.3 item 19). It carries the two
  // choices and waits with no countdown, and the notice that used to live here promised a clock and
  // duplicated the question ("if you touch nothing, the agent decides alone"), which stopped being
  // true the moment the worker lost its clock. A card and a chat notice showing the same question is
  // exactly the "非常混乱" burst the notice coalescer exists to avoid. What stays is the STATE this
  // event carries, which the cycle gate needs to hold the owner while the question is open.
  cu.on('ask', () => {
    recoveryEpoch++; temporaryPause = null
    // ASKING IS NOT EXITING (C). The worker has paused the machine INSIDE a live cycle (red,
    // fast-breathing, no countdown); the cycle keeps its owner so the answer resumes it.
    // (`e.why` still carries the question text and is deliberately unused here — the card shows it.)
    gate.mark('asking', { why: 'ask' })
  })

  // THE ASK WINDOW CLOSED — FINISH THE `asking` STATE (lifecycle bug, 2026-09-13). Only a human
  // Ctrl+Alt+R used to move the gate off `asking`, and an unanswered ask never emits `resume` on
  // purpose, so the machine stayed "asking" for good: the owner's idle and its normal turn/end were
  // both refused as if the human were still holding it, the light never closed, and EVERY other
  // session was refused forever. This is not a resume and must never be reported as one: no resume
  // event, no brake cleared. It only settles the state the gate was holding open, from the truth the
  // core mirrored AFTER the window closed — so a late exit (state `ended`, which the gate refuses to
  // leave) or a newer stop (mirrored as stopped) keeps whatever is really there.
  cu.on('ask-ended', (r) => {
    try {
      if (gate.state() !== 'asking') return      // a newer state already moved on: not ours to finish
      if (r && r.exited) { gate.mark('ended', { why: 'the ask window ended in an exit' }); return }
      if (!r || r.stopped) { gate.mark('paused', { why: 'the ask window ended with a stop standing' }); return }
      gate.mark('open', { why: 'the ask window closed with no brake (no human input)' })
      terminalCleanup.resumePending()
    } catch { /* never break the host */ }
  })

  // Fires ONLY for the human's own Ctrl+Alt+R: the worker notifies 'resume' from Clear() alone,
  // and the plugin's turn-boundary `resume` op is silent by design (it must not wake the model).
  cu.on('resume', (e) => {
    // The HUMAN re-armed (the worker notifies `resume` from Clear() alone): the pause is over, the
    // cycle continues with the same id and the same owner — R is a resume, never a new cycle.
    //
    // ONLY A VALID CURRENT CYCLE MAY WAKE ANYONE (boundary bug, 2026-09-13). The return value of
    // `mark` used to be ignored, so a resume arriving after an exit still steered "继续" into an idle
    // agent while the gate correctly stayed `ended` — the flag said "over" and the agent was woken
    // anyway. A LEGITIMATE R after a pause is untouched: that is the one case `mark('open')` accepts.
    if (!gate.mark('open', { why: 'human re-armed (Ctrl+Alt+R)' })) {
      log.info('resume ignored: the cycle is ended (Ctrl+Alt+Q stands) — nobody is woken')
      return
    }
    brakeWhy = ''      // the brake is off, so there is no reason left to hand to a refused call
    if (terminalCleanup.resumePending()) return
    const version = gate.exitVersion()
    notice(
      '继续 — the human re-armed computer use with Ctrl+Alt+R: the brake is cleared and the red border ' +
      'is gone. Actuation works again. Resume from the break point in your own last wrap-up: do not ' +
      'restart the task from scratch, and do not re-do what was already verified.',
      'computer-use resumed', {
        wake: true,
        // Re-checked at the last boundary: a Q during message construction makes this wake stale, and
        // a stale wake must never start a new turn on a session the human just ended.
        valid: () => gate.state() === 'open' && gate.exitVersion() === version && !cu.exited,
      })
  })
  // Ctrl+Alt+Q = **EXIT** (彻底退出). The cycle is over: deliver the worker's own record AND cut the
  // turn off immediately — a notice alone is not enough, because the model would simply keep working
  // (observed 2026-09-13: it read the stop notice and went on to run a diagnostic command).
  cu.on('exit', async (e) => {
    // TERMINAL FOR THIS CYCLE ID (design: "Q终结当期周期"). Nothing — not R, not a mouse event, not a
    // late callback, not a queued call in this same turn — may move this id back to a live state; a
    // new cycle needs a new turn's first real call and gets a new id (lib/cycle.js).
    gate.mark('ended', { why: (e && e.why) || 'exit event' })
    terminalCleanup.forget() // native exit already performed cleanup; never send a late calm
    selfAbortUntil = Date.now() + 8000
    // CAPTURE THE RECIPIENT BEFORE THE FIRST `await` (integration bug, 2026-09-13). The notice below
    // awaits message construction and delivery, and anything that rebinds `bus.agent` during that
    // window would move the turn cancel to a DIFFERENT session than the one whose cycle just ended —
    // the owner would keep working while a bystander got cancelled. The owner is read once, here.
    const recipient = bus.agent
    // `e.why` is a MEASUREMENT the worker recorded when its detector fired, not a verdict about the
    // human — e.g. "Ctrl+Alt+Q chord detected at 2026-09-13 01:17:44 (source=hook) [vk=0x51 extra=0x0
    // trackedCtrl=1 trackedAlt=1 asyncCtrl=1 asyncAlt=1 fgPid=… fg=MarkPilot]". It is quoted
    // VERBATIM, because it is the only evidence anyone has.
    //
    // The text this replaced hard-coded an accusation — it named the human as the author of the key
    // press — and an agent duly repeated it back to them ("you pressed Ctrl+Alt+Q") for a chord the
    // record showed had been detected minutes earlier, in a session that had already ended, possibly
    // by nobody's hand at all. The worker's own refusal message carries the same correction.
    const record = (e && e.why) || 'the worker sent no record with this event'
    await notice(
      `computer-use exited — the worker's record, quoted verbatim: ${record}\n` +
      'computer use is over for this session: do not continue the task, do not start anything new.\n' +
      'THAT IS A RECORD, NOT AN ACCUSATION. It is a line the worker\'s own detector wrote at the ' +
      'moment it fired: it may carry the timestamp it measured, the witness that saw it (source=…) and ' +
      'the raw fields it read — a record written by an older build may carry only the sentence, which ' +
      'is less evidence still. Either way it does NOT prove the human pressed anything: the detector ' +
      'cannot see whose keys those were, and its timestamp may be long before this turn began. Do NOT ' +
      'tell the human that they pressed Ctrl+Alt+Q. Report it as measured: quote the line, with its ' +
      'time and its witness if it has them, and say plainly that it is history rather than something ' +
      'that just happened.',
      'computer-use exited', { agent: recipient })
    const agent = recipient
    if (agent && typeof agent.cancel === 'function') {
      // keepInbox: the notice above must survive the abort so it is still there next time.
      setTimeout(() => {
        try {
          agent.cancel({ kind: 'hook', reason: 'computer-use exit (Ctrl+Alt+Q)' }, { keepInbox: true })
          // NOT "the human exited": that is the same unmeasured claim the notice above was just
          // corrected for. The worker recorded a chord; who pressed it is not in evidence.
          log.warn('computer-use exit record received — turn cancelled')
        } catch (err) { log.warn(`cancel failed: ${err.message}`) }
      }, 120)
    }
    // NOTHING is resumed here — on purpose. An earlier version called cu.resume() 900 ms after the
    // exit "so the red border is gone", and that single call WAS the bug: resume is the only thing
    // that un-latches EXITED, so the plugin itself resurrected the cycle it had just killed, and
    // the next stray op lit the border again. The exit already leaves no brake behind (worker
    // Panic.Exit clears _engaged/_stopped and every visual flag, and kills the overlay); if that
    // ever stops being true the honest fix is inside Panic.Exit, not a resurrection here.
    // Human's model, 2026-09-13: "Computer use 周期结束之后，所有跟 computer use 相关的监听，全部
    // 都要终结" — and the next cycle is opened by the PLUGIN when a computer_* call actually reaches
    // the worker (ensureCycle above, once per turn), never by this handler and never by a stray op.
  })

  // Precise "the agent stopped driving" signal: a turn ended, so cut the border NOW (no fade).
  //
  // IDENTITY (2026-09-13, B from the review): this event is host-wide and carries `agent`; a
  // background subagent — or any other session — going idle used to call calm() on the MACHINE's
  // cycle, which is `CycleLit=false; Disarm(); Glow.Kill()` in the worker: the border went dark and
  // the ESC/Q/R keyboard hooks stayed but the monitors dropped, for a turn that had nothing to do
  // with this machine. Only the OWNER's idle may cut the owner's light.
  //
  // PAUSE/ASK (F1): an idle while the machine is PAUSED or ASKING is not "the task finished" — the
  // cycle is alive and its red border must stay until the human answers or re-arms. calm() would end
  // it (CycleLit=false), which is exactly the state lie we are fixing.
  ctx.on('agent/status', (payload) => {
    try {
      const st = payload && (payload.status || payload.state)
      if (st !== 'idle' || inFlight !== 0) return
      const whoKey = agentKeyOf(payload && payload.agent)
      // Another agent's idle is not our business. When we cannot identify the agent, stay silent
      // rather than guess: an unlit border on someone else's turn is the bug we are fixing.
      if (!whoKey || !gate.ownsAgent(whoKey)) {
        log.info(`agent/status idle ignored (${whoKey ? 'another agent' : 'no agent identity on the event'})`)
        return
      }
      const paused = pausedOrAsking()
      if (paused) {
        log.info(`agent/status idle while ${gate.state()} — the cycle stays alive (Ctrl+Alt+R resumes it)`)
        return
      }
      lifecycle.idle(payload.agent)?.catch(error => log.warn(`computer-use idle release failed: ${error.message}`))
    } catch { /* the indicator must never break the host */ }
  })

  // Ownership is released by FACTS, never by elapsed time. A disposed owner agent is such a fact:
  // without it a session that died mid-turn would own the machine until the host restarted, and no
  // timer may take a PAUSED cycle away (the human's rule: "暂停只能由人的恢复/终结解除，时间不是授权").
  ctx.on('agent/disposed', (payload) => {
    try {
      const whoKey = agentKeyOf(payload && payload.agent)
      if (whoKey && gate.ownsAgent(whoKey)) {
        log.info(`owner agent disposed (${whoKey}) — releasing the machine for the next real call`)
        leaveTimer.onAgentDisposed(payload.agent)
        terminalCleanup.request('owner agent disposed')
      }
    } catch { /* never break the host */ }
  })

  // Host cancellation stops the owning turn's input immediately. It is separate from
  // Ctrl+Esc, which is the physical keyboard path to a persistent manual pause.
  ctx.on('session/event', (session, event) => {
    try {
      if (event?.type === 'approval/asked') {
        recoveryEpoch++
        if (event.data?.id) pendingApprovals.add(event.data.id)
        else unknownApproval = true
      } else if (event?.type === 'approval/decided' && event.data?.id) pendingApprovals.delete(event.data.id)
      if (!event || !bus.agent) return
      const reason = event.data && event.data.reason
      const kind = reason && reason.kind
      // WHOSE turn? This event is host-wide, and a background subagent starting a turn is not this
      // session deciding to drive this machine.
      // THE ONE PLACE A DEAD CYCLE MAY COME BACK. Human's model (2026-09-13): "Computer use 周期
      // 结束之后，必须得在下一个 session 开启之后才可能会再拉起新周期." So the PLUGIN opens it,
      // once per turn — never an op, because an op carries no idea which turn it belongs to, which
      // is precisely how a stray call from a finished turn used to resurrect the border.
      if (event.type === 'turn/start') {
        // RENEWAL IS PER SESSION (B). This event is host-wide; bumping a machine-wide latch here is
        // what let another session's turn re-open a cycle that had already been ended. Bumping THIS
        // session's generation is all a turn boundary is allowed to do — and it is what gives a
        // brand-new session its qualification, since it never has to match a remembered driver.
        if (session) gate.noteTurnStart(session)
        const owner = gate.ownerSessionKey()
        if (!owner || !session || sameSession(session, owner)) nudgedTurn = false
        // NOTHING IS OPENED HERE (A/B). The opener is the first real call of the turn — the only
        // place the qualification is consumed, and the only place that may touch the exit record.
        // A `resume` sent from a turn boundary is a resurrection path with no call to justify it,
        // which is exactly how the border came back on a session that had ended.
        return
      }
      if (event.type !== 'turn/end') return
      // WHOSE turn? This event is host-wide. An aborted turn in another session — a background
      // subagent the human stopped, another chat — is not "the human grabbing this machine", and
      // braking for it produced a red border out of nowhere. The cycle's own owner is the strongest
      // identity we have; `bus.driverSession` is only the fallback for when nothing owns the machine.
      const ownerSk = gate.ownerSessionKey()
      const foreign = ownerSk
        ? (session && !sameSession(session, ownerSk))
        : (bus.driverSession && session && !sameSession(session, bus.driverSession))
      if (foreign) {
        log.info(`ignoring ${kind} turn/end from another session (${describeSession(session)})`)
        return
      }
      leaveTimer.onTurnEnd(session)
      if (kind === 'aborted' || kind === 'interrupted') {
        if (selfAbortUntil && Date.now() < selfAbortUntil) {
          selfAbortUntil = 0
          log.warn(`turn ended ${kind} — caused by our own Ctrl+Alt+Q exit; NOT re-engaging the brake`)
          return
        }
        // Host cancellation is per request/turn; only the physical Ctrl+Esc path
        // raises an input-triggered persistent brake.
        log.warn(`turn ended ${kind} in a computer-use session — cancelling only its input`)
        recoveryEpoch++; temporaryPause = null
        // An explicit Ctrl+Esc pause remains latched. Ordinary Host cancellation ends
        // this turn and its queued input without inventing a persistent human brake.
        terminalCleanup.request(`owner turn ${kind}`)
        return
      }
      // Ordinary completion releases computer use immediately. No question card,
      // no recommendation timer, and no new conversation turn is created.
      const completion = lifecycle.completeTurn(session, kind || 'completed')
      completion?.catch(error => log.warn(`computer-use completion failed: ${error.message}`))
    } catch { /* never break the host */ }
  })

  // approval gate — every computer_* tool call passes through the policy
  // pure function; its {kind: allow|deny|ask} rides the tools/pre-execute
  // waterfall into the harness approval UI (fail-closed, one-shot grants).
  ctx.on('tools/pre-execute', (exec, next) => {
    // This hook is on the approval path. A timer bug must never deny a non-computer tool, so the
    // leave timer runs in its own fail-open guard; the policy try/catch below stays fail-closed for
    // computer_* calls only.
    try { leaveTimer.observe(exec) } catch (error) { log.warn(`computer-use leave timer observe failed: ${error.message}`) }
    try {
      if (!exec || typeof exec.name !== 'string' || !exec.name.startsWith('computer_')) return next()
      if (exec.name === ACTIVATION_TOOL) return next() // capability discovery does not open a control cycle
      // NOT `bus.agent = exec.agent` (integration bug, 2026-09-13): this hook runs for EVERY
      // computer_* call, including one the cycle gate will refuse as foreign, so rebinding the
      // machine's notice/cancel recipient here handed a foreign caller the exit notice and the
      // Ctrl+Alt+Q cancel. The owner's mailbox is bound in ensureCycle, at the moment ownership is
      // taken. Before any cycle exists, a call still needs somewhere for machine events to go, so
      // this binds only when the machine is unowned.
      if (exec.agent && !gate.isLive()) bus.agent = exec.agent
      // ---- READ THE PROCEDURE FIRST -----------------------------------------------------------
      // The human's question, 2026-09-13: "为什么不先读 computer use skill, 直接上来就用". No tool
      // layer can force a model to read a document — but the plugin CAN say it at the one moment
      // that still changes the outcome: the first computer_* call of a turn. Once per turn (reset on
      // turn/start), steered into the live turn, and it names the three traps that actually cost
      // real time here instead of just pointing at a file.
      if (!nudgedTurn) {
        nudgedTurn = true
        notice(
          'READ THE PROCEDURE BEFORE DRIVING — the `computer-use` skill (skills/computer-use/SKILL.md) ' +
          'is the manual for these tools, and it is written against exactly the mistakes that cost real ' +
          'time here: read `computer_state {windows:true}` BEFORE concluding a window is "blocked" ' +
          '(a MINIMIZED window needs `restore`, not `activate`); measure coordinates with ' +
          '`computer_uia {role, name}` instead of estimating them from a scaled screenshot; and never ' +
          'tell the human a blocker you have not measured. Its opening moves are mandatory and come ' +
          'before any pixel.',
          'computer-use: read the skill first', { agent: exec.agent }).catch(() => {})
      }
      // ... and WHICH session is driving, because `session/event` is host-wide: without this the
      // "an interrupted turn is a brake" rule fired for ANY session's aborted turn. It did exactly
      // that — stopping a background SUBAGENT braked the computer-use session (STOP file 21:56:44.660).
      //
      // ONLY THE OWNER (or an unowned machine) may be recorded here (integration bug, 2026-09-13): a
      // call the gate is about to refuse as foreign must not become the session the host-wide turn
      // events are judged against, or a foreign caller would silence the owner's own brake handling.
      const drv = exec.session || exec.sessionId ||
        (exec.agent && (exec.agent.session || exec.agent.sessionId)) || null
      const ownerSk = gate.ownerSessionKey()
      const mayBind = !ownerSk || !drv || sameSession(drv, ownerSk)
      if (mayBind && drv && !sameSession(drv, bus.driverSession)) {
        bus.driverSession = drv
        log.info(`computer-use driver session: ${describeSession(drv)}`)
      }
      // ---- THE READ-THE-PROCEDURE GATE --------------------------------------------------------
      // Human's rule, 2026-09-13: "未先读 skill 时拒绝驱动类 op". A DRIVING call is refused until
      // THIS session has produced the receipt phrase that exists only inside the computer-use skill
      // (skill-gate.js explains why a phrase is the honest maximum). Two things are deliberately
      // NEVER gated, because a gate that can block them is worse than no gate at all: the safety
      // direction (computer_ask, computer_ctrl stop/exit), and OBSERVATION — an agent that cannot
      // look cannot even report why it is blocked.
      const gArgs = exec.arguments || {}
      const gAct = exec.name === 'computer_ctrl' ? String(gArgs.action || 'selftest') : ''
      if (exec.name === 'computer_ctrl' && gAct === 'acknowledge') {
        if (!acknowledge(gArgs.text, sessionKey(drv))) {
          return { kind: 'deny', reason: `acknowledge failed — pass the EXACT phrase, quoted from the skill. ${ACK_HINT}` }
        }
        log.info('computer-use: procedure acknowledged — driving open for this session')
        notice('✅ 已确认读过 computer-use skill 规程：本 session 的驱动类调用已解锁。', 'computer-use: acknowledged', { agent: exec.agent }).catch(() => {})
        return { kind: 'allow' }
      }
      if (!isAcked(sessionKey(drv)) && isDrivingCall(exec.name, gArgs)) {
        return { kind: 'deny', reason: `READ THE PROCEDURE FIRST. ${ACK_HINT}` }
      }
      // ---- THE APPROVAL CHANNEL IS PART OF THE DECISION ---------------------------------------
      // A policy `ask` is a request for a HUMAN. DSH's `never` approval policy (selected by the
      // danger-full-access preset) cannot deliver one: ApprovalService.decide() rejects at once
      // and the tool layer reports `the user rejected tool "..."` — measured 2026-11-12 on
      // `computer_key {combo:"backspace"}` in a full-access session where the human had touched
      // nothing. So the two facts that decide whether an ask is answerable are read HERE, per
      // call, and handed to policy.js, which settles the ask itself (lib/policy.js
      // applyApprovalChannel): full access runs it, anything else refuses in words that name the
      // unavailable channel instead of blaming the user. Unknown facts keep the old behaviour.
      const approvalEnv = readApprovalEnv({
        ctx,
        session: (exec.agent && exec.agent.session) || (typeof drv === 'object' ? drv : null),
        sessionId: sessionKey(drv),
        durablePermission: typeof sessionPermission === 'function' ? sessionPermission : null,
      })
      const rawDecision = policyDecision(exec.name, gArgs, config.automationMode)
      const decision = policyDecision(exec.name, gArgs, config.automationMode, approvalEnv)
      // An unanswerable ask that ran anyway is the one transition a reader must be able to see
      // without guessing: log it as such, never as a plain allow.
      const ranUnderFullAccess = rawDecision.kind === 'ask' && decision.kind === 'allow'
      // The reason may quote a launch target (`[target=…]`): redact URL userinfo/query tokens
      // before either the log or the durable record so neither can become a credential store.
      const safeReason = decision.reason ? redactReasonText(String(decision.reason)) : ''
      const gateLine = `gate ${exec.name} ${JSON.stringify(gateArgSummary(exec.name, gArgs))} ` +
        `automation=${config.automationMode} ${describeApprovalEnv(approvalEnv)} ` +
        `raw=${rawDecision.kind} final=${decision.kind}` +
        (ranUnderFullAccess ? ' (unanswerable ask ran under full access)' : '') +
        (decision.kind !== 'allow' && safeReason ? ` — ${safeReason}` : '')
      log.info(gateLine)
      // Durable, secret-free diagnostics for the next report. Observation calls only appear when
      // something other than "allow" happened, so a busy screenshot session cannot flood it.
      if (decision.kind !== 'allow' || ranUnderFullAccess || ACTUATION_TOOLS.has(exec.name) || exec.name === 'computer_ctrl') {
        appendGate(dataDir, {
          ts: Date.now(), tool: exec.name, args: gateArgSummary(exec.name, gArgs),
          automationMode: config.automationMode,
          approvalPolicy: approvalEnv.approvalPolicy, sandbox: approvalEnv.sandbox,
          promptsAvailable: approvalEnv.promptsAvailable, fullAccess: approvalEnv.fullAccess,
          delegated: approvalEnv.delegated === true,
          envSources: approvalEnv.sources, raw: rawDecision.kind, final: decision.kind,
          attributionSeam: approvalSeam?.installed === true ? 'installed' : (approvalSeam?.reason ?? 'absent'),
          ...(ranUnderFullAccess ? { escalated: 'full-access' } : {}),
          ...(safeReason ? { reason: safeReason.slice(0, 500) } : {}),
          ...(sessionKey(drv) ? { session: sessionKey(drv) } : {}),
        })
      }
      // RETURN the decision — do not hand it to next(). On this DSH build `next` is
      // `() => Promise<PreToolDecision>`: it takes NO arguments, so `next(decision)` silently
      // discarded the decision and the waterfall fell back to its {kind:'allow'} default. Every
      // policy decision — including the fail-closed deny for an unknown tool — was inert on the real
      // machine, while the hook itself ran (its side effects were visible, its verdict was not).
      // Found 2026-09-13 by A/B: a call that policy.js denies reached its HANDLER instead.
      return decision
    } catch (e) {
      // fail closed
      return { kind: 'deny', reason: `computer-use policy error: ${e.message}` }
    }
  })

  ctx.effect(() => () => leaveTimer.dispose())
  ctx.effect(() => {
    const disposer = () => { return cu.kill().catch(() => {}).finally(detachAudit) }
    return disposer
  })

  const definitions = []
  registerTools({ ctx, cu, config, dataDir, log, snapshotPath, defineTool, hooks, ensureCycle, register: d => definitions.push(d) })
  installToolExposure({ ctx, definitions, defineTool, scopeOf, log, enabled: config.progressiveTools !== false,
    skillPath: fileURLToPath(new URL('SKILL.md', SKILL_DIR_URL)),
    readSkill: () => fs.readFileSync(fileURLToPath(new URL('SKILL.md', SKILL_DIR_URL)), 'utf8') })
  log.info(`ready (mode=${config.automationMode}${config.dryRun ? ' dry-run' : ''}; cycle idle timeout disabled${config.leaveDesktopGraceMs ? `; leave timer ${config.leaveDesktopGraceMs} ms` : ''})`)
}
