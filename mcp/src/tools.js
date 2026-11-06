import { runBatch, actionRefusal } from '../../lib/batch.js'
import { parseKeyCommand } from '../../lib/key-command.js'
import { splitMediaResult } from '../../lib/media-contract.js'

// This adapter owns transport names only. Serial failure/cancellation/result
// semantics are shared with the DSH adapter through runBatch.
export function createMcpToolSurface (cu, { allowInput = false } = {}) {
const MUTATION_NOTE = ' Input requires host authorization configured at startup with DSH_CU_ALLOW_INPUT=1. Tool calls cannot enable it.'
const tools = [
  {
    name: 'cu_screenshot',
    description: 'Capture the screen (or a region). Returns a JPEG/PNG image plus cursor position and capture region metadata. Coordinates everywhere are absolute screen pixels unless a mark id is used.',
    inputSchema: {
      type: 'object', additionalProperties: false,
      properties: {
        x: { type: 'integer' }, y: { type: 'integer' },
        width: { type: 'integer' }, height: { type: 'integer' },
        format: { type: 'string', enum: ['jpeg', 'png'], description: 'png for text-precise scenes' },
        quality: { type: 'integer', minimum: 40, maximum: 95 },
        maxWidth: { type: 'integer', description: 'downscale width; default 1280' },
        cursor: { type: 'boolean', description: 'draw the mouse cursor into the shot' },
      },
    },
  },
  {
    name: 'cu_screen_state',
    description: 'Text-first screen state: active window, visible top-level windows, cursor, and a shallow UIA (accessibility) tree of the active window. Works without vision. Use this as your primary observation; screenshots verify.',
    inputSchema: {
      type: 'object', additionalProperties: false,
      properties: {
        uiaDepth: { type: 'integer', minimum: 1, maximum: 24 },
        uiaMaxNodes: { type: 'integer', minimum: 10, maximum: 1200 },
      },
    },
  },
  {
    name: 'cu_marks',
    description: 'Set-of-Marks: labels clickable UI elements M1..Mn (from UIA) and returns an annotated screenshot + a mark table. Marks are snapshots: refresh after scrolling or changes; stale evidence refuses input.',
    inputSchema: {
      type: 'object', additionalProperties: false,
      properties: {
        maxMarks: { type: 'integer', minimum: 5, maximum: 120 },
        uiaDepth: { type: 'integer', minimum: 1, maximum: 12 },
      },
    },
  },
  {
    name: 'cu_windows',
    description: 'List visible top-level windows (title, class, process, rect, active, minimized).',
    inputSchema: { type: 'object', additionalProperties: false, properties: {} },
  },
  {
    name: 'cu_uia_query',
    description: 'Bounded UIA query inside an explicit window. Default depth6/120 nodes/1200ms soft budget. Broad searches require an observed point anchor. Truncated results are partial evidence; a single provider call cannot be preempted.',
    inputSchema: {
      type: 'object', additionalProperties: false,
      properties: {
        hwnd: { type: 'integer' }, titleContains: { type: 'string' },
        depth: { type: 'integer', minimum: 1, maximum: 24 },
        maxNodes: { type: 'integer', minimum: 10, maximum: 1200 },
        role: { type: 'string', description: 'e.g. Button, Edit, Hyperlink, TabItem' },
        nameContains: { type: 'string' },
        anchor: { type: 'string', description: 'Observed screen point "x,y" inside hwnd; query its subtree' },
        budgetMs: { type: 'integer', minimum: 100, maximum: 5000 },
      },
    },
  },
  {
    name: 'cu_uia_at_point',
    description: 'What UI element is at screen point (x,y)? Returns the element plus ancestors — use to verify a click target before clicking.',
    inputSchema: {
      type: 'object', additionalProperties: false, required: ['x', 'y'],
      properties: { x: { type: 'integer' }, y: { type: 'integer' } },
    },
  },
  {
    name: 'cu_cursor',
    description: 'Current mouse cursor position.',
    inputSchema: { type: 'object', additionalProperties: false, properties: {} },
  },
  {
    name: 'cu_clipboard_read',
    description: 'Read the text clipboard.',
    inputSchema: { type: 'object', additionalProperties: false, properties: {} },
  },
  {
    name: 'cu_wait',
    description: 'Wait until the UI goes idle (foreground window + focused element stable) or timeout.',
    inputSchema: {
      type: 'object', additionalProperties: false,
      properties: {
        timeoutMs: { type: 'integer', maximum: 30000 },
        stableMs: { type: 'integer', maximum: 5000 },
      },
    },
  },
  // ---- mutation tools ----
  tool('cu_release', 'Release computer-use ownership as soon as desktop work and verification are finished, even while the conversation continues. Preserves a manual pause or pending question. Later desktop work can start a fresh cycle.', {
    type: 'object', additionalProperties: false, properties: {},
  }, false),
  tool('cu_hold', 'Reserve the current scene between actions (breathing blue); human takeover remains authoritative.', { type: 'object', additionalProperties: false, properties: {} }, false),
  tool('cu_free', 'Release scene reservation while keeping observation available (cyan).', { type: 'object', additionalProperties: false, properties: {} }, false),
  tool('cu_approve', 'Explain host-managed authorization. This compatibility tool cannot grant approval or enable input.', {
    type: 'object', additionalProperties: false,
    properties: { minutes: { type: 'integer', minimum: 1, maximum: 10, description: 'Ignored; accepted only for old clients.' } },
  }, false),
  tool('cu_move', 'Hover without clicking; returns Windows standard cursor evidence. Browser/custom cursors may be unrecognized; unknown proves neither a handle hit nor a miss.', {
    type: 'object', additionalProperties: false, required: ['x', 'y'],
    properties: { x: { type: 'integer' }, y: { type: 'integer' } },
  }),
  tool('cu_click', 'Click the mouse (left/right/middle; single/double/triple) at a mark or point.', {
    type: 'object', additionalProperties: false,
    properties: {
      mark: { type: 'string', description: 'mark id from cu_marks, e.g. "M7"' },
      x: { type: 'integer' }, y: { type: 'integer' },
      button: { type: 'string', enum: ['left', 'right', 'middle'] },
      clicks: { type: 'integer', minimum: 1, maximum: 3, description: '2=double 3=triple' },
      verificationRegion: { type: 'string', description: 'Expected effect rectangle "x,y,w,h" in screen pixels, independent of click location. Pixel change does not prove semantic success.' },
    },
  }),
  tool('cu_drag', 'Drag measured screen points. Optional expectCursor checks a recognized Windows standard shape before button-down; browser/custom cursors may be unverifiable. Ground those handles independently. cursorCheck says matched or not-requested; completion is delivery, not proof of layout success.', {
    type: 'object', additionalProperties: false,
    properties: {
      fromMark: { type: 'string' }, toMark: { type: 'string' },
      fromX: { type: 'integer' }, fromY: { type: 'integer' },
      toX: { type: 'integer' }, toY: { type: 'integer' },
      durationMs: { type: 'integer', maximum: 3000 },
      expectCursor: { type: 'string', enum: ['resize', 'resize-ew', 'resize-ns', 'resize-nesw', 'resize-nwse', 'move', 'hand'], description: 'Optional standard shape check. Unknown refuses it; omit only with independently verified target geometry/hit-test.' },
      hwnd: { type: 'integer', description: 'expected window at the drag start' },
    },
  }),
  tool('cu_scroll', 'Scroll (up/down/left/right) lines of wheel at a position.', {
    type: 'object', additionalProperties: false, required: ['direction'],
    properties: {
      direction: { type: 'string', enum: ['up', 'down', 'left', 'right'] },
      lines: { type: 'integer', minimum: 1, maximum: 30 },
      mark: { type: 'string' }, x: { type: 'integer' }, y: { type: 'integer' },
    },
  }),
  tool('cu_key', 'Press a key combo, e.g. "ctrl+shift+t", "enter", "alt+f4", "win".', {
    type: 'object', additionalProperties: false, required: ['combo'],
    properties: { combo: { type: 'string' }, holdMs: { type: 'integer', maximum: 5000 } },
  }),
  tool('cu_type', 'Type text. CJK/long text is auto-pasted via clipboard (IME-proof); ASCII short text uses SendInput unicode events. Refuses password fields unless allowPassword is set (ask the human first).', {
    type: 'object', additionalProperties: false, required: ['text'],
    properties: {
      text: { type: 'string' },
      mode: { type: 'string', enum: ['unicode', 'paste'] },
      allowPassword: { type: 'boolean' },
    },
  }),
  tool('cu_clipboard_write', 'Write text to the clipboard.', {
    type: 'object', additionalProperties: false, required: ['text'],
    properties: { text: { type: 'string' } },
  }),
  tool('cu_activate_window', 'Bring a window to the foreground (hwnd or title substring).', {
    type: 'object', additionalProperties: false,
    properties: { hwnd: { type: 'integer' }, titleContains: { type: 'string' } },
  }),
  tool('cu_window_op', 'minimize | maximize | restore | close a window.', {
    type: 'object', additionalProperties: false, required: ['op'],
    properties: {
      op: { type: 'string', enum: ['minimize', 'maximize', 'restore', 'close'] },
      hwnd: { type: 'integer' }, titleContains: { type: 'string' },
    },
  }),
  tool('cu_batch', 'Execute computer actions serially. A failure stops later steps. A human handoff returns a continuing-task checkpoint: inspect the interrupted effect and resume remaining work. End with a screenshot when verification needs one.',
    {
      type: 'object', additionalProperties: false, required: ['actions'],
      properties: {
        actions: {
          type: 'array', minItems: 1, maxItems: 20,
          items: {
            type: 'object', additionalProperties: false, required: ['tool'],
            properties: { tool: { type: 'string' }, args: { type: 'object' } },
          },
        },
      },
    }),
]

function tool (name, description, inputSchema, mutating = true) {
  return { name, description: description + (mutating && !allowInput ? MUTATION_NOTE : ''), inputSchema, mutating }
}


const handlers = {
  cu_screenshot: a => cu.screenshot(a),
  cu_screen_state: a => cu.screenState(a),
  cu_marks: a => cu.marks({ ...a, raw: true }),
  cu_windows: () => cu.call('windows', {}),
  cu_uia_query: async a => {
    const result = await cu.call('uia', { ...a, query: true, depth: a.depth ?? 6, maxNodes: a.maxNodes ?? 120, budgetMs: a.budgetMs ?? 1200 })
    const matches = (result.flat || []).filter(e => (!a.role || e.role === a.role) &&
      (!a.nameContains || (e.name || '').toLowerCase().includes(a.nameContains.toLowerCase())))
    return { ...result, flat: matches.slice(0, 60), truncated: result.truncated === true || matches.length > 60,
      returnedCount: Math.min(60, matches.length) }
  },
  cu_uia_at_point: a => cu.call('uiaFromPoint', a),
  cu_cursor: () => cu.call('cursor', {}),
  cu_clipboard_read: () => cu.clipRead(),
  cu_wait: a => cu.waitForIdle(a),
  cu_release: async () => ({ ...await cu.calm(), conversationContinues: true }),
  cu_hold: () => cu.indicator({ hold: true }),
  cu_free: () => cu.indicator({ hold: false }),
  cu_approve: () => ({ approved: false, inputEnabled: allowInput, approvalSource: 'host-configuration',
    reason: 'This tool does not grant human consent. Input is enabled only by the launching host configuration; the host is responsible for action authorization.' }),
  cu_move: a => cu.move(a.x, a.y),
  cu_click: a => cu.click(targetOf(a), a),
  cu_drag: a => cu.drag(targetOf({ mark: a.fromMark, x: a.fromX, y: a.fromY }),
    targetOf({ mark: a.toMark, x: a.toX, y: a.toY }), { durationMs: a.durationMs, expectCursor: a.expectCursor, expectHwnd: a.hwnd }),
  cu_scroll: a => cu.scroll(a.direction, a.lines ?? 3, a.mark || a.x !== undefined ? { at: targetOf(a) } : {}),
  cu_key: a => cu.key(parseKeyCommand(a.combo).combo, { holdMs: a.holdMs }),
  cu_type: a => cu.type(a.text, { mode: a.mode, allowPassword: a.allowPassword }),
  cu_clipboard_write: a => cu.clipWrite(a.text),
  cu_activate_window: a => cu.activateWindow(a),
  cu_window_op: a => cu.windowOp({ hwnd: a.hwnd, titleContains: a.titleContains }, a.op),
}
async function run (name, args = {}, exec = {}, depth = 0) {
  const definition = tools.find(t => t.name === name)
  if (!definition) throw new Error('unknown tool: ' + name)
  validateArguments(args, definition.inputSchema)
  if (exec.signal?.aborted) throw Object.assign(new Error('MCP request cancelled before dispatch'), { code: 'INPUT_CANCELLED', outcome: 'not-dispatched' })
  if (name === 'cu_batch') {
    if (depth >= 4) throw new Error('batch nesting limit exceeded')
    const batchHandlers = Object.fromEntries(tools.map(t => [t.name, (a, context) => run(t.name, a, context, depth + 1)]))
    return runBatch({ steps: args.actions, handlers: batchHandlers, signal: exec.signal, exec,
      stopped: () => cu.stopped || cu.exited, shot: 'never', screenshot: async () => null })
  }
  if (definition.mutating && !allowInput) throw Object.assign(new Error(
    'MCP_INPUT_DISABLED: the launching host has not enabled input. Configure DSH_CU_ALLOW_INPUT=1 only when that host owns action authorization; cu_approve cannot grant it.'),
    { code: 'MCP_INPUT_DISABLED', outcome: 'not-dispatched' })
  return handlers[name](args, exec)
}
return { tools, run }
}

function targetOf (args) {
  if (typeof args.mark === 'string' && args.mark) return { mark: args.mark }
  if (Number.isFinite(args.x) && Number.isFinite(args.y)) return { x: args.x, y: args.y }
  throw new Error('provide mark or finite x,y')
}

// MCP's schema is discovery metadata; enforce it at this boundary too, including
// each nested batch step, so a client skipping validation cannot bypass the contract.
function validateArguments (args, schema) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('arguments must be an object')
  for (const key of schema.required || []) if (args[key] === undefined) throw new Error('missing argument: ' + key)
  for (const [key, value] of Object.entries(args)) {
    const spec = schema.properties?.[key]
    if (!spec) { if (schema.additionalProperties === false) throw new Error('unknown argument: ' + key); continue }
    if (spec.type === 'integer' ? !Number.isInteger(value) : spec.type === 'array' ? !Array.isArray(value) : typeof value !== spec.type)
      throw new Error('invalid argument type: ' + key)
    if (spec.enum && !spec.enum.includes(value)) throw new Error('invalid argument value: ' + key)
    if (spec.minimum !== undefined && value < spec.minimum || spec.maximum !== undefined && value > spec.maximum)
      throw new Error('argument outside range: ' + key)
    if (spec.type === 'array') {
      if (spec.minItems !== undefined && value.length < spec.minItems || spec.maxItems !== undefined && value.length > spec.maxItems)
        throw new Error('array outside size range: ' + key)
      if (spec.items?.type === 'object') for (const entry of value) validateArguments(entry, spec.items)
    }
  }
}

export function renderMcpResult (name, args, result) {
  const media = splitMediaResult(result)
  const value = media.image ? { ...media.value, imageSource: media.imageSource } : media.value
  const content = [{ type: 'text', text: JSON.stringify(value, null, 1) }]
  if (media.image) content.push({ type: 'image', data: media.image.toString('base64'), mimeType: media.mime })
  return { content, isError: result?.taskStatus === 'continuing' ? false : !!actionRefusal({ tool: name, args }, result) }
}
