import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { workerReferences } from '../lib/core/native-runtime.js'

const source = path.resolve(import.meta.dirname, '../lib/core/worker.cs')
const text = fs.readFileSync(source, 'utf8')
const query = text.slice(text.indexOf('static Dictionary<string, object> Uia('), text.indexOf('// Observed native identities'))
const matches = text.slice(text.indexOf('static List<AutomationElement> FindUiMatches('), text.indexOf('static Dictionary<string, object> UiaAct('))
assert.doesNotMatch(query + matches, /\.FindAll\(|\.FindFirst\(/, 'queries do not create unbounded child collections before budget checks')
assert.match(query, /ValidateUiQueryScope\([\s\S]*UiQueryRoot\(/, 'scope guard precedes first provider query')
assert.doesNotMatch(query, /AutomationElement\.RootElement/, 'unscoped desktop traversal removed')
const anchor = text.slice(text.indexOf('static AutomationElement UiQueryRoot('), text.indexOf('// Generic only so deterministic fake trees'))
assert.ok(anchor.indexOf('UiAnchorOwned(') < anchor.indexOf('AutomationElement.FromPoint('), 'Win32 ownership guard precedes point COM')
assert.match(anchor, /element\.Current\.ProcessId/, 'provider PID is revalidated')
assert.doesNotMatch(query + anchor, /for\s*\([^)]*retry|Retry|Sleep\(/, 'no automatic cold-tree retry')
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-uia-budget-'))
try {
  const exe = path.join(dir, 'fixture.exe')
  const compiler = path.join(process.env.WINDIR || 'C:/Windows', 'Microsoft.NET/Framework64/v4.0.30319/csc.exe')
  execFileSync(compiler, ['/nologo', '/target:exe', '/platform:x64', '/main:UiaBudgetFixture', `/out:${exe}`,
    ...workerReferences().map(r => '/r:' + r), source, path.join(import.meta.dirname, 'uia-budget-fixture.cs')],
  { windowsHide: true, timeout: 30000 })
  const result = JSON.parse(execFileSync(exe, [], { windowsHide: true, timeout: 10000, encoding: 'utf8' }))
  assert.equal(result.ok, true)
  assert.ok(result.checks >= 35)
  assert.equal(result.realUiaCalls, false)
  assert.equal(result.desktopInput, false)
  console.log(JSON.stringify(result))
} catch (error) {
  if (error.stdout) process.stderr.write(String(error.stdout))
  if (error.stderr) process.stderr.write(String(error.stderr))
  throw error
} finally {
  assert.ok(path.resolve(dir).startsWith(path.resolve(os.tmpdir()) + path.sep))
  fs.rmSync(dir, { recursive: true, force: true })
}
