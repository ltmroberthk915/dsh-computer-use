// tools.js — defineTool registrations for dsh-computer-use.
//
// 18 TOOLS. The previous 28 were merged, not deleted; every capability still exists and the
// behavioural detail lives in the skill (loaded only for computer-use work, while these
// definitions are paid for on EVERY request).
//
// Cost model (measured, 2026-09-13): the model payload is ~14.3k chars for the old surface, and
// the JSON-Schema scaffolding — one {type, description} object per parameter — dominated the
// prose. Nine parameters cost more than a 400-character description. Ranking of the levers:
//   1. fewer parameters  2. shorter parameter names  3. shorter descriptions  4. fewer tools
// Hence: whole tools fold into one action/flag parameter (clip read|write, wait idle|stable|
// change, window activate|minimize|…|move, ctrl stop|exit|selftest|calibrate|indicator), and
// multi-number arguments collapse into ONE "M3" | "x,y" | "x,y,w,h" string. Result ~7.1k chars.
//
// The DSL requires every `type: 'object'` node to declare additionalProperties outright
// (true/false, no default) or defineTool throws at load time.

import { runBatch } from './batch.js'
import { saveOwnedShot } from './artifacts.js'
import { attachScreenshot, renderScreenshot, selectBatchScreenshot } from './image-output.js'
import { ObservationStore } from './observations.js'

const P = (type, description, extra = {}) => ({ type, description, ...extra })

/** "M3" | "x,y" | "x y" -> {mark:'M3'} | {x,y}. One parameter instead of four. */
const pt = (v) => {
  if (v === undefined || v === null) return null
  const s = String(v).trim()
  const m = /^M(\d+)$/i.exec(s)
  if (m) return { mark: 'M' + m[1] }
  const c = s.split(/[,\s]+/).map(Number)
  if (c.length >= 2 && Number.isFinite(c[0]) && Number.isFinite(c[1])) return { x: c[0], y: c[1] }
  return null
}

/** "x,y,w,h" -> {x,y,width,height} */
const rect = (v) => {
  if (v === undefined || v === null) return null
  const c = String(v).split(/[,\s]+/).map(Number)
  if (c.length >= 4 && c.every(Number.isFinite)) return { x: c[0], y: c[1], width: c[2], height: c[3] }
  return null
}

export function registerTools ({ ctx, cu, config, dataDir, log, snapshotPath, defineTool, hooks, ensureCycle, register }) {
  const observations = new ObservationStore()
  const saveShot = (buf, ext = 'jpg') => {
    const p = snapshotPath(dataDir).replace(/\.jpg$/, `.${ext}`)
    return saveOwnedShot(dataDir, p, buf)
  }

  // Shared by direct calls, explicit batch steps, and the batch checkpoint.
  const takeScreenshot = async (args, exec) => {
    const r = rect(args.region)
    const shot = await cu.screenshot({
      x: r && r.x, y: r && r.y, width: r && r.width, height: r && r.height,
      preset: args.preset, format: args.png ? 'png' : 'jpeg', cursor: true, wait: args.wait,
      maxWidth: r && r.width <= 900 ? r.width : 1280,
    })
    const path = saveShot(shot.image, shot.mime === 'image/png' ? 'png' : 'jpg')
    const res = { path, mime: shot.mime, region: shot.region }
    if (typeof shot.settled === 'boolean') res.settled = shot.settled
    return attachScreenshot(ctx, exec, res, shot.image)
  }

  const clickTarget = async (args) => {
    const target = args.mark ? { mark: args.mark } : pt(args.at)
    if (args.shift || args.dx !== undefined || args.dy !== undefined) {
      const p = await cu.resolveTarget(target)
      const x = p.x + (args.dx || 0), y = p.y + (args.dy || 0)
      const options = { ...args, ...(p.expectHwnd ? { expectHwnd: p.expectHwnd } : {}) }
      return args.shift ? cu.shiftClick(x, y, options) : cu.click({ x, y }, options)
    }
    return cu.click(target, args)
  }

  const queryUia = async (args, exec) => {
    if (args.snapshot) return observations.get(exec, args.snapshot, 'uia')
    const p = pt(args.at)
    if (p && p.x !== undefined) return cu.call('uiaFromPoint', { x: p.x, y: p.y })
    // Identity witnesses help an intended action, but are expensive for a broad inventory.
    const targets = !!args.hwnd && (args.targets ?? !!(args.id || args.name))
    const res = await cu.call('uia', { hwnd: args.hwnd, depth: args.depth ?? 16, maxNodes: 3000,
      query: true, targets, role: args.role, nameContains: args.name, automationId: args.id, limit: args.limit ?? 80 })
    return observations.publish(exec, 'uia', [args.hwnd ?? null, args.depth ?? 16, args.role ?? null, args.name ?? null, args.id ?? null, args.limit ?? 80, targets],
      { count: res.count, elements: res.flat || [], scanned: res.scanned, truncated: res.truncated, hwnd: res.hwnd ?? args.hwnd, pid: res.pid }, args.since)
  }
  const actUia = (args, exec) => {
    if (args.target && !observations.ownsTarget(exec, args.target)) {
      throw Object.assign(new Error('TARGET_NOT_OBSERVED: obtain a fresh computer_uia target in this Agent before acting'), { code: 'TARGET_NOT_OBSERVED', outcome: 'not-dispatched' })
    }
    return cu.uiaAct({ hwnd: args.hwnd, nameContains: args.name, automationId: args.id, target: args.target, allowRebind: args.rebind === true,
      role: args.role, action: args.action, value: args.value, requireUnique: true, depth: args.depth ?? 24, maxNodes: 3500 })
  }
  const observeState = async (args, exec) => {
    if (args.snapshot) return observations.get(exec, args.snapshot, 'state')
    const result = args.windows ? await cu.call('windows', {}) : await cu.screenState({ uiaDepth: args.depth })
    return observations.publish(exec, 'state', [!!args.windows, args.depth ?? 6], result, args.since)
  }

  // Lossless-JSON guard on EVERY tool result. 2026-09-12: a tool returned `settleNote: undefined`
  // and the harness rejected the whole result as "value is not lossless JSON" AFTER the work was
  // done — the screenshot existed but its path never reached the model. Normalise once, here.
  const lossless = (v) => {
    if (v === undefined) return undefined
    try {
      return JSON.parse(JSON.stringify(v, (k, x) => (typeof x === 'number' && !Number.isFinite(x) ? null : x)))
    } catch { return { error: 'tool result was not serialisable' } }
  }

  // one implementation for the tool AND for computer_batch (merge-design.md §5.4 item 23): a batch
  // step that asks a question must reach the SAME card and the SAME answer, and there must not be
  // two orchestrations to keep in step. The pause decision travels inside the answer record that
  // `hooks.askHuman` returns (it is the human's own choice on the card, D3), so nothing here derives
  // it from how the call ended.
  const askQuestion = (args, exec) => cu.ask({
    question: args && args.question,
    onAsk: (info) => hooks.askHuman(args && args.question, info, exec),
  })

  const reg = (def) => {
    const inner = def.execute
    def.execute = async (args, exec) => {
      // hooks drive the "the agent stopped driving" signal: the activity border is cut the
      // instant the last computer-use call of a turn finishes.
      if (hooks && hooks.onStart) { try { hooks.onStart(exec) } catch { /* never break a tool */ } }
      try {
        // ---- THE BRAKE IS A VERDICT: STOP, DO NOT TAKE ONE MORE STEP -------------------------------
        // The human's brake stops the MACHINE; before this check it did not stop the AGENT, because
        // observations stayed legal while paused and `agent.steer`'s "wrap up" notice only lands at a
        // step boundary. The agent therefore always had one more legal move and kept taking it — the
        // human's own report: "卡停就是让你停住, 关键是你没停啊? 你还在思考中啊". Refusing HERE, at the
        // one door every computer_* call goes through, makes the wrap-up directive the RESULT of the
        // call already being made, so there is no boundary to wait for and nothing to miss.
        // `hooks.askBlocked` returns null unless the cycle is actually paused, and null for the
        // safety-direction tools (`computer_ctrl`, `computer_ask` — see lib/index.js); `ended` remains
        // the cycle gate's verdict, not this one's.
        if (hooks && hooks.askBlocked) {
          let why = null
          try { why = hooks.askBlocked(def.name) } catch { why = null }   // never let the guard break a tool
          if (why) {
            const err = new Error(why)
            err.dshCycleRefusal = true
            throw err
          }
        }
        // ---- THE CYCLE IS OPENED HERE, AND `await` IS THE WHOLE POINT ---------------------------------
        // This wrapper is the ONE point every computer_* invocation passes through exactly once, and
        // it is the LAST point before the tool body (and therefore the worker op) runs: the await
        // below resolves — the worker having ANSWERED the `resume` op — before `inner()` is even
        // entered, let alone before any `cu.*` call writes to the worker's stdin. Ordering is
        // enforced by the same async chain, so there is nothing to race: no host event has to arrive
        // first, no session has to be recognised first. It is also why this is not in
        // tools/pre-execute: that hook is a host waterfall whose await semantics belong to the host,
        // while this one is a line of our own code, and it covers every dispatch path there is —
        // including computer_batch, whose steps go straight to the shared HANDLERS map (the cycle is
        // already open and the latch makes the second call a no-op).
        // `ensureCycle` itself is what decides whether an opener is needed at all, and it is the
        // component that refuses to touch a brake (see lib/index.js).
        // A call that is ALREADY cancelled never reaches the worker (the same check runs again after
        // the opener is awaited — the await is exactly where a human's Ctrl+Alt+Q can land).
        if (exec && exec.signal && exec.signal.aborted) {
          const err = new Error('not dispatched: this call was cancelled before dispatch')
          err.dshCycleRefusal = true
          throw err
        }
        if (ensureCycle) {
          let opened = null
          try { opened = await ensureCycle(exec) } catch (e) {
            // An OWNERSHIP refusal is a VERDICT, not a hiccup: another session owns this machine
            // right now, so this call must fail loudly rather than drive anyway (lib/cycle.js tags
            // it; a failed *opener* keeps the old quiet path — the worker's own refusal follows).
            if (e && e.dshCycleRefusal) throw e
            if (log && typeof log.warn === 'function') log.warn(`cycle open failed: ${e.message}`)
          }
          // A VOIDED OPENING IS A REFUSAL, NOT A WARNING (integration gap, Codex review 2026-09-13).
          // Ignoring this return value let an op whose opening the exit had already cancelled go on
          // to be written to the worker — and the opener's `resume` may have cleared the record a
          // moment before the human ended the session again, so the worker had nothing left to refuse.
          // The same check runs on the cancellation signal, which can also fire while the opener is
          // awaited; both are checked at the point where the op would enter the worker, not earlier.
          if (opened && opened.voided) {
            const err = new Error(
              `not dispatched: ${opened.reason}. The computer-use cycle was ended while this call was ` +
              'opening it, so nothing was sent to the worker. Do not retry in this turn — a new cycle ' +
              'needs a new turn, and Ctrl+Alt+R is the human\'s.')
            err.dshCycleRefusal = true
            throw err
          }
          if (exec && exec.signal && exec.signal.aborted) {
            const err = new Error('not dispatched: this call was cancelled while the cycle was opening')
            err.dshCycleRefusal = true
            throw err
          }
        }
        // ---- THE ONLY HONEST PLACE TO SAY "THIS ACTUATION REACHED THE WORKER" (2026-09-16) ----------
        // Every refusal above this line THROWS (an ownership verdict, a voided opening, a cancellation),
        // and the brake/policy refusals live ABOVE the whole wrapper in `reg`. So this point — the last
        // statement before the tool body — is the one where "it will actually be dispatched" is true.
        // The turn-end card's recommendation is derived from exactly this (see the plugin's
        // `turnSituation`): a call that was denied, refused or cancelled must NOT claim the task was in
        // motion, and a call the human APPROVED high-risk must not be invisible either. An earlier version
        // marked it in `tools/pre-execute`, which runs BEFORE all of these, and produced both errors.
        // `hooks` IS OPTIONAL HERE, not just the member: `registerTools` may be called without one (a
        // registration-only probe does exactly that), and the earlier `hooks.onDispatch` form threw
        // `Cannot read properties of undefined` straight into the dispatch path.
        if (hooks && hooks.onDispatch) { try { hooks.onDispatch(exec) } catch { /* never break a dispatch for a log */ } }
        const out = await inner(args, exec)
        if (out === undefined || out === null) return out
        const safe = lossless(out)
        return safe === undefined ? null : safe
      } finally {
        if (hooks && hooks.onEnd) { try { hooks.onEnd(exec) } catch { /* never break a tool */ } }
      }
    }
    const definition = defineTool(def)
    if (register) register(definition)
    else ctx.tools.register(definition)
  }

  // Render helpers.
  //
  // BUG (2026-09-13, exposed by the very first call after deploying the rewrite): `out(json)`
  // handed the JSON helper straight to `render(a, v)`, so the ARGS OBJECT landed in `json`'s
  // second parameter — which is `cap` — and `String.slice(0, {})` coerces to `.slice(0, 0)`:
  // every tool using it returned an EMPTY string, silently. A render function takes (args, value)
  // and must ignore args; `outJSON()` is the only correct way to ask for the plain-JSON render.
  // build/test-renders.mjs now fails loudly if any registered tool renders empty.
  const TXT = (v, cap = 30_000) => [{ type: 'text', text: typeof v === 'string' ? v.slice(0, cap) : JSON.stringify(v ?? null, null, 1).slice(0, cap) }]
  const out = (render) => ({ schema: { type: 'object', additionalProperties: true }, render })
  const outJSON = () => out((a, v) => TXT(v))
  const outObservation = () => out((_a, value) => [{ type: 'text', text: JSON.stringify(value) }])

  // ---------------- observation ----------------
  reg({
    name: 'computer_shot',
    description: "Screenshot; inspect its attachment directly, or follow view if path-only. KICKOFF: first computer_state {windows:true}, then activate the target with computer_window; require activated:true. settled:false needs a fresh shot.",
    parameters: {
      region: P('string', 'crop "x,y,w,h" (default: whole screen)'),
      preset: P('string', 'taskbar'),
      png: P('boolean', 'PNG instead of JPEG'),
      wait: P('string', 'auto (default) | none'),
    },
    output: out((a, v) => renderScreenshot(v)),
    isConcurrencySafe: () => false,
    timeoutMs: 30_000,
    execute: takeScreenshot,
  })

  reg({
    name: 'computer_state',
    description: "Window/UIA state; start with windows:true, then activate the target. since returns fresh changes against that observation; omit for full. snapshot retrieves a retained full observation for this Agent.",
    parameters: {
      windows: P('boolean', 'windows only (no tree)'),
      depth: P('number', 'tree depth (default 6)'),
      since: P('string', 'base observation ID for changes; invalid base returns full'),
      snapshot: P('string', 'retrieve this full observation without capturing again'),
    },
    output: outObservation(),
    isConcurrencySafe: () => false,
    timeoutMs: 30_000,
    execute: observeState,
  })

  reg({
    name: 'computer_marks',
    description: "Cached UIA map with snapshot IDs. Reuse while unchanged; mark actions check window identity, geometry and sampled pixels. STALE_MARK requires refresh and reselecting the intended element. Refreshed IDs replace old IDs.",
    parameters: {
      hwnd: P('number', 'window (default: active)'),
      shot: P('boolean', 'also return a marked-up screenshot path'),
      refresh: P('boolean', 'rebuild instead of reusing the cache'),
    },
    output: out((a, v) => {
      if (!v || !v.marks) return [{ type: 'text', text: 'no marks' }]
      const head = `marks ${v.count}${v.reused ? ' (cached)' : ''} hwnd=${v.hwnd}` + (v.annotatedShot ? `\nannotatedShot: ${v.annotatedShot}` : '')
      return [{ type: 'text', text: head + '\n' + v.marks.map(m => `${m.id} [${m.role}] (${m.center[0]},${m.center[1]}) ${m.name}`).join('\n') }]
    }),
    isConcurrencySafe: () => false,
    timeoutMs: 45_000,
    async execute (args) {
      const res = await cu.landmarks({ hwnd: args.hwnd, refresh: args.refresh })
      const res2 = {
        count: res.count, reused: !!res.reused, hwnd: res.hwnd,
        marks: res.marks.map(m => ({ id: m.id, role: m.role, name: m.name, center: [m.cx, m.cy] })),
      }
      if (args.shot) {
        const m = await cu.marks({ annotated: true, hwnd: args.hwnd, landmarkMap: res })
        if (m.annotated) res2.annotatedShot = saveShot(m.annotated)
      }
      return res2
    },
  })

  reg({
    name: 'computer_uia',
    description: "Query hwnd plus role/name/exact id; returns controls and patterns. Scoped name/id queries also return target handles. since gives fresh changes; omit for full. snapshot retrieves a retained full result. at hit-tests. truncated:true is partial evidence.",
    parameters: {
      at: P('string', 'hit test at "x,y"'),
      hwnd: P('number', 'window; omit to search desktop'),
      role: P('string', 'Button | Edit | Hyperlink | TabItem | ...'),
      name: P('string', 'name substring'),
      id: P('string', 'exact AutomationId from UIA'),
      targets: P('boolean', 'recovery handles; default on for hwnd + name/id, off for broad queries'),
      limit: P('number', 'maximum matches, 1–80 (default 80)'),
      depth: P('number', 'tree depth, 1–24 (default 16)'),
      since: P('string', 'base observation ID; repeat the same query'),
      snapshot: P('string', 'retrieve a retained full observation ID'),
    },
    output: outObservation(),
    isConcurrencySafe: () => false,
    timeoutMs: 45_000,
    execute: queryUia,
  })

  reg({
    name: 'computer_uia_act',
    description: "Act through UIA. Prefer an observed target handle; rebind:true permits unique identity/semantic recovery inside the same window. Or use hwnd + exact id. Ambiguous, changed or incomplete evidence refuses; verify readback.",
    parameters: {
      hwnd: P('number', 'window (default: desktop)'),
      name: P('string', 'element name substring'),
      id: P('string', 'exact AutomationId from UIA; scope with hwnd'),
      role: P('string', 'TabItem | Button | ListItem | ComboBox | Edit | MenuItem'),
      action: P('string', 'invoke (default) | select | expand | collapse | toggle | setValue | focus | scrollIntoView'),
      value: P('string', 'value for setValue'),
      depth: P('number', 'tree depth, 1–24 (default 24)'),
      target: P('string', 'opaque target from computer_uia; do not combine with selectors'),
      rebind: P('boolean', 'allow unique recovery if the observed native element was replaced'),
    },
    output: outJSON(),
    isConcurrencySafe: () => false,
    timeoutMs: 20_000,
    execute: actUia,
  })

  // ---------------- actuation ----------------
  reg({
    name: 'computer_click',
    description: "Click mark or screen coordinates; dx/dy offset either form. Mark IDs refer to an observed snapshot, not a moving target. STALE_MARK needs a fresh map and re-selection. Check returned focus and receiver.",
    parameters: {
      mark: P('string', 'mark id, e.g. "M7" (preferred)'),
      at: P('string', '"x,y" instead of a mark'),
      dx: P('number', 'offset from the mark centre: +x px'),
      dy: P('number', 'offset from the mark centre: +y px'),
      button: P('string', 'left (default) | right | middle'),
      clicks: P('number', '1 | 2 (double) | 3 (triple)'),
      shift: P('boolean', 'hold SHIFT (range selection)'),
    },
    output: outJSON(),
    isConcurrencySafe: () => false,
    timeoutMs: 15_000,
    execute: clickTarget,
  })

  reg({
    name: 'computer_move',
    description: "Move without clicking to reveal hover controls.",
    parameters: { at: P('string', '"x,y"', { required: true }) },
    output: outJSON(),
    isConcurrencySafe: () => false,
    timeoutMs: 15_000,
    async execute (args) {
      const p = pt(args.at)
      if (!p || p.x === undefined) throw new Error('at must be "x,y"')
      return cu.move(p.x, p.y)
    },
  })

  reg({
    name: 'computer_drag',
    description: "Drag between measured points. Prefer computer_select for text ranges.",
    parameters: {
      from: P('string', '"M3" or "x,y"', { required: true }),
      to: P('string', '"M7" or "x,y"', { required: true }),
    },
    output: outJSON(),
    isConcurrencySafe: () => false,
    timeoutMs: 15_000,
    async execute (args) {
      return cu.drag(await cu.resolveTarget(pt(args.from)), await cu.resolveTarget(pt(args.to)))
    },
  })

  reg({
    name: 'computer_scroll',
    description: "Wheel at a mark/point, or at the current pointer when at is omitted. Refresh marks after scrolling.",
    parameters: {
      dir: P('string', 'up | down | left | right', { required: true }),
      at: P('string', 'scroll at "M3" or "x,y"'),
      lines: P('number', 'notches (default 3)'),
    },
    output: outJSON(),
    isConcurrencySafe: () => false,
    timeoutMs: 15_000,
    async execute (args) {
      const at = pt(args.at)
      return cu.scroll(args.dir, args.lines || 3, at ? { at } : {})
    },
  })

  reg({
    name: 'computer_select',
    description: "Click anchor, optionally scroll, then shift-click the end. Use measured points valid for each step.",
    parameters: {
      from: P('string', 'anchor "M3" or "x,y"', { required: true }),
      to: P('string', 'end "M7" or "x,y"', { required: true }),
      clicks: P('number', 'clicks on each end: 2 word | 3 block (default 1 caret)'),
      scroll: P('number', 'wheel notches between the ends (negative = up)'),
    },
    output: outJSON(),
    isConcurrencySafe: () => false,
    timeoutMs: 30_000,
    async execute (args) {
      const a = await cu.resolveTarget(pt(args.from))
      const b = await cu.resolveTarget(pt(args.to))
      return cu.selectRange({
        fromX: a.x, fromY: a.y, toX: b.x, toY: b.y,
        fromClicks: args.clicks, toClicks: args.clicks, scrollClicks: args.scroll,
      })
    },
  })

  reg({
    name: 'computer_key',
    description: "Press a key combo, e.g. ctrl+shift+t. Activate the target first; missing target or failed refocus refuses input.",
    parameters: { combo: P('string', 'e.g. "ctrl+a"', { required: true }) },
    output: outJSON(),
    isConcurrencySafe: () => false,
    timeoutMs: 15_000,
    async execute (args) { return cu.key(args.combo) },
  })

  reg({
    name: 'computer_type',
    description: "Type into the focused field; target it first. CJK/long text uses paste. Check receiver/readback. Passwords require existing explicit consent and allowPassword.",
    parameters: {
      text: P('string', 'text to type', { required: true }),
      mode: P('string', 'unicode | paste (default: auto)'),
      allowPassword: P('boolean', 'human consented to typing a password'),
    },
    output: outJSON(),
    isConcurrencySafe: () => false,
    timeoutMs: 30_000,
    async execute (args) { return cu.type(args.text, { mode: args.mode, allowPassword: args.allowPassword }) },
  })

  reg({
    name: 'computer_window',
    description: "Activate a known hwnd and require activated:true before capture/input. Other operations: minimize, maximize, restore, close, move. A failed activation stops a batch.",
    parameters: {
      hwnd: P('number', 'window handle', { required: true }),
      op: P('string', 'activate (default) | minimize | maximize | restore | close | move'),
      rect: P('string', 'for move: "x,y,w,h"'),
    },
    output: outJSON(),
    isConcurrencySafe: () => false,
    timeoutMs: 15_000,
    async execute (args) {
      const sel = { hwnd: args.hwnd }
      const op = args.op || 'activate'
      if (op === 'activate') return cu.activateWindow(sel)
      return cu.windowOp(sel, op, rect(args.rect) || {})
    },
  })

  reg({
    name: 'computer_clip',
    description: "Read the clipboard, or write text. Use only content needed for the task.",
    parameters: { text: P('string', 'text to put on the clipboard; omit to read') },
    output: out((a, v) => [{ type: 'text', text: JSON.stringify(v).slice(0, 10_000) }]),
    isConcurrencySafe: () => false,
    timeoutMs: 10_000,
    async execute (args) { return args.text === undefined ? cu.clipRead() : cu.clipWrite(args.text) },
  })

  // ---------------- the agent asks ----------------
  reg({
    name: 'computer_ask',
    description: "Pause and ask one necessary question on the DSH chat card; no countdown. The human selects then confirms. ② 放你走 (recommended), a custom answer, dismissal or cancellation releases the ask brake; ① 让你停 keeps it until Ctrl+Alt+R. Inspect keepPause. Existing authorization needs no repeat question.",
    parameters: {
      question: P('string', 'the one short question to put in front of the human', { required: true }),
    },
    output: outJSON(),
    isConcurrencySafe: () => false,
    // THE TOOL'S DEADLINE IS A WEDGE DETECTOR, NOT A GUILLOTINE (merge-design.md §3, D2) — AND IT IS
    // ALSO THE CARD'S REAPER. Both halves matter, and the second one is measured
    // (merge-abort-evidence.md, V1 caveat):
    //
    //   * The host's timeout policy is COOPERATIVE: `deadline(exec.signal, timeoutMs, TOOL_TIMEOUT)`
    //     (dsh-tool-call-timeout-policy/lib/index.js:125, dsh-timeout/lib/index.js:63-72,
    //     `AbortSignal.any([upstream, timer.signal])`) aborts a signal, it does not cancel the body —
    //     the wrapper `await next()`s and substitutes a TOOL_TIMEOUT result only AFTER our promise
    //     settles (:129-131). So the `finally` in `core.ask()` always gets to release the brake.
    //   * But the signal it aborts is THE SAME ONE we hand to `ask({signal})`. So at T+1 h the human's
    //     CARD IS TORN DOWN, `ask` settles `ASK_ABORTED`, the brake is released, and only then does
    //     the policy replace the result with TOOL_TIMEOUT. That is correct behaviour, and it is why
    //     this number must stay far above any human answer time.
    //
    // THE HUMAN ASKED FOR "WAIT FOR THE ANSWER FOR EVER, NO TIMEOUT". This one line is where that
    // instruction is implemented as a one-hour compromise: a truly unbounded wait is permitted (omit
    // `timeoutMs` and the policy returns early at :124), but then a bug — an answerer that never
    // settles — hangs a turn with no ceiling and no `TOOL_TIMEOUT` breadcrumb. One hour is long
    // enough that no human answer is ever cut off at the card, and short enough that a genuine wedge
    // is diagnosable. It must stay ABOVE the core's own 15 s ask deadline, which is a literal and is
    // never derived from this one (G3). The old 75_000 was 60 s of worker-side countdown plus slack,
    // and its whole reason for existing is gone.
    timeoutMs: 3_600_000,
    async execute (args, exec) { return askQuestion(args, exec) },
  })

  // ---------------- flow ----------------
  reg({
    name: 'computer_wait',
    description: "Wait for idle, stable pixels or a pixel change. A change or timeout does not establish task success/failure; inspect before replaying a write.",
    parameters: {
      mode: P('string', 'idle (default) | stable | change'),
      timeoutMs: P('number', 'hard cap (default 5000/8000/6000 by mode)'),
    },
    output: outJSON(),
    isConcurrencySafe: () => false,
    timeoutMs: 35_000,
    async execute (args) {
      if (args.mode === 'stable') return cu.waitStable({ timeoutMs: args.timeoutMs })
      if (args.mode === 'change') return cu.waitChange({ timeoutMs: args.timeoutMs })
      return cu.waitForIdle({ timeoutMs: args.timeoutMs })
    },
  })

  reg({
    name: 'computer_batch',
    description: "Run actions serially to a checkpoint; failure or cancellation stops later steps. Reuse readback; auto adds at most one needed image. Action ok does not verify the business result.",
    parameters: {
      actions: P('array', '[{tool:"computer_click", args:{mark:"M3"}}, ...]', { required: true }),
      shot: P('string', 'auto (default) | always | never; no automatic image after failure, cancel or pause'),
    },
    output: out((a, v) => [
      ...TXT(v),
      ...(v.observation?.image ? [
        { type: 'text', text: `Attached image: ${v.imageSource}.` },
        ...renderScreenshot(v.observation),
      ] : []),
    ]),
    isConcurrencySafe: () => false,
    timeoutMs: 120_000,
    async execute (args, exec) {
      let automatic
      const result = await runBatch({ steps: args.actions, handlers: HANDLERS, signal: exec && exec.signal,
        stopped: () => cu.stopped || cu.exited, shot: args.shot, exec,
        screenshot: async () => { automatic = await takeScreenshot({}, exec); return automatic.path } })
      return selectBatchScreenshot(result, automatic)
    },
  })

  // ---------------- meta ----------------
  reg({
    name: 'computer_ctrl',
    description: 'Control. "stop" = raise the emergency brake; human/default stops require Ctrl+Alt+R. temporary:true creates your diagnostic pause. recover requires pauseId and a fresh observation of the resolved blocker. exit ends the cycle. selftest/calibrate diagnose input; indicator controls the border; acknowledge accepts the exact skill receipt.',
    parameters: {
      action: P('string', 'selftest | calibrate | stop | exit | indicator | acknowledge | recover', { required: true }),
      why: P('string', 'reason recorded with a stop'),
      temporary: P('boolean', 'stop: explicitly agent-owned diagnostic pause, eligible for checked recovery; ordinary waits use computer_wait'),
      pauseId: P('string', 'recover: credential returned by an explicit temporary stop'),
      on: P('boolean', 'indicator: true = light, false = clear'),
      text: P('string', 'acknowledge: the exact phrase quoted from the computer-use skill; every DRIVING call is refused until it is passed'),
    },
    output: out((a, v) => TXT(v.mode
      ? { mode: v.mode, inputPass: v.inputPass, maxErrorPx: v.maxErrorPx, visualAnchor: v.visualAnchor }
      : v)),
    isConcurrencySafe: () => false,
    timeoutMs: 30_000,
    async execute (args, exec) {
      switch (args.action) {
        case 'stop': return args.temporary ? hooks.temporaryStop(exec, args.why) : cu.panic(args.why)
        case 'recover': return hooks.recover(exec, args.pauseId)
        // THE READ-RECEIPT (2026-09-13, human's rule: "未先读 skill 时拒绝驱动类 op"). The plugin's
        // tools/pre-execute gate refuses every DRIVING call until the session has produced the exact
        // phrase that exists only inside the computer-use skill; this action is how it is produced.
        // The gate validated `args.text` before this handler ran, so there is nothing to check here.
        case 'acknowledge': return { acknowledged: true, note: 'procedure acknowledged — driving is open for this session' }
        // "exit" was advertised in the description above but NEVER WIRED here: the call fell
        // through to `default: selftest`, so computer_ctrl{action:"exit"} returned an input-path
        // health report instead of ending the session. The batch handler below always had it.
        case 'exit': return cu.exit(args.why)
        case 'calibrate': return cu.calibrate({})
        case 'indicator': return cu.indicator({ on: args.on !== false })
        // The `resume` ACTION IS GONE (2026-09-13). It used to call the core's cycle opener, which
        // un-latches Ctrl+Alt+Q — so a TOOL CALL could re-open a cycle the human had ended. A new
        // cycle is opened by the PLUGIN, never by an op the model can name: `ensureCycle` does it,
        // once per turn, on the first computer_* call that actually reaches the worker (and never
        // while a brake is up), while a pause is released only by the human's Ctrl+Alt+R.
        // Refusing LOUDLY matters: falling through to `default: selftest` would hand a stale
        // caller a health report it could read as a successful re-arm.
        case 'resume': throw new Error(
          'action "resume" no longer exists: no tool call may open or re-open a computer-use ' +
          'cycle. After Ctrl+Alt+Q the PLUGIN opens a new cycle on the first computer_* call of a ' +
          'later turn — you do not have to ask for it, and you cannot force it; a pause is released ' +
          'only by the human pressing Ctrl+Alt+R.')
        default: return cu.selfTest()
      }
    },
  })

  // Shared handlers so computer_batch can re-run any of the above.
  const HANDLERS = {
    computer_click: clickTarget,
    computer_move: (a) => { const p = pt(a.at); return cu.move(p.x, p.y) },
    computer_drag: async (a) => cu.drag(await cu.resolveTarget(pt(a.from)), await cu.resolveTarget(pt(a.to))),
    computer_scroll: (a) => cu.scroll(a.dir, a.lines || 3, pt(a.at) ? { at: pt(a.at) } : {}),
    computer_select: async (a) => {
      const f = await cu.resolveTarget(pt(a.from)); const t = await cu.resolveTarget(pt(a.to))
      return cu.selectRange({ fromX: f.x, fromY: f.y, toX: t.x, toY: t.y, fromClicks: a.clicks, toClicks: a.clicks, scrollClicks: a.scroll })
    },
    computer_key: (a) => cu.key(a.combo),
    computer_type: (a) => cu.type(a.text, { mode: a.mode, allowPassword: a.allowPassword }),
    computer_window: (a) => ((a.op || 'activate') === 'activate' ? cu.activateWindow({ hwnd: a.hwnd }) : cu.windowOp({ hwnd: a.hwnd }, a.op, rect(a.rect) || {})),
    computer_clip: (a) => (a.text === undefined ? cu.clipRead() : cu.clipWrite(a.text)),
    computer_uia_act: actUia,
    computer_ask: (a, exec) => askQuestion(a, exec),
    computer_wait: (a) => a.mode === 'stable' ? cu.waitStable({ timeoutMs: a.timeoutMs })
      : a.mode === 'change' ? cu.waitChange({ timeoutMs: a.timeoutMs }) : cu.waitForIdle({ timeoutMs: a.timeoutMs }),
    // The observation tools and the meta tool were missing from this map, so a batch could not
    // take a screenshot: "unknown tool computer_shot" (reported 2026-09-12). The map must cover
    // the WHOLE surface — a caller should never have to know which subset happens to be wired.
    computer_shot: takeScreenshot,
    computer_state: observeState,
    computer_marks: async (a) => {
      const res = await cu.landmarks({ hwnd: a.hwnd, refresh: a.refresh })
      const res2 = {
        count: res.count, reused: !!res.reused, hwnd: res.hwnd,
        marks: res.marks.map(m => ({ id: m.id, role: m.role, name: m.name, center: [m.cx, m.cy] })),
      }
      if (a.shot) {
        const m = await cu.marks({ annotated: true, hwnd: a.hwnd, landmarkMap: res })
        if (m.annotated) res2.annotatedShot = saveShot(m.annotated)
      }
      return res2
    },
    computer_uia: queryUia,
    computer_ctrl: (a, exec) => {
      switch (a.action) {
        case 'stop': return a.temporary ? hooks.temporaryStop(exec, a.why) : cu.panic(a.why)
        case 'recover': return hooks.recover(exec, a.pauseId)
        case 'acknowledge': return { acknowledged: true, note: 'procedure acknowledged — driving is open for this session' }
        case 'exit': return cu.exit(a.why)
        case 'calibrate': return cu.calibrate({})
        case 'indicator': return cu.indicator({ on: a.on !== false })
        // Same refusal as the tool path above: `resume` is not an action any more, and it must not
        // be reachable through computer_batch either.
        case 'resume': throw new Error(
          'action "resume" no longer exists: no tool call may open or re-open a computer-use ' +
          'cycle (the PLUGIN opens one on the first computer_* call of a later turn, and only the ' +
          'human\'s Ctrl+Alt+R releases a pause).')
        default: return cu.selfTest()
      }
    },
  }
}
