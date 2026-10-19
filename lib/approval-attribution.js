// Compatibility with hosts that conflate policy refusals and answerer refusals.
// Delegate first so the host still owns every approval and durable audit pair.
export function installApprovalAttribution (ctx, log) {
  const tools = ctx.get('tools')
  const original = tools?.serviceAsk
  if (typeof original !== 'function') {
    log.warn('approval attribution: host compatibility seam unavailable')
    return
  }
  const ownDescriptor = Object.getOwnPropertyDescriptor(tools, 'serviceAsk')
  const wrapped = async function (exec, ask) {
    let policy
    if (exec?.name?.startsWith('computer_') && exec.agent) {
      const approval = this.ctx?.get?.('approval')
      if (typeof approval?.effectivePolicy === 'function') policy = approval.effectivePolicy(exec.agent.session)
    }
    const result = await original.call(this, exec, ask)
    // Newer/fixed hosts already provide their own reason. Only repair the exact
    // known legacy attribution; never reinterpret cancellation or a grant.
    if (!exec?.name?.startsWith('computer_') || result?.decision?.kind !== 'deny' ||
        result.decision.reason !== `the user rejected tool "${exec.name}"`) return result
    const reason = (policy === 'never'
      ? `tool "${exec.name}" requires approval, but approval prompts are disabled in this session (approval policy: never); the request was automatically rejected without asking the user`
      : `approval for tool "${exec.name}" was rejected by the approval channel`) +
      (ask?.reason ? `; approval required because: ${ask.reason}` : '')
    return { ...result, decision: { ...result.decision, reason } }
  }
  ctx.effect(() => {
    tools.serviceAsk = wrapped
    return () => {
      // Cordis returns a traced callable on get(); compare the stored method,
      // not that newly created callable, to identify our own replacement.
      if (Object.getOwnPropertyDescriptor(tools, 'serviceAsk')?.value !== wrapped) return
      if (ownDescriptor) Object.defineProperty(tools, 'serviceAsk', ownDescriptor)
      else delete tools.serviceAsk
    }
  })
  log.info('approval attribution: installed for computer-use; host approvals and audit retained')
}
