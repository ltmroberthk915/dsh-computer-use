// Compiles the lease class extracted from the current production worker. The
// fixture calls only its fake-backend RunLease, isolated MMF reader, and bounded
// process-confirmation helper. Worker Main / Panic / desktop input cannot run.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { execFileSync } from 'node:child_process'

const workerPath = new URL('../lib/core/worker.cs', import.meta.url)
const worker = fs.readFileSync(workerPath, 'utf8')

// Braces in comments and quoted strings must not truncate the extracted class.
function classSpan(text, anchor) {
  const start = text.indexOf(anchor)
  assert.ok(start >= 0, `production class exists: ${anchor}`)
  assert.equal(text.indexOf(anchor, start + anchor.length), -1, `unique class: ${anchor}`)
  const open = text.indexOf('{', start)
  let depth = 0, state = 'code', end = open
  for (; end < text.length; end++) {
    const c = text[end], next = text[end + 1]
    if (state === 'line') { if (c === '\n') state = 'code'; continue }
    if (state === 'block') { if (c === '*' && next === '/') { state = 'code'; end++ } continue }
    if (state === 'string' || state === 'char') {
      if (c === '\\') { end++; continue }
      if (c === (state === 'string' ? '"' : "'")) state = 'code'
      continue
    }
    if (state === 'verbatim') {
      if (c === '"' && next === '"') { end++; continue }
      if (c === '"') state = 'code'
      continue
    }
    if (c === '/' && next === '/') { state = 'line'; end++; continue }
    if (c === '/' && next === '*') { state = 'block'; end++; continue }
    if (c === '@' && next === '"') { state = 'verbatim'; end++; continue }
    if (c === '"') { state = 'string'; continue }
    if (c === "'") { state = 'char'; continue }
    if (c === '{') depth++
    if (c === '}' && --depth === 0) return { start, end: end + 1, source: text.slice(start, end + 1) }
  }
  assert.fail(`incomplete production class: ${anchor}`)
}

const production = classSpan(worker, 'public static class PointerVisibilityLease').source
assert.doesNotMatch(production, /static\s+PointerVisibilityLease\s*\(/, 'no native static constructor runs in pure fixture')
// Only this class is compiled. Any executable dependency on the rest of worker
// fails compilation; comments mentioning Panic.Init do not count as dependencies.
const fixture = path.join(import.meta.dirname, 'pointer-lease-fixture.cs')
const fixtureText = fs.readFileSync(fixture, 'utf8')
assert.doesNotMatch(fixtureText, /PointerVisibilityLease\s*\.\s*(?:TryHide|GuardianMain)\s*\(/,
  'pure fixture cannot start a native guardian or request native hiding')
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-pointer-lease-'))
const source = path.join(temp, 'ProductionLease.cs'), exe = path.join(temp, 'PointerLeaseFixture.exe')
const sourceHash = crypto.createHash('sha256').update(production).digest('hex')
fs.writeFileSync(source, `namespace DshComputerUse.Worker {\n${production}\n}\n`)
try {
  const compiler = path.join(process.env.WINDIR || 'C:/Windows', 'Microsoft.NET/Framework64/v4.0.30319/csc.exe')
  execFileSync(compiler, ['/nologo', '/target:exe', '/platform:x64', '/optimize+', '/r:System.Core.dll',
    '/main:LeaseSimulation', `/out:${exe}`, source, fixture], { windowsHide: true, timeout: 20000 })
  const output = execFileSync(exe, [], { windowsHide: true, timeout: 10000, encoding: 'utf8' })
  process.stdout.write(output)
  const count = output.match(/PASS (\d+) pure\/isolated-MMF assertions;/)
  assert.ok(count && Number(count[1]) >= 32, 'all production lease assertions executed')
  console.log(`ok test-pointer-lease — ${count[1]} assertions; production class SHA256 ${sourceHash}; no native visibility or input`)
} catch (error) {
  if (error.stdout) process.stderr.write(String(error.stdout))
  if (error.stderr) process.stderr.write(String(error.stderr))
  throw error
} finally {
  const resolved = path.resolve(temp)
  assert.ok(resolved.startsWith(path.resolve(os.tmpdir()) + path.sep), 'temporary cleanup remains inside TEMP')
  for (const file of [source, exe]) if (fs.existsSync(file)) fs.unlinkSync(file)
  fs.rmdirSync(temp)
}
