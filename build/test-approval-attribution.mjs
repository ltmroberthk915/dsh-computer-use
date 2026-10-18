import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { policyDecision } from '../lib/policy.js';
import { patchApprovalAttribution, fixedLengthPayload } from '../scripts/patch-approval-attribution.mjs';

const root = path.dirname(fileURLToPath(import.meta.url));
const originalToolSource = fs.readFileSync(path.join(root, 'fixtures/dsh-tools-service-ask-0.2.1-rc.2.js'), 'utf8');
const read = (kind) => kind === 'original' ? originalToolSource : patchApprovalAttribution(originalToolSource).source;
function askMethod(source) {
  const start = source.indexOf('\tasync serviceAsk(exec, ask) {');
  const end = source.indexOf('\n\t/**', start);
  assert.ok(start > 0 && end > start);
  return vm.runInNewContext(`({${source.slice(start, end)}}).serviceAsk`, {
    assertNever: (value) => { throw new Error(`Unexpected approval outcome ${value}`); },
  });
}
const oldAsk = askMethod(read('original'));
const fixedAsk = askMethod(read('patched'));
// Execute the shipped ApprovalService implementation against an in-memory session.
// No actual sessions, approval UI, worker, or OS input are touched.
const approvalSource = fs.readFileSync(path.join(root, 'fixtures/dsh-user-approval-0.2.1-rc.2.js'), 'utf8')
  .replace(/^import .+;\r?$/gm, '').replace(/^export .+;\r?$/gm, '');
const ApprovalService = vm.runInNewContext(`${approvalSource}\nApprovalService;`, {
  Service: class {},
  z: { object: () => ({}), union: () => ({ default: () => ({}) }) },
  randomUUID,
  SessionSeq: (n) => n,
  scopeTarget: (a) => a,
});
let passed = 0;
const tests = [];
async function test(name, run) {
  await run();
  passed++;
  tests.push(name);
  console.log(`PASS ${name}`);
}
function fixture({ policy = 'ask', override, answer = 'rejected', onAnswer } = {}) {
  const events = [{ type: 'turn/start', data: {} }];
  if (override) events.push({ type: 'approval/policy', data: { policy: override } });
  const session = {
    get seq() { return events.length; },
    eventAt: (seq) => events[seq],
    append: (type, data) => { events.push({ type, data }); },
  };
  let answerCalls = 0;
  const approval = Object.create(ApprovalService.prototype);
  approval.config = { policy };
  approval.ctx = { waterfall: async () => { answerCalls++; onAnswer?.(session); return answer; } };
  const exec = { name: 'computer_key', callId: 'regression-call', agent: { session } };
  const owner = { ctx: { get: () => approval } };
  const ask = { kind: 'ask', reason: 'Delete requires human approval', displayReason: 'Delete' };
  return { approval, exec, owner, ask, events, answerCalls: () => answerCalls };
}
await test('baseline reproduces automatic rejection being attributed to the user', async () => {
  const f = fixture({ policy: 'never' });
  const result = await oldAsk.call(f.owner, f.exec, f.ask);
  assert.match(result.decision.reason, /the user rejected tool/);
  assert.equal(f.answerCalls(), 0);
});
await test('never rejects automatically, names disabled prompts, and preserves the audit pair', async () => {
  const f = fixture({ policy: 'never' });
  const result = await fixedAsk.call(f.owner, f.exec, f.ask);
  assert.equal(result.decision.kind, 'deny');
  assert.match(result.decision.reason, /automatically rejected without asking the user/);
  assert.match(result.decision.reason, /approval policy: never/);
  assert.match(result.decision.reason, /Delete requires human approval/);
  assert.doesNotMatch(result.decision.reason, /the user rejected/);
  assert.equal(result.approvalCancelled, false);
  assert.equal(f.answerCalls(), 0);
  const [asked, decided] = f.events.slice(-2);
  assert.equal(asked.type, 'approval/asked');
  assert.equal(decided.type, 'approval/decided');
  assert.equal(asked.data.id, decided.data.id);
  assert.equal(decided.data.outcome, 'rejected');
});
await test('session never override outranks the ask default', async () => {
  const f = fixture({ policy: 'ask', override: 'never' });
  const result = await fixedAsk.call(f.owner, f.exec, f.ask);
  assert.match(result.decision.reason, /automatically rejected/);
  assert.equal(f.answerCalls(), 0);
});
await test('session ask override reaches the answerer and a rejection makes no unsupported human attribution', async () => {
  const f = fixture({ policy: 'never', override: 'ask' });
  const result = await fixedAsk.call(f.owner, f.exec, f.ask);
  assert.equal(result.decision.kind, 'deny');
  assert.match(result.decision.reason, /rejected by the approval channel/);
  assert.doesNotMatch(result.decision.reason, /automatically|the user rejected/);
  assert.equal(f.answerCalls(), 1);
});
await test('a policy switch while an answerer is pending does not relabel its rejection as automatic', async () => {
  const f = fixture({ onAnswer: (s) => s.append('approval/policy', { policy: 'never' }) });
  const result = await fixedAsk.call(f.owner, f.exec, f.ask);
  assert.match(result.decision.reason, /approval channel/);
  assert.doesNotMatch(result.decision.reason, /automatically/);
});
await test('one-shot approval still allows', async () => {
  const f = fixture({ answer: 'allowed-once' });
  const result = await fixedAsk.call(f.owner, f.exec, f.ask);
  assert.equal(result.decision.kind, 'allow');
  assert.equal(result.approvalCancelled, false);
});
await test('cancelled and unavailable remain distinct denials', async () => {
  for (const answer of ['cancelled', 'unavailable']) {
    const f = fixture({ answer });
    const result = await fixedAsk.call(f.owner, f.exec, f.ask);
    assert.equal(result.decision.kind, 'deny');
    assert.equal(result.approvalCancelled, answer === 'cancelled');
    assert.match(result.decision.reason, answer === 'cancelled' ? /was cancelled/ : /no approval channel/);
  }
});
await test('an already aborted never request is cancelled, not labelled an automatic rejection', async () => {
  const f = fixture({ policy: 'never' });
  f.exec.signal = AbortSignal.abort();
  const result = await fixedAsk.call(f.owner, f.exec, f.ask);
  assert.equal(result.approvalCancelled, true);
  assert.match(result.decision.reason, /was cancelled/);
  assert.equal(f.answerCalls(), 0);
});
await test('missing approval service or missing agent stays fail-closed', async () => {
  const f = fixture();
  const absent = await fixedAsk.call({ ctx: { get: () => undefined } }, f.exec, f.ask);
  assert.equal(absent.decision.kind, 'deny');
  const agentless = await fixedAsk.call(f.owner, { name: 'computer_key' }, f.ask);
  assert.equal(agentless.decision.kind, 'deny');
  assert.match(agentless.decision.reason, /no agent/);
});
await test('approval request forwards the borrowed identity, reason, display reason and signal unchanged', async () => {
  const f = fixture();
  f.exec.signal = new AbortController().signal;
  let received;
  f.approval.request = async (req) => { received = req; return 'rejected'; };
  await fixedAsk.call(f.owner, f.exec, f.ask);
  assert.equal(received.agent, f.exec.agent);
  assert.equal(received.toolName, f.exec.name);
  assert.equal(received.callId, f.exec.callId);
  assert.equal(received.reason, f.ask.reason);
  assert.equal(received.displayReason, f.ask.displayReason);
  assert.equal(received.signal, f.exec.signal);
});
await test('Delete and Backspace keep their existing approval rules in every mode', async () => {
  for (const mode of ['standard', 'autonomous']) {
    for (const key of ['Delete', 'Backspace', 'ctrl+delete']) {
      assert.equal(policyDecision('computer_key', { combo: key }, mode).kind, 'ask', `${mode}: ${key}`);
    }
  }
  assert.equal(policyDecision('computer_key', { combo: 'Delete' }, 'read-only').kind, 'deny');
  assert.equal(policyDecision('computer_key', { combo: 'Delete' }, 'unrestricted').kind, 'allow');
});
await test('fixed-layout payload is executable source with only whitespace padding', async () => {
  const source = fixedLengthPayload(read('original'), read('patched')).toString('utf8');
  assert.equal(source.trimEnd(), read('patched').trimEnd());
  assert.equal(Buffer.byteLength(source), Buffer.byteLength(read('original')));
  const f = fixture({ policy: 'never' });
  const result = await askMethod(source).call(f.owner, f.exec, f.ask);
  assert.match(result.decision.reason, /automatically rejected/);
});
await test('the portable patch is idempotent', async () => {
  const first = patchApprovalAttribution(originalToolSource);
  assert.equal(first.changed, true);
  const second = patchApprovalAttribution(first.source);
  assert.equal(second.changed, false);
  assert.equal(second.source, first.source);
});
await test('unknown runtime shapes and oversized fixed-layout changes are refused', async () => {
  assert.throws(() => patchApprovalAttribution('unrecognized runtime'), /Unsupported/);
  assert.throws(() => patchApprovalAttribution(originalToolSource.replace('the user rejected tool', 'a different outcome')), /Unsupported/);
  assert.throws(() => fixedLengthPayload('short', 'a much longer replacement'), /exceeds/);
});
console.log(`${passed} regression tests passed`);
