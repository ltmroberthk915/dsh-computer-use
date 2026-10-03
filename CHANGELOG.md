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
