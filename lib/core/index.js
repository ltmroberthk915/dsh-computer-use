// @dsh/computer-use-core — capability layer (stage-0)
//
// Owns the native worker lifecycle and exposes an ergonomic JS API over it.
// Both transports (MCP server, DSH Cordis plugin) are thin shells over this
// module. Zero npm dependencies by design: the plugin must survive hostile
// npm environments (offline install, hardened caches).
//
// Worker protocol: NDJSON over stdio — one {"op","args"} per line in,
// one {"id","ok","data"|"error"} per line out. First line out is the
// {"event":"ready"} announcement.

import { spawn, execFileSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { AsyncLocalStorage } from 'node:async_hooks'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { prepareNativeBinary, workerReferences, nativeRuntimeIdentity } from './native-runtime.js'
import { parseKeyCommand } from '../key-command.js'
import { verificationRegion } from '../verification-region.js'

const __dirname = fileURLToPath(new URL('.', import.meta.url))

const DEFAULT_TIMEOUT_MS = 15_000
const CAPTURE_TIMEOUT_MS = 30_000
const INPUT_CLEANUP_GRACE_MS = 1500
// A UIA tree walk can block the resident's synchronous COM thread. Bound the
// caller's wait separately from recovery of a worker that never returns.
const UIA_READS = new Set(['uia', 'uiaFromPoint', 'uiaFocused'])
const URGENT_CONTROL = new Set(['cancelInput', 'abort', 'panic', 'exit', 'endAsk'])
const INPUT_OPS = new Set(['click', 'shiftClick', 'move', 'drag', 'scroll', 'selectRange',
  'type', 'key', 'uiaAct', 'windowOp', 'activate', 'clipWrite', 'calibrate', 'selftest'])
const isInputOp = (op, args = {}) => INPUT_OPS.has(op) || (op === 'focus' && args.refocus === true)
// THE CORE'S ASK DEADLINE, AND IT IS A BARE LITERAL ON PURPOSE (merge-design.md §3, §3.2).
//
// It bounds ONE thing: a wedged worker inside `beginAsk`'s raise sequence (a hung UIA provider), or
// inside `endAsk`'s two file operations. It does NOT bound the wait for a human — there is nothing
// left to bound, because the worker no longer waits at all and the client-UI card has no countdown.
//
// It must never be DERIVED from the tool's timeoutMs. The defect this replaces was exactly that
// coupling: the old call was `this.call('ask', …, (opts.timeoutMs ?? 5000) + 10_000)`, so for every
// tool timeout below 65 s the CORE killed the worker BEFORE the tool's own deadline could fire. The
// measured incident (verify4, 15.58 s and the review's 15 s): `worker timeout: ask (15000ms) —
// worker killed` while the answer was still pending, leaving the STOP file behind with nobody left
// to wait for it (ENGAGE-ASK → ENGAGE-ADOPTED, no RELEASE). Ordering that must hold:
//
//     tool deadline 3_600_000 ms  >  core ask deadline 15_000 ms  >  core endAsk deadline 5_000 ms
//
// Guard G3 asserts the ordering AND that neither number is computed from the other.
const ASK_DEADLINE_MS = 15_000
/** The release is two file operations; if it exceeds this the worker is wedged. */
const END_ASK_DEADLINE_MS = 5_000
export function workerCallError (message, code, op, requestId, outcome = 'unknown') {
  return Object.assign(new Error(`${message} [${code}; outcome=${outcome}]. ${outcome === 'unknown' ? 'Inspect current state before retrying a write.' : 'No input was dispatched by this operation.'}`),
    { code, op, requestId, outcome, detail: message })
}

/** A handoff interrupts an input operation, never the authorized task. */
export function humanContinuation (error = {}) {
  return {
    required: true,
    taskStatus: 'continuing',
    handback: 'received',
    nextAction: 'observe-current-target-then-continue-original-task',
    replayInterruptedInput: false,
    interruptedOperation: error.op || null,
    requestId: error.requestId ?? null,
    outcome: error.outcome === 'not-dispatched' ? 'not-dispatched' : 'unknown',
    instruction: 'Temporary input interruption only. Control has been handed back. You MUST immediately obtain fresh target evidence, verify any partial effect, and continue the original authorized task from its unfinished step until complete. Do not abandon the task, issue a final wrap-up, or ask for permission to continue because of this handoff. Never blindly replay an interrupted write. Explicit user cancellation, manual pause, or exit still takes precedence.',
  }
}

function humanReobserveError (error = {}) {
  const continuation = humanContinuation(error)
  return Object.assign(workerCallError(continuation.instruction, 'HUMAN_REOBSERVE',
    continuation.interruptedOperation, continuation.requestId, continuation.outcome),
  { transient: true, taskStatus: 'continuing', continuation })
}

function workerReobserveError (workerGeneration, interrupted = {}) {
  const outcome = interrupted.outcome === 'unknown' ? 'unknown' : 'not-dispatched'
  const continuation = {
    required: true, taskStatus: 'continuing', reason: 'worker-restarted',
    nextAction: 'observe-current-target-then-continue-original-task',
    replayInterruptedInput: false, outcome, workerGeneration,
    interruptedOperation: interrupted.op || null, requestId: interrupted.requestId ?? null,
    instruction: 'The native worker restarted and previous desktop evidence is invalid. Obtain fresh target evidence, inspect any interrupted operation, and continue the original authorized task. This is worker recovery, not a human handback or permission to replay a write.',
  }
  return Object.assign(workerCallError(continuation.instruction, 'WORKER_REOBSERVE', continuation.interruptedOperation, continuation.requestId, outcome),
    { transient: true, taskStatus: 'continuing', continuation })
}

/** Interactive roles that receive Set-of-Marks labels. */
const SOM_ROLES = new Set([
  'Button', 'MenuItem', 'ListItem', 'TreeItem', 'DataItem', 'TabItem',
  'Hyperlink', 'CheckBox', 'RadioButton', 'ComboBox', 'Edit', 'Spinner',
  'Slider', 'Thumb', 'ScrollBar', 'Custom', 'Pane',
])
const SOM_PATTERNS = /(Invoke|SelectionItem|Toggle|ExpandCollapse|Value|RangeValue|ScrollItem|GridItem)/

export class ComputerUse extends EventEmitter {
  /**
   * @param {object} [opts]
   * @param {string} [opts.workerExe] explicit worker path; discovered otherwise
   * @param {(msg: string) => void} [opts.log]
   */
  constructor (opts = {}) {
    super()
    this.workerExe = opts.workerExe || null
    this.log = opts.log || (() => {})
    this.proc = null
    this.seq = 0
    this.pending = new Map() // id -> {resolve, reject, timer}
    this.ready = false
    this.lastMarks = []      // [{id, x, y, w, h, name, role, center:[cx,cy]}]
    this.lastRegion = null   // capture region the marks refer to
    this.lastScale = 1       // screenshot px per screen px (<1 when downscaled)
    // safety knobs (sandraschi SAFETY.md four-piece: HITL + kill switch +
    // rate limit + audit; see DESIGN §8)
    this.dryRun = opts.dryRun ?? false          // simulate actuations, log only
    this.kickoffRequired = opts.kickoffRequired !== false // pure observation must not require focusing
    this.rateLimit = opts.rateLimit ?? { max: 60, windowMs: 60_000 }
    this.rateWindow = []
    this.humanApproved = opts.autoApprove ?? false // gate for mutating ops
    this.stopped = false         // true while the human's brake is engaged (see 'panic' event)
    this.exited = false          // true once the human ended the session (see 'exit' event)
    this.cooperation = { phase: 'idle', active: false, revision: 0 }
    this.workerGeneration = null
    this.nativeStateSeq = -1
    this.workerStateInvalid = false
    this.runtime = null
    this.inputCleanupGraceMs = INPUT_CLEANUP_GRACE_MS
    this.shutdownGraceMs = INPUT_CLEANUP_GRACE_MS
    this.activeActions = new Map()
    this.inputContext = new AsyncLocalStorage()
    // Monotonic counter of UNSOLICITED state transitions (panic/ask/resume/exit). Anything that
    // learns the machine's state asynchronously — above all the `ask` op, which can take seconds and
    // reports how it ended — captures this before the call and re-checks it after: a reply that
    // describes a state older than the newest event must never overwrite it (F2).
    this.stateSeq = 0
    this.lastMarks = []          // [{id, x, y, w, h, name, role, center:[cx,cy]}]
    this.maps = new Map()        // hwnd -> {marks, sig, ts, title} landmark cache
    this.markSequence = 0
    this.lastMarkFrame = null
    this.onWorkerExit = this.onWorkerExit.bind(this)
  }

  // ---------------- worker plumbing ----------------
  // single-flight: screenState fires 3 parallel calls (windows/cursor/uia) and
  // naive guards used to spawn 3 workers, overwriting this.proc and leaking
  // the rest — every caller must await the SAME in-flight spawn
  ensureWorker () {
    if (this.proc && this.ready) return Promise.resolve()
    if (this._ensuring) return this._ensuring
    const p = this.spawnWorker().finally(() => { if (this._ensuring === p) this._ensuring = null })
    this._ensuring = p
    return p
  }

  spawnWorker () {
    if (!this.workerExe || !existsSync(this.workerExe)) {
      // Prefer the verified prebuilt helper; source checkouts use Windows csc.
      this.workerExe = compileWorkerSync(this.log)
    }
    // Host guard: this core runs INSIDE the DSH host process, so process.pid IS the host pid -
    // but the window a human interacts with belongs to a DIFFERENT process of the same Electron
    // app (main vs renderer/GPU), so the worker is also given the executable path, which
    // recognises every process of the app at once. The worker refuses to drive any window of
    // either; one-shot CLI runs (no env) keep the guard disabled.
    this.spawnRuntime = nativeRuntimeIdentity(this.workerExe)
    const env = { ...process.env, DSH_CU_HOST_PID: String(process.pid), DSH_CU_HOST_EXE: process.execPath || '',
      DSH_CU_PACKAGE_VERSION: this.spawnRuntime.packageVersion, DSH_CU_BUILD_ID: this.spawnRuntime.buildId,
      DSH_CU_SOURCE_HASH: this.spawnRuntime.sourceHash || '', DSH_CU_BINARY_HASH: this.spawnRuntime.binaryHash }
    this.log(`[core] host guard armed for pid ${process.pid} (${process.execPath})`)
    this.proc = spawn(this.workerExe, [], { env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
    // A CHILD THAT FAILS TO START MUST NAME ITSELF (2026-09-13). Every computer_* tool died with a
    // bare `Error: spawn UNKNOWN` — no path, no syscall, no Windows code — because NOTHING listened
    // for this child's 'error' event: an unhandled 'error' on an EventEmitter is thrown, so the rich
    // error object (which names the file Windows refused) was discarded on the way out.
    const child = this.proc
    this.proc.on('error', (e) => {
      let file = '?'
      try { file = `${existsSync(this.workerExe)} exists, ${statSync(this.workerExe).size} bytes` } catch { file = 'stat failed' }
      this.log(`[core] WORKER SPAWN FAILED: code=${e.code} errno=${e.errno} syscall=${e.syscall} ` +
        `exe=${this.workerExe} (${file})`)
      this.spawnError = e
    })
    this.proc.stdin.on('error', (e) => this.log(`[worker:stdin] ${e.message}`))
    this.proc.stdout.setEncoding('utf8')
    let buf = ''
    this.proc.stdout.on('data', (chunk) => {
      buf += chunk
      let nl
      while ((nl = buf.indexOf('\r\n')) >= 0) {
        const line = buf.slice(0, nl).trim()
        buf = buf.slice(nl + 1)
        if (!line) continue
        if (this.proc === child) this.onLine(line)
      }
    })
    this.proc.stderr.on('data', (d) => this.log(`[worker:stderr] ${d}`))
    this.proc.on('exit', (code) => { if (this.proc === child) this.onWorkerExit(code) })
    return new Promise((resolve, reject) => {
      const finish = (error) => {
        clearTimeout(t)
        this.off('ready', ready); this.off('dead', dead); this.off('worker-incompatible', incompatible)
        child.off('error', failed)
        if (error) reject(error); else resolve()
      }
      const ready = () => finish()
      const dead = code => finish(new Error(`worker died at startup (code ${code})`))
      const incompatible = error => finish(error)
      const failed = e => finish(new Error(`worker could not be started: code=${e.code} syscall=${e.syscall} path=${e.path || this.workerExe}`))
      const t = setTimeout(() => {
        finish(new Error('worker ready timeout'))
        try { if (this.proc === child) child.kill() } catch { /* already gone */ }
      }, 10_000)
      // surface the real reason instead of letting the raw emitter error escape
      child.once('error', failed)
      this.once('ready', ready); this.once('dead', dead); this.once('worker-incompatible', incompatible)
    })
  }

  onWorkerExit (code) {
    this.ready = false
    this.proc = null
    this.workerStateInvalid = true
    this.cooperation = { phase: 'unknown', active: false, revision: 0, valid: false, workerGeneration: this.workerGeneration }
    this.maps.clear(); this.lastMarks = []; this.lastMarkFrame = null
    this.finishUiaRead(false)
    for (const [id, p] of this.pending) { clearTimeout(p.timer); p.cleanup?.(); p.reject(Object.assign(workerCallError('worker exited', 'worker-exited', p.op, id), { workerGeneration: p.workerGeneration, cleanup: { cleanupConfirmed: false, cleanupState: 'worker-exited' } })) }
    this.pending.clear()
    this.emit('dead', code)
  }

  onLine (line) {
    let msg
    try { msg = JSON.parse(line) } catch { this.log(`[worker:badline] ${line.slice(0, 200)}`); return }
    if (msg.event === 'ready') {
      // Production spawns must speak the ordered protocol. An old custom binary
      // cannot safely participate in cancellation or generation-aware recovery.
      if (this.spawnRuntime && (msg.protocolVersion !== 2 || typeof msg.workerGeneration !== 'string' ||
          !msg.workerGeneration || !Number.isSafeInteger(msg.cooperation?.stateSeq) ||
          msg.cooperation.workerGeneration !== msg.workerGeneration)) {
        this.ready = false; this.workerStateInvalid = true
        this.emit('worker-incompatible', workerCallError('native worker protocol is incompatible; reinstall or rebuild the current helper',
          'WORKER_PROTOCOL_INCOMPATIBLE', null, null, 'not-dispatched'))
        try { this.proc?.kill() } catch { /* already gone */ }
        return
      }
      this.ready = true
      // COLD-START STATE SYNC (cold-start bug, 2026-09-13): the worker has already adopted any STOP
      // or EXITED record that predates this process, and it reports that state with `ready`. Without
      // this the core started from "not stopped" while the machine was stopped — measured: core
      // stopped=false/exited=false while native said engaged/stopped=true and the light was wrong.
      // This is NOT a fake key press: no event is emitted, nothing is announced and nothing is
      // released — the mirror simply starts out agreeing with the machine.
      if (typeof msg.stopped === 'boolean') this.stopped = msg.stopped
      if (typeof msg.exited === 'boolean') this.exited = msg.exited
      this.workerGeneration = msg.workerGeneration || msg.runtime?.workerGeneration || msg.cooperation?.workerGeneration || null
      this.nativeStateSeq = -1
      this.runtime = this.spawnRuntime ? { ...this.spawnRuntime, ...msg.runtime, workerGeneration: this.workerGeneration } : msg.runtime || null
      this.cooperation = { phase: 'idle', active: false, revision: 0 }
      this.workerStateInvalid = false
      if (msg.cooperation) this.syncCooperation(msg.cooperation, false)
      this.maps.clear(); this.lastMarks = []; this.lastMarkFrame = null
      this.emit('ready', msg)
      return
    }
    // stdout from a replaced child is already filtered; generation also guards
    // protocol-level delayed events and records restored by an observer.
    const generation = msg.workerGeneration || msg.cooperation?.workerGeneration || msg.data?.cooperation?.workerGeneration
    if (generation && this.workerGeneration && generation !== this.workerGeneration) return
    if (msg.event === 'handoff') {
      this.syncCooperation(msg.cooperation)
      return
    }
    // Secure-desktop transitions (UAC prompt / lock screen, human request 2026-11-04): the
    // worker refuses to dispatch while it stands and clears it the moment the normal desktop
    // returns. Mirror the state so callers can show it, and let the plugin notify the human.
    if (msg.event === 'secure') {
      this.secureDesktop = msg.why === 'active'
      this.emit('secure', msg)
      return
    }
    // Durable brake events are separate from automatic physical-input handoff.
    //   panic  — ESC: the human ABORTED. The machine is stopped; wrap up briefly, then wait.
    //   resume — Ctrl+Alt+R: work may continue (a PAUSE ends; it never ends the cycle).
    //   ask    — the agent asked a question: the machine is PAUSED inside a LIVE cycle for as long
    //            as the answer takes. It is NOT an exit, and the worker holds `_engaged`/STOP while
    //            the question is open — so the mirror is stopped=true, exited UNCHANGED. (A single
    //            shared branch used to make this `exited=true, stopped=false`: two lies at once, and
    //            both of those flags are read by the plugin's cycle gate.)
    //   exit   — Ctrl+Alt+Q: the human ENDED the session. Stop the turn outright, stop streaming.
    if (msg.event === 'panic' || msg.event === 'resume' || msg.event === 'exit' || msg.event === 'ask') {
      if (msg.event === 'panic') this.stopped = true
      else if (msg.event === 'resume') this.stopped = false
      else if (msg.event === 'ask') this.stopped = true
      else { this.stopped = false; this.exited = true }
      // MY OWN ask is not an "external" state change (2026-09-13, Codex review): the worker notifies
      // `ask` from EngageAsk, i.e. while this caller is inside its OWN `ask()` — between `beginAsk`
      // and the answer — so counting it as a change would make the core discard its own reply and
      // leave the mirror disagreeing with the machine. Only changes OTHER than the one this request
      // caused may invalidate its reply. (The merge did not change this: `beginAsk` still raises the
      // brake and still notifies once; what went away is the worker-side WAIT, not the event.)
      if (msg.event === 'ask' && this._askOpen) this._askOpen.own++
      this.stateSeq++
      this.emit(msg.event, msg)
      return
    }
    if (this.uiaRead?.id === msg.id) this.finishUiaRead(true)
    const p = this.pending.get(msg.id)
    if (!p) return
    this.pending.delete(msg.id)
    clearTimeout(p.timer)
    p.cleanup?.()
    if (msg.data?.cooperation) this.syncCooperation(msg.data.cooperation)
    if (msg.ok) p.resolve(msg.data)
    else {
      const error = workerCallError(msg.error || 'worker error', msg.code || 'worker-refusal-or-error', p.op, msg.id,
        msg.outcome === 'not-dispatched' ? 'not-dispatched' : 'unknown')
      if (msg.glowHealth) error.glowHealth = msg.glowHealth
      for (const key of ['dragStarted', 'expectedCursor', 'actualCursor', 'cursorCheck']) if (msg[key] !== undefined) error[key] = msg[key]
      p.reject(error.code === 'HUMAN_REOBSERVE' ? humanReobserveError(error) : error)
    }
  }

  /**
   * @param {string} op worker op
   * @param {object} [args]
   * @param {number} [timeoutMs] hard cap on this call
   * @param {boolean} [killOnTimeout] kill a wedged worker when that cap expires (default true)
   * @returns {Promise<any>} worker `data` payload
   */
  // Cleanup runs under its own explicit authority. A cancelled user context must
  // not block key release or the closing of a question; ordinary tools never use it.
  callInternal (op, args = {}, timeoutMs = DEFAULT_TIMEOUT_MS, killOnTimeout = true, beforeDispatch) {
    if (!['cancelInput', 'calm', 'endAsk', 'abort'].includes(op)) throw new Error('unsupported internal cleanup operation')
    return this.inputContext.run({ internalCleanup: true }, () => this.call(op, args, timeoutMs, killOnTimeout, beforeDispatch))
  }

  async cancelRequest (requestId, child, reason, killOnFailure = true) {
    const cleanup = { requestId, workerGeneration: this.workerGeneration, requested: true,
      cleanupConfirmed: false, cleanupState: 'unconfirmed', workerKilled: false }
    const sameWorker = () => {
      if (this.proc !== child) throw Object.assign(new Error('original worker exited before cleanup'), { code: 'worker-replaced' })
    }
    try {
      sameWorker()
      const ack = await this.callInternal('cancelInput', { requestId }, this.inputCleanupGraceMs, false, sameWorker)
      if (ack?.requestId !== undefined && ack.requestId !== requestId) throw new Error('cancellation acknowledgement named another request')
      if (ack?.workerGeneration && ack.workerGeneration !== cleanup.workerGeneration) throw new Error('cancellation acknowledgement named another worker')
      cleanup.cancelled = ack?.cancelled === true
      cleanup.cleanupConfirmed = ack?.cleanupConfirmed === true && ack?.ownedInputCount === 0
      cleanup.cleanupState = ack?.cleanupState || (cleanup.cleanupConfirmed ? 'released' : 'unconfirmed')
      if (Number.isInteger(ack?.ownedInputCount)) cleanup.ownedInputCount = ack.ownedInputCount
    } catch (error) {
      cleanup.cleanupState = this.proc !== child ? 'worker-exited' : 'ack-failed'
      cleanup.errorCode = error.code || 'cleanup-error'
    }
    if (!cleanup.cleanupConfirmed && killOnFailure && this.proc === child) {
      cleanup.killReason = reason
      try { cleanup.workerKilled = child.kill() !== false } catch { cleanup.workerKilled = false }
    }
    return cleanup
  }

  async call (op, args = {}, timeoutMs = DEFAULT_TIMEOUT_MS, killOnTimeout = true, beforeDispatch) {
    const input = isInputOp(op, args)
    const priorGeneration = this.workerGeneration
    const invalidAtStart = this.workerStateInvalid
    const context = this.inputContext.getStore()
    const signal = context?.signal
    const check = () => {
      if (signal?.aborted) throw workerCallError('owning tool cancelled', 'INPUT_CANCELLED', op, null, 'not-dispatched')
      beforeDispatch?.()
      context?.assertOwnership?.()
    }
    check()
    try { await this.ensureWorker() }
    catch (error) { throw workerCallError(error.message || String(error), 'worker-unavailable', op, null, 'not-dispatched') }
    const child = this.proc
    if (!child) throw workerCallError('worker exited before dispatch', 'worker-exited', op, null, 'not-dispatched')
    const queueDeadline = Date.now() + timeoutMs
    while (this.uiaRead && !URGENT_CONTROL.has(op)) {
      await this.waitForUiaRead(op, input, signal, queueDeadline)
      if (this.proc !== child) throw workerCallError('worker exited before dispatch', 'worker-exited', op, null, 'not-dispatched')
      if (Date.now() >= queueDeadline) throw workerCallError('deadline expired waiting for the UIA read', 'worker-uia-busy', op, null, 'not-dispatched')
    }
    check()
    if (input && (invalidAtStart || (priorGeneration && priorGeneration !== this.workerGeneration))) {
      if (this.stopped || this.exited) throw workerCallError('manual pause/exit remains authoritative', 'ABORTED', op, null, 'not-dispatched')
      throw workerReobserveError(this.workerGeneration, { op })
    }
    const id = ++this.seq
    const generation = this.workerGeneration
    if (input && context?.actionRecord) Object.assign(context.actionRecord, {
      requestId: id, workerGeneration: generation, runtime: this.runtime,
    })
    // __cycle is signed last. A caller cannot forge another input series or turn.
    const signed = { ...args, __cycle: context?.internalCleanup !== true, __kickoff: this.kickoffRequired }
    if (input) signed.__inputSeries = context?.inputSeries || randomUUID()
    return new Promise((resolve, reject) => {
      let written = false
      const read = UIA_READS.has(op) && killOnTimeout ? (this.uiaRead = { id, child, timedOut: false }) : null
      const cleanup = () => signal?.removeEventListener('abort', abort)
      const deferReadRecovery = () => {
        if (!read || this.uiaRead !== read) return
        read.timedOut = true
        this.emit('uia-read-settled', false)
        const grace = Math.min(timeoutMs, DEFAULT_TIMEOUT_MS)
        read.watchdog = setTimeout(() => {
          if (this.proc !== child || this.uiaRead !== read) return
          this.log(`[core] UIA read ${id} (${op}) still blocked after ${grace}ms recovery grace; stopping worker pid=${child.pid}`)
          try { child.kill() } catch { /* already gone */ }
        }, grace)
      }
      const fail = async (code, message, timeout) => {
        if (!this.pending.delete(id)) return
        clearTimeout(timer); cleanup()
        const error = workerCallError(message, code, op, id, input && written ? 'unknown' : 'not-dispatched')
        error.operationDispatched = written
        error.workerGeneration = generation
        if (input && written) {
          // Stop the original request out of band, then allow a bounded cleanup
          // acknowledgement before killing a worker that may still own a key down.
          error.cleanup = await this.cancelRequest(id, child, timeout ? 'input-timeout' : 'caller-cancelled', killOnTimeout)
        } else if (read) {
          deferReadRecovery()
        } else if (timeout && killOnTimeout) {
          try { if (this.proc === child) child.kill() } catch { /* already gone */ }
        }
        reject(error)
      }
      const abort = () => {
        // beginAsk is a receipt-producing transaction: after dispatch we need
        // its askId to release the exact brake. ask() checks cancellation before
        // showing the card and always closes that receipt in its finally.
        if (op === 'beginAsk' && written) return
        void fail('INPUT_CANCELLED', 'owning tool cancelled; inspect any accepted input before retrying', false)
      }
      const timer = setTimeout(() => {
        const message = read
          ? `UIA observation timed out: ${op} (${timeoutMs}ms); worker still finishing this read. Narrow the tree or use a point query once it returns.`
          : `worker timeout: ${op} (${timeoutMs}ms)` + (input ? ' — cancellation and owned-input cleanup requested before worker recovery' : killOnTimeout ? ' — worker recovery requested' : ' — worker left alive so cleanup can finish')
        void fail('worker-timeout', message, true)
      }, Math.max(0, queueDeadline - Date.now()))
      this.pending.set(id, { resolve, reject, timer, op, input, cleanup, abort, child, workerGeneration: generation })
      signal?.addEventListener('abort', abort, { once: true })
      if (signal?.aborted) { abort(); return }
      try {
        written = true // a synchronous pipe failure still leaves dispatch uncertain
        child.stdin.write(JSON.stringify({ id, op, args: signed }) + '\r\n')
      } catch (error) {
        void fail('worker-write-failed', 'worker input pipe rejected the request: ' + error.message, false)
      }
    })
  }

  finishUiaRead (completed) {
    const read = this.uiaRead
    if (!read) return
    this.uiaRead = null
    clearTimeout(read.watchdog)
    this.emit('uia-read-settled', completed && !read.timedOut)
  }

  // Only the stdin reader's cancellation command is out of band. Preserve
  // emergency/release requests, but never queue ordinary work behind a slow
  // observation after its caller has given up. Do not replay any request.
  waitForUiaRead (op, input, signal, deadline) {
    const busy = () => workerCallError('native UIA observation still busy; this request was not sent',
      'worker-uia-busy', op, null, 'not-dispatched')
    if (this.uiaRead.timedOut || Date.now() >= deadline) return Promise.reject(busy())
    return new Promise((resolve, reject) => {
      const finish = (error) => {
        clearTimeout(timer)
        this.off('uia-read-settled', settled)
        this.off('input-cancel', cancel)
        signal?.removeEventListener('abort', cancel)
        if (error) reject(error); else resolve()
      }
      const settled = (completed) => finish(completed ? null : busy())
      const cancel = () => finish(workerCallError('cancelled before dispatch', 'INPUT_CANCELLED', op, null, 'not-dispatched'))
      const timer = setTimeout(() => finish(busy()), Math.max(0, deadline - Date.now()))
      this.once('uia-read-settled', settled)
      if (input) this.once('input-cancel', cancel)
      signal?.addEventListener('abort', cancel, { once: true })
      if (signal?.aborted) cancel()
    })
  }

  async kill () {
    const ownAttempt = this.inputContext.getStore()?.actionRecord?.attemptId
    const actions = [...this.activeActions.entries()].filter(([id]) => id !== ownAttempt).map(([, settled]) => settled)
    this.emit('input-cancel')
    const child = this.proc
    const bounded = async promise => {
      let timer
      try { return await Promise.race([promise.then(() => true), new Promise(resolve => { timer = setTimeout(() => resolve(false), this.shutdownGraceMs) })]) }
      finally { clearTimeout(timer) }
    }
    if (child) {
      let exited, detach
      const death = new Promise(resolve => {
        exited = resolve
        if (typeof child.once === 'function') {
          child.once('exit', exited); detach = () => child.off('exit', exited)
        } else {
          this.once('dead', exited); detach = () => this.off('dead', exited)
        }
      })
      try {
        const sameWorker = () => { if (this.proc !== child) throw new Error('original worker already exited') }
        try { await this.callInternal('abort', {}, 1000, false, sameWorker) } catch { /* best effort */ }
        if (this.proc === child) {
          try { child.kill() } catch { /* failure is reported as unknown below */ }
          if (!await bounded(death)) {
            // Termination itself is uncertain. Settle local callers honestly so
            // disposal cannot silently discard their final audit records.
            for (const [id, pending] of this.pending) if (pending.child === child) {
              this.pending.delete(id); clearTimeout(pending.timer); pending.cleanup?.()
              pending.reject(Object.assign(workerCallError('worker shutdown did not confirm process exit', 'worker-shutdown-unconfirmed', pending.op, id),
                { cleanup: { cleanupConfirmed: false, cleanupState: 'shutdown-unconfirmed' } }))
            }
          }
        }
      } finally { detach() }
    }
    // In-flight actuate() finally blocks emit the persistent settlement. Waiting
    // for process exit alone is too early; never wait for the action invoking us.
    await bounded(Promise.all(actions))
  }

  // ---------------- screen observation ----------------
  syncCooperation (state, notify = true) {
    if (!state || this.workerStateInvalid) return false
    if (state.workerGeneration && this.workerGeneration && state.workerGeneration !== this.workerGeneration) return false
    if (Number.isSafeInteger(state.stateSeq)) {
      if (state.stateSeq <= this.nativeStateSeq) return false
    } else if (this.nativeStateSeq >= 0) return false // never downgrade an ordered worker
    if (Number(state.revision) < Number(this.cooperation.revision)) return false
    if (Number(state.revision) === Number(this.cooperation.revision) && Number.isFinite(state.inputEpoch) &&
        state.inputEpoch < (this.cooperation.inputEpoch || 0)) return false
    if (Number.isSafeInteger(state.stateSeq)) this.nativeStateSeq = state.stateSeq
    const inputChanged = Number.isFinite(state.inputEpoch) && state.inputEpoch !== (this.cooperation.inputEpoch || 0)
    this.cooperation = state
    if (state.active || inputChanged) { this.maps.clear(); this.lastMarks = []; this.lastMarkFrame = null }
    if (notify) this.emit('handoff', state)
    return true
  }

  withInputContext (context, fn) {
    return this.inputContext.run({ signal: context?.signal, assertOwnership: context?.assertOwnership,
      cycleId: context?.cycleId ?? null, sessionKey: context?.sessionKey ?? null, agentKey: context?.agentKey ?? null,
      inputSeries: randomUUID() }, fn)
  }

  waitForHuman () {
    const signal = this.inputContext.getStore()?.signal
    const started = performance.now()
    const state = () => Object.fromEntries(['phase', 'active', 'revision', 'heldCount', 'lastKind', 'quietRemainingMs', 'inputEpoch']
      .filter(key => this.cooperation[key] !== undefined).map(key => [key, this.cooperation[key]]))
    const report = (phase, extra = {}) => {
      const record = { ts: Date.now(), op: 'handoff-wait', phase, waitedMs: Math.round(performance.now() - started), cooperation: state(), ...extra }
      try { this.emit('handoff-wait', record) } catch { /* diagnostics never own the wait */ }
      return record
    }
    return new Promise((resolve, reject) => {
      let finished = false
      const events = ['handoff', 'panic', 'ask', 'exit', 'dead', 'input-cancel']
      const cleanup = () => { for (const event of events) this.off(event, listeners[event]); signal?.removeEventListener('abort', cancelled) }
      const finish = (error) => {
        if (finished) return
        finished = true
        cleanup()
        const record = report(error ? 'ended-with-error' : 'handback', error ? { code: error.code, cancelSource: error.cancelSource || null } : {})
        if (error) { error.handoffWait = record; reject(error) } else resolve()
      }
      const cancelled = () => {
        const source = signal?.aborted ? 'host-signal' : 'core-input-cancel'
        const code = signal?.reason?.code || signal?.reason?.name
        const reasonCode = typeof code === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(code) ? code : 'unspecified'
        const snapshot = state()
        const error = workerCallError(`waiting for the human was cancelled; source=${source}; reasonCode=${reasonCode}; waitedMs=${Math.round(performance.now() - started)}; phase=${snapshot.phase}; heldCount=${snapshot.heldCount ?? 'unknown'}. Cancellation ended the local wait; it does not explain why handback was delayed`, 'INPUT_CANCELLED', null, null, 'not-dispatched')
        error.cancelSource = source
        finish(error)
      }
      const check = () => {
        if (signal?.aborted) return cancelled()
        if (this.stopped || this.exited) return finish(workerCallError('manual pause/exit remains authoritative', 'ABORTED', null, null, 'not-dispatched'))
        if (!this.cooperation.active) finish()
      }
      const listeners = Object.fromEntries(events.map(event => [event, event === 'dead' ?
        () => finish(workerCallError('worker exited while waiting', 'worker-exited', null, null, 'not-dispatched')) :
        event === 'input-cancel' ? cancelled : check]))
      for (const event of events) this.on(event, listeners[event])
      signal?.addEventListener('abort', cancelled, { once: true })
      report('started')
      check()
    })
  }

  async waitInputReady () {
    if (this.workerStateInvalid) {
      const context = this.inputContext.getStore()
      if (context?.signal?.aborted) throw workerCallError('owning tool cancelled', 'INPUT_CANCELLED', null, null, 'not-dispatched')
      context?.assertOwnership?.()
      await this.ensureWorker()
      if (context?.signal?.aborted) throw workerCallError('owning tool cancelled', 'INPUT_CANCELLED', null, null, 'not-dispatched')
      context?.assertOwnership?.()
      if (this.workerStateInvalid) throw workerCallError('native worker has not supplied a fresh ready snapshot', 'WORKER_STATE_UNAVAILABLE', null, null, 'not-dispatched')
      if (this.stopped || this.exited) throw workerCallError('manual pause/exit remains authoritative', 'ABORTED', null, null, 'not-dispatched')
      throw workerReobserveError(this.workerGeneration)
    }
    if (!this.cooperation.active) return
    await this.waitForHuman()
    this.inputContext.getStore()?.assertOwnership?.()
    throw humanReobserveError({ outcome: 'not-dispatched' })
  }

  cancelInputs () {
    this.emit('input-cancel')
    for (const pending of [...this.pending.values()]) if (pending.input || INPUT_OPS.has(pending.op)) pending.abort?.()
  }

  /** Raw capture; returns { image: Buffer, mime, region, cursor, settled, settleMs, ts, scaledTo }. */
  async screenshot (opts = {}) {
    const data = await this.call('capture', {
      x: opts.x, y: opts.y, width: opts.width, height: opts.height,
      preset: opts.preset,
      format: opts.format || 'jpeg',
      quality: opts.quality ?? 75,
      // ~1280 wide ≈ Anthropic WXGA guidance: ⌈w/28⌉×⌈h/28⌉ tokens ≈ 1600; bigger
      // wastes vision tokens, smaller loses text legibility (DESIGN §6)
      maxWidth: opts.maxWidth ?? 1280,
      cursor: opts.cursor ?? false,
      // timing: wait for pixel stability before grabbing, hard-capped so it can't stall
      wait: opts.wait || 'auto',
      waitCapMs: opts.waitCapMs,
      stableMs: opts.stableMs,
    }, CAPTURE_TIMEOUT_MS)
    this.lastRegion = data.region
    this.lastScale = data.scaledTo && data.region.width ? data.scaledTo / data.region.width : 1
    return { ...data, image: Buffer.from(data.image, 'base64') }
  }

  /**
   * Text-first screen state — the grounding channel that works even for
   * models without native vision. Merges: window list + active window +
   * shallow UIA tree of the active window + cursor. This is the default
   * observation tool; screenshots are the *verification* channel.
   */
  async screenState (opts = {}) {
    const [windows, cursor, uia] = await Promise.all([
      this.call('windows', {}),
      this.call('cursor', {}),
      this.call('uia', { depth: opts.uiaDepth ?? 5, maxNodes: opts.uiaMaxNodes ?? 260 }).catch(() => null),
    ])
    const active = (windows.windows || []).find(w => w.active) || null
    return {
      active, windows: windows.windows, cursor,
      cooperation: windows.cooperation, indicator: windows.indicator, virtualScreen: windows.virtualScreen,
      runtime: this.runtime, workerGeneration: this.workerGeneration,
      uiaRoot: uia && uia.root, uiaFlat: (uia && uia.flat) || [],
      uiaCount: uia && uia.count, uiaTruncated: !uia || uia.truncated !== false, uiaBudget: uia?.budget, ts: Date.now(),
    }
  }

  /**
   * Set-of-Marks: label interactive elements M1..Mn on the current screen.
   * Returns the annotated screenshot plus a text mark table. Clicking by
   * mark ids refer to the same observed map as the text table.
   */
  async marks (opts = {}) {
    const map = opts.landmarkMap || await this.landmarks({ hwnd: opts.hwnd, depth: opts.uiaDepth ?? 6,
      maxNodes: opts.uiaMaxNodes ?? 300, maxMarks: opts.maxMarks })
    await this.validateMarkFrame()
    const state = { active: { hwnd: map.hwnd }, cursor: await this.call('cursor', {}) }
    // capture FIRST so the visible region drives the ghost-mark filter:
    // minimized windows live at (-32000, -32000) in UIA and must never receive
    // mark ids (clicking them would throw the cursor off-screen)
    const shot = await this.screenshot({ ...opts, quality: opts.quality ?? 80 })
    await this.validateMarkFrame()
    const region = shot.region
    const onScreen = (r) => r.x + r.width >= region.x && r.x <= region.x + region.width
      && r.y + r.height >= region.y && r.y <= region.y + region.height
    const markList = map.marks.filter(m => onScreen({ x: m.x, y: m.y, width: m.w, height: m.h }))
    let annotated = null
    if (opts.annotated !== false && markList.length > 0) {
      // marks are in screen px; map into screenshot px space (screenshot px = screen px × scale)
      const scaled = markList.map(m => ({
        id: m.id,
        x: Math.round((m.x - shot.region.x) * this.lastScale),
        y: Math.round((m.y - shot.region.y) * this.lastScale),
        w: Math.round(m.w * this.lastScale), h: Math.round(m.h * this.lastScale),
      }))
      const res = await this.call('annotate', {
        image: shot.image.toString('base64'), marks: scaled, quality: 80,
      }, CAPTURE_TIMEOUT_MS)
      annotated = Buffer.from(res.image, 'base64')
    }
    return { marks: markList, annotated, raw: opts.raw || !annotated ? shot.image : undefined,
      mime: annotated ? 'image/jpeg' : shot.mime, rawMime: shot.mime,
      region: shot.region, imageSize: shot.imageSize, capturedAt: shot.capturedAt,
      cursorInImage: shot.cursorInImage, scaledTo: shot.scaledTo,
      settled: shot.settled, settleMs: shot.settleMs,
      state: { active: state.active, cursor: state.cursor }, ts: shot.ts ?? Date.now() }
  }

  // ---------------- actions (all audited) ----------------
  async move (x, y) { return this.actuate('move', { x, y }) }

  async click (target, opts = {}) {
    const witness = verificationRegion(opts.verificationRegion)
    const pt = await this.resolveTarget(target) // {x,y} | {mark:'M3'} | [x,y]
    return this.actuate('click', {
      x: pt.x, y: pt.y, button: opts.button || 'left', clicks: opts.clicks || 1,
      settleMs: opts.settleMs ?? 40,
      ...(witness ? { verificationRegion: witness } : {}),
      ...((pt.expectHwnd || opts.expectHwnd) ? { expectHwnd: pt.expectHwnd || opts.expectHwnd } : {}),
    })
  }

  async drag (from, to, opts = {}) {
    const a = await this.resolveTarget(from)
    const b = await this.resolveTarget(to)
    return this.actuate('drag', { fromX: a.x, fromY: a.y, toX: b.x, toY: b.y, ...opts,
      ...((a.expectHwnd || opts.expectHwnd) ? { expectHwnd: a.expectHwnd || opts.expectHwnd } : {}) })
  }

  async scroll (direction, lines, opts = {}) {
    // BUG FIX (2026-09-12): the old signature took `opts` but the tool layer passed the
    // point itself, so opts.at was always undefined (x/y silently dropped — the wheel
    // always fired wherever the cursor happened to be) and a null argument crashed with
    // "Cannot read properties of null (reading 'at')". Accept both shapes now.
    const o = opts || {}
    const at = o.at || (o.x !== undefined && o.y !== undefined ? o : null)
    const pt = at ? await this.resolveTarget(at) : null
    return this.actuate('scroll', { direction, lines, ...(pt ? { x: pt.x, y: pt.y } : {}) })
  }

  // Anchor-based selection: click the START, scroll freely, then shift+click the END.
  // Replaces drag-select, whose end point depends on drag duration and auto-scroll speed.
  async shiftClick (x, y, opts = {}) {
    const witness = verificationRegion(opts.verificationRegion)
    return this.actuate('shiftClick', { x, y, clicks: opts.clicks || 1, settleMs: opts.settleMs ?? 90,
      ...(witness ? { verificationRegion: witness } : {}),
      ...(opts.expectHwnd ? { expectHwnd: opts.expectHwnd } : {}) })
  }

  async selectRange (a = {}) { return this.actuate('selectRange', a) }

  // Low-level control action through the accessibility tree: press a button, SELECT A TAB,
  // expand a combo, set a field's value — one COM call, no pointer travel, no screenshot.
  async uiaAct (a = {}) { return this.actuate('uiaAct', a) }

  // Screenshot timing: wait for the frame signature to stop changing / to change at all.
  async waitStable (opts = {}) { return this.call('waitStable', opts) }
  async waitChange (opts = {}) { return this.call('waitChange', opts) }

  // Agent-activity indicator (blue border) — observations do not light it, actuations do.
  async indicator (opts = {}) { return this.call('indicator', opts) }

  /**
   * The agent has STOPPED driving: cut the border instantly (no ease-out), exactly like the
   * emergency brake. Called when the agent's turn ends, so a lingering blue border can never
   * claim the machine is still under control after control actually stopped.
   */
  async calm ({ beforeDispatch } = {}) { return this.callInternal('calm', {}, DEFAULT_TIMEOUT_MS, true, beforeDispatch) }

  /// **Ask the human one question, machine paused — the ONE question path.**
  ///
  /// Only for the rare case where the agent is genuinely blocked on a decision it must not make
  /// alone. This is a TRANSACTION in two worker ops and one client-UI wait:
  ///
  ///   1. `beginAsk` — the worker writes the STOP file, paints the fast-breathing red, raises the
  ///      host and puts the caret in the composer, then RETURNS AT ONCE. The worker's single-threaded
  ///      op loop is never occupied by the wait, so `abort`/`panic`/any other op is answered while a
  ///      question is open (the old one-shot `ask` op held the loop for the whole window).
  ///   2. `opts.onAsk(info)` — the ANSWER CHANNEL, required. The plugin hands the question to the
  ///      client-UI card `ask_user_question` uses; it resolves with `{answered, keepPause, …}` and
  ///      has no countdown of its own. That is the "hang until the human answers" the human asked for.
  ///   3. `endAsk` — issued from the `finally`, so EVERY ending releases: answered, dismissed,
  ///      aborted turn, tool deadline, `onAsk` throwing. `keepPause` travels from the human's own
  ///      choice on the card (①让你停 / ②放你走, D3) — never derived from how the call ended.
  ///
  /// @param {object} opts
  /// @param {string} opts.question
  /// @param {(info: {askId:number, hostRaised:boolean, caretPlaced:boolean}) => Promise<object>} opts.onAsk
  ///   resolves `{answered:boolean, keepPause?:boolean, selected?:string[], custom?:string, reason?:string}`
  /// @returns {Promise<object>} `{...answer, question, askId, stopped, exited, release}`
  async ask (opts = {}) {
    if (typeof opts.onAsk !== 'function') {
      throw new Error('ask() requires onAsk: the worker no longer waits for a human; the answer comes from the client UI')
    }
    // The ask reports state (it engages and releases a brake), so its replies are state reports, not
    // just data, and the guard counts EXTERNAL state changes only (F2): the worker's own `ask`
    // notification belongs to this very request (see onLine), so it must not invalidate anything.
    // Anything else that arrived meanwhile — above all Ctrl+Alt+Q — makes a reply history, and
    // history may not overwrite the present. The window is far longer now (a human reading a card,
    // not a 60 s clock), so that discipline matters MORE, not less: it is applied to the release.
    const before = this.stateSeq
    const tracker = { own: 0 }
    this._askOpen = tracker
    let b
    try {
      // A throw HERE means nothing was engaged (the worker verified `Panic.Engaged`, or refused for
      // NO-CYCLE) — so there is nothing to release and no `endAsk` is sent.
      b = await this.call('beginAsk', { question: opts.question }, ASK_DEADLINE_MS)
    } finally {
      this._askOpen = null
    }
    const askId = b && b.askId
    const askWorker = this.proc
    const sameAskWorker = () => {
      if (this.proc !== askWorker) throw Object.assign(new Error('question worker exited; its askId cannot release a replacement worker'), { code: 'worker-replaced' })
    }
    let answer = null
    let rel = null
    let via = 'ok'
    try {
      const context = this.inputContext.getStore()
      if (context?.signal?.aborted) throw workerCallError('owning tool cancelled after the ask brake was engaged', 'INPUT_CANCELLED', 'beginAsk', null, 'unknown')
      context?.assertOwnership?.()
      answer = await opts.onAsk({ askId, hostRaised: !!(b && b.hostRaised), caretPlaced: !!(b && b.caretPlaced) })
      // `via` is an AUDIT LABEL ONLY — it decides nothing. The pause decision is `keepPause`, and it
      // comes from the human: ①让你停 keeps the brake, and every other ending (②放你走, a typed custom
      // answer, a dismissed card, an aborted turn, the tool deadline, a missing answer) releases it.
      via = !answer ? 'ok'
        : answer.answered ? 'answered'
          : (answer.reason === 'cancelled' ? 'cancelled'
            : (answer.reason === 'aborted' || answer.reason === 'tool-timeout') ? 'aborted' : (answer.reason || 'ok'))
    } finally {
      // SOMEONE must read the answer's decision — `|| false` would turn "the channel never said" into
      // a release, which is the safe direction but would hide a broken channel. Require a boolean and
      // shout when it is missing; a channel that cannot state the pause decision must not silently
      // keep a brake up.
      const keepPause = answer && typeof answer.keepPause === 'boolean' ? answer.keepPause : false
      if (answer && typeof answer.keepPause !== 'boolean') {
        this.log('[ask] the answer channel returned no keepPause boolean — releasing the brake (the safe direction): ' +
          JSON.stringify({ answered: (answer && answer.answered) === true, reason: answer && answer.reason }))
      }
      // CAPTURE THE STATE THE RELEASE IS ALLOWED TO OVERWRITE (Codex-review discipline, kept from the
      // old ask). `endAsk`'s own audit record is not a state change, so `before` does not move for a
      // normal release; if a Ctrl+Alt+Q (or a new panic) lands while the release is in flight, the
      // reply describes a machine that no longer exists and must not be applied on top of it.
      const beforeRelease = this.stateSeq
      try {
        rel = await this.callInternal('endAsk', { askId, via, keepPause }, END_ASK_DEADLINE_MS, /* killOnTimeout */ false, sameAskWorker)
      } catch (e) {
        // ONE retry: the first attempt may have timed out against a briefly busy worker. A second
        // failure is not swallowed — the audit pair (ENGAGE-ASK with no ASK-RELEASE) is the signal,
        // and the orphan sweep is the backstop. NEVER a kill here (killOnTimeout:false above): the
        // dead worker's STOP file would outlive every waiter, which is the defect being removed.
        try {
          rel = await this.callInternal('endAsk', { askId, via: via + '+retry', keepPause }, END_ASK_DEADLINE_MS, false, sameAskWorker)
        } catch (e2) {
          this.log(`[ask] endAsk failed twice: ${e2.message} — the brake may need the orphan sweep (the next worker call sweeps it, or the human's Ctrl+Alt+R)`)
        }
      }
      if (rel) {
        if (this.stateSeq === beforeRelease) {
          this.stopped = !!rel.stopped
          if (rel.exited) this.exited = true
        } else {
          this.log('[ask] a state change arrived while the ask brake was being released — the newer state stands')
        }
      }
      const external = (this.stateSeq - before) - tracker.own
      if (external > 0) this.log(`[ask] ${external} state change(s) arrived while the question was pending`)
      // EMITTED FROM THE FINALLY, so a throwing/throttled `endAsk` still settles the plugin's
      // `asking` gate: an ask that leaves the gate stuck on `asking` locks out the owner's idle and
      // its turn/end and every other session (lifecycle bug, 2026-09-13). It is not a resume, it
      // clears no brake and it reports only how the question actually ended.
      this.emit('ask-ended', {
        answered: !!(answer && answer.answered),
        stopped: this.stopped,
        exited: this.exited,
        release: rel,
      })
    }
    return { ...(answer || {}), question: opts.question, askId, stopped: this.stopped, exited: this.exited, release: rel }
  }

  /// **End the session from the agent side** — the programmatic twin of Ctrl+Alt+Q.
  /// Only when the work genuinely cannot go on: it cancels the turn, and nothing re-opens the
  /// session (not even Ctrl+Alt+R) until an agent drives this machine again.
  async exit (why) {
    return this.call('exit', { why: why || 'could not proceed' })
  }

  /**
   * Where will synthetic keystrokes land? Returns the foreground window, whether it matched
   * the intended target, whether it had to be re-asserted, and an integrity-level warning when
   * Windows (UIPI) would silently discard our input. Text-only — no screenshot needed.
   */
  async focus (opts = {}) {
    return opts.refocus === true ? this.actuate('focus', opts) : this.call('focus', opts)
  }

  /** Sampled fingerprint plus window identity/geometry; a change invalidates cached marks. */
  async frameSig (opts = {}) { return this.call('frameSig', opts) }

  /**
   * Landmark map of a window — the "look once, then reuse" mechanism.
   *
   * The first call on a window returns named interactive elements with snapshot ids and
   * its centre (M1..Mn); a later call while the window still looks the same costs ONE cheap
   * frame hash (no image transfer, annotation or model vision) and returns the same table with
   * `reused:true`. So entering a window and reading it once is enough to keep working in it by
   * NAME, without paying for another screenshot each step.
   */
  async landmarks (opts = {}) {
    const step = opts.step ?? 16
    const insetPct = opts.insetPct ?? 10
    // UIA-ONLY MODE (test report 2026-11-04): an animated neighbour (DSH Pet) keeps flipping the
    // sampled pixel signature, so every refresh came back STALE_MARK. uiaOnly pins identity by
    // window handle / process / geometry alone — the sampled signature is read (for the report)
    // but never compared; dispatch-time occlusion checking still guards the actual click.
    const uiaOnly = opts.uiaOnly === true
    const fs = await this.frameSig({ hwnd: opts.hwnd, step, insetPct })
    if (uiaOnly) fs.sig = null
    const hwnd = fs.hwnd
    if (!hwnd || (!fs.sig && !uiaOnly)) throw staleMark('window snapshot unavailable')
    const cached = this.maps.get(String(hwnd))
    const key = JSON.stringify([opts.depth ?? 6, opts.maxNodes ?? 300, opts.maxMarks ?? 80, opts.minSize ?? 8, opts.role, opts.nameContains, uiaOnly])
    if (cached && sameMarkFrame(cached.frame, fs) && cached.key === key && !opts.refresh) {
      this.lastMarks = cached.marks
      this.lastMarkFrame = { ...fs, step, insetPct }
      return { hwnd, marks: cached.marks, count: cached.marks.length, reused: true, ageMs: Date.now() - cached.ts, sig: fs.sig, uiaOnly }
    }
    const uia = await this.call('uia', {
      hwnd: hwnd || undefined,
      depth: opts.depth ?? 6,
      maxNodes: opts.maxNodes ?? 300,
      role: opts.role,
      nameContains: opts.nameContains,
    })
    const marks = buildMarks(uia.flat || [], opts.maxMarks ?? 80, opts.minSize ?? 8)
    const after = await this.frameSig({ hwnd, step, insetPct })
    if (uiaOnly) after.sig = null
    if (!sameMarkFrame(fs, after)) {
      const changed = ['hwnd', 'pid'].filter(k => fs[k] !== after[k])
      for (const k of ['x', 'y', 'width', 'height']) if (fs.region?.[k] !== after.region?.[k]) changed.push(`region.${k}`)
      if (fs.sig !== after.sig) changed.push('sampled-frame-signature')
      throw staleMark('window changed while reading the element map (' + changed.join(', ') +
        '); this comparison does not identify the animation, occluder or other cause')
    }
    for (const mark of marks) mark.id = `M${++this.markSequence}`
    this.lastMarks = marks
    this.lastMarkFrame = { ...after, step, insetPct }
    this.maps.set(String(hwnd), { marks, frame: after, sig: after.sig, key, ts: Date.now() })
    if (this.maps.size > 16) this.maps.delete(this.maps.keys().next().value)
    return { hwnd, marks, count: marks.length, reused: false, sig: fs ? fs.sig : null, uiaOnly, elements: (uia.flat || []).length }
  }

  // The human's emergency brake, reachable from the model side too (ESC / Ctrl+Alt+Q are
  // handled inside the worker by a low-level keyboard hook).
  async panic (why, temporary = false) { return this.call('panic', { why: why || 'manual', temporary }) }

  async recover (pauseId) {
    const before = this.stateSeq
    const result = await this.call('recover', { pauseId })
    if (result.recovered && this.stateSeq === before && !this.exited) this.stopped = false
    else if (result.recovered) return { recovered: false, reason: 'a newer machine state superseded recovery' }
    return result
  }
  // Opening a NEW CYCLE is the plugin's job, from the ONE place a real call reaches the worker (the
  // plugin's ensureCycle) — never the human's: Ctrl+Alt+R releases a brake and does nothing else
  // (the worker's Clear()), while this op is the one and only thing that un-latches Ctrl+Alt+Q.
  //
  // `expectExit` is the exit record the CALLER saw when it decided to open ("" = it saw none). The
  // worker compares it against the record on disk inside the same lock it writes records in, and
  // REFUSES to clear a newer one: an exit that lands while this op is being spawned or written is
  // newer than the caller's decision, and clearing it is how a Ctrl+Alt+Q would be undone (#6).
  async resume (expectExit) {
    // The reply's MIRROR is guarded too (Codex review #2/#3): the worker's answer and a later
    // unsolicited event can arrive in the SAME stdout chunk, and the Node layer processes the chunk's
    // lines before this continuation runs — so `this.exited = false; this.stopped = false` used to
    // overwrite a panic (or a new exit) that had already been observed. A state event that landed
    // while this op was in flight is NEWER than the op's own result: the newer state stands.
    const before = this.stateSeq
    const r = await this.call('resume', typeof expectExit === 'string' ? { expectExit } : {})
    if (this.stateSeq === before) {
      this.exited = false
      this.stopped = false
    } else {
      this.log('[resume] a state event arrived while the cycle opener was in flight — the newer state stands')
    }
    return r
  }
  async selfTest () { return this.actuate('selftest', {}) }
  async calibrate (opts = {}) { return this.actuate('calibrate', opts) }

  async key (combo, opts = {}) {
    return this.actuate('key', { combo: parseKeyCommand(combo).combo, holdMs: opts.holdMs ?? 60, ...(opts.expectHwnd ? { expectHwnd: opts.expectHwnd } : {}) })
  }

  async type (text, opts = {}) {
    // refuse typing into password fields unless explicitly allowed — the model
    // should ask the human, never handle credentials blind (DESIGN §8.3)
    if (!opts.allowPassword) {
      const f = await this.call('uiaFocused', {}).catch(() => null)
      if (f && f.element && f.element.isPassword) {
        throw new Error('target is a password field; set allowPassword:true after explicit human consent')
      }
    }
    // paste is IME-proof and faster for CJK/long text; unicode works when the
    // clipboard must not be touched. Auto rule: non-ASCII or >80 chars → paste.
    const automatic = !opts.mode || opts.mode === 'auto'
    const mode = automatic ? (/[\u0100-\uffff]/.test(text) || text.length > 80 ? 'paste' : 'unicode') : opts.mode
    const args = {
      text, mode, restoreClipboard: opts.restoreClipboard ?? true,
      ...(opts.expectHwnd ? { expectHwnd: opts.expectHwnd } : {}),
    }
    try {
      return await this.actuate('type', args)
    } catch (error) {
      // Only the pre-mutation format refusal proves that no text was sent. Never replay an
      // interrupted/unknown paste, a concurrent human copy, or an explicitly requested paste.
      if (!automatic || mode !== 'paste' || error.code !== 'CLIPBOARD_PRESERVATION_UNAVAILABLE' || error.outcome !== 'not-dispatched') throw error
      const result = await this.type(text, { ...opts, mode: 'unicode' })
      return { ...result, modeFallback: 'clipboard-preservation-unavailable' }
    }
  }

  async clipRead () { return this.call('clipRead', {}) }
  /** Worker-side OCR: text + per-word boxes in ABSOLUTE screen pixels (2026-11-04). */
  async ocr (region) { return this.call('ocr', region ? { ...region } : {}) }
  async clipWrite (text) { return this.actuate('clipWrite', { text }) }

  async activateWindow (sel) { return this.actuate('activate', sel) }
  async windowOp (sel, op, opts = {}) { return this.actuate('windowOp', { ...sel, op, ...opts }) }
  /** Deterministic placement (no mouse): move/resize a window to an arbitrary rect. */
  async windowMove (sel, rect) { return this.windowOp(sel, 'move', rect) }
  async waitForIdle (opts = {}) {
    return this.call('waitForIdle', { timeoutMs: opts.timeoutMs ?? 5000, stableMs: opts.stableMs ?? 350, pollMs: opts.pollMs ?? 120 })
  }

  /** Resolve {mark} | {x,y} | [x,y] | 'M12' into absolute screen px. */
  async resolveTarget (target) {
    if (typeof target === 'string') target = { mark: target }
    if (Array.isArray(target)) return { x: target[0], y: target[1] }
    if (target && typeof target.mark === 'string') {
      const m = this.lastMarks.find(k => k.id.toLowerCase() === String(target.mark).toLowerCase())
      if (!m) throw staleMark(`unknown or retired mark ${target.mark}`)
      await this.validateMarkFrame()
      return { x: m.cx, y: m.cy, mark: m, expectHwnd: this.lastMarkFrame.hwnd }
    }
    if (target && Number.isFinite(target.x) && Number.isFinite(target.y)) return target
    throw new Error('target must be {mark}, {x,y}, or [x,y]')
  }

  async validateMarkFrame () {
    const frame = this.lastMarkFrame
    if (!frame) throw staleMark('no verified landmark snapshot')
    let current
    try { current = await this.frameSig({ hwnd: frame.hwnd, step: frame.step, insetPct: frame.insetPct }) }
    catch { throw staleMark('window snapshot could not be checked') }
    if (!sameMarkFrame(frame, current)) throw staleMark('window contents, position or identity changed')
  }

  /** Every state-changing op funnels through here for the audit trail. */
  async actuate (op, args) {
    const parent = this.inputContext.getStore() || {}
    const rec = { attemptId: randomUUID(), requestId: null, op, args: redact(args),
      phase: 'started', ts: Date.now(), cycleId: parent.cycleId ?? null,
      sessionKey: parent.sessionKey ?? null, agentKey: parent.agentKey ?? null,
      workerGeneration: this.workerGeneration, runtime: this.runtime }
    this.emit('action', { ...rec })
    let settleAction
    this.activeActions.set(rec.attemptId, new Promise(resolve => { settleAction = resolve }))
    return this.inputContext.run({ ...parent, inputSeries: parent.inputSeries || randomUUID(), actionRecord: rec }, async () => {
      try {
        await this.waitInputReady()
        if (this.dryRun) {
          rec.dryRun = true; rec.outcome = 'not-dispatched'
          return { dryRun: true, op }
        }
        const now = Date.now()
        this.rateWindow = this.rateWindow.filter(t => now - t < this.rateLimit.windowMs)
        if (this.rateWindow.length >= this.rateLimit.max) {
          throw workerCallError(`rate limit: ${this.rateLimit.max} actuations/${this.rateLimit.windowMs}ms exceeded`,
            'RATE_LIMITED', op, null, 'not-dispatched')
        }
        this.rateWindow.push(now)
        const data = await this.call(op, args)
        rec.result = auditReceipt(data); rec.outcome = 'delivered'
        return data
      } catch (initial) {
        let err = initial
        if (err.code === 'HUMAN_YIELD') {
          try {
            await this.call('ping', {})
            if (rec.workerGeneration && rec.workerGeneration !== this.workerGeneration) {
              throw workerReobserveError(this.workerGeneration, { ...err, op })
            }
            await this.waitForHuman()
            this.inputContext.getStore()?.assertOwnership?.()
            err = humanReobserveError({ ...err, op })
          } catch (waitError) {
            err = waitError.code === 'WORKER_REOBSERVE' ? waitError : Object.assign(workerCallError(waitError.detail || waitError.message || String(waitError), waitError.code || 'handoff-wait-failed',
              op, err.requestId ?? null, err.outcome === 'not-dispatched' ? 'not-dispatched' : 'unknown'),
            { ...(waitError.handoffWait ? { handoffWait: waitError.handoffWait } : {}),
              ...(waitError.cancelSource ? { cancelSource: waitError.cancelSource } : {}),
              ...(waitError.cleanup ? { cleanup: waitError.cleanup } : {}) })
          }
        }
        if (err.code === 'HUMAN_REOBSERVE' || err.code === 'WORKER_REOBSERVE') {
          try { this.inputContext.getStore()?.assertOwnership?.() }
          catch (ownerError) {
            err = workerCallError(ownerError.message, ownerError.code || 'COMPUTER_OWNER_CHANGED', op,
              err.requestId ?? null, err.outcome)
          }
        }
        // UIA/native errors may echo names, values or typed text. The caller gets
        // the original exception; the persistent audit records a bounded code.
        rec.code = auditCode(err.code); rec.error = rec.code
        rec.outcome = err.outcome || 'unknown'
        if (err.requestId != null) rec.requestId = err.requestId
        if (err.cleanup) rec.cleanup = err.cleanup
        if (err.handoffWait) rec.handoffWait = err.handoffWait
        throw err
      } finally {
        rec.phase = 'settled'; rec.settledAt = Date.now(); rec.elapsedMs = rec.settledAt - rec.ts
        try { this.emit('action:settled', { ...rec }) }
        finally { this.activeActions.delete(rec.attemptId); settleAction() }
      }
    })
  }

}

function staleMark (reason) {
  return Object.assign(new Error(`STALE_MARK: ${reason}; no input sent. Refresh computer_marks and choose the target again, or use a current UIA selector.`),
    { code: 'STALE_MARK', outcome: 'not-dispatched' })
}

function sameMarkFrame (a, b) {
  const identity = a?.hwnd === b?.hwnd && a?.pid === b?.pid &&
    ['x', 'y', 'width', 'height'].every(k => Number.isFinite(a.region?.[k]) && a.region[k] === b.region[k])
  if (!identity) return false
  // A uiaOnly landmark frame (sig === null, test report 2026-11-04) deliberately carries no
  // pixel signature: identity is geometry alone, and the click path's occlusion check remains.
  if (a.sig === null) return true
  return !!a?.sig && a.sig === b?.sig
}

/** Keep secrets out of the audit log. */
function redact (args) {
  if (!args || typeof args !== 'object') return {}
  const safeStrings = new Set(['combo', 'button', 'direction', 'action', 'mode', 'preset', 'property'])
  return Object.fromEntries(Object.entries(args).map(([key, value]) => [key,
    typeof value === 'string' ? safeStrings.has(key) ? value.slice(0, 128) : `<${value.length} chars>` :
      typeof value === 'number' || typeof value === 'boolean' || value === null ? value : '<structured value>']))
}

function auditCode (code) {
  return typeof code === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(code) ? code : 'action-error'
}

// Explicit receipt allowlist: never persist screenshots, focus/UIA objects,
// clipboard content, passwords, arbitrary strings or provider result trees.
function auditReceipt (data) {
  if (!data || typeof data !== 'object') return {}
  const keys = ['ok', 'delivered', 'count', 'chars', 'typed', 'clicked', 'moved', 'settled',
    'elapsedMs', 'durationMs', 'hwnd', 'x', 'y', 'width', 'height', 'dryRun']
  return Object.fromEntries(keys.filter(key => typeof data[key] === 'boolean' ||
    (typeof data[key] === 'number' && Number.isFinite(data[key]))).map(key => [key, data[key]]))
}

/**
 * Turn a flat UIA dump into clickable marks — id, centre, role, name, in reading order
 * (top-to-bottom then left-to-right). Shared by `marks()` (annotated screenshot) and
 * `landmarks()` (cached, image-free map), so both produce identical ids for the same UI.
 */
function buildMarks (flat, maxMarks = 60, minSize = 8) {
  const seen = new Set()
  const interactive = []
  for (const e of flat) {
    if (interactive.length >= maxMarks) break
    if (e.isOffscreen === true || e.intersectsVirtualScreen === false) continue
    const r = e.rect || {}
    const name = (e.name || '').replace(/\s*\r\n\s*/g, ' | ').trim()
    const key = `${e.role}|${name}|${r.x},${r.y}`
    const clickable = SOM_ROLES.has(e.role) || SOM_PATTERNS.test((e.patterns || []).join(','))
    if (name && !seen.has(key) && clickable && r.width >= minSize && r.height >= minSize) {
      seen.add(key)
      interactive.push({ ...e, name })
    }
  }
  interactive.sort((a, b) => (a.rect.y - b.rect.y) || (a.rect.x - b.rect.x))
  return interactive.map((m, i) => ({
    id: `M${i + 1}`,
    x: m.rect.x, y: m.rect.y, w: m.rect.width, h: m.rect.height,
    cx: m.rect.x + Math.floor(m.rect.width / 2), cy: m.rect.y + Math.floor(m.rect.height / 2),
    name: (m.name || '').slice(0, 90), role: m.role,
  }))
}

function discoverWorker () {
  const local = join(process.env.LOCALAPPDATA || '', 'dsh-computer-use', 'worker')
  // A newer test binary is not a newer compatible implementation. Only the
  // build keyed by this package's worker source can serve its wire protocol.
  try {
    const sha = createHash('sha256').update(readFileSync(join(__dirname, 'worker.cs'))).digest('hex').slice(0, 16).toUpperCase()
    const exe = join(local, sha, 'dsh-computer-use-worker.exe')
    if (!existsSync(exe)) return null
    const out = execFileSync(exe, ['--op', 'ping'], { encoding: 'utf8', timeout: 4000, windowsHide: true })
    return /"pong"\s*:\s*true/.test(out) ? exe : null
  } catch { return null }
}

/** Use the prebuilt release worker, or Windows' own compiler in a source checkout. */
function compileWorkerSync (log) {
  return prepareNativeBinary({ source: join(__dirname, 'worker.cs'), name: 'dsh-computer-use-worker.exe',
    cache: 'worker', references: workerReferences() }, { log })
}

export { discoverWorker }
