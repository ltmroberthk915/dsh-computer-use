// Host names are aliases of one operation/result contract. Adapters execute
// their native argument shapes; batching and refusal semantics use this view.
export function canonicalStep (step = {}) {
  step ||= {}
  const args = step.args || {}
  const names = {
    cu_screenshot: 'computer_shot', cu_screen_state: 'computer_state', cu_windows: 'computer_state',
    cu_cursor: 'computer_state', cu_marks: 'computer_marks', cu_uia_query: 'computer_uia',
    cu_uia_at_point: 'computer_uia', cu_wait: 'computer_wait', cu_move: 'computer_move',
    cu_click: 'computer_click', cu_drag: 'computer_drag', cu_scroll: 'computer_scroll',
    cu_key: 'computer_key', cu_type: 'computer_type', cu_batch: 'computer_batch',
  }
  if (step.tool === 'cu_activate_window') return { tool: 'computer_window', args: { ...args, op: 'activate' } }
  if (step.tool === 'cu_window_op') return { tool: 'computer_window', args }
  if (['cu_hold', 'cu_free', 'cu_release'].includes(step.tool)) return { tool: 'computer_ctrl', args: { action: step.tool.slice(3) } }
  if (step.tool === 'cu_clipboard_read') return { tool: 'computer_clip', args: {} }
  if (step.tool === 'cu_clipboard_write') return { tool: 'computer_clip', args }
  return { tool: names[step.tool] || step.tool, args }
}

const reads = new Set(['computer_state', 'computer_uia', 'computer_marks', 'computer_shot', 'computer_wait', 'computer_ocr'])
export const isReadStep = step => {
  const s = canonicalStep(step)
  return reads.has(s.tool) || (s.tool === 'computer_clip' && s.args.text === undefined)
}
export const isReadbackStep = step => {
  const s = canonicalStep(step)
  return ['computer_state', 'computer_uia', 'computer_marks', 'computer_shot', 'computer_ocr'].includes(s.tool) ||
    (s.tool === 'computer_clip' && s.args.text === undefined)
}
export const endsBatch = step => {
  const s = canonicalStep(step)
  return s.tool === 'computer_ctrl' && ['stop', 'exit', 'release'].includes(s.args.action)
}

export function actionRefusal (step, result) {
  const s = canonicalStep(step)
  if (result?.ok === false || result?.success === false) return result.error || result.reason || 'action reported failure'
  if (s.tool === 'computer_window' && (s.args.op || 'activate') === 'activate' && result?.activated !== true) {
    return 'target window activation was not confirmed; subsequent actions were not dispatched'
  }
  if (s.tool === 'computer_ctrl' && s.args.action === 'recover' && result?.recovered !== true) return result.reason || 'temporary pause recovery refused'
  if (s.tool === 'computer_ctrl' && s.args.action === 'release' && !result?.released && !result?.alreadyReleased) return result.reason || 'cycle release refused'
  if (s.tool === 'computer_batch' && result?.actions?.some(action => action.ok === false)) return 'nested batch did not complete; subsequent actions were not dispatched'
  return null
}

export function actionError (error) {
  return { ok: false, error: String(error?.message || error),
    code: error?.code || 'action-error', outcome: error?.outcome || 'unknown',
    ...(error?.dragStarted !== undefined ? { dragStarted: error.dragStarted } : {}),
    ...(error?.expectedCursor !== undefined ? { expectedCursor: error.expectedCursor, actualCursor: error.actualCursor } : {}),
    ...(error?.cursorCheck !== undefined ? { cursorCheck: error.cursorCheck } : {}),
    ...(error?.cancelSource ? { cancelSource: error.cancelSource } : {}),
    ...(error?.handoffWait ? { handoffWait: error.handoffWait } : {}) }
}
