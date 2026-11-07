# Release 2.2.3 — host debug gates: driving the Harness itself, only with two human gates

The host guard used to refuse EVERY driving op aimed at the DSH window — right for ordinary work
(the agent must never approve its own approvals, type as the human, or press Stop), but it also made
self-iteration (debugging another plugin in the SAME instance) impossible. This release keeps the
default and adds an explicit, human-opened debug mode.

- Two gates, both fail-closed, both set OUTSIDE a tool call: (1) the CALLING conversation is
  `danger-full-access` (the composer's 完全权限 pill), and (2) debug mode was switched on by hand in
  **设置 → 电脑操控（调试）**. Tools can read both and write neither.
- New settings page (`client.js`, `settings.section` slot) backed by a same-origin route
  `GET|POST /api/computer-use/host-debug`; the switch is stored host-side and read hot by the worker
  (500 ms), so toggling needs no restart.
- Refusals return `HOST_DEBUG_GATE` with actionable text and pop ONE notice card (10-minute dedupe,
  never blocking the failed call) naming both gates.
- With both gates open, driving the Harness window is allowed and every action is audited as
  `HOST-CONTROL`; `close`, `minimize` and `hide` of the Harness remain refused even then.
- A worker launched WITHOUT host identity (CLI, MCP, a test harness) also refuses those three on a
  `DeepSeek Harness.exe` window unless the caller passes `confirmHost:true` — added after a harness
  without the env vars sent `WM_CLOSE` to the real Harness on 2026-11-08.
- Tests: `build/test-host-gate.mjs` (source shape) and `build/live-host-gate.mjs` (real window:
  both-closed / each gate alone / both open / close refused / hot toggle). SKILL gains a
  "Driving the Harness itself (debug gates)" section.

Distribution: npm `latest` 2.2.3; markets follow npm. Loaded desktop hosts require a restart.
