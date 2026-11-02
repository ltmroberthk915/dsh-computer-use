import { createCycleGate } from '../lib/cycle.js'
import { createCycleLifecycle } from '../lib/cycle-lifecycle.js'

export async function lifecycleFixture (options = {}) {
  const session = { id: 'session-A' }, agent = { id: 'agent-A', session }, exec = { session, agent }
  const gate = createCycleGate(), calls = []
  let inFlight = 0
  const cu = { stopped: false, exited: false, cooperation: { active: false },
    calm: async (args = {}) => {
      await options.beforeCalmDispatch?.({ cu, gate })
      args.beforeDispatch?.()
      calls.push('calm')
      return options.calm ? options.calm({ cu, gate }) : { released: true }
    } }
  const claimOf = value => gate.claim({ session: value?.session || value?.agent?.session, agent: value?.agent })
  gate.noteTurnStart(session)
  await gate.open(claimOf(exec), async () => ({}))
  const lifecycle = createCycleLifecycle({ gate, cu, claimOf, owner: () => exec,
    paused: () => cu.stopped || ['paused', 'asking'].includes(gate.state()), inFlight: () => inFlight })
  return { session, agent, exec, gate, calls, cu, lifecycle, claimOf,
    setInFlight: n => { inFlight = n }, start: () => { inFlight++ }, end: () => { inFlight-- } }
}
