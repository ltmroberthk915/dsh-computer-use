# Zero-UIA apps: the WeChat 4.x case (measured 2026-11-04)

A worked example of the SKILL.md "Zero-UIA applications" ladder. Names and numbers below are
what was actually measured on this machine; treat them as the pattern, not as constants.

## The signal

`computer_uia` on WeChat 4.x returns ~8 elements: the window, a tiny pane, and one
`MMUIRenderSubWindowHW` pane — WeChat's own UI framework draws every real control off-screen.
No accessibility tree exists for the content at all. One query establishes this; more queries
will not change it.

## What worked, in order

1. **OCR the decision regions.** The search dropdown, the conversation-list rows, the chat
   header: `computer_ocr` over each, pick entries by name, click box centers. This is the
   cheap path and should be first.
2. **Keyboard flow for navigation.** `ctrl+f` focuses search; type; `enter` opens the result
   page; `escape`/re-clicking closes it. The focus warning ("may not have reached its target",
   "no editable pattern") fires on every keystroke here — expected false negative, the box is
   below the custom surface.
3. **Crops only where looks matter.** The input-box content check before sending (compare the
   pasted text character by character), the sent-bubble confirmation after.

## Traps measured on the way

- **Search language must match the UI language.** The client was Traditional Chinese: the
  built-in assistant is 「檔案傳輸助手」 and a Simplified "档案传输" query returns only web
  suggestions ("搜尋網路結果"). Search a language-invariant token, or skip search: after the
  search page closes, the wanted conversation was simply row two of the list.
- **An IME garbles unicode typing.** A 37-char CJK message typed via `computer_type` (which had
  fallen back to unicode — see below) went out as `【【试】】SH computer--se…`: characters
  dropped, punctuation doubled. Clipboard paste (`ctrl+v`) delivers byte-exact.
- **Why auto-paste fell back to unicode that day:** the clipboard held a private format
  (49161) the preservation lease cannot snapshot, and the old behaviour REFUSED to paste —
  the JS auto-fallback then re-typed as unicode into the IME. Since 2026-11-04 the worker
  downgrades to paste-without-restore + `clipboardWarning` instead of refusing; if you still
  see `clipboardRestore:"skipped-unpreservable-clipboard"`, the old clipboard is gone — say so.
- **`delete`/`backspace` are destructive keys** (always require human approval; auto-refused
  under approval-policy `never`). The search box's own ✕ button clears it without any chord.
- **Enter can move the foreground inside the app** (search page ↔ main window are different
  HWNDs): a KICKOFF-FOCUS-REQUIRED after `enter` is normal — the refusal now names the actual
  foreground (hwnd/pid/title); re-activate and continue.
- **A click that changes nothing is not always a miss**: clicking an already-focused input
  box reports changedPct 0 with the caret already inside — read `focus`/`receiver` before
  re-clicking. The warning text says the same.

## The verification discipline that saved the run

Before pressing `enter` to send: OCR/crop the input box and compare the text character by
character — the IME-garbled first message was only caught (too late) by the post-send bubble
crop. The corrected second message was verified BEFORE sending and went out byte-exact.
External side effects (messages, submits) always get the pre-send readback, not just the
post-send one.
