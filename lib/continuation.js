// Temporary ownership handoff is a task checkpoint, not a failed/cancelled task.
export function handoffResult (error) {
  if (error?.code !== 'HUMAN_REOBSERVE' || !error.continuation?.required) return null
  return {
    ok: false,
    status: 'continuation-required',
    taskStatus: 'continuing',
    transient: true,
    code: error.code,
    outcome: error.outcome || 'unknown',
    message: error.message,
    continuation: { ...error.continuation },
  }
}
