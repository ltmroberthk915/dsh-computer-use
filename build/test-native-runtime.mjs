// Installation regressions: isolated tiny native program, no desktop input.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { buildNativeBundle, prepareNativeBinary } from '../lib/core/native-runtime.js'
if (process.platform !== 'win32') { console.log('ok native-runtime: Windows-only test skipped'); process.exit(0) }
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cu-native-install-中文 空格-'))
const source = path.join(root, 'fixture.cs')
const spec = { source, name: 'fixture.exe', cache: 'test', references: ['System.dll'] }
const cleanEnv = { ...process.env, LOCALAPPDATA: path.join(root, 'cache'), PATH: '', Path: '' }
const noCompiler = { ...cleanEnv, SystemRoot: path.join(root, 'no-windows'), windir: path.join(root, 'no-windows') }
const run = binary => execFileSync(binary, [], { windowsHide: true, timeout: 5000, encoding: 'utf8' }).trim()
let checks = 0
try {
  fs.writeFileSync(source, 'class Program { static void Main() { System.Console.WriteLine("original"); } }')
  const built = buildNativeBundle(spec)
  const first = prepareNativeBinary(spec, { env: noCompiler })
  assert.equal(run(first), 'original'); assert.match(first, /prebuilt/); checks++
  assert.equal(prepareNativeBinary(spec, { env: noCompiler }), first); checks++
  assert(!first.startsWith(path.dirname(built.binary)), 'do not lock files inside node_modules'); checks++
  const old = path.join(root, 'cache/dsh-computer-use/test/unrelated-newer/fixture.exe')
  fs.mkdirSync(path.dirname(old), { recursive: true }); fs.writeFileSync(old, 'not executable')
  assert.equal(prepareNativeBinary(spec, { env: noCompiler }), first); checks++
  fs.writeFileSync(first, 'damaged cached binary')
  const repaired = prepareNativeBinary(spec, { env: noCompiler })
  assert.notEqual(repaired, first); assert.equal(run(repaired), 'original'); checks++
  fs.writeFileSync(source, 'class Program { static void Main() { System.Console.WriteLine("updated"); } }')
  assert.throws(() => prepareNativeBinary(spec, { env: noCompiler }), /PowerShell 7 is not required/); checks++
  const updated = prepareNativeBinary(spec, { env: cleanEnv })
  assert.equal(run(updated), 'updated'); assert.match(updated, /csc/); assert.notEqual(updated, first); checks++
  buildNativeBundle(spec)
  fs.appendFileSync(built.binary, 'tamper')
  assert.throws(() => prepareNativeBinary(spec, { env: noCompiler }), /PowerShell 7 is not required/); checks++
  assert.equal(run(prepareNativeBinary(spec, { env: cleanEnv })), 'updated'); checks++
  buildNativeBundle(spec)
  const module = pathToFileURL(path.resolve(import.meta.dirname, '../lib/core/native-runtime.js')).href
  const overrides = { LOCALAPPDATA: path.join(root, 'race'), SystemRoot: noCompiler.SystemRoot, windir: noCompiler.windir, PATH: '', Path: '' }
  const script = `import { prepareNativeBinary } from ${JSON.stringify(module)}; console.log(prepareNativeBinary(${JSON.stringify(spec)}, { env: { ...process.env, ...${JSON.stringify(overrides)} } }));`
  const children = await Promise.all(Array.from({ length: 4 }, () => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', script], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    let out = '', err = ''; child.stdout.on('data', b => { out += b }); child.stderr.on('data', b => { err += b })
    child.on('error', reject); child.on('exit', code => code === 0 ? resolve(out.trim()) : reject(new Error(err)))
  })))
  assert.equal(new Set(children).size, 1); assert.equal(run(children[0]), 'updated'); checks++
  console.log(`ok test-native-runtime — ${checks} cases: no PATH/PowerShell/compiler, stale/corrupt artifacts, Unicode paths, concurrent cold install`)
} finally {
  if (!root.startsWith(path.join(os.tmpdir(), 'cu-native-install-'))) throw Error('invalid fixture cleanup')
  fs.rmSync(root, { recursive: true, force: true })
}
