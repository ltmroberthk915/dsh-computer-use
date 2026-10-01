// verify-tools-schema.mjs — load-time guard for the dsh-tools schema DSL.
//
// Runs every computer_* definition through the real defineTool() compiler from an installed
// @deepseek-ai/dsh-tools, using a stub ctx/cu: no worker, no DSH host, no side effects. It catches
// author-schema violations (the DSL demands explicit additionalProperties on object nodes) before a
// host restart turns them into a "plugin tree failed to load" crash.
//
// Usage: node build/verify-tools-schema.mjs [path-to-dsh-tools/lib/index.js] [path-to-lib/tools.js]
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const ROOT = path.resolve(import.meta.dirname, '..')

/** Find @deepseek-ai/dsh-tools without a machine-specific path: argv, env, then local installs. */
function findDsl () {
  const explicit = [process.argv[2], process.env.DSH_TOOLS].filter(Boolean)
  for (const c of explicit) {
    if (fs.existsSync(c)) return c
  }
  const roots = [
    path.join(ROOT, 'node_modules/@deepseek-ai/dsh-tools/lib/index.js'),
    path.join(ROOT, '../node_modules/@deepseek-ai/dsh-tools/lib/index.js'),
  ]
  for (const c of roots) {
    if (fs.existsSync(c)) return c
  }
  return undefined
}

const DSL = findDsl()
const PLUGIN = process.argv[3] || path.join(ROOT, 'lib/tools.js')
console.log(`plugin: ${PLUGIN}`)

let defineTool
const candidates = [DSL].filter(Boolean)
for (const candidate of candidates) {
  try {
    ({ defineTool } = await import(pathToFileURL(candidate).href))
    console.log(`dsl: ${candidate}`)
    break
  } catch (e) {
    console.log(`dsl miss: ${candidate} — ${e.message}`)
  }
}
if (!defineTool) {
  console.error('FAIL: could not import defineTool from any candidate path')
  console.error('      pass the path to @deepseek-ai/dsh-tools/lib/index.js as argv[2],')
  console.error('      or set DSH_TOOLS to it.')
  process.exit(2)
}

const { registerTools } = await import(pathToFileURL(PLUGIN).href)

const registered = []
const ctx = { tools: { register: (tool) => registered.push(tool) } }
const cu = {}          // never touched: nothing is executed here
const config = { annotateMarks: true }

try {
  registerTools({ ctx, cu, config, dataDir: '.', log: () => {}, snapshotPath: () => 'shot.jpg', defineTool })
} catch (e) {
  console.error(`FAIL: registerTools threw — ${e.message}`)
  process.exit(1)
}

const names = registered.map(t => t.name)
console.log(`ok: ${registered.length} tools registered`)
for (const t of registered) console.log(`  ${t.name}`)

const EXPECTED_PREFIX = 'computer_'
const bad = names.filter(n => !n.startsWith(EXPECTED_PREFIX))
if (bad.length) console.error(`FAIL: unexpected tool names: ${bad.join(', ')}`)
if (new Set(names).size !== names.length) console.error('FAIL: duplicate tool names')

process.exit(bad.length || new Set(names).size !== names.length ? 1 : 0)
