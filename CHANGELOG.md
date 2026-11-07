# 2.2.3 — host debug gates: driving the Harness itself, only with two human gates

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
# 2.1.0 — one-call launch, proven focus, and a countdown that stops stuttering

New capabilities, all additive to the 2.0.x tool surface (20 → 21 tools).

- `computer_launch` accepts an optional `args` array: an executable starts with real arguments (a dedicated browser profile, a document path) in ONE call. Each array entry is one argument VALUE, quoted exactly once in the worker; empty entries, NUL and control characters are refused before dispatch. The target keeps the earlier high-risk escalation for executables/scripts/UNC/file: targets.
- `computer_focus {x,y,hwnd}` puts keyboard focus on a field and PROVES it before typing: it clicks the field, reports the UIA focused control (`controlType`/`name`/`automationId`), and proves a caret either from `GetGUIThreadInfo` or — when the OS reports none — from a two-frame blink comparison. `verified:false` must stop the caller from typing; typing follows the focused control, not the window.
- Countdown continuity: after one preparation countdown, further actions inside a sliding 5-second window show NO countdown of any duration; every dispatched mutation slides the window, and the window is reset when the hands-off state ends (release/calm/brake). The adaptive 1 s / 0.1 s cadence still applies once the window lapses.
- Same-input-family guards: a modal dialog of the same app (Find/Replace, Save As) no longer refuses keyboard input and screenshots as `INPUT_TARGET_CHANGED` / `KICKOFF-FOCUS-REQUIRED`. Same-window, same-process, descendant-process and owner/parent relationships count as one family; `activate` adopts a modal dialog and reports `hwnd` + `modalOf`. Mouse clicks keep the strict pixel-owner check — nothing is retargeted for clicks, and an unrelated window on top is still refused.
- `allowCovered` is forwarded to the tool surface and narrowed: it authorises only the target application's own embedded renderer (a descendant process, e.g. WeChat's article panel under Weixin.exe); an unrelated window on top yields `COVERED-UNRELATED` and nothing is clicked.
- `delivery:"path"` on `computer_shot`/`computer_batch` withholds the image block while writing the file; a batch-level request also demotes every step image, not just the checkpoint.
- The skill manual gains hard rules for modal dialogs, destructive document selection (never triple-click/`ctrl+a`; verify the selection before typing; `ctrl+z` after an unexpected change; Save As a new file), focus-with-caret verification before typing, and download paths (resolved from the KnownFolder registry value; Edge insecure-download blocks are reported after at most two attempts instead of retried in a loop).

Distribution: publish 2.1.0 to npm next first, then promote to latest after the usual maturation period (`scripts/release-channel.mjs`); only then promote the GitHub release. Market catalog refresh is independent. Loaded local hosts may require a restart; do not interrupt an active host automatically.
# 2.0.1 — npx entry for the embedded MCP server

No behavior change to the `computer_*` tools or to the plugin's loading path.

- `package.json` gains `bin`: both `dsh-codex-style-computer-use` and the `dsh-computer-use-mcp` alias point at `mcp/src/index.js`. The entry resolves `../../lib/core/index.js` and `../../lib/tool-contract.js` from the packed layout, so an install has no dependency gap; the server still starts observation-only unless the launching host sets `DSH_CU_ALLOW_INPUT=1`.
- The MCP server section of all nine READMEs documents `npx -y dsh-codex-style-computer-use` alongside the checkout form.
- `scripts/verify-package.mjs` now asserts every `bin` target exists and carries a node shebang, so a broken entry fails the package check instead of reaching users.
- Storefront assets published earlier on `main` — `docs/images/icon-180.png` (180×180) and the French, German, Spanish, Portuguese, Arabic, Russian and Persian READMEs — ship in this version.

Distribution: publish 2.0.1 to npm next first, then promote to latest after the 24-hour maturation period (`scripts/release-channel.mjs`). The `npx` command only resolves once a version carrying `bin` is the latest dist-tag; until then a checkout plus `node mcp/src/index.js` is the supported entry. Market catalog refresh is independent.

# 2.0.0 — guarded input, bounded evidence and recoverable desktop control

This major release changes default post-action text feedback and UIA query scope. Existing computer_* tool names remain available.

- Default compact text feedback uses a local point read; full and none remain explicit options. Default visual feedback is preserved. Click verificationRegion can name a separate effect area.
- UIA queries default to depth 6, 120 nodes and a 1200 ms soft budget. Filtered queries require a window; larger queries require an observed anchor. A single synchronous COM call remains non-interruptible.
- Full local evidence can be retrieved from bounded snapshots: 4 MiB retained JSON in memory, 32 MiB disk data, 64 records and 24-hour expiry with lazy cleanup. Disk failure falls back to memory; memory pressure returns complete already-collected evidence inline without replaying input.
- Window-management chords report receiver changes without mistaking expected key releases for a failed switch. Human interruption and host protection remain enforced; activate and reobserve the next target before continuing.
- Worker backpressure/recovery, input ownership, stale-target checks, drag/cursor geometry and cancellation cleanup are hardened.
- Adaptive preparation notice: 1 second initially, 0.1 seconds within a rolling 3-minute interval. Scene hold uses breathing deep blue; free mode permits human input. A compact tilted kite temporarily represents the agent pointer and restores native presentation on release.

Migration: callers relying on full automatic UIA output should use feedback:full. Prefer scoped point/anchor queries and inspect truncated/budget metadata. Cached snapshots are historical, not fresh verification. Pixels changing does not prove task success.

Release validation includes the actual packed Windows artifact and real host schema checks. Tests use isolated private desktops, fake input senders and offscreen rendering; they do not establish every application's behavior on a user's live desktop.

Distribution: publish 2.0.0 to npm next first. Follow scripts/release-channel.mjs to check and promote after the repository's 24-hour maturation period; only then promote the GitHub release to latest. Market catalog refresh is independent. Loaded local hosts may require restart; do not interrupt an active host automatically.

# 1.3.1 — worker-side grounding, UAC awareness and IME-safe text

- Add `computer_ocr`: text with per-word absolute-pixel boxes from the inbox Windows OCR engine (zero external dependencies; the union `Windows.winmd` ships in the package). Locate controls by name in zero-UIA applications instead of spending a screenshot.
- `computer_wait` mode `change` now returns `changeBounds` — where the change landed. Mode `stable` reports `caretSteady` when the only motion is a blinking caret (~1-2 Hz), instead of burning the full timeout.
- `computer_marks` accepts `uiaOnly` to pin identity by window and geometry when an animated neighbour keeps invalidating the sampled pixel signature; the click-time occlusion check still applies.
- Detect the Windows secure desktop (UAC prompt or lock screen) through an input-desktop probe: refuse to dispatch while it stands, notify the human in Chinese and English, and resume automatically once the normal desktop returns.
- Fix a measured IME incident: when the clipboard holds private formats the preservation lease could not snapshot (WeChat format 49161), paste was refused and the fallback re-typed CJK text through the IME, sending a garbled message. The worker now pastes without restoring and reports `clipboardRestore:"skipped-unpreservable-clipboard"` plus a warning.
- Indicators: every colour uses the same 1.6 cm DPI-derived rail (about 106 px at 175% scaling, up from a fixed 8 px). Breathing bands never go dark: thinking/asking 50..140, human handoff 90..160; deep blue remains steady. The pre-operation notice is now 1.2 s.
- A deliberate 16-pixel pointer move between actuations yields keyboard/mouse ownership for the whole live cycle, not only while an injection is in flight.
- Reduce false-positive and blind-retry noise: hide this worker's own overlay from `computer_state` windows, name the actual foreground (hwnd/pid/title) in `KICKOFF-FOCUS-REQUIRED`, name the offending `action[i]`/combo in high-risk batch refusals, and explain that a no-change click on an already-focused editor is expected.
- Reorganise the computer-use skill: generalised zero-UIA guidance, IME and clipboard rules at the top level with the measured WeChat case in `skills/computer-use/references/zero-uia-apps.md`.

# 1.3.0 — desktop lifecycle and indicators

- Allow ordinary user input outside actual actuation; align the deep-blue indicator with that boundary and remove its timed tail. Tolerate 16 pixels of pointer jitter during actuation.
- Show a purple 1.5-second notice before a new input call or coherent batch. Start the full countdown after the first visible frame; cancel on a stop and refresh evidence if the user changes the desktop.
- Return human handoff as a required continuation checkpoint with partial outcomes and batch resume positions, so the authorized task remains active.
- Isolate live cycles by session/agent/turn and by an exclusive native operating-system handle across workers. Recheck ownership after waits; serialize MCP calls.
- Add voluntary computer_ctrl release / cu_release. End desktop work while the chat continues, permit subsequent same-turn acquisition, and automatically release on normal completion without an exit-question menu.
- Preserve explicit manual pauses, questions, cancellation and Q termination. Retain the 1.2.3 approval-attribution compatibility fix.
- Restyle indicators as continuous square-corner 2-pixel rails with an 8-pixel glow. Keep ordinary states free of floating badges, use compact top hints for handoff/pause/preparation, and request overlay capture exclusion on supported Windows builds. Control state and animation timing are unchanged by this visual revision.

# 1.2.3 — automatic approval attribution compatibility

- Install the approval attribution correction automatically when the plugin loads. Normal package installation/update now covers computer-use calls on affected hosts, including batches.
- Delegate every request to the original host approval service, preserving grants, denial, cancellation and durable audit. Correct only the exact legacy rejection message; already-fixed hosts and other tools retain their own results.
- Restore the original method on unload, including Cordis traced service access. Add nine integrated-plugin regressions (23 total) and test the module from the actual packed archive in CI.

# 1.2.2 — host approval attribution tools (GitHub pre-release, 2026-10-19)

- Package the host approval attribution patch, upstream fixtures and 14 regressions in a new GitHub pre-release, with a separate patch-toolkit archive and a complete plugin tarball.
- Run the new regression guard in Windows CI. Plugin actuation and approval rules retain the 1.2.1 behavior; the host patch requires separate deployment.
- npm publication and market/latest promotion remain separate operations.

# Host approval attribution patch (2026-10-19; introduced with plugin 1.2.1)

- Add a portable patch utility for DSH Desktop 0.2.1-rc.2's compiled tool runtime. Automatic `never` refusals identify disabled approval prompts; answerer refusals identify the channel without asserting a human decision.
- Preserve approval outcomes, audit, cancellation and computer-use key policy. Include 14 regressions against upstream fixtures and document local live-host and independent loader verification.
- Preview by default, create output exclusively, reject unknown source shapes, and support verified fixed-length module output. Host deployment is a separate step.

# 1.2.1 — native attention request fix

- Import `randomUUID` explicitly in the attention transport so native `probe` and `raise` requests reach the helper instead of throwing a `ReferenceError` (issue #2).
- Exercise real native request/response round trips, unique request IDs and journal correlation. The release smoke test now sends a probe instead of stopping at helper readiness. Tests target an absent executable and do not raise real application windows.

# Distribution corrections (2026-10-03; npm runtime remains 1.2.0)

- Clarify the default non-strict pnpm 11.7.0 install behavior and the explicit strict-policy conditions; existing 1.2.0 users do not need to reinstall.
- Allow `CU_REGISTRY` for read-only publisher checks, include registry provenance in results and failures, and retain official-registry verification for `latest` promotion (issue #1).
- Document strict pnpm release-age failures for bare names, exact pins and npm tarball URLs. Include the exact 1.2.0 maturity time and a narrowly scoped optional exception.
- Add a publisher promotion guard: wait at least 24 hours before moving `latest`; reject missing registry evidence, wrong repository identity and downgrades.
- Reproduce old-name configuration loss with the official app-boot composer. Provide an explicit migration utility with backups, atomic replacement, concurrent-edit protection and a Windows PowerShell 5.1/Desktop Node launcher.
- Distinguish first-install hot loading from replacement/restart-required states and show the bundled Desktop CLI path.

# 1.2.0 — registry distribution and portable native runtime

- Publish as **dsh-codex-style-computer-use**; preserve the GitHub repository, tool names and settings namespace.
- Ship both native helpers with source and binary SHA-256 identities. Copy them into versioned user caches so running helpers do not lock package files during updates.
- Remove the runtime PowerShell 7 dependency. Source checkouts compile directly with the Windows .NET Framework compiler.
- No prepare/install/prepack hooks or packageManager bootstrap; all JS, skills, C# sources and native binaries are included.
- Preserve the 1.2.0-rc.2 input handoff and safety behavior. Old Git/tarball installs need one migration through the plugin UI because the old npm name is owned by another author.

# 1.2.0-rc.2

- Physical input immediately yields desktop control; sustained input or held keys/buttons for 2 seconds enters waiting; 3 quiet seconds after release permits fresh observation and automatic task continuation.
- Ctrl+Esc is the only physical-input persistent pause. Ctrl+Alt+R resumes; Ctrl+Alt+Q exits. Ordinary input, mouse distance/reversal/wheel counts, and screen corners never create STOP.
- Release only accepted owned key/button downs; preserve human-held input. Native stdin cancellation interrupts an in-flight action without a persistent pause.
- Show a gentle pale-yellow edge gradient during human ownership. Wait locally without model polling; do not replay partial writes.
- Preserve DSH Pet main-window exclusions and original topmost restoration.
- Avoid stop-lock/input-lock inversion during cross-process pause adoption. Physical Ctrl+Esc / Ctrl+Alt+R and host reload have been verified locally. Test scope is recorded in docs/RELEASE-1.2.0-rc.2.md.

# 1.1.2-rc.3

- Includes the retained DSH Pet topmost and main-window-selection fixes. Experimental local candidate: native clipboard and shared physical input validation are pending; do not replace a running host solely from fault-injection results.
- Release a chord's accepted key downs after send failure or cancellation, retain cleanup failures and refuse already-held chord keys. Interrupt long key holds between short waits.
- Preserve supported clipboard bytes and an initially empty clipboard. Compare the sequence and restore under one exclusive lock; a newer copy wins. Refuse unsupported formats before mutation.
- In automatic typing only, a proven pre-dispatch preservation refusal can fall back to Unicode. Explicit paste, clipboard conflicts, interruptions and unknown outcomes never trigger that fallback.
- Keep the three tested model routes and tool schemas unchanged; original receipts and full observations remain available.

# 1.1.2-rc.2

- Experimental local candidate: native clipboard and shared physical input validation are pending; do not replace a running host solely from fault-injection results.
- Release a chord's accepted key downs after send failure or cancellation, retain cleanup failures and refuse already-held chord keys. Interrupt long key holds between short waits.
- Preserve supported clipboard bytes and an initially empty clipboard. Compare the sequence and restore under one exclusive lock; a newer copy wins. Refuse unsupported formats before mutation.
- In automatic typing only, a proven pre-dispatch preservation refusal can fall back to Unicode. Explicit paste, clipboard conflicts, interruptions and unknown outcomes never trigger that fallback.
- Keep the three tested model routes and tool schemas unchanged; original receipts and full observations remain available.

# 1.1.2-rc.1

- Add model-specific post-input checkpoints without changing input dispatch: GLM 5.3 Flash and DeepSeek Flash return images, the tested GLM 5.3 Max route uses UIA/text after failing grounding controls. Keep explicit images and original receipts.
- Preserve batch checkpoints, cancellation and human brake checks. A failed observation does not turn successful input into a retryable error.
- Remove duplicate batch observation rendering; retain complete structured results. actionFeedback:false restores manual direct-action observations.
- Local validation candidate. Controlled real-model fixture tests and regression checks are recorded separately; shared-desktop handoff and floating-overlay native validation remain required before a new Orb plugin release.

# 1.1.1

- Refuse text input on a focused Button with no editable UIA pattern, before sending characters or writing the clipboard. Preserve custom-editor compatibility.
- Preserve explicit pre-dispatch refusal codes through the worker transport; keep uncertain failures unknown.
- Scope stable/change pixel waits to an optional observed hwnd. Refuse moved, minimized or unavailable targets and report the sampled region. Whole-desktop behavior remains the default.
- Sample all grid points for dimensions not divisible by the stride: prevent full-screen buffer overruns and truncated bottom rows.
- Explain which frame witness changed for STALE_MARK, without attributing it to a particular overlay. Update input-focus and evidence-based verification guidance.

Validation: baseline/new native fixtures, protocol guards, host runtime compatibility, and live GLM 5.3 Flash synthetic-image controls. Results and limits are documented separately.

# 1.1.0

Desktop tasks can now activate their tools per Agent, recover an observed UIA control after replacement with explicit unique-evidence checks, and request incremental observations while retaining complete snapshots.

- Idle Agents receive three activation/safety tools; active Agents receive the existing 18 controls plus the activation entry. Other Agents and children activate independently.
- Scoped name/id UIA queries issue target handles. Opt-in rebinding refuses ambiguous, changed-context or incomplete evidence. Broad queries avoid witness overhead by default.
- Explicit since bases produce lossless changes, including order. Each Agent retains 64 full observations, retrievable with snapshot. Missing or unsuitable bases return full output.
- Native screenshot transport, approval modes, cycle ownership and human brakes remain in place. Public installs keep the existing standard approval default.

Validation: 31 Windows guard scripts passed on the flattened release tree; the production DSH runtime/Node PTC compatibility checks cover Agent isolation and snapshot retrieval. Controlled native fixtures test successful recovery and zero extra button callbacks on refusals. Earlier model tests used the configured DeepSeek route; these are small controlled samples, not a claim of universal speed or reliability.

Requires Windows, Node.js >=22 and a DSH host providing scoped tool registration (including @deepseek-ai/dsh-scope). progressiveTools:false retains the original global tool surface on hosts providing those packages.

中文：新增按 Agent 加载工具、显式且唯一的 UIA 目标恢复、增量观察与完整快照取回。宽查询默认不生成恢复句柄，以控制额外开销；人为刹车、审批和控制会话归属仍然生效。
