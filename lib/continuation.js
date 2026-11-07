// Temporary ownership handoff is a task checkpoint, not a failed/cancelled task.
export function handoffResult (error) {
  if (!['HUMAN_REOBSERVE', 'WORKER_REOBSERVE', 'HANDOFF_WAIT_TIMEOUT', 'HANDOFF_HELD_TIMEOUT'].includes(error?.code) || !error.continuation?.required) return null
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
