# dsh-computer-use

给 **DeepSeek Harness** 用的 Windows 桌面操控插件：18 个 `computer_*` 工具，通过一个 C# worker
观察并驱动原生 Windows 应用——worker 在首次使用时，由 Windows 自带的 C# 编译器现场编译。

[English](README.md) | 中文

仅支持 Windows（`os: win32`）。需要 Node.js ≥ 22 与 Windows 自带的 .NET Framework 4.x。

## 它能做什么

- **观察** —— 窗口列表、截图（区域 / JPEG / PNG / 降采样）、可点元素的 Set-of-Marks 编号图，
  以及带精确 `AutomationId` 的 UI Automation 树。
- **操作** —— 点击、移动、拖拽、滚动、选中文本区间、键入、按键，并可走控件**自身的 UI
  Automation 模式**，而不是盲猜坐标。
- **批量** —— 一次 `computer_batch` 串行执行一组动作，遇错即停，因此一段已知流程只花一轮模型往返。
- **提问** —— `computer_ask` 把问题发到 DSH 与 `ask_user_question` 相同的那张聊天卡片上，且没有倒计时。
- **能传到模型的人为刹车** —— 停止事件被推入正在运行的会话，agent 当场知道自己被打断，
  而不是等到下一轮才发现。

工具读的是桌面，不读你的文件。插件自己只写三处：worker 二进制
（`%LOCALAPPDATA%\dsh-computer-use\worker\`）、审计日志与截图（`$DSH_HOME/data/computer-use/`）。

## 安装

**网页版 profile**

```sh
dsh plugin --profile web add github:ltmroberthk915/dsh-computer-use
```

重启 `dsh web`，打开 **设置 → computer-use**。

**DSH Desktop**

DSH Desktop 持有自己的 `desktop` profile，而 `dsh` CLI 刻意拒绝对它做插件管理。请从应用内安装：
**设置 → 插件 → 添加插件**，粘贴 Git 地址 `github:ltmroberthk915/dsh-computer-use`，
然后从托盘彻底退出并重启。

**预构建 tarball** —— 每个 release 都附带 `dsh-computer-use.tgz`；不想从源码安装的话，
把它的路径或 URL 填进同一个「添加插件」输入框即可。

## 随包 skill

驱动类工具会被锁住，直到会话给出那句只存在于 `skills/computer-use/SKILL.md` 里的回执短语。
这是刻意的——没有任何工具层能"看见"模型是否读过文档，这是"先读规程再动手"最诚实的一种实现。

因此插件会通过 `ctx.skills.register()` **把这个 skill 注册给宿主**，让模型始终读得到。
如果你的宿主没有挂载 skills 服务，就把它复制到可发现的位置，否则门禁会拒绝操作，
而模型又没有可读的规程来解锁：

```sh
# 仅在宿主没有 skills 服务时需要
cp -r skills/computer-use "$DSH_HOME/skills/"
```

## 工具

| 分组 | 工具 |
|---|---|
| 观察 | `computer_state` `computer_shot` `computer_marks` `computer_uia` |
| 操作 | `computer_click` `computer_move` `computer_drag` `computer_scroll` `computer_select` `computer_key` `computer_type` `computer_uia_act` `computer_window` `computer_clip` |
| 流程 | `computer_wait` `computer_batch` |
| 元 | `computer_ask` `computer_ctrl` |

`computer_marks` 返回屏幕上元素的编号列表，`computer_shot` 把同一批编号画到图上。mark 是一次**快照
ID**：派发输入前会核对窗口身份与采样像素，因此过期的 mark 会被拒绝，而不是点到错误的位置。

## 审批模式

`automationMode` 在插件设置里配置，默认 `standard`：

| 模式 | 观察 | 操作 |
|---|---|---|
| `read-only` | 允许 | 拒绝 |
| `standard` | 允许 | 每个动作都经宿主审批卡确认 |
| `autonomous` | 允许 | 允许，高危动作仍需确认 |
| `unrestricted` | 允许 | 允许（worker 自身的失效保护与限速仍在） |

高危动作（关闭窗口、`alt+f4`、`win+r` 等）在任何模式下都要确认。
密码框通过 UI Automation 的 `IsPassword` 识别，默认拒绝输入。

## 安全模型

- **物理急停** —— 把鼠标甩到屏幕左上角，worker 立刻闩锁并拒绝后续一切注入，同时释放按住的键与进行中的拖拽。
- **暂停** —— `ESC`、滚轮、或你自己在桌面上的输入都会暂停机器；人为暂停需 `Ctrl+Alt+R` 解除。
- **退出** —— `Ctrl+Alt+Q` 结束会话：覆盖层消失、监听全部拆除，后续注入被拒，直到之后某一轮重新开启。
- **刹车是关于机器的事实，不属于某一个进程** —— 闩锁状态落盘，每个 worker 都会遵守，包括之后从命令行启动的。
- **审计** —— 每次操作连同脱敏后的参数追加到 `$DSH_HOME/data/computer-use/audit.jsonl`。
- **插件级开关** —— `DSH_COMPUTER_USE_KILL=1` 让插件拒绝启动；`dryRun: true` 只模拟并记录。

## 配置

| 键 | 默认 | 含义 |
|---|---:|---|
| `automationMode` | `standard` | 审批模式（见上） |
| `dryRun` | `false` | 只模拟操作并记录 |
| `maxActionsPerMinute` | `60` | 核心层操作限速 |
| `annotateMarks` | `true` | 在截图上绘制 Set-of-Marks 方框 |
| `workerExe` | `""` | 显式指定 worker 路径；留空则自动发现或编译 |
| `snapshotDir` | `""` | 截图目录；留空为 `$DSH_HOME/data/computer-use/shots` |

## MCP 服务

`mcp/` 是建立在同一核心之上的零依赖 MCP stdio 服务，供只讲 MCP、不讲 Cordis 的客户端使用：

```sh
node mcp/src/index.js
```

## 开发

仓库自带守卫套件，保护上面这些不变量——循环生命周期、提问/刹车协议、操作分类、skill 门禁，
以及随包 skill 的注册接线：

```sh
pwsh -NoProfile -ExecutionPolicy Bypass -File build/run-guards.ps1   # 全部守卫
node build/verify-tools-schema.mjs                                   # 工具 schema 加载守卫
```

工具定义走真实的 `@deepseek-ai/dsh-tools` DSL 编译，因此 schema 写错会在这里失败，
而不是在宿主重启时把整棵插件树带崩。部分守卫会编译原生 worker，仅 Windows 可跑。

## 许可

MIT —— 见 [LICENSE](LICENSE)。
