// test-policy.mjs — the approval gate must COVER every registered tool, and the SAFETY-DIRECTION
// tools must never be gated.
//
// Why this exists (2026-09-13): the tool surface was rewritten from 28 names to 17 and
// lib/policy.js kept the old allow-lists. policyDecision() fails closed, so its answer for
// computer_shot / computer_select / computer_move / computer_window / computer_clip /
// computer_uia_act / computer_ctrl was "deny: unknown computer-use tool" — the plugin would have
// refused its own tools the moment they were reloaded, and the failure would have looked like a
// broken build rather than a stale list.
//
// The same shape bit TWICE more, and the second one is the dangerous direction: computer_ask
// (added 2026-09-12) had no policy either, so the ONE call that must never be gated — the one that
// stops the machine and asks the human, i.e. the safety direction, where what it asks for IS human
// attention — was denied in all four modes, and the human's own "ask + 5 秒" rule could not run.
//
// Guards: 6 invariants, each with a mutation of lib/policy.js that MUST make it fire. The guard
// fails if a mutation is not caught, if it changes nothing, or if its anchor is gone — a guard that
// cannot fire is worse than no guard.
//
//   node build/test-policy.mjs [path-to-tools.js]
// exit 0 = the gate covers the surface; exit 1 = at least one hole (or a broken self-test).

import { pathToFileURL, fileURLToPath } from 'node:url'
import { statSync, readFileSync } from 'node:fs'
import path from 'node:path'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const PLUGIN = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.join(root, 'lib/tools.js')
const POLICY = path.join(root, 'lib/policy.js')
const MODES = ['read-only', 'standard', 'autonomous', 'unrestricted']

// a representative call for each tool, so argument-dependent tools are exercised every way.
// computer_ctrl lists the actions that EXIST; `resume` is deliberately NOT one of them — it was
// removed from the surface on 2026-09-13 (no tool call may re-open a cycle the human ended), and its
// refusal is asserted separately below rather than fed to the coverage scan, where a stale action
// name would masquerade as a broken allow-list.
const SAMPLE = {
  computer_clip: [{ text: 'x' }, {}],
  computer_ctrl: [{ action: 'stop' }, { action: 'exit' }, { action: 'calibrate' }, { action: 'selftest' }, { action: 'indicator' }],
  computer_key: [{ combo: 'ctrl+a' }, { combo: 'alt+f4' }],
  computer_window: [{ hwnd: 1, op: 'close' }, { hwnd: 1, op: 'activate' }],
  computer_type: [{ text: 'x' }, { text: 'x', allowPassword: true }],
  computer_ask: [{ question: 'proceed?' }],
}
const UNKNOWN = /unknown computer-use tool|unknown computer_ctrl action/

// ---- the invariants ---------------------------------------------------------------------------
// Each run(ctx) returns a list of hole descriptions ([] = holds). ctx = { policy, tools }.
const CHECKS = [
  {
    id: 'coverage',
    name: 'every registered tool × sample × mode has an EXPLICIT policy (no "unknown" fall-through)',
    run: ({ policy, tools }) => {
      const out = []
      for (const def of tools) {
        for (const args of (SAMPLE[def.name] || [{}])) {
          for (const mode of MODES) {
            const d = policy.policyDecision(def.name, args, mode)
            if (d.kind === 'deny' && UNKNOWN.test(d.reason || '')) {
              out.push(`${def.name} ${JSON.stringify(args)} [${mode}] -> ${d.reason}`)
            }
          }
        }
      }
      return out
    },
  },
  {
    id: 'ask-all-modes',
    name: 'computer_ask is allowed in ALL FOUR modes (brake-like: it drives nothing, it IS the safety direction)',
    run: ({ policy }) => MODES
      .map((m) => [m, policy.policyDecision('computer_ask', { question: 'q' }, m)])
      .filter(([, d]) => d.kind !== 'allow')
      .map(([m, d]) => `computer_ask [${m}] -> ${d.kind}${d.reason ? ' (' + d.reason + ')' : ''} — the human's ask+5s rule must never sit behind an approval prompt`),
  },
  {
    id: 'ask-survives-actuation-gate',
    name: 'a mode that GATES an actuation still allows computer_ask',
    run: ({ policy }) => {
      const out = []
      const gated = MODES.filter((m) => policy.policyDecision('computer_click', {}, m).kind !== 'allow')
      if (gated.length === 0) out.push('no mode gates computer_click any more — this check has lost its contrast (test bug)')
      for (const m of gated) {
        const d = policy.policyDecision('computer_ask', { question: 'q' }, m)
        if (d.kind !== 'allow') out.push(`[${m}] computer_click is gated but computer_ask is ${d.kind} — asking must survive a mode that gates actuation`)
      }
      return out
    },
  },
  {
    id: 'brake-all-modes',
    name: 'the brake (computer_ctrl action:"stop") is allowed in EVERY mode, read-only included',
    run: ({ policy }) => MODES
      .map((m) => [m, policy.policyDecision('computer_ctrl', { action: 'stop' }, m)])
      .filter(([, d]) => d.kind !== 'allow')
      .map(([m, d]) => `computer_ctrl stop [${m}] -> ${d.kind}${d.reason ? ' (' + d.reason + ')' : ''}`),
  },
  {
    id: 'exit-all-modes',
    name: 'the session exit (computer_ctrl action:"exit") is allowed in EVERY mode — the ask protocol\'s second answer ("I cannot proceed") must never be gated',
    run: ({ policy }) => MODES
      .map((m) => [m, policy.policyDecision('computer_ctrl', { action: 'exit' }, m)])
      .filter(([, d]) => d.kind !== 'allow')
      .map(([m, d]) => `computer_ctrl exit [${m}] -> ${d.kind}${d.reason ? ' (' + d.reason + ')' : ''} — the ask notice promises the human the agent can end the session`),
  },
  {
    id: 'resume-refused',
    name: 'the REMOVED `resume` action is refused in every mode (no tool call may re-arm a cycle)',
    run: ({ policy }) => MODES
      .map((m) => [m, policy.policyDecision('computer_ctrl', { action: 'resume' }, m)])
      .filter(([, d]) => d.kind !== 'deny')
      .map(([m, d]) => `computer_ctrl resume [${m}] -> ${d.kind} (must be deny)`),
  },
  {
    id: 'observations-readonly',
    name: 'observations are allowed in read-only (they drive nothing)',
    run: ({ policy, tools }) => {
      const out = []
      for (const def of tools) {
        if (!/^computer_(shot|state|marks|uia|wait)$/.test(def.name)) continue
        for (const args of (SAMPLE[def.name] || [{}])) {
          const d = policy.policyDecision(def.name, args, 'read-only')
          if (d.kind !== 'allow') out.push(`observation ${def.name} denied in read-only: ${d.reason}`)
        }
      }
      return out
    },
  },
]

// ---- mutations of lib/policy.js: each MUST make its check fire ---------------------------------
const MUTATIONS = [
  { check: 'coverage', what: 'drop computer_click from ACTUATION_TOOLS',
    find: "'computer_click', ", with: '' },
  { check: 'coverage', what: 'delete the computer_ask branch (the fail-closed fall-through again)',
    find: "  if (name === 'computer_ask') return { kind: 'allow' }", with: '  // ask branch removed' },
  { check: 'ask-all-modes', what: 'make the ask branch mode-gated (allowed only in unrestricted)',
    find: "  if (name === 'computer_ask') return { kind: 'allow' }",
    with: "  if (name === 'computer_ask') return mode === 'unrestricted' ? { kind: 'allow' } : { kind: 'ask', reason: 'gated' }" },
  { check: 'ask-survives-actuation-gate', what: 'deny the ask in read-only (the exact backwards behaviour)',
    find: "  if (name === 'computer_ask') return { kind: 'allow' }",
    with: "  if (name === 'computer_ask') return mode === 'read-only' ? { kind: 'deny', reason: 'read-only: ask denied' } : { kind: 'allow' }" },
  { check: 'brake-all-modes', what: 'deny the brake in read-only',
    find: "    if (act === 'stop') return { kind: 'allow' }",
    with: "    if (act === 'stop') return mode === 'read-only' ? { kind: 'deny', reason: 'no' } : { kind: 'allow' }" },
  { check: 'exit-all-modes', what: 'delete the exit branch (the exact hole: "unknown computer_ctrl action: exit" in all four modes)',
    find: "    if (act === 'exit') return { kind: 'allow' }\n", with: '' },
  { check: 'resume-refused', what: 're-add the dead resume branch as an ALLOW',
    find: "    if (act === 'calibrate' || act === 'indicator') return decideActuation(name, a, mode)",
    with: "    if (act === 'resume') return { kind: 'allow' }\n    if (act === 'calibrate' || act === 'indicator') return decideActuation(name, a, mode)" },
  { check: 'observations-readonly', what: 'drop computer_shot from OBSERVATION_TOOLS',
    find: "'computer_shot', ", with: '' },
]

// ---- load the tool surface (stubs: this guard only asks the POLICY, it never runs a tool) -------
const captured = []
const cuStub = new Proxy({}, { get: (_t, p) => (p === 'then' ? undefined : async () => ({})) })
const ctxStub = { tools: { register: (d) => captured.push(d) }, logger: () => ({ info () {}, warn () {}, error () {} }) }
const toolMod = await import(`${pathToFileURL(PLUGIN).href}?mtime=${statSync(PLUGIN).mtimeMs}`)
toolMod.registerTools({
  ctx: ctxStub, cu: cuStub, config: { annotateMarks: true }, dataDir: 'C:/tmp/cu-test',
  log: () => {}, snapshotPath: (d) => `${d}/shot.jpg`, defineTool: (d) => d,
})

// policy.js has no imports, so a mutated copy loads straight from a data: URL — no temp files, and
// no chance of a mutant leaking into the real module registry.
const policySource = readFileSync(POLICY, 'utf8')
const loadPolicy = (source) => import('data:text/javascript;base64,' + Buffer.from(source, 'utf8').toString('base64'))
const realPolicy = await import(`${pathToFileURL(POLICY).href}?v=${statSync(POLICY).mtimeMs}`)

const failures = []
const holesFor = (policy) => CHECKS.flatMap((c) => c.run({ policy, tools: captured }).map((msg) => ({ check: c.id, msg })))

// ---- the report table (informative, decided by the REAL policy) --------------------------------
const realHoles = holesFor(realPolicy)
console.log(`plugin: ${PLUGIN}`)
console.log(`policy: ${POLICY}`)
console.log(`tools:  ${captured.length}\n`)
for (const def of captured) {
  const parts = []
  for (const args of (SAMPLE[def.name] || [{}])) {
    for (const mode of MODES) {
      const d = realPolicy.policyDecision(def.name, args, mode)
      if (mode === 'unrestricted') parts.push(d.kind === 'allow' ? 'A' : d.kind.toUpperCase())
    }
  }
  const uniq = [...new Set(parts)].join('')
  console.log(`  ${uniq === 'A' ? 'ok   ' : 'check'} ${def.name.padEnd(20)} unrestricted=[${uniq}]${uniq === 'A' ? '' : '  <-- gated somewhere'}`)
}
if (realHoles.length) {
  console.log('')
  for (const h of realHoles) console.log(`  HOLE  [${h.check}] ${h.msg}`)
  failures.push(...realHoles.map((h) => `HOLE [${h.check}] ${h.msg}`))
}

// ---- self-test: every check must fire on a mutated copy of lib/policy.js -----------------------
let caught = 0
let mutations = 0
for (const mut of MUTATIONS) {
  mutations++
  const source = policySource.split(mut.find).join(mut.with)
  // A mutation that does not change the text proves nothing: report it as a test bug, never a pass.
  if (source === policySource) {
    failures.push(`self-test BUG: the mutation "${mut.what}" did not apply (anchor absent) or changed nothing — fix the test, not the guard`)
    continue
  }
  const mutant = await loadPolicy(source)
  const fired = holesFor(mutant).filter((h) => h.check === mut.check)
  // Attribution: THIS invariant must fire, not merely "some invariant somewhere".
  if (fired.length === 0) {
    failures.push(`self-test FAILED: the guard accepted lib/policy.js with "${mut.what}" — the "${mut.check}" invariant cannot fire`)
  } else {
    caught++
  }
}

if (failures.length) {
  console.error('\nFAIL test-policy')
  for (const f of failures) console.error('  ' + f)
  console.error(`self-test: ${caught}/${mutations} mutations caught`)
  process.exit(1)
}
console.log(`\nPASS: the approval gate covers all ${captured.length} tools in all 4 modes, and the safety-direction tools are never gated`)
console.log(`self-test: ${caught}/${mutations} mutations caught (${CHECKS.length} invariants)`)
