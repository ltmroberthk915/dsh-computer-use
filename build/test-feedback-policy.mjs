import assert from 'node:assert/strict'
import { feedbackPolicy, visionEvidence } from '../lib/feedback.js'
const now = Date.parse('2026-11-05T00:00:00Z')
const exec = { agent: { options: { provider: 'test', model: 'vision' } } }
const record = { provider: 'test', model: 'vision', adapterVersion: 'adapter-2', grounding: 'failed', testedAt: '2026-11-01T00:00:00Z', expiresAt: '2026-11-10T00:00:00Z' }
const ctx = { get: name => name === 'attachments' ? { saveImage () {} } : { resolveModelInfo: async () => ({ inputModalities: ['image'], adapterVersion: 'adapter-2' }) } }
assert.equal((await feedbackPolicy(ctx, exec, true, { now, rules: [record] })).kind, 'state')
for (const changed of [{ adapterVersion: 'adapter-1' }, { expiresAt: '2026-11-04' }, { testedAt: '2026-11-06' }, { expiresAt: 'bad' }, { model: 'another' }]) {
  const result = await feedbackPolicy(ctx, exec, true, { now, rules: [{ ...record, ...changed }] })
  assert.equal(result.kind, 'image')
  assert.equal(result.grounding, 'unverified')
}
assert.equal(visionEvidence(exec, { now, adapterVersion: 'unversioned', rules: [{ ...record, grounding: 'verified', adapterVersion: 'unversioned' }] }).grounding, 'unverified')
assert.equal(visionEvidence(exec, { now, adapterVersion: 'adapter-2', rules: [{ ...record, grounding: 'verified' }] }).grounding, 'verified')
assert.equal((await feedbackPolicy(ctx, exec, false)).kind, null)
const controller = new AbortController(); controller.abort()
assert.equal((await feedbackPolicy(ctx, { ...exec, signal: controller.signal }, true)).reason, 'cancelled')
console.log('ok feedback-policy: current, expired, future, malformed, adapter mismatch, unversioned evidence and cancellation')
