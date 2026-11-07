/**
 * client.js — the settings page for HOST DEBUG MODE.
 *
 * WHY IT EXISTS
 * The worker refuses every driving op aimed at the DSH window: the host owns the human's approval
 * cards, the question card and the Stop control, so an agent that could click it could approve
 * itself. Self-iteration (debugging ANOTHER plugin inside this same instance) needs to drive that
 * window, and the only honest way to allow it is two gates the agent cannot open itself:
 *
 *   1. THIS conversation holds 完全权限 (session sandbox = danger-full-access);
 *   2. debug mode is switched ON by a human here.
 *
 * The switch is stored host-side (lib/host-debug.js) and read hot by the worker, so toggling it
 * needs no restart. The page never enables gate 1 — that is the composer's permission pill.
 *
 * Same hand-written ModuleLoader bundle as the other DSH plugins: no build step, React comes from
 * the shell's `require('react')`.
 */
window.__ModuleLoader__.load({
  id: 'dsh-codex-style-computer-use',
  factory: require => {
    const module = { exports: {} }
    const exports = module.exports
    const React = require('react')
    const { createElement: h, useState, useEffect, useCallback } = React

    const API = '/api/computer-use/host-debug'
    const TEXT = {
      nav: '电脑操控（调试）',
      title: '电脑操控（调试）',
      sub: '允许 AI 驱动它自己所在的 Harness 窗口。平时必须保持关闭：那个窗口里有审批卡、提问卡和停止键。',
      loading: '读取中…',
      reload: '重新读取',
      save: '保存',
      on: '已开启',
      off: '已关闭',
      gate1: '门禁 1 · 本对话完全权限',
      gate2: '门禁 2 · 调试模式',
      gateHint: '两项都满足，AI 才能点击/输入 Harness 自身的窗口。',
      fullYes: '完全权限（danger-full-access）',
      fullNo: '不是完全权限',
      fullUnknown: '无法读取会话权限',
      warnOff: '调试模式关闭：AI 只能看 Harness，不能驱动它。',
      warnGate1: '本对话不是完全权限，即使打开调试模式，驱动宿主仍会被拒绝。',
      warnBlocked: '上一次有驱动 Harness 的请求被门禁拒绝。',
      blockedAt: '最近一次被拒绝',
      since: '开启于',
      saveHint: '保存后立即生效，无需重启。',
      danger: '开启后，AI 可以点击、输入、滚动 Harness 窗口。除关闭/最小化/隐藏窗口永远禁止外，其余动作仅受门禁约束。',
    }

    function row (label, value, ok) {
      return h('div', { style: { display: 'flex', justifyContent: 'space-between', gap: 12, padding: '8px 0', borderBottom: '1px solid rgba(127,127,127,.18)' } },
        h('span', { style: { opacity: .85 } }, label),
        h('b', { style: { color: ok ? 'inherit' : '#c0392b' } }, value))
    }

    function SettingsPage () {
      const [state, setState] = useState(null)
      const [error, setError] = useState(null)
      const [busy, setBusy] = useState(false)

      const load = useCallback(async () => {
        setError(null)
        try {
          const r = await fetch(API, { cache: 'no-store' })
          const j = await r.json()
          if (!r.ok) throw new Error(j.error || ('HTTP ' + r.status))
          setState(j)
        } catch (e) { setError(String(e?.message ?? e)) }
      }, [])

      useEffect(() => { load() }, [load])

      const save = useCallback(async (enabled) => {
        setBusy(true)
        try {
          const r = await fetch(API, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ enabled }) })
          const j = await r.json()
          if (!r.ok) throw new Error(j.error || ('HTTP ' + r.status))
          setState(j)
        } catch (e) { setError(String(e?.message ?? e)) } finally { setBusy(false) }
      }, [])

      const sandbox = state?.session?.sandbox ?? null
      const full = state?.session?.fullAccess === true
      const enabled = state?.enabled === true

      return h('div', { style: { padding: '18px 22px', lineHeight: 1.55, maxWidth: 760 } },
        h('h2', { style: { margin: '0 0 6px', fontSize: 18 } }, TEXT.title),
        h('p', { style: { margin: '0 0 14px', opacity: .8 } }, TEXT.sub),
        error ? h('div', { style: { margin: '0 0 12px', padding: '8px 10px', border: '1px solid #c0392b', borderRadius: 6, color: '#c0392b' } }, '出错：', error) : null,
        state ? h('div', { style: { margin: '0 0 14px' } },
          row(TEXT.gate1, full ? TEXT.fullYes : (sandbox ? (TEXT.fullNo + '：' + sandbox) : TEXT.fullUnknown), full),
          row(TEXT.gate2, enabled ? TEXT.on : TEXT.off, enabled),
          h('p', { style: { margin: '10px 0 0', opacity: .75, fontSize: 13 } }, TEXT.gateHint),
          !full ? h('p', { style: { margin: '6px 0 0', color: '#c0392b', fontSize: 13 } }, TEXT.warnGate1) : null,
          !enabled ? h('p', { style: { margin: '6px 0 0', opacity: .75, fontSize: 13 } }, TEXT.warnOff) : null,
          state.lastBlockedAt ? h('p', { style: { margin: '6px 0 0', fontSize: 13 } }, TEXT.warnBlocked + '（' + TEXT.blockedAt + '：' + state.lastBlockedAt + '）') : null,
          h('p', { style: { margin: '6px 0 0', fontSize: 13, opacity: .6 } },
            (enabled ? (TEXT.since + '：' + (state.since || '-') + '；') : '') + TEXT.saveHint)
        ) : h('p', { style: { opacity: .7 } }, TEXT.loading),
        h('div', { style: { display: 'flex', gap: 10, margin: '16px 0 14px' } },
          h('button', {
            disabled: busy,
            onClick: () => save(!enabled),
            style: { padding: '7px 16px', borderRadius: 6, border: '1px solid rgba(127,127,127,.4)', cursor: 'pointer', fontWeight: 600, background: enabled ? 'transparent' : '#1f6feb', color: enabled ? 'inherit' : '#fff' },
          }, busy ? '…' : (enabled ? '关闭调试模式' : '开启调试模式')),
          h('button', { disabled: busy, onClick: load, style: { padding: '7px 14px', borderRadius: 6, border: '1px solid rgba(127,127,127,.3)', cursor: 'pointer', background: 'transparent' } }, TEXT.reload)
        ),
        h('p', { style: { margin: 0, fontSize: 13, lineHeight: 1.5, padding: '10px 12px', border: '1px solid rgba(200,120,0,.5)', borderRadius: 6, background: 'rgba(200,120,0,.08)' } }, '⚠ ' + TEXT.danger)
      )
    }

    function apply (ctx) {
      ctx.slots.inject('settings.section', () => ctx.slots.register({
        name: 'settings.section',
        id: 'computer-use-debug',
        order: 52,
        label: () => TEXT.nav,
        locale: 'settings.computerUseDebug',
      }, () => h(SettingsPage)))
    }

    exports.apply = apply
    exports.inject = ['slots', 'locale']
    exports.name = 'dsh-codex-style-computer-use'
    return module.exports
  },
})
