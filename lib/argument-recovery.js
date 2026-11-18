// The agent loop settles a failed model response before dispatching any of its tools.
// Returning retry at this boundary regenerates only this step, on the existing turn.
export function installArgumentRecovery (ctx, names, buildNotice, isAgentLoopRequest) {
  if (typeof isAgentLoopRequest !== 'function') return
  const attempts = new WeakMap()

  ctx.on('agent/request-error', async ({ agent, turn, step, signal, failure }, next) => {
    if (signal.aborted || failure.code !== 'MALFORMED_RESPONSE') return next()
    const message = failure.message ?? ''
    const name = /^Tool call "(computer_[a-z0-9_]+)": /.exec(message)?.[1]
    if (!names.has(name) || !message.includes('\n\nReceived arguments:\n')) return next()
    const session = agent.session
    if (!session.requestHeader()?.tools?.some(tool => tool.name === name)) return next()

    const previous = attempts.get(signal)
    const count = previous?.sessionId === session.id && previous.turn === turn && previous.step === step ? previous.count + 1 : 1
    const state = { sessionId: session.id, turn, step, count, name }
    const text = [
      `Windows Computer Use: ${name} had invalid JSON. No tool from the failed response ran. Earlier tool results are already recorded.`,
      'Continue the current task from those results. Generate the pending action using the advertised parameter types.',
      ...(name === 'computer_click' ? ['The JSON shape for a coordinate click is {"at":"<screenX>,<screenY>"}. Replace both placeholders with the observed screen coordinates.'] : []),
      ...(count === 2 ? ['If this format keeps failing, use another available approach or explain what remains in plain text.'] : []),
    ].join(' ')
    if (count <= 2) {
      const notice = await buildNotice(text, `correct ${name} arguments (attempt ${count})`)
      signal.throwIfAborted()
      session.append('user/message', notice, { surfaceOp: 'append' })
    }
    attempts.set(signal, state)
    return { kind: 'retry' }
  }, { prepend: true })

  // After two unsuccessful corrections the host still needs a normal finish. Publish an
  // explicitly plugin-authored status through the chat stream, with no tool blocks.
  ctx.on('llm/stream', (request, next) => {
    const state = attempts.get(request.signal)
    if (!state || state.count <= 2 || state.sessionId !== request.sessionId || !isAgentLoopRequest(request)) return next()
    request.signal.throwIfAborted()
    attempts.delete(request.signal)
    return checkpoint(state.name)
  }, { prepend: true })
}

async function * checkpoint (name) {
  const text = `Windows Computer Use 插件：模型连续三次生成了无效的工具参数，最后一次是 ${name}。这一步尚未执行，之前的操作结果已保留。可以在本对话继续。`
  yield { type: 'block-start', index: 0, blockType: 'text' }
  yield { type: 'text-delta', index: 0, text }
  yield { type: 'block-end', index: 0, block: { type: 'text', text } }
  yield { type: 'finish', reason: { kind: 'stop' } }
}
