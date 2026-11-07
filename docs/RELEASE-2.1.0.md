# 2.1.0 — one-call launch, proven focus, and a countdown that stops stuttering

Additive release: every 2.0.x tool name and receipt keeps working, and the model-facing tool surface grows from 20 to 21 tools.

## What is new

- **`computer_launch` with `args`.** An executable starts with real arguments in one call — a dedicated browser profile (`msedge.exe --user-data-dir=… --new-window <url>`) or a document path (`WINWORD.EXE "…doc"`). Each array entry is one argument VALUE, quoted exactly once in the worker with CommandLineToArgvW rules; empty entries, NUL and control characters are refused before dispatch (`LAUNCH_BAD_ARGS`, `outcome:"not-dispatched"`). Executable/script/UNC/`file:` targets keep the existing high-risk escalation.
- **`computer_focus` (new tool, op `focusField`).** Puts keyboard focus on a field and proves it before typing: clicks `x,y`, reports the UIA focused control (`controlType`/`name`/`automationId`, `textTarget`), and proves a caret either from `GetGUIThreadInfo` (`caretVerified`) or — when the OS reports no caret — from a two-frame blink comparison (`caretBlink`, 260 ms apart). `verified:false` names the reason (non-text control, or a text control whose caret stayed unproven) and the caller must not type. This closes the measured failure where activating a dialog left focus in the document and the text was silently swallowed.
- **Countdown continuity.** After one preparation countdown, further actions inside a sliding 5-second window show no countdown of any duration; every dispatched mutation slides the window, and the window is reset when the hands-off state ends (release/calm/brake). The adaptive 1 s / 0.1 s cadence still applies once the window lapses.
- **Same-input-family guards.** A modal dialog of the same app no longer refuses keyboard input and screenshots as `INPUT_TARGET_CHANGED` / `KICKOFF-FOCUS-REQUIRED`: same window, same process, descendant process, and owner/parent relationships count as one input family. `activate` adopts a modal dialog and reports `hwnd` + `modalOf`. Mouse clicks keep the strict pixel-owner check; an unrelated window on top is still refused and nothing is retargeted for clicks.
- **`allowCovered` is exposed and narrowed.** Published through `computer_click`; it authorises only the target application's own embedded renderer (a descendant process, e.g. WeChat's article panel under `Weixin.exe`). An unrelated window on top yields `COVERED-UNRELATED` and nothing is clicked.
- **`delivery:"path"`** on `computer_shot` / `computer_batch` withholds the image block while writing the file and returning the path; a batch-level request also demotes every step image, not just the final checkpoint.
- **Skill rules.** Modal dialogs, focus/caret verification before typing, destructive document selection (never triple-click or `ctrl+a`; confirm the selection, `ctrl+z` after an unexpected change, Save As a new file), download paths resolved from the KnownFolder registry value, and the Edge insecure-download block reported after at most two attempts instead of retried in a loop.

## Validation

- Repository guards: 15 suites green, including the reviewed control-logic hash (`test-glow-visual`), op classification, batch coverage for the new tool, policy mutations, MCP contracts/execution, preparation/countdown, indicator hold, and cycle invariants.
- The two new platform rules have dedicated probes compiled against the shipped `worker.cs`: `build/descendant-probe.cs` (process ancestry) and `build/family-probe.cs` (same-input-family), plus live checks on the machine (a WeChat embedded-panel click, a Word modal dialog, and a real 163 Mail session).
- `scripts/verify-package.mjs` passes on the packed artifact; native helpers are rebuilt from the shipped source with matching sha256 manifests.

## Migration

- Callers that relied on a countdown before every independent action will now see none inside a continuous sequence (5 s sliding window). Release/calm/brake restore the warning from scratch.
- Callers that passed `allowCovered:true` to click through ANY overlapping window now get `COVERED-UNRELATED` for unrelated windows. Aim at the target app's own embedded renderer, or bring the target forward.
- Typing after activating a dialog should be preceded by `computer_focus`; treat `verified:false` as "do not type".

## Distribution

Publish 2.1.0 to npm `next` first, then promote to `latest` after the repository's 24-hour maturation period (`scripts/release-channel.mjs check` / `promote`); only then promote the GitHub release. Market catalog refresh is independent. A loaded local host may need a restart; do not interrupt an active host automatically.
