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
