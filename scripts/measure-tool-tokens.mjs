// Read-only model-facing schema cost. No tool executes and no native worker starts.
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
const args = process.argv.slice(2)
const source = path.resolve(args.find(a => !a.startsWith('--')) || path.join(import.meta.dirname, '../lib/tools.js'))
const definitions = []
const { registerTools } = await import(pathToFileURL(source).href)
registerTools({ ctx: { tools: { register: t => definitions.push(t) } }, cu: {},
  config: { annotateMarks: true }, dataDir: '.', log: () => {},
  snapshotPath: () => 'not-created.jpg', defineTool: t => t })
const tools = definitions.map(({ name, description, parameters }) => {
  const characters = JSON.stringify({ name, description, parameters }).length
  return { name, characters, approximateTokens: Math.round(characters / 4) }
})
const characters = tools.reduce((sum, t) => sum + t.characters, 0)
const result = { source, basis: 'JSON name/description/parameters; chars / 4 is an estimate, not a tokenizer',
  count: tools.length, characters, approximateTokens: Math.round(characters / 4), tools }
console.log(JSON.stringify(result, null, 2))
const output = args.find(a => a.startsWith('--out='))?.slice(6)
if (output && !args.includes('--no-baseline')) fs.writeFileSync(path.resolve(output), JSON.stringify(result, null, 2) + '\n')
