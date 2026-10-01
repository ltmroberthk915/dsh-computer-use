// test-batch-coverage.mjs — computer_batch must be able to REACH every registered tool.
//
// Why this exists (2026-09-12): registerTools() keeps an internal HANDLERS map that
// computer_batch dispatches through, and it had drifted — `computer_shot` was registered and
// worked when called directly, but was NOT in that map, so a batch step
//   [{tool:"computer_shot", args:{region:"…"}}]
// failed with `unknown tool computer_shot`. The schema validator, the token auditor and the
// render test all passed: every definition was valid, only the DISPATCH table was incomplete.
// That is the same class of bug as the empty-render one, so it gets the same kind of test.
//
//   node build/test-batch-coverage.mjs [path-to-tools.js]
// exit 0 = every tool is reachable; exit 1 = at least one is missing from the map.

import { pathToFileURL } from 'node:url'
import { statSync } from 'node:fs'

const PLUGIN = process.argv[2] || 'lib/tools.js'
const captured = []

// Stub core: every method resolves, so a handler that REACHES the core is fine and a handler
// that is MISSING from the map is not. Errors thrown for other reasons (missing args) are
// acceptable here — this test is about reachability, not about behaviour.
//
// EXCEPT `ask`: it must actually INVOKE the answer channel it is handed, because reaching the core is
// exactly what `computer_ask` used to do while never reaching a human. Driving `onAsk` here is what
// makes the `computer_ask` row below a statement about the ANSWER PATH rather than about a function
// call.
const cuStub = new Proxy({}, {
  get: (_t, prop) => {
    if (prop === 'then') return undefined
    if (prop === 'ask') return async (opts = {}) => ({ answered: false, keepPause: false, reason: 'stub', viaOnAsk: await opts.onAsk({ askId: 1, hostRaised: false, caretPlaced: false }) })
    return async () => ({ stub: String(prop) })
  },
})
const ctxStub = { tools: { register: (def) => captured.push(def) }, logger: () => ({ info () {}, warn () {}, error () {} }) }

const mod = await import(`${pathToFileURL(PLUGIN).href}?mtime=${statSync(PLUGIN).mtimeMs}`)
// THE ANSWER CHANNEL IS PART OF THE SURFACE (merge-design.md §6 G7). `hooks.askHuman` is what
// `computer_ask` reaches through `askQuestion` -> `cu.ask({onAsk})`; without it the tool throws
// before its handler runs and this guard would be green for the wrong reason. The stub RECORDS that
// it was called, so the `computer_ask` row below also proves the batch path reaches the SAME
// orchestration the tool does, instead of reporting a bare "reached its handler".
const asked = []
const HOOKS = { askHuman: async (question, info, exec) => { asked.push({ question, info, hasExec: !!exec }); return { answered: false, keepPause: false, reason: 'stub' } } }
mod.registerTools({
  ctx: ctxStub, cu: cuStub, config: { annotateMarks: true }, dataDir: 'C:/tmp/cu-test', log: () => {},
  snapshotPath: (d) => `${d}/shot.jpg`, defineTool: (d) => d,
  hooks: HOOKS,
})

const batch = captured.find(d => d.name === 'computer_batch')
if (!batch) { console.log('FAIL: computer_batch is not registered at all'); process.exit(1) }

// A REAL question for the ask row: it is the one argument whose absence would make the tool refuse
// before reaching the channel, and the value is asserted below.
const ARGS = { computer_ask: { question: 'proceed?' } }

let bad = 0
for (const def of captured) {
  if (def.name === 'computer_batch') continue
  const before = asked.length
  let step = null, err = null
  try {
    const res = await batch.execute({ actions: [{ tool: def.name, args: ARGS[def.name] || {} }] })
    step = res.actions && res.actions[0]
  } catch (e) { err = e.message }
  const unknown = !!(step && typeof step.error === 'string' && step.error.startsWith('unknown tool'))
  const ok = !err && !!step && !unknown
  if (!ok) bad++
  const detail = err ? `threw: ${err}`
    : unknown ? 'NOT in the batch handler map'
      : step.ok ? 'reached its handler'
        : `reached its handler (${String(step.error).slice(0, 48)})`
  console.log(`  ${ok ? 'OK  ' : 'FAIL'} ${def.name.padEnd(20)} ${detail}`)
  if (def.name === 'computer_ask') {
    // THE ANSWER CHANNEL, not just the core method (merge-design.md §5.4 item 22): a batch step that
    // asks must arrive at the SAME orchestration the direct tool call uses, i.e. it must reach
    // `hooks.askHuman`. `computer_ask: (a) => cu.ask(...)` used to pass the loop above while never
    // touching the human at all.
    if (asked.length !== before + 1) {
      console.log('  FAIL computer_ask       the batch step did not reach hooks.askHuman — a batch could raise a brake with no way to put the question to the human')
      bad++
    } else {
      const rec = asked[asked.length - 1]
      // The QUESTION must survive the whole way to the channel; `exec` is not asserted here (a batch
      // step invoked with no exec legitimately hands the channel `undefined`).
      if (rec.question !== 'proceed?') { console.log(`  FAIL computer_ask       hooks.askHuman was reached with the wrong shape: ${JSON.stringify({ question: rec.question, hasExec: rec.hasExec })}`); bad++ }
      else console.log('  ok   computer_ask       reached hooks.askHuman with the question')
    }
  }
}

// THE SELF-TEST. The assertion above is only worth its line if it can go red: with the answer
// channel removed from `hooks`, the SAME batch step must stop reaching it. If it still passes, the
// guard is measuring nothing.
{
  const saved = HOOKS.askHuman
  delete HOOKS.askHuman
  const before = asked.length
  let reached = false
  try {
    await batch.execute({ actions: [{ tool: 'computer_ask', args: { question: 'proceed?' } }] })
    reached = asked.length > before
  } catch { reached = asked.length > before }
  HOOKS.askHuman = saved
  if (reached) {
    console.log('  FAIL self-test          the ask assertion stayed GREEN with hooks.askHuman removed — it cannot fire for the drift it exists to catch')
    bad++
  } else {
    console.log('  ok   self-test          removing hooks.askHuman turns the ask assertion red')
  }
}

console.log(bad === 0
  ? `\nPASS: computer_batch can reach all ${captured.length - 1} other registered tools`
  : `\nFAIL: ${bad} tool(s) unreachable from computer_batch — add them to the HANDLERS map`)
process.exit(bad === 0 ? 0 : 1)
