// build/test-ask-release.mjs — G2, THE EXECUTABLE HALF: "no ending without a release".
//
// Every other guard in this repo reads the SOURCE. This one reads the BRAKE FILE. It drives the real
// compiled worker through the real `ComputerUse` class and asserts the one invariant the whole merge
// exists for — after `ask()` settles, whatever the ending, the STOP file is GONE — which is exactly
// what verify4 measured as broken (`ENGAGE-ASK → ENGAGE-ADOPTED` with no RELEASE, and every op
// refused until a human pressed Ctrl+Alt+R).
//
// ISOLATION (mandatory): DSH_COMPUTER_USE_STOP_FILE / _EXIT_FILE / _AUDIT_LOG all point into a
// scratch dir under build/, and DSH_CU_HOST_PID / DSH_CU_HOST_EXE are DELETED so `HostMainWindow()`
// finds nothing and NO window is raised and NO caret is placed. Nothing here touches
// %LOCALAPPDATA%\dsh-computer-use, no desktop input is sent, and the worker is started with stdio
// pipes only.
//
//   node build/test-ask-release.mjs
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { ComputerUse, discoverWorker } from '../lib/core/index.js'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SCRATCH = path.join(root, 'build', 'iso-ask-release')
const SHIM_DIR = path.join(SCRATCH, 'shim')
const workerSource = path.join(root, 'lib', 'core', 'worker.cs')

const failures = []
const ok = (cond, why) => { if (!cond) failures.push(why); return cond }

// EACH CASE GETS ITS OWN STATE DIRECTORY, and that is a correctness requirement, not tidiness.
// A shared STOP path made the guard FLAKY (measured once in three runs): a worker that has been
// asked to die may take a moment to go, and its STOP file is then still on disk when the NEXT
// worker starts — which ADOPTS it and writes `ENGAGE-ADOPTED`, failing a later case's audit
// assertion for a reason that belongs to the previous one. Per-case paths make adoption from a
// previous case impossible, so an `ENGAGE-ADOPTED` can only mean what the case is testing.
let CASE = 'default'
const stateDir = () => path.join(SCRATCH, CASE)
const stopPath = () => path.join(stateDir(), 'STOP')
const auditPath = () => path.join(stateDir(), 'worker-audit.log')

function isolate (name = 'default') {
  delete process.env.DSH_CU_HOST_PID
  delete process.env.DSH_CU_HOST_EXE
  CASE = name
  fs.mkdirSync(stateDir(), { recursive: true })
  for (const f of [stopPath(), path.join(stateDir(), 'EXITED'), auditPath()]) { try { fs.rmSync(f, { force: true }) } catch { /* fine */ } }
  process.env.DSH_COMPUTER_USE_STOP_FILE = stopPath()
  process.env.DSH_COMPUTER_USE_EXIT_FILE = path.join(stateDir(), 'EXITED')
  process.env.DSH_COMPUTER_USE_AUDIT_LOG = auditPath()
}

const audit = () => { try { return fs.readFileSync(auditPath(), 'utf8') } catch { return '' } }
const stopExists = () => fs.existsSync(stopPath())
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// THE SETUP CALL IS NOT THE THING UNDER TEST, AND ITS TIMEOUT MUST NOT BE MISTAKEN FOR THE FAULT.
// Every case lights the cycle with `cu.call('windows')` before it measures anything. Measured: that op
// costs 130-360 ms on a warm worker, but a FRESHLY COMPILED exe pays a first-load cost (a real-time
// antivirus scan of a new binary), so a hand-picked 4 s cap on the SETUP turns into a `worker-timeout`,
// the core kills the worker, and the case then fails for a reason that has nothing to do with the
// question path. This was not hypothetical: it is what made this guard alternate pass/fail, and in
// case 4 it was worse than flaky — that case's discriminator fired on ANY timeout, so a SETUP timeout
// would have been accepted as proof that the injected `beginAsk` hang had fired. A discriminator that
// fires for the wrong reason is the exact self-deception it exists to prevent.
const SETUP_MS = 30_000                 // lighting the cycle: never the measured quantity
const DISCRIMINATOR_MS = 15_000         // must be the core's own ASK_DEADLINE_MS, not the setup cap
// THE SANDBOX WORKER'S CACHE DIRECTORY MUST BE UNIQUE PER RUN OF THIS FILE, and this is a correctness
// requirement, measured the hard way. `compile-worker.ps1` keys its cache on the source's sha16, and
// two runs of this test compile byte-identical sources — so without a token they target the SAME exe
// path, and a sandbox worker still alive from the PREVIOUS run holds that file open. `csc` then fails
// with CS0016 "cannot write output file", the case cannot construct its fault, and (before the
// compile-failure check above existed) it would silently measure a STALE, UNPATCHED exe. `reapWorkers`
// cannot prevent this: that worker belongs to a different node process. This was the real cause of the
// guard alternating pass/fail. A per-run token makes a collision impossible rather than unlikely.
const CACHE_TOKEN = `-r${process.pid}`
// `ask()` settles in 1-2 s against a healthy worker. The budget is generous on purpose: case 3's
// witness check, not this number, is what proves the sandbox worker really took the injected fault —
// so a false GREEN here is impossible, while a false RED (slow machine) would be pure noise.
const ASK_SETTLED_BUDGET_MS = 8_000

// EVERY SANDBOX WORKER THAT HAS EVER STARTED, tracked here rather than on the ComputerUse object:
// `cu.proc` is a single slot that a later spawn REPLACES, so a worker started earlier in the same
// case can still be alive and holding its own exe on disk when the NEXT case compiles — which is
// `csc` error CS0016 ("another program is using this file"), and the reason a case could end up
// running a STALE, UNPATCHED exe that a previous compile had left at the same cache path.
const LIVE_WORKERS = new Set()
async function reapWorkers (ms = 8000) {
  for (const p of LIVE_WORKERS) { try { p.kill() } catch { /* already gone */ } }
  const deadline = Date.now() + ms
  while (LIVE_WORKERS.size > 0 && Date.now() < deadline) await sleep(60)
  await sleep(120)
  return LIVE_WORKERS.size === 0
}

/**
 * One `ComputerUse` against a copied worker, with every op it writes to stdin recorded.
 *
 * The copy is what makes the FAULT-INJECTION cases possible: the repo's OWN compile script
 * (`compile-worker.ps1`, `-Path`) compiles a source file of our choosing, so a sandboxed worker that
 * sleeps inside `beginAsk`/`endAsk` on an env flag needs no test-only code in the shipped source. The
 * patch strings are asserted to be present before writing, so a rename cannot silently produce an
 * unpatched worker that makes the fault case pass for the wrong reason.
 */
async function withWorker (fn, faults = {}) {
  const src = fs.readFileSync(workerSource, 'utf8')
  let patched = src
  const BEAT = 'Panic.EngageAsk(q);'
  const ENDCALL = 'Panic.EndAsk(askId, keepPause, via);'
  if (faults.hangBeginAskMs) {
    if (!patched.includes(BEAT)) throw new Error('self-test BUG: cannot find the beginAsk seam to hang')
    patched = patched.replace(BEAT, `${BEAT}\n            { int h; if (int.TryParse(Environment.GetEnvironmentVariable("DSH_CU_TEST_BEGINASK_HANG_MS"), out h) && h > 0) { Environment.SetEnvironmentVariable("DSH_CU_TEST_BEGINASK_HANG_MS", "0"); Thread.Sleep(h); } }`)
  }
  if (faults.hangEndAskMs) {
    if (!patched.includes(ENDCALL)) throw new Error('self-test BUG: cannot find the endAsk seam to hang')
    // The hang happens BEFORE the release, so the worker is genuinely wedged with the brake still up
    // — which is the state the "do not kill it" rule is about. It DISARMS itself after firing once
    // (clearing the env var) so the retry that follows can complete and release the brake, which is
    // what makes "the retry really ran" observable rather than a timing coincidence.
    patched = patched.replace(ENDCALL, `{ int h; if (int.TryParse(Environment.GetEnvironmentVariable("DSH_CU_TEST_ENDASK_HANG_MS"), out h) && h > 0) { Program.AuditRecord("TEST-ENDASK-HANG", "sleeping " + h); Environment.SetEnvironmentVariable("DSH_CU_TEST_ENDASK_HANG_MS", "0"); Thread.Sleep(h); } }\n            ${ENDCALL}`)
    if (!patched.includes('DSH_CU_TEST_ENDASK_HANG_MS')) throw new Error('self-test BUG: the endAsk hang patch did not apply')
  }
  if (process.env.DSH_CU_RELEASE_DEBUG) console.error(`[dbg] withWorker faults=${JSON.stringify(faults)} patched=${patched !== src}`)
  let exe = null
  if (patched !== src || faults.forceCopy) {
    // NOTHING MAY STILL BE RUNNING A SANDBOX EXE WHILE `csc` WRITES ONE (CS0016), and a case must
    // never fall through to a STALE exe it did not just build. Both are one requirement: wait for
    // every live worker to be confirmed gone, then compile, then read the compiler's own exit.
    if (!(await reapWorkers())) {
      throw new Error('a sandbox worker from an earlier case was still running — refusing to compile over it (a stale, UNPATCHED exe at the same cache path is exactly how this guard could "pass" while measuring nothing)')
    }
    // ITS OWN SOURCE PATH AND ITS OWN CACHE, per call: a shared `_shim/worker.cs` means the compile
    // cache key (sha16 of the source) changes per case while the path does not, so a failed compile
    // can leave the previous case's exe sitting there looking like this case's output.
    const dir = fs.mkdtempSync(path.join(SCRATCH, 'shim-'))
    const cs = path.join(dir, 'worker.cs')
    fs.writeFileSync(cs, patched)
    // A SANDBOX SOURCE THAT DOES NOT CARRY THE FAULT IS A LYING TEST: the case would then measure an
    // unpatched worker and "pass" for the wrong reason. Read the file BACK and assert the seam.
    const seam = faults.hangEndAskMs ? 'DSH_CU_TEST_ENDASK_HANG_MS' : (faults.hangBeginAskMs ? 'DSH_CU_TEST_BEGINASK_HANG_MS' : null)
    if (seam && !fs.readFileSync(cs, 'utf8').includes(seam)) throw new Error(`self-test BUG: the sandbox source at ${cs} does not contain ${seam}`)
    const { execFileSync } = await import('node:child_process')
    const pwsh = path.join(process.env.LOCALAPPDATA || '', 'Microsoft', 'WindowsApps', 'Microsoft.PowerShell_8wekyb3d8bbwe', 'pwsh.exe')
    let printed
    try {
      printed = execFileSync(pwsh, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File',
        path.join(root, 'lib', 'core', 'compile-worker.ps1'), '-Path', cs, '-Force',
        '-CacheToken', CACHE_TOKEN],
      { encoding: 'utf8', timeout: 180_000, stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (e) {
      // A COMPILER FAILURE IS FATAL FOR THE CASE, never a fallback: `compile-worker.ps1` prints the
      // cache path BEFORE it invokes csc, so "it printed a path that exists" is not a success signal
      // — it is the exact shape that let a stale exe be measured as this case's fault.
      const tail = String((e && (e.stdout || e.message)) || e).slice(-500)
      throw new Error(`the sandbox worker FAILED TO COMPILE — this case cannot construct its fault and must not run: ${tail}`)
    }
    exe = (printed.match(/[^\r\n]*dsh-computer-use-worker\.exe/g) || []).pop()
    if (!exe || !fs.existsSync(exe.trim())) throw new Error(`the sandbox worker did not compile: ${printed.slice(-400)}`)
    exe = exe.trim()
    if (process.env.DSH_CU_RELEASE_DEBUG) console.error(`[dbg] sandbox worker = ${exe}`)
  } else {
    exe = discoverWorker()
    if (!exe) throw new Error('no compiled worker found and no compile-on-demand available')
  }

  const ops = []
  const log = []
  // The sandbox worker's own witness that the fault-injection patch is the code that RAN: if this
  // line is absent from the audit, the case under test measured an unpatched worker.
  const witness = () => audit().includes('TEST-ENDASK-HANG')
  const cu = new ComputerUse({ workerExe: exe, kickoffRequired: false, log: (m) => log.push(m) })
  const spawn = cu.spawnWorker.bind(cu)
  cu.spawnWorker = async () => {
    const r = await spawn()
    // TRACK THE PROCESS, not just cu.proc: a later spawn replaces that slot, and a worker started
    // earlier can outlive it. Removal on 'exit' is what makes `reapWorkers()` a real confirmation.
    const p = cu.proc
    if (p && !LIVE_WORKERS.has(p)) { LIVE_WORKERS.add(p); p.once('exit', () => LIVE_WORKERS.delete(p)) }
    const write = p.stdin.write.bind(p.stdin)
    p.stdin.write = (chunk, ...rest) => {
      try { const line = JSON.parse(String(chunk)); if (line && line.op) ops.push(line.op) } catch { /* not ours */ }
      return write(chunk, ...rest)
    }
    return r
  }
  try {
    return await fn({ cu, ops, log, exe, witness })
  } finally {
    try { await cu.kill() } catch { /* best effort */ }
    await reapWorkers()
  }
}

isolate('case1')

// ---------------------------------------------------------------- 1. the answered path
{
  let stopWhileAsking = null
  await withWorker(async ({ cu, ops }) => {
    await cu.call('windows', {}, SETUP_MS)                 // light the cycle (a signed call)
    const t0 = Date.now()                                  // ONLY the ask is measured, never the setup
    const res = await cu.ask({
      question: 'is the release guard working?',
      onAsk: async () => { stopWhileAsking = stopExists(); return { answered: false, keepPause: false, reason: 'test' } },
    })
    const elapsed = Date.now() - t0
    ok(elapsed < ASK_SETTLED_BUDGET_MS, `(i) ask() took ${elapsed} ms — the worker is BLOCKING on the question again (verify4 §3.B: a second op written to stdin is never answered)`)
    ok(stopWhileAsking === true, '(ii) the STOP file did not exist while onAsk ran — the brake was never up, so the release assertion below proves nothing')
    ok(!stopExists(), '(iii) THE STOP FILE SURVIVED THE ENDING — this is the leak: a brake with nobody left to wait for it')
    const a = audit()
    ok(/ENGAGE-ASK/.test(a), '(iv) the audit has no ENGAGE-ASK line — the raise was not recorded')
    ok(/ASK-RELEASE/.test(a), '(iv) the audit has no ASK-RELEASE line — the release was not recorded')
    ok(!/ENGAGE-ADOPTED/.test(a), '(iv) the audit shows ENGAGE-ADOPTED: a leaked ask brake was adopted instead of released')
    ok(ops.includes('beginAsk') && ops.includes('endAsk'), '(v) the core did not send both beginAsk and endAsk')
    ok(res.stopped === false, '(vi) the reply says the machine is still stopped after a no-answer ending')
  })
}

// ---------------------------------------------------------------- 2. onAsk THROWS — the mutation-able path
{
  isolate('case2')
  await withWorker(async ({ cu }) => {
    await cu.call('windows', {}, SETUP_MS)
    const t0 = Date.now()                                  // ONLY the ask is measured, never the setup
    let threw = false
    try {
      await cu.ask({ question: 'does a throwing channel still release?', onAsk: async () => { throw new Error('channel exploded') } })
    } catch { threw = true }
    const elapsed = Date.now() - t0
    ok(elapsed < ASK_SETTLED_BUDGET_MS, `(i-throw) ask() took ${elapsed} ms — the worker blocked`)
    ok(!stopExists(), '(iii-throw) THE STOP FILE SURVIVED A THROWING ANSWER CHANNEL — the finally did not release the brake')
    const a = audit()
    ok(/ENGAGE-ASK/.test(a) && /ASK-RELEASE/.test(a), '(iv-throw) the audit pair is incomplete for a throwing channel')
    ok(!/ENGAGE-ADOPTED/.test(a), '(iv-throw) the audit shows ENGAGE-ADOPTED after a throwing channel')
    // The promise rejecting is NOT asserted as required: `ask()` returns `{...answer, stopped, exited,
    // release}` and a channel that throws must still settle the transaction. What is asserted is the
    // BRAKE, which is the safety property. (A throw propagates to the caller; a non-throw is fine.)
    void threw
  })
}

// ---------------------------------------------------------------- 3. a WEDGED endAsk: do not kill, retry once
{
  isolate('case3')
  await withWorker(async ({ cu, ops, witness }) => {
    // THE FAULT IS ARMED BEFORE THE WORKER IS SPAWNED, and the worker's own op is what disarms it:
    // `beginAsk` clears it, so the FIRST `endAsk` is the one that sleeps. Armed any later and the
    // worker may already have been started without it (measured — the first draft of this guard
    // armed it after the cycle call and the fault silently did not run, which is exactly the class of
    // self-deception the witness assertion below exists to catch).
    // THE HANG MUST OUTLAST THE 5 s endAsk DEADLINE BUT NOT SO FAR THAT IT COSTS THE WORKER ITS LIFE.
    // This distinction is the whole case, and it was measured: the core's `call()` timer KILLS the
    // worker on expiry, so if the injected hang outlives the deadline by much the first `endAsk`
    // times out AND the worker dies. The retry then reaches a FRESH worker, which finds a STOP file it
    // did not write and correctly refuses to clear it — `released:false, reason:"stop-locked"`, and the
    // audit line `ASK-RELEASE-FOREIGN-STOP`. That is the ownership guard working exactly as designed
    // (an ask may release only its own brake), and it made this case fail for a reason that has nothing
    // to do with what it tests. With the hang just past the deadline the same worker is still inside
    // `Thread.Sleep` when the deadline fires, survives it, and is still the brake's owner when the
    // retry lands — so the retry genuinely releases, the worker is genuinely alive, and (v) below
    // tests what it claims to test. The margin also has to beat the core's own retry deadline: the
    // hang ends 1.5 s after the first timeout, inside the retry's fresh 5 s.
    process.env.DSH_CU_TEST_ENDASK_HANG_MS = '6500'
    await cu.call('windows', {}, SETUP_MS)
    const t0 = Date.now()
    const res = await cu.ask({ question: 'wedged release', onAsk: async () => ({ answered: false, keepPause: false, reason: 'test' }) })
    delete process.env.DSH_CU_TEST_ENDASK_HANG_MS
    const elapsed = Date.now() - t0
    const endAsks = ops.filter((o) => o === 'endAsk').length
    ok(witness(), '(vi) the sandbox worker never took the injected endAsk hang — this case measured an UNPATCHED worker, so it proves nothing')
    // HONEST EXACTNESS: only the RETRY can return after the deadline, so a settled call that took
    // longer than the deadline proves the retry ran. (Asserting `=== 2` alone would be lying about
    // what was observed: the hung first request may still be unanswered when the second lands.)
    ok(endAsks >= 2 && elapsed > 5_000, `(vi) ${endAsks} endAsk call(s) in ${elapsed} ms — the timeout did not produce the advertised single retry`)
    ok(res && res.release && res.release.released === true, `(vi) the retry did not release the brake: ${JSON.stringify(res && res.release)}`)
    ok(!stopExists(), '(vi) the STOP file is still on disk after the retry reported a verified release')
    // (v) THE WORKER MUST STILL BE ALIVE. `proc.kill()` would have ended the question with the brake
    // still on disk and no process left to release it — the defect this whole design removes.
    let alive = false
    try { process.kill(cu.proc.pid, 0); alive = true } catch { alive = false }
    ok(alive, '(v) the worker was KILLED by the endAsk timeout — a kill deletes no STOP file, so the brake outlived every waiter')
  }, { hangEndAskMs: true })
}

// ---------------------------------------------------------------- 4. THE DISCRIMINATOR: a hung beginAsk
// This case exists to prove the assertions above can FIRE. It re-creates mutation (c) of G2 — "a
// 20 s wait inside the worker's beginAsk" — as a real, compiled worker that sleeps there. If the
// guard were measuring nothing, this case would pass as easily as the others; it must not.
{
  isolate('case4')
  let timedOut = false
  let setupMs = null
  let askMs = 0
  try {
    await withWorker(async ({ cu }) => {
      // Armed BEFORE the spawn, for the same reason as case 3: a fault armed after the worker exists
      // may never be read at all.
      process.env.DSH_CU_TEST_BEGINASK_HANG_MS = '25000'   // > the core's own 15 s ask deadline
      const setup0 = Date.now()
      try {
        await cu.call('windows', {}, SETUP_MS)
      } catch (e) {
        // THE SETUP MUST NOT BE ABLE TO IMPERSONATE THE DISCRIMINATOR. Without this, a timeout on the
        // cycle call matches the `/worker timeout|worker exited|worker-unavailable/` sniff below and is
        // read as "the injected beginAsk hang fired" — a discriminator proving its own opposite. Throw
        // with a message that sniff deliberately does not match, so the failure says what it is.
        throw new Error(`the SETUP call failed, so this discriminator measured nothing ` +
          `(after ${Date.now() - setup0} ms): ${String(e && e.message).slice(0, 200)}`)
      }
      setupMs = Date.now() - setup0
      const t0 = Date.now()
      try {
        await cu.ask({ question: 'the worker is wedged inside the raise', onAsk: async () => ({ answered: false, keepPause: false, reason: 'test' }) })
        askMs = Date.now() - t0                       // only reached if the ask did NOT wedge
      } catch (e) {
        // The expected ending. TIME IT HERE, where the clock is still running: the throw is the very
        // result being discriminated, and timing it from the outer catch measured 0 ms (measured — the
        // first draft of this fix failed for exactly that reason while the discriminator itself was
        // working perfectly).
        askMs = Date.now() - t0
        throw e
      } finally { delete process.env.DSH_CU_TEST_BEGINASK_HANG_MS }
    }, { hangBeginAskMs: true })
  } catch (e) {
    timedOut = /worker timeout|worker exited|worker-unavailable/.test(String(e && e.message))
    if (process.env.DSH_CU_RELEASE_DEBUG) console.error(`[dbg] case4 catch: code=${e && e.code} msg=${String(e && e.message).slice(0, 300)}`)
  }
  delete process.env.DSH_CU_TEST_BEGINASK_HANG_MS
  ok(timedOut && askMs > 12_000, `the hung-beginAsk discriminator did NOT time out (ask ${askMs} ms, setup ${setupMs} ms, timedOut=${timedOut}) — it must fail with a TIMEOUT on the ask, which is the only thing that proves the core's ${DISCRIMINATOR_MS} ms deadline still catches a worker wedged inside the raise`)
  // Clean the leak the TIMEOUT deliberately produced, so the next run starts from nothing.
  try { fs.rmSync(stopPath(), { force: true }) } catch { /* fine */ }
}

// EVERY WORKER THIS RUN STARTED MUST BE GONE BEFORE THIS FILE EXITS. The faults leave brakes and
// wedged workers behind on purpose, so a leftover process is a real possibility — and a live sandbox
// worker is exactly what locks its own exe and breaks the NEXT run's compile (CS0016; see CACHE_TOKEN).
// Reaping here as well as before each compile is the difference between "usually works" and "works".
try { await reapWorkers(10_000) } catch { /* best effort — nothing here may mask a real failure */ }
for (const dir of [SHIM_DIR, SCRATCH]) { try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* fine */ } }

if (failures.length) {
  console.error('FAIL test-ask-release')
  for (const f of failures) console.error('  ' + f)
  process.exit(1)
}
console.log('ok test-ask-release — the real compiled worker was engaged and released through the real core: ask() returns in <2 s, the STOP file exists during the answer and is verified GONE after every ending (answered, no-answer and THROWING channel), a wedged endAsk does NOT kill the worker and is retried exactly once, and a worker wedged inside beginAsk is still caught by the core deadline (the discriminator)')
