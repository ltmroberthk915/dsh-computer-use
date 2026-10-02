# 1.2.0-rc.2 release verification

This pre-release changes shared-desktop input ownership. Physical input yields immediately; 2 seconds of continued input or a held key/button enters automatic waiting; after all inputs are released and 3 seconds are quiet, the task takes a fresh observation and can continue. Ctrl+Esc is the persistent physical-input pause, Ctrl+Alt+R resumes, and Ctrl+Alt+Q exits.

## Validation performed on Windows — 2026-10-02

| Layer | Result | Scope |
|---|---|---|
| Final public source tree | 36/36 guard scripts passed | Includes isolated compiled C# fixtures and JS/protocol guards. The optional exit-coherence native leg stays skipped by default. |
| Real DSH tool-definition compiler | 18 tool definitions registered | Installed DSH DSL, no desktop input. |
| Handoff behavior | 18 C# cases and 9 JS cases passed | Deterministic clocks and an input-sender seam; included in the guard count above. |
| Installed rc.2 native operation | 11/11 passed | Dedicated owned WinForms window; independent text/control/window readbacks, actual input and screenshot. |
| rc.2 native cancellation/recovery | 5/5 passed | Separate stdin reader cancels held Shift and a mouse drag. Observed release samples: 20 ms and 34 ms, not a universal latency guarantee. |
| Physical user input | Mouse yield/wait/quiet continuation; Ctrl+Esc and Ctrl+Alt+R captured | rc.1 hook/state-machine evidence, with the same physical hook/state machine in rc.2. |
| Model continuation protocol | 3/3 configured routes passed | Real DSH ToolRuntime and model adapters with a synthetic target and controlled HUMAN_YIELD, not a full physical desktop benchmark. |

The three configured model routes were GLM 5.3 Max, GLM 5.3 Flash and DeepSeek Flash. Each used four model responses, read the target after the human-input wait, wrote the requested text once and verified it. The three recorded total-token counts were 14,718, 17,288 and 20,880 respectively; usage includes context/cache accounting and is not a comparative billing benchmark. Local waiting makes no model polling calls.

Physical evidence was collected on rc.1 at 17:49 and 17:55 (UTC+08:00). The final rc.2 native source differs in one input-boundary block: it refuses a manual pause without acquiring the cross-process stop lock while holding the input lock. That avoids a lock-order inversion. A dedicated concurrency regression and the final native tests cover this change. The JS core, plugin entry, tools and main skill are byte-identical between those two candidates. The first mouse-only trial was not counted as a physical hotkey pass; the later keyboard trial captured both pause and resume.

The indicator guard was updated during publication to follow the accepted-input ledger and raw cleanup sender, replacing checks for the old direct SendInput structure. Mutation checks verify that a missing light refresh or cleanup routed through the refusal gate fails the guard. Production runtime bytes were not changed for this test correction.

## Package identity and retained behavior

The release archive retains all 29 runtime/config/skill files from the installed and verified rc.2 candidate. Its two README files were corrected for the public flattened repository and current input rules. The final archive checksum is attached to this GitHub release.

Native worker source SHA-256:

`7e24c3fa73fed54eb8209efc253753d44664037954d936573e7c80150caf5856`

The DSH Pet/main-window exclusions and restoration of the original topmost flag remain. The two attention implementation files are unchanged from the source backup before this change. The final local installation was verified in desktop/web/headless profiles and the restarted Desktop plugin page reported version 1.2.0-rc.2 with one running component.

## Practical limits

- Once Windows/UIA has accepted an atomic effect, it cannot be rolled back. Subsequent input is refused and an interrupted write needs a fresh readback; it is not blindly replayed.
- Injected events, including other software's input marked injected, are not classified as physical human input. Remote-control products need separate verification.
- A held key or button never counts as quiet. Host cancellation ends the current input/wait; the local driving-tool wait ceiling is one hour. Existing manual pauses remain authoritative.
- The installed automatic-typing case correctly fell back to Unicode because clipboard preservation was unavailable. It verifies fallback and preservation, not successful clipboard paste.
- These scoped tests do not establish a general vision score or a success rate across arbitrary applications. Local logs and desktop screenshots are retained locally and are not included in the public archive.
