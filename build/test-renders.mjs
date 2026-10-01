// test-renders.mjs — every registered tool must render a NON-EMPTY result.
//
// Why this exists (2026-09-13): the 17-tool rewrite handed the JSON helper straight to
// `render(a, v)` (`output: out(json)`), so the ARGS object arrived in the helper's `cap`
// parameter and `String.slice(0, {})` coerced to `.slice(0, 0)`. Every such tool returned an
// EMPTY string — silently, in production, on the first call after the rewrite. Nothing in the
// schema validator or the token auditor could see it, because the definitions were perfectly
// valid; only the OUTPUT was blank.
//
//   node build/test-renders.mjs [path-to-tools.js]
// exit 0 = every tool rendered something; exit 1 = at least one rendered nothing.

import { pathToFileURL } from 'node:url'
import { statSync } from 'node:fs'

const PLUGIN = process.argv[2] || 'lib/tools.js'
const captured = []

const cuStub = new Proxy({}, {
  get: (_t, prop) => {
    if (prop === 'then') return undefined
    return async () => ({ stub: String(prop) })
  },
})
const ctxStub = { tools: { register: (def) => captured.push(def) }, logger: () => ({ info () {}, warn () {}, error () {} }) }

const mod = await import(`${pathToFileURL(PLUGIN).href}?mtime=${statSync(PLUGIN).mtimeMs}`)
mod.registerTools({
  ctx: ctxStub,
  cu: cuStub,
  config: { annotateMarks: true },
  dataDir: 'C:/tmp/cu-test',
  log: () => {},
  snapshotPath: (d) => `${d}/shot.jpg`,
  defineTool: (d) => d,
})

// A value shaped like a real result: the renderer must turn it into text.
const SAMPLE = {
  ok: true, count: 2, path: 'C:/tmp/x.jpg', region: { x: 0, y: 0, width: 100, height: 50 },
  marks: [{ id: 'M1', role: 'Button', name: 'OK', center: [10, 20] }],
  actions: [{ tool: 'computer_click', ok: true }], windows: [{ hwnd: 1, title: 'w' }],
  element: { role: 'Edit', name: 'field' }, mode: 'unicode', chars: 3,
  verdict: 'ok', view: 'read_image this path',
}

let bad = 0
console.log(`tools registered: ${captured.length}`)
for (const def of captured) {
  const render = def.output && def.output.render
  let text = null
  let err = null
  try {
    const r = render ? render({ some: 'args' }, SAMPLE) : null
    // renders return [{type:'text', text}] or a string; normalise
    if (Array.isArray(r)) text = r.map(p => (p && p.text) || '').join('')
    else if (typeof r === 'string') text = r
    else text = r == null ? '' : JSON.stringify(r)
  } catch (e) { err = e.message }
  const ok = !err && typeof text === 'string' && text.trim().length > 0
  if (!ok) bad++
  console.log(`  ${ok ? 'OK  ' : 'FAIL'} ${def.name.padEnd(22)} ${err ? 'threw: ' + err : `${text.trim().length} chars`}`)
}

console.log(bad === 0
  ? `\nPASS: all ${captured.length} tools render a non-empty result`
  : `\nFAIL: ${bad} tool(s) render NOTHING — the model would receive an empty tool result`)
process.exit(bad === 0 ? 0 : 1)
