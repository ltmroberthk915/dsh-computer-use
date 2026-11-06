// One reviewed, non-interactive behavior gate for source and packed artifacts.
// Tests requiring real input or unisolated desktop hooks are listed explicitly.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'

const sourceRoot = path.resolve(import.meta.dirname, '..')
const packageIndex = process.argv.indexOf('--package')
const packageRoot = packageIndex >= 0 ? path.resolve(process.argv[packageIndex + 1] || '') : null
if (packageIndex >= 0 && !process.argv[packageIndex + 1]) throw Error('--package needs an unpacked package path')
const run = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-behavior-'))
const logs = path.join(run, 'logs'); fs.mkdirSync(logs)
let root = sourceRoot
if (packageRoot) {
  if (!fs.existsSync(path.join(packageRoot, 'package.json'))) throw Error('not an unpacked package')
  root = path.join(run, 'package')
  fs.cpSync(packageRoot, root, { recursive: true, filter: p => path.basename(p) !== 'node_modules' })
  fs.mkdirSync(path.join(root, 'build'), { recursive: true })
  // Only test code comes from the checkout; every lib/skill/script under test
  // comes from the actual archive. Never replace packed product code with source.
  for (const item of fs.readdirSync(path.join(sourceRoot, 'build'), { withFileTypes: true })) {
    if (item.isFile() && (/\.(mjs|cs)$/.test(item.name) || item.name === 'key-command-cases.json'))
      fs.copyFileSync(path.join(sourceRoot, 'build', item.name), path.join(root, 'build', item.name))
  }
  fs.cpSync(path.join(sourceRoot, 'build/fixtures'), path.join(root, 'build/fixtures'), { recursive: true })
}
const excluded = {
  'test-evidence-native.mjs': 'requires actual foreground SendInput and keyboard delivery; a never-activated private desktop cannot prove this physical-input property',
  'test-approval-attention.mjs': 'alias imports test-attention.mjs, which is already run directly',
}
const reviewed = new Set([
  'action-feedback', 'agent-pointer', 'approval-attribution', 'ask-invariants', 'ask-merge', 'ask-orphan', 'ask-release',
  'attention-native', 'attention', 'audit-completion', 'batch-coverage', 'buildusermessage', 'bundled-skill',
  'coactive', 'compact-feedback', 'control-targets', 'core-system-recovery', 'cursor', 'cycle-completion',
  'cycle-no-timeout', 'cycle-open', 'desktop-acceptance-io', 'desktop-ownership', 'drag-options', 'evidence-protocol',
  'exit-coherence', 'feedback-cache-integration', 'feedback-policy', 'glow-pump', 'glow-visual', 'handoff-continuation',
  'handoff-lock', 'human-handoff', 'indicator-hold', 'input-stamp', 'key-command',
  'kickoff-focus', 'mcp-contracts', 'mcp-execution', 'modifier-vk', 'monitor-lifetime', 'native-hardening', 'native-respawn',
  'native-runtime', 'native-fault-lifecycle', 'observation-archive', 'observations', 'op-classification', 'pointer-lease', 'policy', 'preparation',
  'release-channel', 'renders', 'root-integration', 'session-identity', 'skill-gate', 'steer-message-shape',
  'task-rules', 'terminal-cleanup', 'timeout-branch', 'turnend-agent', 'turnend-rootagent',
  'ui-geometry', 'uia-budget', 'uia-read-timeout', 'uia-native', 'uia-targets-native', 'verification-region', 'window-management-key',
].map(name => `test-${name}.mjs`))
const files = fs.readdirSync(path.join(root, 'build')).filter(name => /^test-.+\.mjs$/.test(name)).sort()
const unreviewed = files.filter(name => !reviewed.has(name) && !excluded[name])
if (unreviewed.length) throw Error('Review desktop isolation and add new tests to the gate: ' + unreviewed.join(', '))
const results = []
for (const name of files) {
  if (excluded[name]) { results.push({ name, status: 'excluded', reason: excluded[name] }); continue }
  const state = path.join(run, 'state', name); fs.mkdirSync(state, { recursive: true })
  const env = { ...process.env, DSH_HOME: state, LOCALAPPDATA: path.join(state, 'local'),
    DSH_COMPUTER_USE_STOP_FILE: path.join(state, 'STOP'), DSH_COMPUTER_USE_EXIT_FILE: path.join(state, 'EXITED'),
    DSH_COMPUTER_USE_OWNER_FILE: path.join(state, 'owner'), DSH_COMPUTER_USE_AUDIT_LOG: path.join(state, 'worker-audit.log') }
  delete env.DSH_CU_NATIVE_RELEASE_LEG; delete env.DSH_CU_DESKTOP_TESTS
  const started = Date.now(), log = path.join(logs, name + '.log')
  const stream = fs.createWriteStream(log)
  const result = await new Promise(resolve => {
    const child = spawn(process.execPath, [path.join(root, 'build', name)], { cwd: root, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    let tail = '', timedOut = false
    const consume = b => { stream.write(b); tail = (tail + b.toString()).slice(-5000) }
    child.stdout.on('data', consume); child.stderr.on('data', consume)
    const timer = setTimeout(() => { timedOut = true; child.kill() }, 240_000)
    child.once('error', error => { clearTimeout(timer); stream.end(); resolve({ status: 'failed', error: error.message, log }) })
    child.once('close', code => {
      clearTimeout(timer); stream.end()
      resolve({ status: code === 0 && !timedOut ? 'passed' : 'failed', code, timedOut, log,
        ...(code === 0 ? {} : { error: tail }), subcasesSkipped: /\bSKIP\b/.test(tail) })
    })
  })
  results.push({ name, ...result, elapsedMs: Date.now() - started })
  console.log(`${result.status}: ${name}${result.subcasesSkipped ? ' (optional subcases excluded; see log)' : ''}`)
  if (result.status === 'failed') console.log(result.error)
}
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
const sourceHash = createHash('sha256').update(fs.readFileSync(path.join(root, 'lib/core/worker.cs'))).digest('hex')
const report = { package: pkg.name, version: pkg.version, packageRoot, testedRoot: root, sourceHash,
  generatedAt: new Date().toISOString(), passed: results.filter(r => r.status === 'passed').length,
  failed: results.filter(r => r.status === 'failed').length, excluded: results.filter(r => r.status === 'excluded').length, results }
const reportPath = path.join(run, 'report.json'); fs.writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n')
console.log(JSON.stringify({ report: reportPath, passed: report.passed, failed: report.failed, excluded: report.excluded }))
if (report.failed) process.exitCode = 1
