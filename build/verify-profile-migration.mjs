import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { planMigration, applyMigration, NEW_NAME } from '../scripts/migrate-profile.mjs'
const host = process.argv[2]
assert(host && path.isAbsolute(host), 'Pass the absolute DSH runtime directory (containing package.json)')
const require = createRequire(path.join(host, 'package.json'))
const yaml = require('yaml')
const boot = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-app-boot')).href)
const atomic = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-atomic-write')).href)
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'cu-profile-migration-'))
try {
  const profile = path.join(scratch, 'desktop'), pkg = path.join(profile, 'node_modules', NEW_NAME)
  fs.mkdirSync(pkg, { recursive: true })
  fs.writeFileSync(path.join(profile, 'package.json'), JSON.stringify({ private: true, dsh: { profile: { bundles: [NEW_NAME] } } }))
  fs.writeFileSync(path.join(pkg, 'package.json'), JSON.stringify({ name: NEW_NAME, version: '1.2.0', dsh: { bundle: { patch: './cordis.patch.yml' } } }))
  fs.copyFileSync(path.resolve(import.meta.dirname, '../cordis.patch.yml'), path.join(pkg, 'cordis.patch.yml'))
  const filename = path.join(profile, 'cordis.patch.yml')
  const source = '# 我的审批配置\r\n- id: computer-use\r\n  name: \'dsh-computer-use\' # retain this comment\r\n  disabled: true\r\n  config:\r\n    enabled: false\r\n    automationMode: read-only\r\n    dryRun: true\r\n    maxActionsPerMinute: 7\r\n    annotateMarks: false\r\n- id: unrelated\r\n  name: another-plugin\r\n  config: { keep: yes }\r\n'
  fs.writeFileSync(filename, source)
  const compose = () => {
    const loaded = boot.loadProfileDirectory('dsh', profile, path.join(host, 'package.json'))
    assert.deepEqual(loaded.skippedBundles, [])
    const warnings = []
    const rows = boot.composeEntries([...loaded.layers.map(x => x.patches), loaded.patches], message => warnings.push(message))
    return { entry: rows.find(x => x.id === 'computer-use'), warnings }
  }
  const before = compose()
  assert(before.warnings.some(x => x.includes('name mismatch')))
  assert.equal(before.entry.config.automationMode, 'standard')
  const plan = planMigration(source, yaml)
  assert.equal(plan.changes, 1)
  assert.equal(plan.updated, source.replace("'dsh-computer-use'", JSON.stringify(NEW_NAME)))
  const result = await applyMigration(filename, plan, atomic)
  assert.equal(fs.readFileSync(result.backup, 'utf8'), source)
  const after = compose()
  assert(!after.warnings.some(x => x.includes('name mismatch')))
  assert.deepEqual(after.entry.config, { enabled: false, automationMode: 'read-only', dryRun: true, maxActionsPerMinute: 7, annotateMarks: false })
  assert.equal(after.entry.disabled, true)
  assert.equal(planMigration(plan.updated, yaml).changes, 0)
  assert.throws(() => planMigration('- id: computer-use\n  name: dsh-computer-use\n  name: duplicate\n', yaml), /Invalid patch/)
  fs.writeFileSync(filename, source + '# concurrent user edit\r\n')
  await assert.rejects(applyMigration(filename, plan, atomic), /changed after inspection/)
  assert.equal(fs.readFileSync(filename, 'utf8'), source + '# concurrent user edit\r\n')
  if (process.argv[3]) {
    fs.writeFileSync(filename, source)
    const shell = path.join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe')
    const installArgs = process.argv[3] === 'auto' ? [] : ['-DshInstall', process.argv[3]]
    const output = execFileSync(shell, ['-NoProfile', '-File', path.resolve(import.meta.dirname, '../scripts/migrate-profile.ps1'), '-Apply', ...installArgs, '-ProfileDirectory', profile], { encoding: 'utf8', windowsHide: true })
    assert(JSON.parse(output).changed)
    assert.equal(compose().entry.config.automationMode, 'read-only')
    console.log('ok desktop bundled Node + Windows PowerShell 5.1 migration launcher')
  }
  console.log(JSON.stringify({ hostComposition: true, reproducedNameMismatch: true, preservedReadOnly: true, preservedDisabledAndConfig: true, backup: true, idempotent: true, concurrentEditProtected: true }))
} finally {
  assert(path.dirname(scratch) === os.tmpdir() && path.basename(scratch).startsWith('cu-profile-migration-'))
  fs.rmSync(scratch, { recursive: true, force: true })
}
