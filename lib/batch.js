// Serial execution and observation selection; no desktop or lifecycle side effects here.
import { handoffResult } from './continuation.js'
import { actionRefusal, actionError, isReadStep as isRead, isReadbackStep as isReadback, endsBatch } from './tool-contract.js'
export { actionRefusal } from './tool-contract.js'

export async function runBatch ({ steps, handlers, signal, stopped, screenshot, shot = 'auto', exec, assertOwnership }) {
  if (!Array.isArray(steps) || !['auto', 'always', 'never'].includes(shot)) throw new Error('invalid batch actions or shot mode')
  const actions = []
  let failed = false
  let continuation = null
  let endedBy = null
  for (const step of steps) {
    const name = step?.tool
    if (failed || signal?.aborted) {
      actions.push({ tool: name || '', ok: false, outcome: 'not-dispatched',
        ...(continuation && !signal?.aborted
          ? { status: 'deferred', message: 'Resume this unfinished step after fresh target evidence; the original task must continue.' }
          : { error: signal?.aborted ? 'cancelled' : endedBy ? 'batch ended by control action' : 'earlier action failed' }) })
      failed = true
      continue
    }
    const fn = Object.hasOwn(handlers, name) && handlers[name]
    if (!fn) { actions.push({ tool: name || '', ok: false, outcome: 'not-dispatched', error: 'unknown tool' }); failed = true; continue }
    try {
      assertOwnership?.()
      const stoppedBefore = stopped()
      const result = await fn(step.args || {}, exec)
      const refusal = actionRefusal(step, result)
      actions.push({ tool: name, ok: !refusal, result, ...(refusal ? { error: refusal } : {}) })
      if (result?.taskStatus === 'continuing' && result.continuation?.required && !signal?.aborted && !stopped()) {
        const nestedPath = result.continuation.resumeActionPath || [result.continuation.resumeFromActionIndex]
        continuation = { ...result.continuation, resumeFromActionIndex: actions.length - 1,
          resumeActionPath: [actions.length - 1, ...nestedPath.filter(Number.isInteger)] }
      }
      if (endsBatch(step)) endedBy = { tool: name, action: step.args?.action || name.replace(/^cu_/, '') }
      else if (result?.endedBy) endedBy = result.endedBy
      failed = !!refusal || !!continuation || (!stoppedBefore && stopped()) || !!endedBy
    } catch (error) {
      const checkpoint = !signal?.aborted && !stopped() ? handoffResult(error) : null
      if (checkpoint) {
        continuation = { ...checkpoint.continuation, resumeFromActionIndex: actions.length }
        actions.push({ tool: name, ...checkpoint, continuation })
      } else {
        actions.push({ tool: name, ...actionError(error) })
      }
      failed = true
    }
  }
  const needsShot = shot === 'always' || (shot === 'auto' && steps.some(s => !isRead(s)) && !isReadback(steps.at(-1) || {}))
  const result = { actions, attachedShot: null }
  if (endedBy) result.endedBy = endedBy
  if (continuation) Object.assign(result, {
    status: 'continuation-required', taskStatus: 'continuing', transient: true, continuation,
  })
  if (!failed && !signal?.aborted && !stopped() && needsShot) {
    try { result.attachedShot = await screenshot() }
    catch (error) { result.observationError = String(error.message || error) }
  }
  // A transport/provider return does not prove that a form was saved or a message was sent.
  if (steps.some(s => s && !isRead(s))) result.verification = 'Inspect returned readback or image before claiming the task effect; ok only means the action returned.'
  if (result.attachedShot) result.view = 'read_image the attachedShot if visual verification is needed'
  return result
}
