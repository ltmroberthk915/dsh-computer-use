# 1.3.1 — worker-side grounding, UAC awareness and IME-safe text

Released 2026-11-04 · previous release [1.3.0](RELEASE-1.3.0.md)

## Why this release exists

1.3.0 made the desktop lifecycle and the indicators honest. A measured WeChat run then showed where
the remaining cost sat: a zero-UIA application forced one screenshot per decision, an IME turned
unicode typing into a garbled outbound message, and a UAC prompt left the agent retrying into a
surface it could never reach. 1.3.1 moves grounding into the worker and turns those failures into
detected, reported states.

## New and changed tools

| Area | What changed |
| --- | --- |
| `computer_ocr` | New observation tool. Inbox Windows OCR returns lines and per-word boxes in absolute screen pixels, so controls can be located by name. The union `Windows.winmd` ships inside the package; no SDK, language pack download or extra dependency. |
| `computer_wait` (change) | Returns `changeBounds` — the bounding box of the differing region — so "message sent" (input area) can be told apart from "caret blinking" (one line). |
| `computer_wait` (stable) | Reports `caretSteady: true` when the only motion is a ~1–2 Hz caret blink, instead of waiting out the full timeout. |
| `computer_marks` | New `uiaOnly` option pins identity to window handle and geometry when an animated neighbour keeps invalidating the sampled pixel signature. Occlusion checking at dispatch still applies. |
| `computer_type` (paste) | When the clipboard holds private or oversized formats that cannot be snapshotted, the paste proceeds without restoration and reports `clipboardRestore: "skipped-unpreservable-clipboard"` with a warning. It no longer refuses and fall back to unicode keystrokes. |

## Secure desktop (UAC / lock screen)

The worker probes the input desktop every monitor tick. Three consecutive misses engage a paused
state: input ops refuse to dispatch with `SECURE_DESKTOP_ACTIVE`, the human receives a bilingual
notice, and the agent is told what only the human can do. One success clears the state and dispatch
resumes automatically — no cycle, lease or light is torn down by the wait.

Windows does not allow automation to answer the prompt itself; this release reports and waits
instead of pretending otherwise.

## Indicators

- All colours share one DPI-derived rail: 1.6 cm of physical screen (about 106 px at 175% scaling,
  previously a fixed 8 px).
- Breathing bands keep a visible floor: thinking and asking 50..140, human handoff 90..160. Deep
  blue while actuating stays steady.
- The pre-operation notice counts down 1.2 s (was 1.5 s).
- A deliberate 16-pixel pointer move between actuations now yields the desktop for the remainder of
  the live cycle, not only while an injection is in flight.

## Reliability and noise

- `computer_state` no longer lists the worker's own indicator overlay.
- `KICKOFF-FOCUS-REQUIRED` names the foreground window (hwnd, pid, title).
- High-risk batch refusals name the offending `action[i]` and its argument.
- The no-change click warning explains that an already-focused editor is an expected cause.

## Docs

The computer-use skill now leads with the generalised zero-UIA ladder (OCR first, keyboard flow,
crop-and-verify), the IME/clipboard rule for editors that cannot be read back, and the new wait
fields. The measured WeChat case moved to
[`skills/computer-use/references/zero-uia-apps.md`](../skills/computer-use/references/zero-uia-apps.md).

## Compatibility

No tool was removed or renamed. `computer_ocr` is new; existing calls behave as before except the
paste downgrade and the two `computer_wait` fields, which are additive. Windows x64, Node >= 22,
same host range as 1.3.0. Both native helpers ship prebuilt.
