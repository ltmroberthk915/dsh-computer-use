// Local installation smoke, intentionally outside the portable test-* gate.
// Usage: node build/verify-host-contract.mjs [candidate-root] [report.json] [host-root]
// Imports the real installed DSH DSL and Schema. Never applies the plugin,
// executes its tools, constructs ComputerUse, starts a worker, or writes .dsh.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { registerHooks, createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'

const scriptRoot = path.resolve(import.meta.dirname, '..')
const candidate = path.resolve(process.argv[2] || scriptRoot)
const reportPath = path.resolve(process.argv[3] || path.join(scriptRoot, 'build/system-audit-20261105',
  candidate === scriptRoot ? 'host-contract-source.json' : 'host-contract-candidate.json'))
const hostRoot = path.resolve(process.argv[4] || process.env.DSH_CONTRACT_HOST_ROOT || 'D:/npm-global/node_modules/@deepseek-ai/dsh')
const hostAnchor = pathToFileURL(path.join(hostRoot, 'package.json')).href
const report = { generatedAt: new Date().toISOString(), candidate, hostRoot,
  appliedPlugin: false, executedTools: false, constructedNativeClient: false, desktopInput: false,
  checks: [], pass: false }
const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8'))
const digest = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex')
let hooks
const check = (name, fn) => { fn(); report.checks.push(name) }
try {
  assert.ok(fs.existsSync(path.join(candidate, 'lib/index.js')), 'candidate must contain the plugin entry')
  assert.ok(fs.existsSync(path.join(hostRoot, 'package.json')), 'installed host package is required')
  // Preserve the host's real package exports/conditions and transitive dependency
  // graph. No source text replacement and no node_modules/profile mutation.
  hooks = registerHooks({ resolve (specifier, context, nextResolve) {
    return nextResolve(specifier, specifier.startsWith('@deepseek-ai/') ? { ...context, parentURL: hostAnchor } : context)
  } })
  const hostRequire = createRequire(hostAnchor)
  const [dsl, schema, plugin, tools, feedback] = await Promise.all([
    import('@deepseek-ai/dsh-tools'), import('@deepseek-ai/schemastery'),
    import(pathToFileURL(path.join(candidate, 'lib/index.js')).href),
    import(pathToFileURL(path.join(candidate, 'lib/tools.js')).href),
    import(pathToFileURL(path.join(candidate, 'lib/feedback.js')).href),
  ])
  report.host = Object.fromEntries(['@deepseek-ai/dsh', '@deepseek-ai/dsh-tools', '@deepseek-ai/schemastery', '@deepseek-ai/dsh-scope'].map(name => {
    const file = name === '@deepseek-ai/dsh' ? path.join(hostRoot, 'package.json') : hostRequire.resolve(name + '/package.json')
    return [name, { version: readJson(file).version, manifest: file }]
  }))
  report.package = { name: readJson(path.join(candidate, 'package.json')).name,
    version: readJson(path.join(candidate, 'package.json')).version,
    entrySha256: digest(path.join(candidate, 'lib/index.js')), toolsSha256: digest(path.join(candidate, 'lib/tools.js')),
    rulesSha256: digest(path.join(candidate, 'lib/feedback-routes.json')) }
  const { Config } = plugin
  check('real Schema export and plugin Config load', () => {
    assert.equal(typeof schema.default.object, 'function')
    assert.equal(typeof Config, 'function')
    assert.equal(typeof plugin.apply, 'function')
  })
  const defaults = Config({})
  report.defaults = { enabled: defaults.enabled, progressiveTools: defaults.progressiveTools,
    actionFeedback: defaults.actionFeedback, actionFeedbackDetail: defaults.actionFeedbackDetail, automationMode: defaults.automationMode,
    feedbackRulesProvided: defaults.feedbackRules !== undefined }
  check('Config applies expected defaults without replacing bundled rules with []', () => {
    assert.equal(defaults.enabled, true); assert.equal(defaults.actionFeedback, true)
    assert.equal(defaults.actionFeedbackDetail, 'compact')
    assert.equal(defaults.automationMode, 'standard'); assert.equal(defaults.feedbackRules, undefined)
  })
  const rules = readJson(path.join(candidate, 'lib/feedback-routes.json'))
  check('all bundled route rules validate through real Config', () => {
    assert.deepEqual(Config({ feedbackRules: structuredClone(rules) }).feedbackRules, rules)
  })
  const custom = { provider: 'host-smoke', model: 'fixture', adapterVersion: '1.2.3', grounding: 'verified',
    testedAt: '2026-11-01T00:00:00Z', expiresAt: '2026-12-01T00:00:00Z', reason: 'compile-only fixture' }
  check('custom verified rule and explicit [] survive Config unchanged', () => {
    assert.deepEqual(Config({ feedbackRules: [custom] }).feedbackRules, [custom])
    assert.deepEqual(Config({ feedbackRules: [] }).feedbackRules, [])
  })
  for (const field of ['provider', 'model', 'adapterVersion', 'grounding', 'testedAt', 'expiresAt']) {
    check(`Config rejects missing feedback rule ${field}`, () => {
      const invalid = { ...custom }; delete invalid[field]
      assert.throws(() => Config({ feedbackRules: [invalid] }))
    })
  }
  check('Config rejects invalid enum/type values', () => {
    assert.throws(() => Config({ feedbackRules: [{ ...custom, grounding: 'maybe' }] }))
    assert.throws(() => Config({ feedbackRules: [{ ...custom, adapterVersion: 12 }] }))
    assert.throws(() => Config({ feedbackRules: 'not-an-array' }))
    assert.throws(() => Config({ actionFeedback: 'yes' }))
    assert.throws(() => Config({ actionFeedbackDetail: 'tiny' }))
    assert.throws(() => Config({ actionFeedbackDetail: 1 }))
    assert.throws(() => Config({ automationMode: 'not-a-mode' }))
  })
  check('real Config accepts compact/full/none feedback detail', () => {
    for (const detail of ['compact', 'full', 'none']) assert.equal(Config({ actionFeedbackDetail: detail }).actionFeedbackDetail, detail)
  })
  check('parsed default/empty/custom rules retain runtime evidence semantics', () => {
    const first = rules[0]
    if (first) {
      const exec = { agent: { options: { provider: first.provider, model: first.model } } }
      const now = (Date.parse(first.testedAt) + Date.parse(first.expiresAt)) / 2
      assert.equal(feedback.visionEvidence(exec, { rules: defaults.feedbackRules, adapterVersion: first.adapterVersion, now }).grounding, first.grounding)
      assert.equal(feedback.visionEvidence(exec, { rules: Config({ feedbackRules: [] }).feedbackRules, adapterVersion: first.adapterVersion, now }).grounding, 'unverified')
    }
    const exec = { agent: { options: { provider: custom.provider, model: custom.model } } }
    assert.equal(feedback.visionEvidence(exec, { rules: Config({ feedbackRules: [custom] }).feedbackRules,
      adapterVersion: custom.adapterVersion, now: Date.parse('2026-11-05T00:00:00Z') }).grounding, 'verified')
  })

  const definitions = []
  const denyNative = new Proxy({}, { get (_object, key) { throw Error('Native client access during schema registration: ' + String(key)) } })
  tools.registerTools({ ctx: { tools: { register: definition => definitions.push(definition) } }, cu: denyNative,
    config: defaults, dataDir: 'X:/SCHEMA-ONLY-NOT-WRITTEN', log: () => {},
    snapshotPath: () => { throw Error('No screenshot is allowed during schema verification') }, defineTool: dsl.defineTool })
  const names = definitions.map(definition => definition.name)
  check('real defineTool compiles all 19 unique computer tools', () => {
    assert.equal(definitions.length, 19); assert.equal(new Set(names).size, names.length)
    assert.ok(names.every(name => name.startsWith('computer_')))
  })
  const byName = new Map(definitions.map(definition => [definition.name, definition]))
  const validate = (name, args) => dsl.validateJsonSchemaValue(byName.get(name).parameters, args)
  check('new observation and feedback parameters survive the real host DSL', () => {
    for (const [name, properties] of Object.entries({
      computer_shot: ['region'], computer_click: ['verificationRegion', 'feedback'],
      computer_uia: ['anchor', 'budgetMs', 'maxNodes', 'offset', 'snapshot', 'limit'],
      computer_uia_act: ['anchor', 'budgetMs'], computer_state: ['offset', 'limit', 'snapshot'],
      computer_batch: ['feedback'], computer_ctrl: ['action'],
    })) for (const property of properties) assert.ok(Object.hasOwn(byName.get(name).parameters.properties, property), name + '.' + property)
  })
  const valid = [
    ['computer_drag', { from: '10,20', to: '50,60', expectCursor: 'resize-ew', hwnd: 42 }],
    ['computer_drag', { from: 'M1', to: 'M2', expectCursor: 'resize-nwse' }],
    ['computer_ctrl', { action: 'hold' }], ['computer_ctrl', { action: 'free' }], ['computer_ctrl', { action: 'release' }],
    ['computer_ctrl', { action: 'clear_cache' }],
    ['computer_shot', { region: '-100,200,300,400' }],
    ['computer_click', { at: '10,20', verificationRegion: '100,900,300,100', feedback: 'compact' }],
    ['computer_click', { at: '10,20', feedback: 'full' }],
    ['computer_click', { at: '10,20', feedback: 'none' }],
    ['computer_uia', { hwnd: 42, anchor: '100,200', name: 'Save', depth: 8, maxNodes: 240, budgetMs: 1200, limit: 20 }],
    ['computer_uia', { snapshot: 'Ofixture-1', offset: 80, limit: 20 }],
    ['computer_state', { snapshot: 'Ofixture-2', offset: 0, limit: 10 }],
    ['computer_uia_act', { hwnd: 42, id: 'save', anchor: '100,200', budgetMs: 1200, action: 'invoke' }],
    ['computer_key', { combo: 'escape + shift + control' }],
    ['computer_batch', { shot: 'never', actions: [{ tool: 'computer_ctrl', args: { action: 'hold' } },
      { tool: 'computer_drag', args: { from: '1,2', to: '3,4', expectCursor: 'resize', hwnd: 42 } }] }],
    ['computer_batch', { feedback: 'compact', actions: [{ tool: 'computer_ctrl', args: { action: 'clear_cache' } }] }],
  ]
  for (const [name, args] of valid) check(`${name} accepts ${JSON.stringify(args)}`, () => assert.deepEqual(validate(name, args), []))
  for (const [name, args] of [
    ['computer_drag', { from: '1,2' }],
    ['computer_drag', { from: '1,2', to: '3,4', hwnd: '42' }],
    ['computer_drag', { from: '1,2', to: '3,4', expectCursor: 7 }],
    ['computer_ctrl', {}], ['computer_ctrl', { action: 5 }], ['computer_batch', { actions: 'not-an-array' }],
    ['computer_click', { at: '1,2', verificationRegion: [1,2,3,4] }],
    ['computer_click', { at: '1,2', feedback: 'tiny' }],
    ['computer_uia', { hwnd: 42, anchor: {x:1,y:2} }],
    ['computer_uia', { hwnd: 42, budgetMs: '1200' }],
    ['computer_uia', { snapshot: 'Ofixture-1', offset: '80' }],
    ['computer_state', { snapshot: 'Ofixture-2', limit: '10' }],
  ]) check(`${name} rejects malformed host arguments ${JSON.stringify(args)}`, () => assert.ok(validate(name, args).length > 0))
  report.validationBoundary = 'Real installed DSL/schema compilation and argument validation only. Native scope/anchor ownership, traversal limits, cache expiry/pressure and window-management re-observation gates are runtime behavior tested separately; this smoke executes no tools.'
  report.tools = definitions.map(definition => ({ name: definition.name, timeoutMs: definition.timeoutMs,
    parameters: Object.keys(definition.parameters.properties || {}) }))
  report.pass = true
} catch (error) {
  report.error = { name: error.name, message: error.message, stack: error.stack }
  process.exitCode = 1
} finally {
  hooks?.deregister()
  fs.mkdirSync(path.dirname(reportPath), { recursive: true })
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n')
}
console.log(JSON.stringify({ pass: report.pass, checks: report.checks.length, report: reportPath,
  candidate, ...(report.error ? { error: report.error.message } : {}),
  appliedPlugin: false, executedTools: false, nativeWorkerStarted: false }))
