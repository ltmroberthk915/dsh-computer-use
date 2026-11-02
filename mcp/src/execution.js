// Serialize whole MCP tool calls, including batches and human handoff waits.
// The native desktop lease also excludes other worker processes.
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
  if (error?.code !== 'HUMAN_REOBSERVE') return null
  return {
    status: 'interrupted', code: error.code, taskStatus: 'continuing', transient: true,
    outcome: error.outcome || 'unknown', continuation: error.continuation || describe(error),
  }
}
