// Serialize whole MCP tool calls, including batches and human handoff waits.
// The native desktop lease also excludes other worker processes.
import { handoffResult } from '../../lib/continuation.js'

export function createToolQueue () {
  let tail = Promise.resolve()
  return (run, signal) => {
    const next = tail.then(() => {
      if (signal?.aborted) throw Object.assign(new Error('MCP request cancelled before dispatch'),
        { code: 'INPUT_CANCELLED', outcome: 'not-dispatched' })
      return run()
    })
    tail = next.catch(() => {})
    return next
  }
}

export function continuationResult (error, describe) {
  const shared = handoffResult(error)
  if (shared) return shared
  // Compatibility for a bare human-handoff error from an older core. Worker
  // recovery must retain its own description, never invent a human handback.
  if (error?.code !== 'HUMAN_REOBSERVE' || !describe) return null
  return handoffResult({ ...error, continuation: describe(error) })
}
