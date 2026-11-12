// test-approval-channel.mjs — an `ask` nobody can answer must never become a refusal the user
// never made.
//
// Measured 2026-11-12: a `danger-full-access` session (DSH approval policy `never`) called
// `computer_key {combo:"backspace"}` with automationMode=autonomous. The plugin returned
// `{kind:'ask'}`; the host's `never` policy rejected it in the same tick without showing a card;
// the tool layer rendered `Error: the user rejected tool "computer_key"`. The human had touched
// nothing. Full access had been chosen precisely to stop being asked.
//
// This guard pins all three answers, and the wiring that produces them:
//
//   1. full access          -> the ask runs (the human's standing grant), nothing else changes;
//   2. any other sandbox    -> refuse AND name the unavailable channel; never "the user rejected";
//   3. a real ask channel   -> unchanged `ask`; the host owns the card, its audit pair and the
//                              human's actual decision.
//
// It also pins the gate's durable diagnostics (one policy.jsonl line per gated call, no typed
// text) and the legacy-attribution seam installing into a tool registry that mounts late.
//
// No worker, desktop input, host prompt or real session is touched.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { policyDecision, applyApprovalChannel, ACTUATION_TOOLS, NO_APPROVAL_CHANNEL } from '../lib/policy.js'
import { readApprovalEnv, readDelegation, describeApprovalEnv } from '../lib/approval-env.js'
import { mkDataDir, appendGate, gateArgSummary, redactReasonText } from '../lib/audit.js'
import { installApprovalAttribution } from '../lib/approval-attribution.js'
import { ComputerUse } from '../lib/core/index.js'
import { registerTools } from '../lib/tools.js'
import { createCycleGate, agentKeyOf } from '../lib/cycle.js'
import { createCycleLifecycle } from '../lib/cycle-lifecycle.js'
import { createLeaveTimer } from '../lib/leave-timer.js'
import { createTerminalCleanup } from '../lib/terminal-cleanup.js'
import { recoveryProblem } from '../lib/recovery.js'
import { ACTIVATION_TOOL } from '../lib/exposure.js'

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-cu-approval-channel-'))
process.env.DSH_HOME = scratch // the durable-session fallback must never read the real host home

let passed = 0
const cases = []
async function test (name, run) {
  await run()
  passed++
  cases.push(name)
  console.log(`PASS ${name}`)
}

// ---- the three channels ------------------------------------------------------------------------
const FULL_ACCESS = Object.freeze({ approvalPolicy: 'never', sandbox: 'danger-full-access', promptsAvailable: false, fullAccess: true })
const WORKSPACE = Object.freeze({ approvalPolicy: 'never', sandbox: 'workspace-write', promptsAvailable: false, fullAccess: false })
const ASK_CHANNEL = Object.freeze({ approvalPolicy: 'ask', sandbox: 'workspace-write', promptsAvailable: true, fullAccess: false })
const UNKNOWN = Object.freeze({ approvalPolicy: null, sandbox: null, promptsAvailable: true, fullAccess: false })

function assertNotBlamedOnUser (decision) {
  assert.equal(decision.kind, 'deny')
  assert.match(decision.reason, /approval prompts are unavailable/)
  assert.match(decision.reason, /the user was not asked/)
  assert.doesNotMatch(decision.reason, /the user rejected/i)
  assert.doesNotMatch(decision.reason, /rejected by the user/i)
}

// The exact commands from the report, plus the other destructive keys the key grammar escalates.
const HIGH_RISK_KEYS = ['backspace', 'delete', 'alt+f4', 'win+r', 'win+d', 'win+l', 'ctrl+shift+esc']
const HIGH_RISK_TOOLS = [
  ['computer_window', { hwnd: 1, op: 'close' }],
  ['computer_type', { text: 'x', allowPassword: true }],
  ['computer_launch', { target: 'C:\\Windows\\System32\\cmd.exe' }],
  ['computer_batch', { actions: [{ tool: 'computer_key', args: { combo: 'delete' } }] }],
]

await test('full access runs every unanswerable high-risk ask in autonomous; other sandboxes refuse honestly', async () => {
  for (const combo of HIGH_RISK_KEYS) {
    const allowed = policyDecision('computer_key', { combo }, 'autonomous', FULL_ACCESS)
    assert.equal(allowed.kind, 'allow', `autonomous ${combo} must run under full access, got ${allowed.kind}: ${allowed.reason}`)
    assert.match(allowed.reason, /has full access/)
    assertNotBlamedOnUser(policyDecision('computer_key', { combo }, 'autonomous', WORKSPACE))
    // ... and the real approval channel is untouched: the host still asks.
    assert.equal(policyDecision('computer_key', { combo }, 'autonomous', ASK_CHANNEL).kind, 'ask', combo)
    assert.equal(policyDecision('computer_key', { combo }, 'autonomous', UNKNOWN).kind, 'ask', combo)
    assert.equal(policyDecision('computer_key', { combo }, 'autonomous').kind, 'ask', combo)
  }
})

await test('standard mode keeps failing closed: full access is not an approval', async () => {
  for (const combo of HIGH_RISK_KEYS) {
    const decision = policyDecision('computer_key', { combo }, 'standard', FULL_ACCESS)
    assert.equal(decision.kind, 'deny', `standard ${combo} must not become unrestricted`)
    assert.match(decision.reason, /automationMode=standard asks before this actuation/)
    assert.doesNotMatch(decision.reason, /the user rejected/i)
  }
  for (const args of [{ x: 1, y: 2 }, { mark: 'M3' }]) {
    const decision = policyDecision('computer_click', args, 'standard', FULL_ACCESS)
    assert.equal(decision.kind, 'deny')
    assert.match(decision.reason, /automationMode=standard/)
  }
  // ... and a real channel still asks, so the mode means what it says.
  assert.equal(policyDecision('computer_click', { x: 1, y: 2 }, 'standard', ASK_CHANNEL).kind, 'ask')
})

await test('a delegated subagent session never inherits the human grant', async () => {
  const delegated = { ...FULL_ACCESS, delegated: true }
  for (const combo of HIGH_RISK_KEYS) {
    const decision = policyDecision('computer_key', { combo }, 'autonomous', delegated)
    assert.equal(decision.kind, 'deny', `delegated child must not run ${combo}`)
    assert.match(decision.reason, /delegated subagent session/)
    assert.doesNotMatch(decision.reason, /the user rejected/i)
  }
  for (const [name, args] of HIGH_RISK_TOOLS) {
    assert.equal(policyDecision(name, args, 'autonomous', delegated).kind, 'deny', name)
  }
  // Ordinary (non-escalated) actuation is the autonomous mode's own business and is unchanged.
  assert.equal(policyDecision('computer_click', { x: 1, y: 2 }, 'autonomous', delegated).kind, 'allow')
})

await test('the other high-risk families follow the same rule (window close / password typing / code launch / batch)', async () => {
  for (const [name, args] of HIGH_RISK_TOOLS) {
    assert.equal(policyDecision(name, args, 'autonomous', FULL_ACCESS).kind, 'allow', name)
    assertNotBlamedOnUser(policyDecision(name, args, 'autonomous', WORKSPACE))
    assert.equal(policyDecision(name, args, 'autonomous', ASK_CHANNEL).kind, 'ask', name)
    assert.equal(policyDecision(name, args, 'autonomous').kind, 'ask', name)
  }
})

await test('ordinary actuation and observation are unaffected by the channel', async () => {
  for (const env of [FULL_ACCESS, WORKSPACE, ASK_CHANNEL, UNKNOWN, undefined]) {
    assert.equal(policyDecision('computer_key', { combo: 'ctrl+s' }, 'autonomous', env).kind, 'allow')
    assert.equal(policyDecision('computer_shot', { marks: true }, 'autonomous', env).kind, 'allow')
    assert.equal(policyDecision('computer_ask', { question: 'q' }, 'autonomous', env).kind, 'allow')
  }
})

await test('read-only and unrestricted keep their exact semantics in every channel', async () => {
  for (const env of [FULL_ACCESS, WORKSPACE, ASK_CHANNEL, UNKNOWN, undefined]) {
    assert.equal(policyDecision('computer_key', { combo: 'enter' }, 'read-only', env).kind, 'deny')
    assert.equal(policyDecision('computer_key', { combo: 'enter' }, 'unrestricted', env).kind, 'allow')
  }
})

await test('an unknown channel keeps the conservative ask instead of inventing a grant', async () => {
  assert.equal(applyApprovalChannel({ kind: 'ask', reason: 'x' }, { approvalPolicy: 'never' }).kind, 'deny')
  assert.equal(applyApprovalChannel({ kind: 'ask', reason: 'x' }, { fullAccess: true }).kind, 'ask')
  assert.equal(applyApprovalChannel({ kind: 'ask', reason: 'x' }, null).kind, 'ask')
  assert.equal(applyApprovalChannel({ kind: 'allow' }, WORKSPACE).kind, 'allow')
  assert.equal(applyApprovalChannel({ kind: 'deny', reason: 'x' }, WORKSPACE).kind, 'deny')
  const noEvidence = applyApprovalChannel({ kind: 'ask', reason: 'x' }, { approvalPolicy: 'never' })
  assert.match(noEvidence.reason, new RegExp(NO_APPROVAL_CHANNEL.replace(/[()]/g, '\\$&')))
  assert.match(noEvidence.reason, /is not full access/)
  // A grant without an explicit unprompted mode does not run, and a delegated child never does.
  assert.equal(applyApprovalChannel({ kind: 'ask', reason: 'x' }, FULL_ACCESS).kind, 'deny')
  assert.equal(applyApprovalChannel({ kind: 'ask', reason: 'x' }, FULL_ACCESS, 'standard').kind, 'deny')
  assert.equal(applyApprovalChannel({ kind: 'ask', reason: 'x' }, FULL_ACCESS, 'autonomous').kind, 'allow')
  assert.equal(applyApprovalChannel({ kind: 'ask', reason: 'x' }, { ...FULL_ACCESS, delegated: true }, 'autonomous').kind, 'deny')
})

// ---- reading the channel out of live host services ---------------------------------------------
function services (map) {
  return { get: (name) => map[name] }
}
const SESSION = { id: 'session-under-test', header: { cwd: scratch } }

await test('readApprovalEnv prefers the authoritative per-session services', async () => {
  const env = readApprovalEnv({
    ctx: services({ approval: { effectivePolicy: () => 'never' }, sandboxPolicy: { resolve: () => ({ mode: 'danger-full-access' }) } }),
    session: SESSION,
  })
  assert.equal(env.approvalPolicy, 'never')
  assert.equal(env.sandbox, 'danger-full-access')
  assert.equal(env.fullAccess, true)
  assert.equal(env.promptsAvailable, false)
  assert.deepEqual(env.sources, ['approval.effectivePolicy', 'sandboxPolicy.resolve'])
  assert.equal(describeApprovalEnv(env), 'approval=never sandbox=danger-full-access (from approval.effectivePolicy+sandboxPolicy.resolve)')
})

await test('readApprovalEnv falls back layer by layer and never throws on a broken service', async () => {
  const throwing = {
    get: (name) => {
      if (name === 'approval') return { effectivePolicy: () => { throw new Error('boom') } }
      if (name === 'sandboxPolicy') return { resolve: () => { throw new Error('boom') } }
      if (name === 'permissionPresets') return { permissionState: () => ({ sandbox: 'danger-full-access' }) }
      throw new Error('get failed')
    },
  }
  const env = readApprovalEnv({ ctx: throwing, session: SESSION })
  assert.equal(env.approvalPolicy, null)
  assert.equal(env.sandbox, 'danger-full-access')
  assert.deepEqual(env.sources, ['permissionPresets.permissionState'])
  // The deployment default is NOT the session's mode: a host launched with full access must not
  // hand that grant to a session that has no evidence for it.
  const deploymentDefault = readApprovalEnv({ ctx: services({ shell: { sandboxMode: 'danger-full-access' } }), session: SESSION })
  assert.equal(deploymentDefault.sandbox, null)
  assert.equal(deploymentDefault.fullAccess, false)
  // A shape from a future host build is not a licence to guess.
  const unknownShape = readApprovalEnv({ ctx: services({ approval: { effectivePolicy: () => 'sometimes' }, sandboxPolicy: { resolve: () => ({ mode: 'yolo' }) } }), session: SESSION })
  assert.equal(unknownShape.approvalPolicy, null)
  assert.equal(unknownShape.sandbox, null)
  assert.equal(unknownShape.promptsAvailable, true)
  // The durable record is the last resort, and it may only NARROW the sandbox: its cache can
  // still say "danger-full-access" right after the human switched away, so it can never be the
  // evidence FOR an execution grant. It is not read for the approval policy either — "nobody can
  // be asked" is a grant too, so it must come from the live service.
  const staleGrant = readApprovalEnv({
    ctx: services({}),
    session: SESSION,
    sessionId: SESSION.id,
    durablePermission: () => ({ sandbox: 'danger-full-access', approval: 'never' }),
  })
  assert.equal(staleGrant.sandbox, null)
  assert.equal(staleGrant.fullAccess, false)
  assert.equal(staleGrant.approvalPolicy, null)
  assert.equal(staleGrant.promptsAvailable, true)
  const narrowing = readApprovalEnv({
    ctx: services({}),
    session: SESSION,
    sessionId: SESSION.id,
    durablePermission: () => ({ sandbox: 'workspace-write', approval: 'ask' }),
  })
  assert.equal(narrowing.sandbox, 'workspace-write')
  assert.equal(narrowing.approvalPolicy, null)
})

// ---- the real gate, driven through apply() ------------------------------------------------------
const pluginUrl = pathToFileURL(path.resolve(import.meta.dirname, '..', 'lib', 'index.js')).href
const pluginSource = fs.readFileSync(new URL(pluginUrl), 'utf8')
const prelude = pluginSource
  .replace(/^import .+$/gm, '')
  .replace(/^export /gm, '')
  .replaceAll('import.meta.url', JSON.stringify(pluginUrl))
const fluent = new Proxy(function () { return fluent }, { get () { return fluent } })
const noop = () => {}
const handlers = new Map()
const logLines = []
let livePolicy = 'never'
let liveSandbox = 'danger-full-access'
const fakeLog = { info: (m) => logLines.push(String(m)), warn: noop, error: noop }
const dataDir = path.join(scratch, 'data')
const liveServices = () => ({
  approval: { effectivePolicy: () => livePolicy },
  sandboxPolicy: { resolve: () => ({ mode: liveSandbox }) },
})
const ctx = {
  logger: () => fakeLog,
  get: (name) => liveServices()[name],
  inject: noop,
  effect: (fn) => { fn() },
  on: (name, fn) => handlers.set(name, fn),
  tools: { register: noop },
}
const apply = new Function(
  'defineTool', 'Schema', 'ComputerUse', 'policyDecision', 'acknowledge', 'isAcked', 'ACK_HINT', 'isDrivingCall',
  'mkDataDir', 'snapshotPath', 'installAudit', 'registerTools', 'fs', 'os', 'path', 'createCycleGate', 'agentKeyOf',
  'setTimeout', 'clearTimeout', 'Date', 'recoveryProblem', 'installHumanAttention', 'fileURLToPath', 'installToolExposure',
  'scopeOf', 'ACTIVATION_TOOL', 'createCycleLifecycle', 'createLeaveTimer', 'createTerminalCleanup',
  'installApprovalAttribution', 'readApprovalEnv', 'describeApprovalEnv', 'ACTUATION_TOOLS', 'appendGate', 'gateArgSummary', 'redactReasonText',
  `${prelude}\nreturn apply;`,
)((d) => d, fluent, ComputerUse, policyDecision, () => true, () => true, '', () => false,
  mkDataDir, () => '', () => {}, registerTools, fs, os, path, createCycleGate, agentKeyOf,
  setTimeout, clearTimeout, Date, recoveryProblem, noop, (p) => p, noop, () => undefined,
  ACTIVATION_TOOL, createCycleLifecycle, createLeaveTimer, createTerminalCleanup,
  installApprovalAttribution, readApprovalEnv, describeApprovalEnv, ACTUATION_TOOLS, appendGate, gateArgSummary, redactReasonText)
apply(ctx, {
  enabled: true, progressiveTools: false, automationMode: 'autonomous',
  maxActionsPerMinute: 60, snapshotDir: dataDir,
})
assert.ok(handlers.has('tools/pre-execute'), 'the gate must be registered')
const agent = { session: SESSION, status: 'running', inject: noop, steer: noop, cancel: noop }
const preFor = (name, args) => handlers.get('tools/pre-execute')({
  name, arguments: args, session: SESSION.id, agent, signal: new AbortController().signal,
}, () => ({ kind: 'allow' }))

await test('the live gate runs computer_key backspace under full access (the reported failure)', async () => {
  livePolicy = 'never'; liveSandbox = 'danger-full-access'
  const decision = preFor('computer_key', { combo: 'backspace' })
  assert.equal(decision.kind, 'allow', JSON.stringify(decision))
  assert.match(decision.reason, /full access/)
})

await test('the live gate refuses without blaming the user when full access is absent', async () => {
  livePolicy = 'never'; liveSandbox = 'workspace-write'
  const decision = preFor('computer_key', { combo: 'backspace' })
  assert.equal(decision.kind, 'deny')
  assert.match(decision.reason, /approval prompts are unavailable/)
  assert.doesNotMatch(decision.reason, /the user rejected/i)
})

await test('the live gate leaves a real approval channel alone', async () => {
  livePolicy = 'ask'; liveSandbox = 'danger-full-access'
  assert.equal(preFor('computer_key', { combo: 'backspace' }).kind, 'ask')
  assert.equal(preFor('computer_window', { hwnd: 1, op: 'close' }).kind, 'ask')
  assert.equal(preFor('computer_key', { combo: 'ctrl+s' }).kind, 'allow')
})

await test('the live gate refuses a delegated subagent session even under full access', async () => {
  livePolicy = 'never'; liveSandbox = 'danger-full-access'
  const header = SESSION.header
  SESSION.header = { ...header, origin: 'subagent', parentSession: 'session-parent', delegationDepth: 1 }
  try {
    const decision = preFor('computer_key', { combo: 'win+r' })
    assert.equal(decision.kind, 'deny')
    assert.match(decision.reason, /delegated subagent session/)
    assert.doesNotMatch(decision.reason, /the user rejected/i)
  } finally { SESSION.header = header }
  assert.equal(preFor('computer_key', { combo: 'win+r' }).kind, 'allow', 'the human session keeps the grant')
})

await test('a launch target keeps its credentials out of the gate log and policy.jsonl', async () => {
  livePolicy = 'never'; liveSandbox = 'danger-full-access'
  const target = 'https://user:SuperSecretPW@example.com/reset?token=abc123'
  assert.equal(preFor('computer_launch', { target }).kind, 'allow')
  // A target can also EMBED a URL after an executable name, and a URL can be stuffed into a
  // coordinate field; both must be redacted before they reach either sink.
  assert.equal(preFor('computer_launch', { target: 'cmd https://user:SuperSecretPW@example.com/x?t=9' }).kind, 'allow')
  assert.equal(preFor('computer_click', { at: 'https://user:SuperSecretPW@example.com/?q=1' }).kind, 'allow')
  assert.ok(!logLines.some((line) => line.includes('SuperSecretPW')), 'the gate log must not carry URL credentials')
  const rows = fs.readFileSync(path.join(dataDir, 'policy.jsonl'), 'utf8').trim().split('\n').map(JSON.parse)
  const launch = rows.filter((row) => row.tool === 'computer_launch').at(-2)
  assert.deepEqual(launch.args, { target: 'https://example.com/reset?<redacted>' })
  const embedded = rows.filter((row) => row.tool === 'computer_launch').at(-1)
  assert.equal(embedded.args.target, 'cmd https://example.com/x?<redacted>')
  const click = rows.filter((row) => row.tool === 'computer_click').at(-1)
  assert.equal(click.args.at, 'https://example.com/?<redacted>')
  assert.ok(!JSON.stringify(rows).includes('SuperSecretPW'))
  assert.ok(!JSON.stringify(rows).includes('abc123'))
})

await test('every gated call leaves one secret-free policy.jsonl record', async () => {
  const file = path.join(dataDir, 'policy.jsonl')
  assert.ok(fs.existsSync(file), 'policy.jsonl must exist after gated calls')
  const rows = fs.readFileSync(file, 'utf8').trim().split('\n').map(JSON.parse)
  assert.ok(rows.length >= 3, `expected >=3 records, got ${rows.length}`)
  const escalated = rows.find((row) => row.escalated === 'full-access')
  assert.ok(escalated, 'the full-access escalation must be recorded as such')
  assert.equal(escalated.tool, 'computer_key')
  assert.equal(escalated.args.combo, 'backspace')
  assert.equal(escalated.raw, 'ask')
  assert.equal(escalated.final, 'allow')
  assert.equal(escalated.approvalPolicy, 'never')
  assert.equal(escalated.sandbox, 'danger-full-access')
  assert.equal(escalated.automationMode, 'autonomous')
  assert.equal(escalated.delegated, false)
  assert.equal(escalated.attributionSeam, 'awaiting-tools', 'the record must name the seam\'s real state')
  assert.ok(rows.some((row) => row.delegated === true), 'the delegated refusal must be recorded as delegated')
  for (const row of rows) {
    assert.ok(row.ts > 0)
    assert.ok(!('text' in row.args), 'typed text must never be persisted')
    assert.ok(!JSON.stringify(row).includes('the user rejected'))
  }
  const refused = rows.find((row) => row.final === 'deny')
  assert.ok(refused && /approval prompts are unavailable/.test(refused.reason))
})

await test('gateArgSummary keeps identities and lengths, never payload text', async () => {
  assert.deepEqual(gateArgSummary('computer_key', { combo: 'ctrl+a' }), { combo: 'ctrl+a' })
  assert.deepEqual(gateArgSummary('computer_type', { text: 'secret words' }), { textLength: 12 })
  assert.deepEqual(gateArgSummary('computer_batch', { actions: [{}, {}] }), { steps: 2 })
  assert.deepEqual(gateArgSummary('computer_clip', { text: 'secret' }), {})
  // The real argument surface of the driving tools, so a record still names its target.
  assert.deepEqual(gateArgSummary('computer_click', { mark: 'M7', button: 'left' }), { mark: 'M7', button: 'left' })
  assert.deepEqual(gateArgSummary('computer_drag', { from: 'M3', to: 'M7' }), { from: 'M3', to: 'M7' })
  assert.deepEqual(gateArgSummary('computer_scroll', { dir: 'down', lines: 3, at: 'M3' }), { dir: 'down', lines: 3, at: 'M3' })
  assert.deepEqual(gateArgSummary('computer_uia_act', { value: 'typed secret' }), {})
})

await test('a throwing service property getter leaves the facts unknown instead of crashing the gate', async () => {
  const throwingGetter = {
    get: (name) => name === 'approval'
      ? { get effectivePolicy () { throw new Error('boom') } }
      : { get resolve () { throw new Error('boom') } },
  }
  const env = readApprovalEnv({ ctx: throwingGetter, session: SESSION })
  assert.equal(env.approvalPolicy, null)
  assert.equal(env.sandbox, null)
  assert.equal(env.promptsAvailable, true)
  assert.equal(env.fullAccess, false)
})

await test('delegation is read from the host session header; a fork stays the human conversation', async () => {
  const ROOT = { header: { cwd: 'C:/x', isSeeded: true } }
  assert.equal(readDelegation(ROOT), false)
  assert.equal(readDelegation({ header: { origin: 'subagent' } }), true)
  assert.equal(readDelegation({ header: { delegationDepth: 2 } }), true)
  assert.equal(readDelegation({ header: { parentSession: 'session-parent', isSeeded: false } }), true)
  // Real DSH "fork session" header: parentSession + isSeeded, NO origin/delegationDepth. It is
  // the human's own continued conversation and must keep the grant its parent had.
  assert.equal(readDelegation({ header: { cwd: 'C:/x', parentSession: 'session-49c42f5c', isSeeded: true } }), false)
  assert.equal(readDelegation({ header: 'not-a-record' }), true)
  assert.equal(readDelegation({}), true, 'a live session without a header cannot prove it is the human')
  assert.equal(readDelegation({ header: null }), true)
  assert.equal(readDelegation(null), false, 'no session at all is not a delegation claim')
  const env = readApprovalEnv({ ctx: services({ approval: { effectivePolicy: () => 'never' }, sandboxPolicy: { resolve: () => ({ mode: 'danger-full-access' }) } }), session: { id: 'child', header: { origin: 'subagent', delegationDepth: 1 } } })
  assert.equal(env.delegated, true)
  assert.equal(env.fullAccess, true)
  const fork = readApprovalEnv({ ctx: services({ approval: { effectivePolicy: () => 'never' }, sandboxPolicy: { resolve: () => ({ mode: 'danger-full-access' }) } }), session: { id: 'fork', header: { cwd: 'C:/x', parentSession: 'session-49c42f5c', isSeeded: true } } })
  assert.equal(fork.delegated, false)
  assert.equal(policyDecision('computer_key', { combo: 'backspace' }, 'autonomous', fork).kind, 'allow')
})

// ---- the attribution seam must arrive even when the registry mounts late ------------------------
await test('policy.jsonl rotates at 4 MiB instead of growing without bound', async () => {
  const dir = path.join(scratch, 'rotate-data')
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, 'policy.jsonl')
  const big = 4 * 1024 * 1024 + 10
  fs.writeFileSync(file, 'x'.repeat(big))
  appendGate({ root: dir }, { ts: 1, tool: 'computer_key' })
  assert.ok(fs.existsSync(`${file}.1`), 'the previous stream must be rotated aside')
  const fresh = fs.readFileSync(file, 'utf8')
  assert.match(fresh, /"tool":"computer_key"/)
  assert.ok(fresh.length < 200)
  // A second rotation replaces the single `.1` rather than accumulating files.
  fs.writeFileSync(file, 'y'.repeat(big))
  appendGate({ root: dir }, { ts: 2, tool: 'computer_shot' })
  assert.ok(!fs.existsSync(`${file}.2`))
  assert.equal(fs.statSync(`${file}.1`).size, big)
})

await test('the legacy-attribution seam installs into a registry that mounts after the plugin', async () => {
  const registry = {
    serviceAsk: async (exec) => ({ decision: { kind: 'deny', reason: `the user rejected tool "${exec.name}"` }, approvalCancelled: false }),
  }
  let seal = null
  const lateCtx = {
    get: () => undefined,
    inject: (names, cb) => { seal = () => cb({ tools: registry }) },
    effect: (fn) => { fn() },
  }
  const log = { info: noop, warn: noop }
  const state = installApprovalAttribution(lateCtx, log)
  assert.equal(state.installed, false)
  assert.equal(state.reason, 'awaiting-tools')
  seal()
  assert.equal(state.installed, true)
  const exec = { name: 'computer_key', agent: { session: { id: 's' } } }
  registry.ctx = { get: () => ({ effectivePolicy: () => 'never' }) }
  const result = await registry.serviceAsk(exec, { kind: 'ask', reason: 'high-risk action' })
  assert.match(result.decision.reason, /automatically rejected without asking the user/)
  assert.doesNotMatch(result.decision.reason, /the user rejected/)
  assert.equal(state.rewrites, 1)
})

console.log(`ok test-approval-channel — ${passed} cases; full access runs unanswerable asks, every other channel refuses by name, diagnostics persisted; no desktop input`)
