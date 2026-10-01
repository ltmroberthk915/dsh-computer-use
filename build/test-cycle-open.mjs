// test-cycle-open.mjs — WHERE THE CYCLE IS OPENED, AND WHOSE FAULT AN EXIT IS.
//
// The bug this guard exists for (measured 2026-09-13, host log dsh-2026-09-13.log): the machine-wide
// `%LOCALAPPDATA%\dsh-computer-use\EXITED` record is cleared by exactly ONE thing — the worker op
// `resume` — and the plugin used to send it only from the `turn/start` branch, gated on
// `bus.driverSession`, which is only ever set by a PREVIOUS session's tool call. A brand-new session
// therefore never satisfied that gate: its first turn started at 01:19:51 with the latch still set,
// the session was recognised only at 01:19:55 (by its own first tool call), and its first driving call
// at 01:21:34 came back CYCLE-ENDED. The agent then told the human they had pressed Ctrl+Alt+Q.
//
// So there are FOUR invariants, and each one carries a mutation that must make it go red:
//   1. the per-turn latch is reset at turn/start (next to nudgedTurn, the same axis);
//   2. every computer_* call AWAITS the opener on the dispatch path, before the worker op is sent;
//   3. the opener can never clear a BRAKE — only the EXITED latch, only via `resume`, only once per
//      turn, and never while a brake is up (a human's Ctrl+Alt+R must stay the only release);
//   4. nothing in lib/ still accuses the human of a key press the worker only ever *measured*.
//
// Checks 2 and 3 are not text matches: the real `ensureCycle` source is lifted out of lib/index.js,
// compiled into a throw-away module and RUN against a stub core, and the real lib/tools.js is driven
// with a stub core to observe the order of the calls it makes. Text is only used where behaviour is
// not observable (the turn/start reset lives inside apply(), which needs the DSH host to load).
//
//   node build/test-cycle-open.mjs
// exit 0 = all invariants hold and all mutations are caught; exit 1 otherwise.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const ROOT = path.resolve(import.meta.dirname, '..')
const LIBDIR = path.join(ROOT, 'lib')
const INDEX = 'index.js'
const TOOLS = 'tools.js'

const readLib = () => Object.fromEntries(
  fs.readdirSync(LIBDIR)
    .filter((f) => f.endsWith('.js'))
    .map((f) => [f, fs.readFileSync(path.join(LIBDIR, f), 'utf8')]),
)
const BASE = readLib()
if (!BASE[INDEX] || !BASE[TOOLS]) { console.log('FAIL test-cycle-open'); console.log('  lib/index.js or lib/tools.js is missing'); process.exit(1) }

// TEXT CHECKS RUN ON COMMENT-STRIPPED SOURCE, so a comment describing a rule can never satisfy a
// check for the code that implements it (the lesson from build/test-skill-gate.mjs). String literals
// are copied through, because the notice's own wording is part of what is being checked.
function stripComments (src) {
  let out = ''; let i = 0; let mode = 'code'
  while (i < src.length) {
    const c = src[i]; const d = src[i + 1]
    if (mode === 'code') {
      if (c === '/' && d === '/') { mode = 'line'; i += 2; continue }
      if (c === '/' && d === '*') { mode = 'block'; i += 2; continue }
      if (c === '"' || c === "'" || c === '`') { mode = c; out += c; i++; continue }
      out += c; i++; continue
    }
    if (mode === 'line') { if (c === '\n') { mode = 'code'; out += c } i++; continue }
    if (mode === 'block') { if (c === '*' && d === '/') { mode = 'code'; i += 2 } else { if (c === '\n') out += c; i++ } continue }
    if (c === '\\') { out += c + (d || ''); i += 2; continue }
    if (c === mode) mode = 'code'
    out += c; i++
  }
  return out
}
const strip = (m) => Object.fromEntries(Object.entries(m).map(([k, v]) => [k, stripComments(v)]))

/** Source text of `anchor` up to and including its matching `}` — the function, verbatim. */
function braceBody (src, anchor) {
  const start = src.indexOf(anchor)
  if (start < 0) return null
  const open = src.indexOf('{', start + anchor.length - 1)
  if (open < 0) return null
  let depth = 0; let i = open; let mode = 'code'
  while (i < src.length) {
    const c = src[i]; const d = src[i + 1]
    if (mode === 'code') {
      if (c === '/' && d === '/') { mode = 'line'; i += 2; continue }
      if (c === '/' && d === '*') { mode = 'block'; i += 2; continue }
      if (c === '"' || c === "'" || c === '`') { mode = c; i++; continue }
      if (c === '{') depth++
      else if (c === '}') { depth--; if (depth === 0) return src.slice(start, i + 1) }
      i++; continue
    }
    if (mode === 'line') { if (c === '\n') mode = 'code'; i++; continue }
    if (mode === 'block') { if (c === '*' && d === '/') { mode = 'code'; i += 2 } else i++; continue }
    if (c === '\\') { i += 2; continue }
    if (c === mode) mode = 'code'
    i++
  }
  return null
}

/** The notice's text, with the `' + '` line joins collapsed, so a phrase split over two source lines
 *  is still found as the reader will see it. */
const visible = (src) => src.replace(/'\s*\+\s*'/g, '')

// ------------------------------------------------------------------------------------------------
// A sandbox for the behavioural tests: LOCALAPPDATA is redirected so the LATCHES under test are files
// this guard owns, never the real machine's (which may legitimately hold an EXITED record right now).
const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'cu-cycle-open-'))
const LATCHDIR = path.join(SANDBOX, 'dsh-computer-use')
fs.mkdirSync(LATCHDIR, { recursive: true })
const SHOTS = path.join(SANDBOX, 'shots')
fs.mkdirSync(SHOTS, { recursive: true })
const EXITED = path.join(LATCHDIR, 'EXITED')
const STOPFILE = path.join(LATCHDIR, 'STOP')
const SAVED = { localappdata: process.env.LOCALAPPDATA, stopfile: process.env.DSH_COMPUTER_USE_STOP_FILE }
process.env.LOCALAPPDATA = SANDBOX
delete process.env.DSH_COMPUTER_USE_STOP_FILE
const clearLatches = () => {
  for (const p of [EXITED, STOPFILE]) { try { fs.unlinkSync(p) } catch { /* absent is the point */ } }
  delete process.env.DSH_COMPUTER_USE_STOP_FILE
}

// ---- the real opener, lifted out of lib/index.js and executed ------------------------------------
let harnessSeq = 0
async function ensureCycleBehaviour (indexSrc) {
  const out = []
  const exitPath = braceBody(indexSrc, 'function exitRecordPath ()')
  const exited = braceBody(indexSrc, 'function exitedLatch ()')
  const brake = braceBody(indexSrc, 'function brakeLatch ()')
  const exitText = braceBody(indexSrc, 'function exitRecordText ()')
  const claimOf = braceBody(indexSrc, 'const claimOf = (exec)')
  const opener = braceBody(indexSrc, 'const ensureCycle = async (exec)')
  if (!exitPath || !exited || !brake || !exitText || !claimOf || !opener) {
    out.push({ name: 'the cycle opener is extractable from lib/index.js', ok: false,
      detail: `could not lift ${!exitPath ? 'exitRecordPath ' : ''}${!exited ? 'exitedLatch ' : ''}${!brake ? 'brakeLatch ' : ''}${!exitText ? 'exitRecordText ' : ''}${!claimOf ? 'claimOf ' : ''}${!opener ? 'ensureCycle' : ''} out of lib/index.js — did the shape change?` })
    return out
  }
  // The lifted opener needs the REAL gate (lib/cycle.js), because that is where identity, ownership
  // and the per-turn qualification now live — the guard must exercise the shipped state machine, not
  // a copy of it.
  const moduleSrc = [
    "import fs from 'node:fs'",
    "import os from 'node:os'",
    "import path from 'node:path'",
    `import { createCycleGate, agentKeyOf } from ${JSON.stringify(pathToFileURL(path.join(LIBDIR, 'cycle.js')).href)}`,
    'export function make ({ cu, log, exec }) {',
    "  const sessionKey = (s) => (!s ? null : (typeof s === 'string' ? s : (s.id || s.sessionId || s.key || null)))",
    // The machine's mailbox: bound to the cycle OWNER, never to whoever called last (integration bug).
    '  const bus = { agent: null, driverSession: null }',
    '  const gate = createCycleGate({ sessionKey, agentKey: agentKeyOf, now: () => Date.now() })',
    exitPath,
    exited,
    brake,
    exitText,
    claimOf,
    opener,
    '  return {',
    '    ensureCycle,',
    '    turnStart: (s) => gate.noteTurnStart(s),',
    '    mark: (st, d) => gate.mark(st, d),',
    '    state: () => gate.state(),',
    '    snapshot: () => gate.snapshot(),',
    '    used: () => gate.snapshot().qualifications.some((q) => q.used),',
    '    mailbox: () => bus.agent,',
    '    driver: () => bus.driverSession,',
    '  }',
    '}',
  ].join('\n')
  const b64 = Buffer.from(moduleSrc, 'utf8').toString('base64')
  let mod
  try {
    mod = await import('data:text/javascript;base64,' + b64 + '#guard' + (++harnessSeq))
  } catch (e) {
    out.push({ name: 'the cycle opener compiles and loads', ok: false, detail: `lifted source did not compile: ${e.message}` })
    return out
  }

  // Every case: two calls inside ONE turn (the per-turn qualification is what makes it one opener),
  // against a stub core whose only observable behaviour is `resume`. The claim comes from the EXEC,
  // exactly as it does in production (a call identity, never a remembered driver session).
  const EXEC = { session: 'session-A', agent: { id: 'agent-A' } }
  const runCase = async (name, prep, shape, check) => {
    clearLatches()
    try { prep() } catch (e) { out.push({ name, ok: false, detail: `setup failed: ${e.message}` }); return }
    const calls = []
    const cu = {
      exited: !!shape.exited,
      stopped: !!shape.stopped,
      resume: async (expect) => { calls.push(expect === undefined ? 'resume' : `resume:${String(expect).length}`); if (shape.throws) throw new Error('worker could not be started') },
    }
    const env = mod.make({ cu, log: { info () {}, warn () {} }, exec: EXEC })
    let err = null
    try {
      await env.ensureCycle(EXEC)
      if (shape.turnStart) env.turnStart(EXEC.session)
      await env.ensureCycle(EXEC)
    } catch (e) { err = e.message }
    const r = { calls, opened: env.used(), err, state: env.state() }
    const ok = check(r)
    out.push({ name, ok, detail: `resume calls=${calls.length} latch=${r.opened} state=${r.state}${err ? ` threw=${err}` : ''}` })
  }

  await runCase(
    'opens: an INHERITED EXITED record is cleared once, on the turn that calls computer use',
    () => fs.writeFileSync(EXITED, 'Ctrl+Alt+Q chord detected\r\nsource=hook\r\nat=2026-09-13 01:17:44\r\n'),
    { exited: false, stopped: false },
    (r) => r.calls.length === 1 && r.opened === true && r.err === null)

  await runCase(
    'opens: the core\'s own exited flag (no file) is cleared too',
    () => {},
    { exited: true, stopped: false },
    (r) => r.calls.length === 1 && r.opened === true)

  // NOTE on `opened` from here on: the gate consumes the turn's qualification on the FIRST call
  // whatever it decides, so "a qualification was used" is true even when no opener ran — that is the
  // fix for the same-turn resurrection. The observable that still separates the cases is whether a
  // `resume` was actually sent, so these cases assert the resume count (and the gate's own state).
  await runCase(
    'quiet: a LIVE cycle is never re-opened (no exit, no brake → no resume at all)',
    () => {},
    { exited: false, stopped: false },
    (r) => r.calls.length === 0 && r.opened === true && r.state === 'open')

  await runCase(
    'brake: a raised BRAKE is never cleared, even with an exit record present',
    () => fs.writeFileSync(EXITED, 'record'),
    { exited: true, stopped: true },
    (r) => r.err === null && r.calls.length === 0 && r.opened === true)

  await runCase(
    'brake: the PERSISTED STOP latch is obeyed even when the local flag is stale',
    () => { fs.writeFileSync(EXITED, 'record'); fs.writeFileSync(STOPFILE, 'emergency stop') },
    { exited: false, stopped: false },
    (r) => r.err === null && r.calls.length === 0 && r.opened === true)

  await runCase(
    'brake: the STOP latch honours the worker\'s own DSH_COMPUTER_USE_STOP_FILE override',
    () => {
      fs.writeFileSync(EXITED, 'record')
      fs.writeFileSync(path.join(SANDBOX, 'custom-stop'), 'emergency stop')
      process.env.DSH_COMPUTER_USE_STOP_FILE = path.join(SANDBOX, 'custom-stop')
    },
    { exited: false, stopped: false },
    (r) => r.err === null && r.calls.length === 0 && r.opened === true)

  // A FAILED OPENER IS VISIBLE AND FINAL: it is attempted exactly once and the rejection reaches the
  // caller here. lib/tools.js is what turns a non-tagged failure into a logged warning (so the tool
  // path does not throw), and the worker's own refusal follows; the point of this case is that the
  // failure is NOT retried inside the turn — a retry is how a rejected opener used to be re-attempted
  // after the human had already ended the cycle.
  await runCase(
    'containment: a failing opener is attempted exactly ONCE and its failure is visible to the caller',
    () => fs.writeFileSync(EXITED, 'record'),
    { exited: false, stopped: false, throws: true },
    (r) => r.err !== null && r.calls.length === 1 && r.opened === true)

  return out
}

// ---- the real dispatch path: what order does a computer_* call make its calls in? ----------------
async function dispatchBehaviour (toolsSrc, tag) {
  const out = []
  const file = path.join(SANDBOX, `tools-${tag}.mjs`)
  fs.writeFileSync(file, toolsSrc.replace(/from '\.\/(batch|artifacts|image-output)\.js'/g,
    (_, name) => `from ${JSON.stringify(pathToFileURL(path.join(LIBDIR, name + '.js')).href)}`))
  let mod
  try {
    mod = await import(pathToFileURL(file).href + '?t=' + (++harnessSeq))
  } catch (e) {
    out.push({ name: 'lib/tools.js loads', ok: false, detail: `did not load: ${e.message}` })
    return out
  }
  const defs = []
  const order = []
  const cu = new Proxy({
    screenshot: async () => {
      order.push('worker:screenshot')
      return { image: Buffer.alloc(8), mime: 'image/jpeg', region: { x: 0, y: 0, width: 8, height: 8 }, settled: true }
    },
  }, {
    get: (t, p) => {
      if (p === 'then') return undefined
      if (Object.prototype.hasOwnProperty.call(t, p)) return t[p]
      return async () => { order.push('worker:' + String(p)); return {} }
    },
  })
  const register = (ensureCycle) => {
    defs.length = 0
    mod.registerTools({
      ctx: { tools: { register: (d) => defs.push(d) }, logger: () => ({ info () {}, warn () {} }) },
      cu,
      config: { annotateMarks: true },
      dataDir: { root: SHOTS, shots: SHOTS },
      log: { info () {}, warn () {} },
      snapshotPath: (d) => path.join(d.shots, `shot-${++harnessSeq}.jpg`),
      defineTool: (d) => d,
      ...(ensureCycle ? { ensureCycle } : {}),
    })
  }
  // The stub opener AWAITS, exactly like the real one (which awaits the worker's answer): if the
  // wrapper stops awaiting it, the tool's own worker call is recorded first and this test goes red.
  register(async () => { await new Promise((r) => setTimeout(r, 8)); order.push('cycle') })

  const cases = [
    ['computer_state', { windows: true }],
    ['computer_uia', { at: '1,1' }],
    ['computer_shot', {}],
    ['computer_ctrl', { action: 'selftest' }],
    ['computer_batch', { actions: [{ tool: 'computer_wait', args: {} }] }],
  ]
  for (const [name, args] of cases) {
    const def = defs.find((d) => d.name === name)
    order.length = 0
    if (!def) { out.push({ name: `dispatch: ${name} is registered`, ok: false, detail: 'not registered' }); continue }
    try { await def.execute(args, {}) } catch { /* the stubs are minimal; the ORDER is what is under test */ }
    out.push({
      name: `dispatch: ${name} — the cycle is opened (and awaited) before any worker call`,
      ok: order[0] === 'cycle' && order.length > 1,
      detail: `order: ${order.join(' → ') || '(nothing recorded)'}`,
    })
  }

  // The parameter is optional: the other guards (and any embedder) may register without an opener.
  register(null)
  order.length = 0
  const state = defs.find((d) => d.name === 'computer_state')
  try { await state.execute({ windows: true }, {}) } catch { /* order only */ }
  out.push({
    name: 'dispatch: registering without an opener still works (the hook is optional)',
    ok: order.length > 0 && order.every((x) => x.startsWith('worker:')),
    detail: `order: ${order.join(' → ') || '(nothing recorded)'}`,
  })
  return out
}

// ---- text checks: what cannot be observed behaviourally ------------------------------------------
const TEXT_CHECKS = [
  // THE GATE IS THE STATE MACHINE (2026-09-13). Identity, ownership and the per-turn qualification
  // moved into lib/cycle.js so they could be driven behaviourally; these checks assert the PLUGIN is
  // wired to it and that the turn boundary no longer opens anything by itself.
  ['gate: the plugin builds the cycle gate from lib/cycle.js',
    (s) => /import \{ createCycleGate, agentKeyOf \} from '\.\/cycle\.js'/.test(s[INDEX]) &&
      /const gate = createCycleGate\(\{ sessionKey, agentKey: agentKeyOf/.test(s[INDEX])],
  ['gate: the claim comes from the EXEC (session + agent), never from a remembered driver session',
    (s) => {
      const b = braceBody(s[INDEX], 'const claimOf = (exec)')
      return !!b && /exec\.session/.test(b) && /exec\.agent/.test(b) && !/driverSession/.test(b)
    }],
  ['turn/start: renews ONLY this session\'s qualification and opens NOTHING',
    (s) => {
      const b = braceBody(s[INDEX], "if (event.type === 'turn/start') {")
      if (!b) return false
      if (!/gate\.noteTurnStart\(session\)/.test(b)) return false
      return !/cu\.resume\(/.test(b)     // an opener here is a resurrection path with no call to justify it
    }],
  ['wiring: the opener is handed to registerTools (the dispatch path)',
    (s) => /const ensureCycle = async \(exec\)/.test(s[INDEX]) && /registerTools\(\{[^}]*\bensureCycle\b[^}]*\}\)/.test(s[INDEX])],
  ['opener: the turn\'s ONE decision belongs to the gate, which shares one settled promise',
    (s) => {
      const b = braceBody(s[INDEX], 'const ensureCycle = async (exec)')
      if (!b || !/gate\.open\(cl,/.test(b)) return false
      const g = fs.readFileSync(path.join(LIBDIR, 'cycle.js'), 'utf8')
      // The shared promise is created ONCE per qualification, and its pre-check shares ONE
      // synchronous block with the call to the opener: no microtask gap may sit between "is this
      // still valid?" and "start the opener", because an exit that already happened would then still
      // get an opener started (#7). The post-await check must remain for an opener in flight.
      return /if \(e\.promise\) return e\.promise/.test(g) &&
        /e\.promise = Promise\.resolve\(\)/.test(g) &&
        /const started = \(typeof openFn === 'function'\) \? openFn\(\) : undefined/.test(g) &&
        !/Promise\.resolve\(\)\s*\n?\s*\.then\(\(\) => \(typeof openFn/.test(g)
    }],
  // A WHITELIST, not a blacklist of brake ops: naming the three members the opener may touch is the
  // only form a new op cannot slip past (an added `cu.call('abort')`, a `cu['panic']`, or anything
  // that appears only on the brake path — where the behavioural cases above never reach it).
  ['opener: it touches ONLY cu.exited / cu.stopped / cu.resume — nothing that could release a brake',
    (s) => {
      const b = braceBody(s[INDEX], 'const ensureCycle = async (exec)')
      if (!b || /\bcu\s*\[/.test(b)) return false
      const members = new Set([...b.matchAll(/\bcu\.([A-Za-z_$][\w$]*)/g)].map((m) => m[1]))
      return members.size > 0 && members.has('resume') &&
        [...members].every((m) => m === 'exited' || m === 'stopped' || m === 'resume')
    }],
  ['opener: the brake guard is checked BEFORE the resume is sent',
    (s) => {
      const b = braceBody(s[INDEX], 'const ensureCycle = async (exec)')
      if (!b) return false
      const guard = b.indexOf('brakeLatch()')
      return guard >= 0 && b.indexOf('cu.stopped') >= 0 && b.indexOf('await cu.resume(') > guard
    }],
  ['opener: the record it is about to clear is QUOTED to the worker, so a newer one cannot be cleared',
    (s) => {
      const b = braceBody(s[INDEX], 'const ensureCycle = async (exec)')
      if (!b) return false
      return /const expect = exitRecordText\(\)/.test(b) && /await cu\.resume\(expect\)/.test(b)
    }],
  ['brake: the latch helpers only READ — no lib file may write or delete a latch',
    (s) => {
      const bodies = [braceBody(s[INDEX], 'function exitedLatch ()'), braceBody(s[INDEX], 'function brakeLatch ()')]
      if (bodies.some((b) => !b)) return false
      return bodies.every((b) => /fs\.existsSync\(/.test(b) && !/fs\.(writeFile|appendFile|unlink|rm|rmdir|rename|truncate|open|copyFile|mkdir)\w*Sync?\s*\(/.test(b))
    }],
  ['dispatch: tools.js awaits the opener BEFORE `inner()` (i.e. before the worker op)',
    (s) => {
      const a = s[TOOLS].indexOf('await ensureCycle(exec)')
      const i = s[TOOLS].indexOf('const out = await inner(args, exec)')
      return a >= 0 && i >= 0 && a < i
    }],
  ['dispatch: a VOIDED opening is refused, not dispatched (and a cancelled call never enters)',
    (s) => /if \(opened && opened\.voided\)/.test(s[TOOLS]) &&
      /exec\.signal && exec\.signal\.aborted/.test(s[TOOLS]) &&
      /err\.dshCycleRefusal = true/.test(s[TOOLS])],
  ['exit notice: the card is still called `computer-use exited`',
    (s) => /'computer-use exited'/.test(s[INDEX])],
  ['exit notice: its recipient is captured BEFORE the first await (a rebind must not steal the cancel)',
    (s) => {
      const b = braceBody(s[INDEX], "cu.on('exit', async (e)")
      if (!b) return false
      const cap = b.indexOf('const recipient = bus.agent')
      return cap >= 0 && b.indexOf('await notice(') > cap
    }],
  ['wake boundary: the resume handler obeys `mark` AND re-validates at delivery',
    (s) => {
      const h = braceBody(s[INDEX], "cu.on('resume', (e)")
      if (!h) return false
      // 1. an ended cycle is not allowed to wake anybody, and the handler must act on mark()'s verdict
      if (!/if \(!gate\.mark\('open'/.test(h)) return false
      // 2. the wake carries a validity predicate, so a Q during message construction kills it
      if (!/valid: \(\) => gate\.state\(\) === 'open'/.test(h)) return false
      if (!/gate\.exitVersion\(\) === version/.test(h)) return false
      // 3. and the notice re-checks that predicate AFTER its last await, immediately before delivery
      const n = braceBody(s[INDEX], 'const notice = async (text, summary, opts)')
      if (!n) return false
      const chk = n.indexOf('opts.valid')
      return chk >= 0 && n.indexOf('await buildMessage') < chk && n.indexOf('agent.steer(msg)') > chk
    }],
  ['ask ending: the gate is settled from the MIRRORED truth, and `asking` is never left standing',
    (s) => {
      const b = braceBody(s[INDEX], "cu.on('ask-ended', (r)")
      if (!b) return false
      if (!/if \(gate\.state\(\) !== 'asking'\) return/.test(b)) return false   // a newer state is not ours to finish
      if (!/r\.exited\) \{ gate\.mark\('ended'/.test(b)) return false
      if (!/r\.stopped\) \{ gate\.mark\('paused'/.test(b)) return false
      if (!/gate\.mark\('open'/.test(b)) return false
      return !/cu\.resume\(/.test(b) && !/mark\('open', \{ why: 'human/.test(b)   // never impersonates a human resume
    }],
  ['host stop button: the brake is engaged WITHOUT calming the cycle away first',
    (s) => {
      // NB: anchor on the interrupt branch's own log text — the self-abort branch above logs
      // "NOT re-engaging the brake" and legitimately calms (that cycle IS over).
      const i = s[INDEX].indexOf('in a computer-use session')
      if (i < 0) return false
      const win = s[INDEX].slice(i, i + 400)
      return win.includes('cu.panic(') && !win.includes('cu.calm(')
    }],
  ['exit notice: the worker\'s record is quoted VERBATIM (never re-worded by the plugin)',
    (s) => /const record = \(e && e\.why\)/.test(s[INDEX]) && /\$\{record\}/.test(s[INDEX])],
  ['exit notice: it says the record is history — a timestamp and a witness, not a deed',
    (s) => {
      const t = visible(s[INDEX])
      return /RECORD, NOT AN ACCUSATION/.test(t) && /does NOT prove the human pressed anything/.test(t) &&
        /the witness that saw it/.test(t)
    }],
  ['exit notice: and it forbids the accusation outright',
    (s) => /Do NOT tell the human that they pressed Ctrl\+Alt\+Q/.test(visible(s[INDEX]))],
  ['exit notice: computer use is still declared over for this session',
    (s) => /computer use is over for this session: do not continue the task, do not start anything new\./.test(visible(s[INDEX]))],
  // ABSENCE runs on the RAW source on purpose: the phrase must not survive even inside a comment.
  ['accusation: the phrase is gone from every file in lib/',
    (s) => Object.entries(s).every(([, v]) => !/SESSION EXITED BY THE HUMAN/.test(v))],
]

async function evaluate (map) {
  const stripped = strip(map)
  const results = []
  for (const [name, fn] of TEXT_CHECKS) {
    let ok = false; let detail = ''
    try { ok = !!fn(stripped) } catch (e) { detail = 'check threw: ' + e.message }
    results.push({ name, ok, detail })
  }
  results.push(...await ensureCycleBehaviour(map[INDEX]))
  results.push(...await dispatchBehaviour(map[TOOLS], 'base-' + harnessSeq))
  return results
}

// ---- run ----------------------------------------------------------------------------------------
let failures = 0
let base = null
try {
  base = await evaluate(BASE)
} catch (e) {
  console.log('FAIL test-cycle-open')
  console.log('  the guard itself threw: ' + e.message)
  process.exit(1)
}

// ---- every invariant must be able to fail --------------------------------------------------------
const MUTATIONS = [
  ['turn/start opens the cycle again (a resurrection path with no call behind it)', INDEX,
    '        if (session) gate.noteTurnStart(session)\n',
    '        if (session) { gate.noteTurnStart(session); cu.resume().catch(() => {}) }\n',
    'turn/start'],
  ['the claim falls back to the remembered driver session', INDEX,
    '    const s = (exec && (exec.session || exec.sessionId)) ||\n      (exec && exec.agent && (exec.agent.session || exec.agent.sessionId)) || null\n    return gate.claim({ session: s, agent: exec && exec.agent })',
    '    return gate.claim({ session: bus.driverSession, agent: exec && exec.agent })',
    'gate: the claim comes from the EXEC'],
  ['the opener is no longer wired into the dispatch path', INDEX,
    ', defineTool, hooks, ensureCycle })', ', defineTool, hooks })',
    'wiring: the opener is handed to registerTools'],
  ['the opener is not awaited on the tool path (fire and forget)', TOOLS,
    'await ensureCycle(exec) } catch', 'ensureCycle(exec) } catch',
    'dispatch: tools.js awaits the opener'],
  ['a voided opening is ignored and the op is dispatched anyway', TOOLS,
    'if (opened && opened.voided) {', 'if (false && opened && opened.voided) {',
    'dispatch: a VOIDED opening is refused'],
  ['the exit record is no longer quoted to the worker (any newer record could be cleared)', INDEX,
    'const expect = exitRecordText()\n', 'const expect = undefined\n',
    'opener: the record it is about to clear is QUOTED'],
  ['the brake guard is made inert', INDEX,
    '      if (cu.stopped || brakeLatch()) {', '      if (false) {',
    'brake: a raised BRAKE is never cleared'],
  ['the brake path THROWS instead of returning quietly', INDEX,
    "        log.warn('not opening a cycle: a brake is engaged (only the human\\'s Ctrl+Alt+R releases it)')\n        return { opened: false, reason: 'brake' }",
    "        log.warn('not opening a cycle: a brake is engaged')\n        throw new Error('brake is up')",
    'brake: a raised BRAKE is never cleared'],
  ['the opener is allowed to send a brake op', INDEX,
    '      await cu.resume(expect)', "      await cu.panic('halt')\n      await cu.resume(expect)",
    'opener: it touches ONLY'],
  ['the opener is allowed to send an UNLISTED op', INDEX,
    '      await cu.resume(expect)', "      await cu.call('abort', {})\n      await cu.resume(expect)",
    'opener: it touches ONLY'],
  ['a latch helper starts deleting the file it reads', INDEX,
    '    if (env) return fs.existsSync(env)', '    if (env) return fs.unlinkSync(env)',
    'brake: the latch helpers only READ'],
  ['the record is no longer quoted verbatim', INDEX,
    "const record = (e && e.why) || 'the worker sent no record with this event'",
    "const record = 'the human pressed Ctrl+Alt+Q'",
    'exit notice: the worker\'s record is quoted VERBATIM'],
  ['the accusation comes back', INDEX,
    "'THAT IS A RECORD, NOT AN ACCUSATION.", "'SESSION EXITED BY THE HUMAN (Ctrl+Alt+Q).",
    'accusation: the phrase is gone'],
]

let caught = 0
for (const [label, file, from, to, expectCheck] of MUTATIONS) {
  const mutated = { ...BASE }
  if (!mutated[file].includes(from)) { console.log(`  FAIL self-test BUG: cannot mutate "${label}" (anchor absent in ${file})`); failures++; continue }
  mutated[file] = mutated[file].split(from).join(to)
  if (mutated[file] === BASE[file]) { console.log(`  FAIL self-test BUG: mutation "${label}" changed NOTHING`); failures++; continue }
  let after
  try { after = await evaluate(mutated) } catch (e) { console.log(`  FAIL self-test: evaluating "${label}" threw: ${e.message}`); failures++; continue }
  const fired = after.filter((r) => r.name.includes(expectCheck) && !r.ok)
  if (fired.length > 0) caught++
  else {
    console.log(`  FAIL self-test FAILED: nothing fired for mutation "${label}" (expected a red ${expectCheck})`)
    failures++
  }
}

const red = base.filter((r) => !r.ok)
if (red.length) {
  for (const r of red) console.log(`  FAIL ${r.name}${r.detail ? ' — ' + r.detail : ''}`)
  failures += red.length
}

// ---- the sandbox is this guard's own; the real latches were never touched ------------------------
try { fs.rmSync(SANDBOX, { recursive: true, force: true }) } catch { /* best effort */ }
if (SAVED.localappdata === undefined) delete process.env.LOCALAPPDATA; else process.env.LOCALAPPDATA = SAVED.localappdata
if (SAVED.stopfile === undefined) delete process.env.DSH_COMPUTER_USE_STOP_FILE; else process.env.DSH_COMPUTER_USE_STOP_FILE = SAVED.stopfile

if (failures) {
  console.log(`FAIL test-cycle-open — ${failures} problem(s); self-test ${caught}/${MUTATIONS.length} mutations caught`)
  process.exit(1)
}
console.log(`ok test-cycle-open — ${base.length} invariants: the cycle opens on the CALL that reaches the worker ` +
  `(awaited before the op, once per turn), only the EXITED latch may be cleared and never a brake, and the exit ` +
  `notice quotes the worker's measurement instead of accusing the human (self-test ${caught}/${MUTATIONS.length} mutations caught)`)
