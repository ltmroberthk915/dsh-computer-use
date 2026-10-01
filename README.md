# dsh-computer-use

Windows desktop computer use for **DeepSeek Harness**: 18 `computer_*` tools that observe and drive
native Windows applications through a C# worker compiled on first use by the compiler that already
ships with Windows.

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

## Install

**Web profile**

```sh
dsh plugin --profile web add github:ltmroberthk915/dsh-computer-use
```

Then restart `dsh web` and open **Settings → computer-use**.

**DSH Desktop**

DSH Desktop keeps its own `desktop` profile, and the `dsh` CLI deliberately refuses to manage that
profile. Install from the app instead: **Settings → Plugins → Add plugin**, paste the Git address
`github:ltmroberthk915/dsh-computer-use`, then restart the app from the tray.

**Prebuilt tarball** — every release attaches `dsh-computer-use.tgz`; pass its path or URL to the
same Add-plugin field if you would rather not install from source.

## The bundled skill

The driving tools stay locked until the session produces a receipt phrase that exists only inside
`skills/computer-use/SKILL.md`. That is deliberate — it is the strongest honest version of "read the
manual before driving", because no tool layer can see whether a model read a document.

The plugin therefore **registers that skill with the host** through `ctx.skills.register()`, so the
model can always read it. If your host does not mount the skills service, copy the directory so the
file is discoverable, or the gate will refuse actuation with no readable manual to unlock it:

```sh
# only needed when the host has no skills service
cp -r skills/computer-use "$DSH_HOME/skills/"
```

## Tools

| Group | Tools |
|---|---|
| Observe | `computer_state` `computer_shot` `computer_marks` `computer_uia` |
| Act | `computer_click` `computer_move` `computer_drag` `computer_scroll` `computer_select` `computer_key` `computer_type` `computer_uia_act` `computer_window` `computer_clip` |
| Flow | `computer_wait` `computer_batch` |
| Meta | `computer_ask` `computer_ctrl` |

`computer_marks` returns numbered marks for the elements it found on screen, and `computer_shot`
draws the same numbers onto the image. A mark is a snapshot ID: it is validated against window
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

- **Physical kill switch** — move the pointer into the top-left corner of the screen; the worker
  latches and refuses every later injection, and releases held buttons or a drag in progress.
- **Pause** — `ESC`, a mouse-wheel turn, or your own typing on the desktop pauses the machine. A
  human pause is released with `Ctrl+Alt+R`.
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
