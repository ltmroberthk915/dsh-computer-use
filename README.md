# Computer Use · Codex-style desktop control

Windows desktop computer use for **DeepSeek Harness**: 18 desktop tools plus an Agent activation entry that observe and drive
native Windows applications through prebuilt C# workers included in the package. No PowerShell 7,
SDK, terminal commands or install-time builds are needed.

English | [中文](README.zh.md)

Windows only (`os: win32`). Requires Node.js ≥ 22 and the .NET Framework 4.x that Windows ships with.

## What it does

- **Observe** — window list, screenshots (region / JPEG / PNG / downscaled), a Set-of-Marks map of
  clickable elements, and the UI Automation tree with exact `AutomationId`s.
- **Act** — click, move, drag, scroll, select a text range, type, press keys, and drive controls
  through their own UI Automation patterns instead of blind coordinates.
- **Batch** — one `computer_batch` call runs a list of actions serially and stops at the first
  failure, so a known sequence costs one model round trip instead of ten.
- **Ask** — `computer_ask` raises a question on the same chat card DSH uses for `ask_user_question`,
  with no countdown.
- **A human brake that reaches the model** — a stop is pushed into the running session, so the agent
  learns it was interrupted instead of discovering it on the next turn.

The tools read the desktop; they do not read your files. The only file the plugin writes on its own
is the Worker binary in `%LOCALAPPDATA%\dsh-computer-use\worker\`, plus the audit log and screenshots
under `$DSH_HOME/data/computer-use/`.

## Install and update in dsh-market

Search **computer-use** and select **dsh-codex-style-computer-use**, by **ltmroberthk915** (npm maintainer: **ltmroberthk**). Click **Install**. Later, click **Update** or **Update all** in the market. The package includes both native helpers; no PowerShell 7 or build permission is needed.

If the catalog has not synced yet, use **Settings → Plugins → Add plugin**, enter `dsh-codex-style-computer-use`, and install. This also creates an ordinary registry installation that can be updated from the market. If DSH reports **restart required**, fully exit DSH from its tray menu and reopen it.

**Migrating an older Git/tarball installation from this repository:** remove the old **dsh-computer-use** entry in the market, then install **dsh-codex-style-computer-use**. The unscoped npm name `dsh-computer-use` belongs to a different repository; do not install it as an upgrade of this plugin. A Git installation cannot switch its dependency identity just by fetching a new commit. After this one-time UI migration, use normal market updates. Existing `computer_*` tool names and the `computer-use` settings namespace are retained.

The GitHub Release also includes `dsh-computer-use.tgz` for offline/manual installation; registry installation is the default for market updates.

CLI users (web profile):

```sh
dsh plugin --profile web add dsh-codex-style-computer-use
```

## The bundled skill

The driving tools stay locked until the session produces a receipt phrase that exists only inside
`skills/computer-use/SKILL.md`. That is deliberate — it is the strongest honest version of "read the
manual before driving", because no tool layer can see whether a model read a document.

The plugin registers the bundled skill through `ctx.skills.register()` when available. If that service is absent, `computer_use_activate` returns the same manual, its absolute source path and the scoped tool list. The receipt and all existing approval/brake checks still apply.

## Shared input in 1.2.0-rc.2

This pre-release introduces immediate human takeover, automatic waiting after 2 seconds of continued input, and continuation after 3 quiet seconds. Waiting happens locally without model polling. Interrupted writes require a fresh readback and are never blindly replayed. Host cancellation releases accepted automation-owned input without creating a new persistent pause. Existing DSH Pet/main-window and original-topmost handling is retained.

The configured GLM 5.3 Max, GLM 5.3 Flash and DeepSeek Flash routes passed a controlled continuation-protocol test. Native input and physical hotkeys were verified separately; this is not a general desktop or vision benchmark. See [release verification](docs/RELEASE-1.2.0-rc.2.md) for scope.

## On-demand controls in 1.1

- **Per-Agent tools:** idle Agents see `computer_use_activate`, `computer_ctrl` and `computer_ask`. A successful computer-use skill load, receipt or activation exposes the 18 existing tools plus the activation entry to that Agent. Other Agents and children activate independently. Native calls and Node `run_code` are supported. Activation does not start control or release a human brake.
- **Observed UIA targets:** a scoped name/id query returns an opaque target handle. Use it for pattern actions; opt-in `rebind:true` allows unique identity or semantic recovery after replacement in the same window. Changed context, ambiguity and incomplete scans refuse. Broad queries skip recovery handles unless `targets:true`; creating witnesses for a large list costs extra native work.
- **Incremental observations:** pass the previous observation ID as `since` with the same query. Deltas preserve additions, changes, removals and ordering. Each Agent retains 64 complete snapshots; `snapshot` retrieves an exact historical result. Missing bases, changed scope, incomplete evidence or a larger delta fall back to full output.

See [the detailed protocol](skills/computer-use/references/progressive-control.md) for cache limits and recovery boundaries. UIA snapshots preserve provider-returned fields within existing provider limits; historical retrieval is not fresh outcome verification.

## Tools

| Group | Tools |
|---|---|
| Activate | `computer_use_activate` |
| Observe | `computer_state` `computer_shot` `computer_marks` `computer_uia` |
| Act | `computer_click` `computer_move` `computer_drag` `computer_scroll` `computer_select` `computer_key` `computer_type` `computer_uia_act` `computer_window` `computer_clip` |
| Flow | `computer_wait` `computer_batch` |
| Meta | `computer_ask` `computer_ctrl` |

`computer_marks` returns numbered marks for the elements it found on screen; `computer_marks {shot:true}` also saves an annotated image. `computer_shot` returns a plain screenshot and, on image-capable routes, a native image attachment. A mark is a snapshot ID: it is validated against window
identity and sampled pixels before any input is dispatched, so a stale mark is refused rather than
clicked at the wrong place.

## Approval modes

`automationMode` is set in the plugin's settings and defaults to `standard`:

| Mode | Observation | Actuation |
|---|---|---|
| `read-only` | allowed | denied |
| `standard` | allowed | every action asks through the host's approval card |
| `autonomous` | allowed | allowed, high-risk operations still ask |
| `unrestricted` | allowed | allowed (worker failsafe and rate limit still apply) |

High-risk operations (closing a window, `alt+f4`, `win+r`, and the like) ask in every mode. Password
fields are detected through UI Automation's `IsPassword` and refused by default.

## Safety model

- **Shared input** — physical typing, scrolling, mouse movement and mouse buttons immediately yield control. Continued input or a held key/button for 2 seconds enters automatic waiting. After all keys/buttons are released and 3 seconds pass without physical input, the agent takes a fresh observation and continues the authorized task. A brief touch also waits for the 3-second quiet interval. A gentle pale-yellow edge gradient shows human ownership.
- **Manual pause** — only physical `Ctrl+Esc` raises a persistent input brake; `Ctrl+Alt+R` resumes. Ordinary Esc, typing, scrolling, pointer distance/frequency and the screen corner do not create this pause. Explicit question/diagnostic holds remain separate.
- **Exit** — `Ctrl+Alt+Q` ends the session: the overlay goes away, its listeners are torn down, and
  further actuation is refused until a later turn opens a new one.
- **The brake is a fact about the machine, not one process** — the engaged state is persisted, and
  every worker adopts it, including one started later from a shell.
- **Audit** — every actuation is appended to `$DSH_HOME/data/computer-use/audit.jsonl` with argument
  sanitisation.
- **Kill switch for the plugin itself** — `DSH_COMPUTER_USE_KILL=1` makes the plugin refuse to start;
  `dryRun: true` simulates actuations and only logs them.

## Configuration

| Key | Default | Meaning |
|---|---:|---|
| `automationMode` | `standard` | approval mode (above) |
| `progressiveTools` | `true` | per-Agent activation; `false` keeps the original 18 global tools |
| `dryRun` | `false` | simulate actuations, log only |
| `maxActionsPerMinute` | `60` | core-level actuation rate limit |
| `annotateMarks` | `true` | draw Set-of-Marks boxes on screenshots |
| `workerExe` | `""` | explicit worker path; empty = autodiscover or compile |
| `snapshotDir` | `""` | screenshot directory; empty = `$DSH_HOME/data/computer-use/shots` |

## MCP server

`mcp/` is a zero-dependency MCP stdio server over the same core, for clients that speak MCP rather
than Cordis:

```sh
node mcp/src/index.js
```

## Development

The repository ships the guard suite that protects the invariants above — the cycle lifetime, the
ask/brake protocol, the operation classification, the skill gate, and the bundled-skill wiring:

```sh
pwsh -NoProfile -ExecutionPolicy Bypass -File build/run-guards.ps1   # all guards
node build/verify-tools-schema.mjs                                   # tool-schema load guard
```

The tool definitions are compiled through the real `@deepseek-ai/dsh-tools` DSL, so a schema mistake
fails here instead of taking the host's plugin tree down on restart. Some guards compile the native
worker and are Windows-only.

## License

MIT — see [LICENSE](LICENSE).
