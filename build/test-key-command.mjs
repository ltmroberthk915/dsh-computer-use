import fs from 'node:fs'
import assert from 'node:assert/strict'
import { parseKeyCommand, keyCommandRisk } from '../lib/key-command.js'
import { policyDecision } from '../lib/policy.js'
const cases = JSON.parse(fs.readFileSync(new URL('./key-command-cases.json', import.meta.url), 'utf8'))
for (const { input, combo, risk } of cases.valid) {
  assert.equal(parseKeyCommand(input).combo, combo, input)
  assert.equal(parseKeyCommand(combo).combo, combo, `idempotent ${input}`)
  assert.equal(keyCommandRisk(input), risk, input)
  for (const value of [input, combo]) {
    assert.equal(policyDecision('computer_key', { combo: value }, 'autonomous').kind, risk ? 'ask' : 'allow')
    assert.equal(policyDecision('computer_key', { combo: value }, 'standard').kind, 'ask')
    assert.equal(policyDecision('computer_key', { combo: value }, 'read-only').kind, 'deny')
    assert.equal(policyDecision('computer_key', { combo: value }, 'unrestricted').kind, 'allow')
  }
  assert.equal(policyDecision('computer_batch', { actions: [{ tool: 'computer_key', args: { combo: input } }] }, 'autonomous').kind, risk ? 'ask' : 'allow')
}
for (const input of cases.invalid) {
  assert.throws(() => parseKeyCommand(input), /KEY_COMMAND_INVALID/)
  for (const mode of ['standard', 'autonomous', 'unrestricted', 'read-only'])
    assert.equal(policyDecision('computer_key', { combo: input }, mode).kind, 'deny')
}
console.log(`ok canonical key contract: ${cases.valid.length} equivalence/alias/order cases and ${cases.invalid.length} malformed commands; no desktop input`)
