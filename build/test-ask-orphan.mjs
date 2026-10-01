import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SCRATCH = path.join(root, 'build', 'iso-ask-orphan')
// THE SCRATCH DIRECTORY IS CREATED HERE, NOT ASSUMED (2026-10-01). It used to exist only because a
// developer's working tree had it, so a FRESH CLONE failed at the first write with
// `ENOENT ... open 'build/iso-ask-orphan/STOP'` — a guard that cannot run where it is published
// protects nothing. `reset()` removes files, never the directory, so this stays idempotent.
fs.mkdirSync(SCRATCH, { recursive: true })
const STOP = path.join(SCRATCH, 'STOP')
const EXITED = path.join(SCRATCH, 'EXITED')
const AUDIT = path.join(SCRATCH, 'worker-audit.log')
delete process.env.DSH_CU_HOST_PID
delete process.env.DSH_CU_HOST_EXE
const ENV = { ...process.env, DSH_COMPUTER_USE_STOP_FILE: STOP, DSH_COMPUTER_USE_EXIT_FILE: EXITED, DSH_COMPUTER_USE_AUDIT_LOG: AUDIT }
delete ENV.DSH_CU_HOST_PID; delete ENV.DSH_CU_HOST_EXE
const audit = () => { try { return fs.readFileSync(AUDIT, 'utf8') } catch { return '' } }
const stopExists = () => fs.existsSync(STOP)
const reset = () => { for (const f of [STOP, EXITED, AUDIT]) { try { fs.rmSync(f, { force: true }) } catch { /* fine */ } } }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function start (exe) {
  const proc = spawn(exe, [], { env: ENV, stdio: ['pipe', 'pipe', 'pipe'] })
  proc.stdout.setEncoding('utf8')
  proc.stderr.setEncoding('utf8')
  proc.stderr.on('data', () => {})
  const exited = new Promise((resolve) => { proc.on('exit', () => resolve()) })
  return new Promise((resolve, reject) => {
    let buf = ''
    const t = setTimeout(() => reject(new Error('worker ready timeout')), 12_000)
    proc.stdout.on('data', (d) => {
      buf += d
      const nl = buf.indexOf('\n')
      if (nl < 0) return
      try {
        const m = JSON.parse(buf.slice(0, nl).trim())
        if (m.event === 'ready') { clearTimeout(t); resolve({ proc, ready: m, exited }) }
      } catch { /* not the ready line */ }
    })
    proc.on('error', (e) => { clearTimeout(t); reject(e) })
  })
}
/**
 * Stop a worker AND WAIT FOR THE OS TO CONFIRM IT IS GONE (`exit`), never a fixed sleep.
 *
 * A pid that has only been asked to die may still answer `Process.GetProcessById`, and case 2b's
 * whole point is "the asker is gone" — measured the hard way: a fixed 300 ms sleep left the kill
 * unconfirmed and the next worker correctly ADOPTED the still-live asker's brake, which read as a
 * false failure of the sweep.
 */
const stop = async (handle) => {
  try { handle.proc.stdin.end() } catch { /* fine */ }
  try { handle.proc.kill() } catch { /* fine */ }
  await Promise.race([handle.exited, sleep(6000)])
  await sleep(120)
}

async function main () {
  const { discoverWorker } = await import(pathToFileURL(path.join(root, 'lib/core/index.js')).href)
  // THE TARGET IS OVERRIDABLE SO THIS GUARD'S OWN SELF-TEST CAN RUN IT AGAINST ANOTHER BUILD.
  // Without this the guard cannot be turned red at all: `discoverWorker()` ranks the cache by mtime and
  // then PING-VERIFIES each candidate, and the just-compiled worker answers first — measured, by
  // swapping a pre-fix exe into the cache under both a new and an ancient mtime and watching the guard
  // stay green while the pre-fix binary sat at the path it was told to use. A guard whose failure
  // cannot be demonstrated is the thing this repo calls a bug, so the mutation needs a seam: point
  // DSH_CU_TEST_WORKER at the build under test and every case below runs against that one.
  const exe = process.env.DSH_CU_TEST_WORKER || discoverWorker()
  if (!exe) { console.error('FAIL test-ask-orphan — no compiled worker found'); process.exit(1) }
  const failures = []
  const ok = (cond, why) => { if (!cond) failures.push(why) }

  // 1. a DEAD asker (a pid that cannot exist) ⇒ the record is SWEPT
  reset()
  fs.writeFileSync(STOP, 'who deleted the build output?\nsource=agent-ask\naskPid=999999')
  {
    const handle = await start(exe); const { ready } = handle
    ok(ready.stopped === false, `case 1: ready reported stopped=${ready.stopped} — a dead asker's brake was ADOPTED instead of swept (the measured leak: ENGAGE-ASK → ENGAGE-ADOPTED, no RELEASE)`)
    ok(!stopExists(), 'case 1: the STOP file survived startup — the orphan was not swept')
    ok(/ASK-ORPHAN-SWEPT/.test(audit()), 'case 1: no ASK-ORPHAN-SWEPT line — a sweep that leaves no record cannot be told apart from an adoption')
    ok(/999999/.test(audit()), 'case 1: the sweep record does not name the dead pid it swept')
    await stop(handle)
  }

  // 2. a LIVE asker's record ⇒ ADOPTED, never swept
  reset()
  {
    const first = await start(exe)
    const pid = first.ready.pid
    ok(pid > 0, 'case 2: `ready` did not report a pid, so a live asker cannot be simulated')
    fs.writeFileSync(STOP, `a question from a still-running asker\nsource=agent-ask\naskPid=${pid}`)
    // Make the running worker re-read the file through the same path an op uses.
    first.proc.stdin.write(JSON.stringify({ id: 1, op: 'cursor', args: {} }) + '\r\n')
    await sleep(600)
    ok(stopExists(), "case 2: a LIVE asker's brake was deleted — the sweep must never take a brake from a process that can still wait for its answer")
    await stop(first)
    ok(stopExists(), 'case 2: the STOP record vanished when its asker was stopped — the next case would then prove nothing (self-test BUG)')
    ok(audit().includes('ENGAGE-ADOPTED'), 'case 2: the first worker never recorded an adoption of the live asker\'s brake (self-test BUG)')
    // 2b. now that asker is dead ⇒ the NEXT process sweeps the very same record
    const second = await start(exe)
    ok(second.ready.stopped === false && !stopExists(),
      'case 2b: after the asker died the next worker kept its brake — liveness is not what decides the sweep')
    await stop(second)
  }

  // 3. a HUMAN brake ⇒ never swept
  reset()
  fs.writeFileSync(STOP, 'the human pressed ESC and means it')
  {
    const handle = await start(exe); const { ready } = handle
    ok(ready.stopped === true, "case 3: a HUMAN brake was not adopted — refusing to stop on a human's brake is the one direction that must never happen")
    ok(stopExists(), 'case 3: a HUMAN brake was deleted from disk')
    ok(!/ASK-ORPHAN-SWEPT/.test(audit()), 'case 3: the audit claims a human brake was swept')
    await stop(handle)
  }

  // 4. another marker (an agent temporary pause) ⇒ out of scope
  reset()
  fs.writeFileSync(STOP, 'an agent temporary pause\nsource=agent-temporary\npauseId=abc123')
  {
    const handle = await start(exe); const { ready } = handle
    ok(ready.stopped === true, 'case 4: an agent-temporary brake was not adopted')
    ok(stopExists(), 'case 4: an agent-temporary brake was swept — only `source=agent-ask` records are in scope')
    await stop(handle)
  }

  // 5. an agent-ask record from a build that did not mark its asker ⇒ adopted, never guessed at
  reset()
  fs.writeFileSync(STOP, 'a question from a build that did not mark its records\nsource=agent-ask')
  {
    const handle = await start(exe); const { ready } = handle
    ok(ready.stopped === true, 'case 5: an unmarked agent-ask record was not adopted — the pre-merge behaviour for old records is to obey them')
    ok(stopExists(), 'case 5: an unmarked agent-ask record was deleted on a guess')
    await stop(handle)
  }

  // 6. A LIVE ASKER'S BRAKE IS NEITHER SWEPT NOR STOLEN.
  //
  // THIS CASE REPLACES THE WITHDRAWN ONE. An earlier version of this file asserted that the adopter
  // could RELEASE the adopted brake, and it was GREEN — while being blind, because it hardcoded
  // `askId: 1`, the single id a freshly-minted counter happens to match (see
  // blocker1-adopted-brake.md). The second independent audit found that the same code let a LIVE
  // asker's brake be deleted by an unrelated endAsk. The fix was withdrawn; what survives is the
  // property that must hold with or without it: a brake whose asker still answers is LEFT ALONE.
  //
  // The decoy makes the branch reachable in the first place: `TrySweepOrphanAskStop` declines on
  // `PidIsRunning`, so without this case the live-asker path is never exercised at all.
  reset()
  {
    const decoy = spawn(process.execPath, ['-e', 'setTimeout(()=>{},120000)'], { stdio: 'ignore' })
    try {
      await sleep(250)                                    // let the decoy actually be schedulable
      fs.writeFileSync(STOP, `an ask whose asker pid still answers\nsource=agent-ask\naskPid=${decoy.pid}`)
      const handle = await start(exe)
      ok(handle.ready.stopped === true, "case 6: a LIVE asker's brake was not adopted — obeying it is the only safe direction")
      ok(stopExists(), "case 6: a LIVE asker's brake was deleted — the sweep took a brake it must not take")
      // The adopter must NOT be able to end it. This is the brake-stealing regression the second audit
      // found: with ownership taken, an id that is also the adopter's own first-ask id would release a
      // brake whose question is still on a card. Refusal is the correct, safe answer here.
      handle.proc.stdin.write(JSON.stringify({ id: 2, op: 'endAsk', args: { askId: 1, keepPause: false, via: 'test' }, __cycle: true }) + '\r\n')
      let reply = null
      await new Promise((resolve) => {
        let buf = ''
        const t = setTimeout(resolve, 8000)
        handle.proc.stdout.on('data', (d) => {
          buf += d
          for (const line of buf.split('\r\n')) {
            if (!line.trim()) continue
            try { const m = JSON.parse(line); if (m.id === 2) { reply = m; clearTimeout(t); resolve() } } catch { /* partial */ }
          }
        })
      })
      const d = reply && reply.data
      ok(d && d.released === false,
        `case 6: AN endAsk RELEASED A LIVE ASKER'S BRAKE — its question is still on a card, so this deleted a brake the worker had no right to touch (reply: ${JSON.stringify(d)})`)
      ok(stopExists(), "case 6: the LIVE asker's brake is gone from disk — only a dead asker's record may ever be cleared")
      await stop(handle)
    } finally { try { decoy.kill() } catch { /* best effort */ } }
  }

  reset()
  if (failures.length) { console.error('FAIL test-ask-orphan'); for (const f of failures) console.error('  ' + f); console.error('--- audit ---\n' + audit()); process.exit(1) }
  console.log('ok test-ask-orphan — the real compiled worker sweeps an ask brake whose asker is GONE (audit ASK-ORPHAN-SWEPT, naming the pid), leaves a LIVE asker\'s brake alone AND refuses to end it (case 6: taking ownership of it was a brake-stealing regression and was withdrawn), and never touches a human brake, an agent-temporary brake, or an unmarked record from an older build')
}

main().catch((e) => { console.error('FAIL test-ask-orphan — ' + (e && e.stack || e)); process.exit(1) })
