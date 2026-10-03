# Computer Use · Codex 风格桌面操控

给 **DeepSeek Harness** 用的 Windows 桌面操控插件：18 个桌面工具加一个 Agent 激活入口，通过一个 C# worker
观察并驱动原生 Windows 应用。发布包已包含编译好的原生组件，无需安装 PowerShell 7、SDK 或执行编译命令。

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

## 在 dsh-market 安装和更新

搜索 **computer-use**，选择 **dsh-codex-style-computer-use**，作者 **ltmroberthk915**（npm 维护者 **ltmroberthk**），点击**安装**。以后直接点市场里的**更新**或**全部更新**。两份原生组件都已随包提供，无需终端、PowerShell 7、SDK 或手改构建白名单。

目录尚未同步时，可在 **设置 → 插件 → 添加插件** 输入 `dsh-codex-style-computer-use` 安装；这同样是可由市场更新的 npm 安装。如果界面提示**需要重启**，从托盘彻底退出 DSH 后重新打开。

**已有本仓库旧 Git/tgz 版本：**在市场卸载旧的 **dsh-computer-use**，再安装 **dsh-codex-style-computer-use**。npm 上的无 scope 包 `dsh-computer-use` 属于另一仓库，不能用作本插件的更新。旧 Git 依赖不会因仓库改名自动迁移；完成这一次界面内迁移后，后续使用普通市场更新即可。原有 `computer_*` 工具名与 `computer-use` 设置命名空间保留。

GitHub Release 仍提供 `dsh-computer-use.tgz`，供离线或手动安装。市场自动更新优先使用 npm 包。

网页版的命令行安装方式：

```sh
dsh plugin --profile web add dsh-codex-style-computer-use
```

## 随包 skill

驱动类工具会被锁住，直到会话给出那句只存在于 `skills/computer-use/SKILL.md` 里的回执短语。
这是刻意的——没有任何工具层能"看见"模型是否读过文档，这是"先读规程再动手"最诚实的一种实现。

插件在宿主提供 skills 服务时通过 `ctx.skills.register()` 注册随包规程。服务缺失时，`computer_use_activate` 也能返回同一份规程、源文件绝对路径及当前 Agent 的工具列表。回执门禁和既有审批、刹车检查仍然有效。

## 1.2.0-rc.2 的人机共用输入

本预发布版采用“立即让权 → 持续输入 2 秒进入等待 → 静默 3 秒后继续”。等待由本地事件完成，不消耗模型轮询。中途被打断的写入先读回实际结果，避免重复执行。宿主取消任务时释放自动化实际按下的输入，不新增持续暂停。此前 DSH Pet 主窗口识别和原有置顶位恢复修复均保留。

已配置的 GLM 5.3 Max、GLM 5.3 Flash 和 DeepSeek Flash 通过受控续作协议测试；原生操作与实体热键另行验证。这些结果不代表任意真实桌面或视觉任务的成功率，详见[发布验证说明](docs/RELEASE-1.2.0-rc.2.md)。

## 1.1 的按需控制

- **按 Agent 加载：**未激活时暴露 `computer_use_activate`、`computer_ctrl`、`computer_ask`。成功读取 computer-use skill、确认规程或调用激活入口后，该 Agent 获得原有 18 个工具，加入口共 19 个。其他 Agent 和子 Agent 独立启用，支持原生调用和 Node `run_code`。激活本身不启动控制，也不释放人为刹车。
- **已观察的 UIA 目标：**指定窗口和 name/id 的聚焦查询默认生成 target 句柄。控件重建时，显式 `rebind:true` 才允许在同一窗口内进行唯一身份或语义匹配。上下文变化、歧义、扫描不完整时拒绝动作。宽查询需 `targets:true` 才生成恢复句柄，避免普通观察承担额外开销。
- **增量观察：**重复相同查询并传入上一 observation 的 `since`，返回新增、变化、删除及顺序信息。每 Agent 保留最近 64 份完整快照，`snapshot` 可取回确切的历史结果。缺少基线、范围变化、证据不完整或增量更大时自动回退全量。

保留的是提供器实际返回的完整字段，沿用原有提供器限制；历史快照不代替动作后的新验证。缓存上限和恢复边界见[详细协议](skills/computer-use/references/progressive-control.md)。

## 工具

| 分组 | 工具 |
|---|---|
| 激活 | `computer_use_activate` |
| 观察 | `computer_state` `computer_shot` `computer_marks` `computer_uia` |
| 操作 | `computer_click` `computer_move` `computer_drag` `computer_scroll` `computer_select` `computer_key` `computer_type` `computer_uia_act` `computer_window` `computer_clip` |
| 流程 | `computer_wait` `computer_batch` |
| 元 | `computer_ask` `computer_ctrl` |

`computer_marks` 返回屏幕上元素的编号列表；`computer_marks {shot:true}` 额外保存对应的标注图。`computer_shot` 返回普通截图，在支持图片输入的模型路由上直接附带图片。mark 是一次**快照
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

- **人机共用输入** —— 实体键盘、滚轮、鼠标移动或按钮操作立即让出控制。持续输入或按住键/按钮 2 秒进入自动等待；全部松开并静默 3 秒后，重新观察目标并继续已授权任务。短暂触碰也等待 3 秒静默。人操作时显示温和的淡黄色边缘渐变。
- **人工暂停** —— 只有实体 `Ctrl+Esc` 触发持续输入刹车，`Ctrl+Alt+R` 恢复。普通 Esc、打字、滚动、鼠标距离/频率和屏幕左上角不再触发这种暂停；显式提问、诊断暂停保持独立。
- **退出** —— `Ctrl+Alt+Q` 结束会话：覆盖层消失、监听全部拆除，后续注入被拒，直到之后某一轮重新开启。
- **刹车是关于机器的事实，不属于某一个进程** —— 闩锁状态落盘，每个 worker 都会遵守，包括之后从命令行启动的。
- **审计** —— 每次操作连同脱敏后的参数追加到 `$DSH_HOME/data/computer-use/audit.jsonl`。
- **插件级开关** —— `DSH_COMPUTER_USE_KILL=1` 让插件拒绝启动；`dryRun: true` 只模拟并记录。

## 配置

| 键 | 默认 | 含义 |
|---|---:|---|
| `automationMode` | `standard` | 审批模式（见上） |
| `progressiveTools` | `true` | 按 Agent 激活；设为 `false` 可保留原有 18 个全局工具 |
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
