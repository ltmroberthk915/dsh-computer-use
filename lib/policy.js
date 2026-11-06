// policy.js — pure approval decision for dsh-computer-use.
// Modeled on @anweat/dsh-browser's approval-policy.js: a pure function mapping
// (toolName, args, automationMode) -> {kind:'allow'|'deny'|'ask', reason}.
// Fail-closed by construction: unknown tool names are denied.
//
// ⚠️ KEEP IN SYNC WITH THE TOOL SURFACE. A fail-closed list is only safe if it is also COMPLETE.
// 2026-09-13: the tool set was rewritten from 28 names to 17 (merged + renamed) and this
// allow-list was NOT updated, so the plugin's own gate would have denied most of its own tools
// with "unknown computer-use tool" — before they ever ran. `build/test-policy.mjs` now fails if
// any registered tool falls through to that branch, so the next rename cannot silently do this.
//
// Two tools cannot be classified by name alone and are decided by their ARGUMENTS:
//   computer_clip   — no text = read the clipboard; text = write it
//   computer_ctrl   — selftest = health;  stop = the brake;  exit = end the session;
//                     calibrate / indicator = control
// (`resume` is NOT among them any more: it was removed from the tool surface on 2026-09-13 because
// it un-latched Ctrl+Alt+Q, i.e. a TOOL CALL could re-open a cycle the human had ended. Only the
// plugin's session/event turn/start opens a cycle, and only the human's Ctrl+Alt+R releases a pause.)
// computer_ask is argument-independent and BRAKE-LIKE — see its branch below.

import { keyCommandRisk } from './key-command.js'

export const OBSERVATION_TOOLS = new Set([
  'computer_shot', 'computer_state', 'computer_marks', 'computer_uia', 'computer_wait', 'computer_ocr',
])

export const ACTUATION_TOOLS = new Set([
  'computer_click', 'computer_move', 'computer_drag', 'computer_scroll', 'computer_select',
  'computer_key', 'computer_type', 'computer_uia_act', 'computer_window', 'computer_batch',
])

export const HIGH_RISK_NOTE = 'high-risk action (destructive key / closing a window / password field) — always requires human approval'

/** @returns {{kind:'allow'|'deny'|'ask', reason?: string}} */
export function policyDecision (name, args, mode) {
  const a = args || {}

  // ---- the two argument-dependent tools -------------------------------------------------
  if (name === 'computer_ctrl') {
    const act = String(a.action || 'selftest')
    // The brake is available in EVERY mode, including read-only, and it drives nothing.
    if (act === 'stop') return { kind: 'allow' }
    if (act === 'release') return { kind: 'allow' }
    // An advisory visual intent never injects input or releases a human brake.
    if (act === 'hold' || act === 'free') return { kind: 'allow' }
    if (act === 'recover') return mode === 'read-only'
      ? { kind: 'deny', reason: 'read-only mode cannot recover control' } : { kind: 'allow' }
    if (act === 'selftest') return { kind: 'allow' }      // input-path health, never moves the pointer
    // ends the session: it drives nothing, and the human's own Ctrl+Alt+Q is unconditional. It is
    // the second answer of the ask protocol ("I cannot proceed") and the ask notice promises the
    // human the agent can give it — denying it made that answer dead in all four modes.
    if (act === 'exit') return { kind: 'allow' }
    if (act === 'calibrate' || act === 'indicator') return decideActuation(name, a, mode)
    return { kind: 'deny', reason: `unknown computer_ctrl action: ${act}` }
  }

  // ---- BRAKE-LIKE, and therefore NEVER gated -------------------------------------------------
  // computer_ask actuates NOTHING: it stops the machine, raises the host window and asks the human
  // a question. That is the SAFETY DIRECTION — it is the one call that must never sit behind an
  // approval prompt, because what it is asking for IS human attention. Gating it is exactly
  // backwards. Until 2026-09-13 it fell through to the fail-closed "unknown computer-use tool"
  // branch and was DENIED in all four modes, which silently killed the human's own "ask + 5 秒"
  // rule (their spec: "一旦出现 computer ask, 这时候返回到 DSH desktop 窗口. 若5秒规则内有回应,
  // 则进入暂停态").
  if (name === 'computer_ask') return { kind: 'allow' }
  if (name === 'computer_clip') {
    if (a.text === undefined) return { kind: 'allow' }     // read
    return decideActuation(name, a, mode)                  // write
  }

  if (OBSERVATION_TOOLS.has(name)) return { kind: 'allow' }
  if (ACTUATION_TOOLS.has(name)) return decideActuation(name, a, mode)
  return { kind: 'deny', reason: `unknown computer-use tool: ${name}` }
}

function decideActuation (name, a, mode) {
  let hr
  try { hr = highRisk(name, a) } catch (error) { return { kind: 'deny', reason: error.message } }
  switch (mode) {
    case 'read-only':
      return { kind: 'deny', reason: `automationMode=read-only: ${name} drives the machine` }
    case 'standard':
      return hr ? { kind: 'ask', reason: HIGH_RISK_NOTE + riskSuffix(name, a) }
        : { kind: 'ask', reason: `automationMode=standard: actuation ${name}` }
    case 'autonomous':
      return hr ? { kind: 'ask', reason: HIGH_RISK_NOTE + riskSuffix(name, a) } : { kind: 'allow' }
    case 'unrestricted':
      return { kind: 'allow' }
    default:
      return { kind: 'deny', reason: `unknown automationMode: ${mode}` }
  }
}

/** Names the exact argument that escalated, so a refused batch names its offending step
 *  (test report 2026-11-04: "ctrl+a then delete" read as a generic high-risk refusal and the
 *  model had to guess which op tripped it). Empty string when there is nothing to add. */
function riskSuffix (name, a) {
  if (name === 'computer_key') return ` [combo=${a.combo}]`
  if (name === 'computer_window') return ` [op=${a.op}]`
  if (name === 'computer_type') return ' [allowPassword]'
  if (name === 'computer_batch') {
    const actions = Array.isArray(a.actions) ? a.actions : []
    for (let i = 0; i < actions.length; i++) {
      const step = actions[i]
      if (!step) continue
      const t = String(step.tool || '')
      if ((ACTUATION_TOOLS.has(t) || t === 'computer_clip' || t === 'computer_ctrl') && highRisk(t, step.args || {}))
        return ` [action[${i}] ${t}${step.args?.combo !== undefined ? ` combo=${step.args.combo}` : step.args?.op !== undefined ? ` op=${step.args.op}` : ''}]`
    }
  }
  return ''
}

export function highRisk (name, args) {
  const a = args || {}
  if (name === 'computer_key') {
    return keyCommandRisk(a.combo)
  }
  if (name === 'computer_window' && String(a.op || 'activate') === 'close') return true
  if (name === 'computer_type' && a.allowPassword) return true
  if (name === 'computer_batch') {
    const actions = Array.isArray(a.actions) ? a.actions : []
    for (const step of actions) {
      if (!step) continue
      const t = String(step.tool || '')
      if ((ACTUATION_TOOLS.has(t) || t === 'computer_clip' || t === 'computer_ctrl') && highRisk(t, step.args || {})) return true
    }
  }
  return false
}
