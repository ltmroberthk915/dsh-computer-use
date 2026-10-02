> Historical design notes. The stage-0 brake descriptions below are superseded by the current [README](../README.md), [lifecycle contract](../skills/computer-use/references/lifecycle.md), and [1.2.0-rc.2 release verification](RELEASE-1.2.0-rc.2.md).

# dsh-computer-use — 设计文档

> 让 DSH（DeepSeek Harness）里的 DeepSeek 模型用键鼠操控这台 Windows 电脑，
> 目标是逼近 **GPT-6 Astra 在 Codex 桌面端（Computer Use 插件）** 的表现。
> 版本 stage-0（本文档随代码一起交付，全部断言标注来源：〔实测〕〔DSH 源码〕〔官方文档〕〔社区〕）。

---

## 0. 参照系：Astra 在 Codex 桌面端到底做了什么

先把"追赶对象"拆成可复制的工程事实〔官方文档/媒体交叉，2026-09〕：

| 维度 | Astra/Codex Computer Use 的事实 | 我们的对应物 |
|---|---|---|
| 产品形态 | **Computer Use 插件 = 一个 MCP server + 一个 skill**（非模型内建魔法） | 完全同构：`@dsh/computer-use-mcp` + `dsh-computer-use` 插件 + `skills/computer-use` |
| 集成路径 | OpenAI 官方推荐 **代码执行 harness**（模型写 PyAutoGUI/Playwright 代码，在持久会话里跑局部循环） | stage-2 路线图 `computer_exec`（§9.3） |
| 动作协议 | 批量 `actions[]`：顺序执行、**首败即停**、未执行项统一回填 halt 文本、批末自动附截图 | `computer_batch` 已实现同语义（含批末附截图）〔实测〕 |
| 坐标 | 绝对像素（截图坐标系），宿主做 bounds check + scale 逆映射 | 绝对像素 + mark 编号系统（更强：编号天然免越界）|
| 速度 | OSWorld 2.0 每任务 ~40min（数百步 → 3-8s/步）；"turn 数是延迟通货" | turn 削减三件套：batch / marks / 批末附截图 |
| 护栏 | 三级确认 taxonomy、App 白名单（exe/AUMID）、`requirements.toml` kill switch、"屏幕内容≠许可" | automationMode 四档 × pre-execute ask + 失败即关（fail-closed）+ 角落急停 + 审计 JSONL（§8） |
| 平台限制 | Windows 只能前台接管活动桌面（macOS 可后台） | 同样前台；后台化走 VM 路线（§10 未做） |

模型侧的关键现实：**deepseek-flash 是 text+image 模型**〔DSH 源码：`dsh-base` 模型目录 + `dsh-attachment` 管线〕，
因此我们的设计是**双通道 grounding**：text-first（UIA 结构化状态，不依赖视觉）+ vision 校验（截图经 attachment 管线喂给模型）。

---

## 1. 约束条件（为什么长这样）

### 1.1 宿主事实〔DSH 源码考古，asar 169MB + ~/.dsh 实测〕
- DSH = Electron 壳 + **Cordis 4.0.2 插件框架**；profile = pnpm workspace + 层叠 cordis.patch.yml。
- 工具注册：`ctx.tools.register(defineTool({name, description, parameters, output:{schema,render}, timeoutMs, isConcurrencySafe, execute}))`（`@deepseek-ai/dsh-tools`）。
- 审批：`ctx.on('tools/pre-execute', (exec,next)=>next({kind:'allow'|'deny'|'ask',reason}))` 瀑布 → harness approval UI（fail-closed）。browser 插件是范本。
- **内置 MCP 客户端** `@deepseek-ai/dsh-mcp-client`（stdio + streamable-http；工具名 `mcp__<server>__<tool>`；**图片结果自动桥接为附件**喂 vision 模型）——但默认 base 组合不含它，需 patch insert。
- 插件按 web/desktop 双 profile 各装一份（铁律#6）；desktop 的 CLI 直装被 `rejectElectronProfile` 拦，需手工复制 + bundles 注册（本仓库 deploy.ps1 已做）。

### 1.2 机器现实〔AGENTS.md 铁律 + 实测〕
- 会话沙箱只有 Node 能上网、Chrome 起不来、.NET schannel 废 → **插件运行时绝不能依赖网络/浏览器**。
- npm 环境加固过、全局包已迁移 → **零 npm 运行时依赖**（core 与 MCP server 均 import 零包）。
- node-gyp 编译不可假设可用（无 VS Build Tools 保证）；nut.js 预编译包已从公开 npm 撤下〔社区〕→ **原生层用 Windows 自带的 `csc.exe`（C# 5）现场编译单文件 worker**，缓存于 `%LOCALAPPDATA%`，无 SDK、无网络、无签名问题外的任何依赖〔实测：28KB exe 编译+运行通过〕。

---

## 2. 总体架构

```
┌────────────────────────────── DSH 宿主进程 (Node 22, Cordis) ─────────────────────────────┐
│  skills/computer-use (SKILL.md: agent loop 纪律，进系统提示)                              │
│  ┌────────────────────────────┐        ┌────────────────────────────┐                     │
│  │ dsh-computer-use (Cordis)  │        │ dsh-mcp-client (可选 insert)│                     │
│  │ defineTool(computer_*)     │        │ mcp__computeruse__*        │                     │
│  │ tools/pre-execute 审批门    │        │ (图片结果自动桥接→vision)   │                     │
│  │ 审计 JSONL / dry-run       │        └──────────┬─────────────────┘                     │
│  └─────────────┬──────────────┘                   │                                       │
│                │        lib/core (inlined)    （零依赖：worker 生命周期/SoM/限速/审计）    │
│                └──────────────┬───────────────────┘                                       │
└───────────────────────────────┼───────────────────────────────────────────────────────────┘
                                │ NDJSON over stdio（常驻子进程；宿主沙箱外）
                 ┌──────────────┴──────────────┐
                 │ worker.exe (C# 5 → csc.exe) │  SendInput / BitBlt+DIB / UIA / 剪贴板
                 │ PerMonitorV2 DPI aware      │  角落急停 / 拖拽人机接管探测 / waitForIdle
                 └─────────────────────────────┘
```

四个交付物：
1. `packages/computer-use-core` —— 能力核心 + C# worker 源码 + 编译脚本
2. `packages/dsh-computer-use` —— DSH 原生插件（主力使用面）
3. `packages/computer-use-mcp` —— MCP stdio server（给任何 MCP 客户端；也可经 dsh-mcp-client 接回 DSH）
4. `scripts/deploy.ps1` —— 双 profile 部署（先全量备份 ~/.dsh，含回滚路径）

---

## 3. 原生 worker（worker.cs）

**语言与编译**：C# 5（老 csc.exe 冻结在 C# 5，这是踩过的坑〔实测〕），引用全部走 GAC 全路径
（csc 不解析 GAC 简名）。单文件 ~700 行，输出 28KB exe〔实测〕。

**协议**：NDJSON over stdio——每行一个 `{"op","args"}`，回 `{"id","ok","data"|"error"}`；
启动先发 `{"event":"ready", virtualScreen, monitors}`。附 `--op <op> [json]` 单发模式（调试与沙箱测试用）〔实测〕。

**操作集**：`ping screens cursor capture annotate move click drag scroll key type clipRead clipWrite
windows activate windowOp uia uiaFromPoint uiaFocused waitForIdle abort`。

关键技术选择（每条都有出处）：
- **SendInput 而非 mouse_event**〔MSDN：mouse_event 已标记 superseded〕；绝对坐标用
  `MOUSEEVENTF_ABSOLUTE|VIRTUALDESK` 归一化到整个虚拟桌面（多显示器负坐标合法）。
- **DPI**：启动即 `SetProcessDpiAwarenessContext(-4)`（PerMonitorV2）〔MSDN 高 DPI 指南〕，
  否则坐标全被虚拟化——这是社区最常见的坑。
- **截图**：GDI `BitBlt(SRCCOPY|CAPTUREBLT)` 到自建 32bpp DIB，拷贝进托管 Bitmap **后**再释放
  DIB（顺序反了就是 AV 崩溃 + WER 弹窗挂起——本项目实测踩过并修复），
  可选把真实光标 `DrawIconEx` 画进去；JPEG(GDI+ 编码器)/PNG、`maxWidth` 双三次降采样。
  延迟 ~200-400ms/帧〔实测〕，对 3-8s/步的 agent loop 足够；DXGI/WGC 是 stage-2（§9.2）。
- **UIA**：`System.Windows.Automation`（net48 GAC 程序集），BFS 限深限节点、
  每元素 try/catch（provider 挂起不拖垮整树）、元素含 name/role/rect/patterns/**isPassword**/value。
  Chromium 系内容可经 RootWebArea 拿到 DOM 化树〔社区：Windows-MCP 已验证〕。
- **waitForIdle**：轮询 (前台窗口, 标题, 焦点元素) 三元组签名，稳定 `stableMs` 即认为 UI 静止——
  替代固定 sleep 的竞态对策（OSWorld 2.0 "Streaming Interaction" 挑战）。
- **type 双模式**：ASCII 短文本走 `KEYEVENTF_UNICODE` 逐字符；含 CJK 或 >80 字符自动走
  剪贴板粘贴（IME-proof，社区共识），粘贴后可恢复原剪贴板内容。

**worker 侧仅有的两道安全**（策略层在插件，见 §8）：
1. **角落急停**（failsafe corner）：任何 actuation 前若物理光标位于屏幕左上角 ≤4px 内则拒绝
   （pyautogui FAILSAFE 同款约定〔社区：sandraschi〕）——人类物理优先权永远成立。
2. **拖拽人机接管探测**：drag 过程逐步比对期望坐标与实际光标，偏移 >24px 即释放左键中止。

---

## 4. Grounding 设计（本方案与市面方案差异最大的地方）

### 4.1 双通道
| 通道 | 载体 | 适用 | 成本 |
|---|---|---|---|
| **text-first** | `computer_state`（窗口列表+active+UIA 浅树）与 `computer_uia`（按 role/name 过滤，带精确 rect） | 默认观察通道；纯文本模型也能跑 | ~1-3K token，无视觉 |
| **vision 校验** | `computer_screenshot`（≤1280px JPEG/PNG 存盘 → read_image / attachment 管线 / MCP 图片桥接） | 布局复杂、canvas、UIA 不可见控件 | ~1.6K visual token/张〔Anthropic ⌈w/28⌉×⌈h/28⌉ 公式〕 |

### 4.2 Set-of-Marks（SoM）
`computer_marks`：UIA 树筛出可交互元素（role/pattern 匹配），编号 M1..Mn，
返回 (a) 文本 mark 表（id/role/name/center 坐标）与 (b) 画了编号框的标注截图。
模型点击只需 `computer_click {mark:"M7"}` —— **把坐标回归问题变成选择问题**：
- 天然免疫坐标幻觉/越界（服务端解析 mark→元素中心）；
- UI 变了 mark 就失效，逼迫模型重新观察（防死循环的隐性收益）；
- 与 Microsoft UFO² 的 Hybrid Detection（UIA+视觉检测 IoU 去重 + SoM 编号）〔官方〕同思路，
  我们 stage-0 用纯 UIA 做标记源，stage-2 并入视觉检测器（§9.4）。

### 4.3 坐标约定
绝对像素（虚拟桌面系），对齐 OpenAI/Claude 生态〔官方〕；宿主端 `resolveTarget` 做
mark→坐标解析与屏幕边界校验；缩放比 `scaledTo/region.width` 由 core 保管，
标注坐标乘缩放比进截图空间（方向踩过一次，已修复〔实测〕）。

---

## 5. 动作协议与 Agent Loop

**Loop 骨架**（写进 SKILL.md，模型行为由 skill 约束）：
```
observe(text-first) → [需要交互: marks] → act(by mark) → batch(3-7 步) → verify(批末自动附图) → report
```

**batch 语义**（照抄 Anthropic/OpenAI 批处理协议〔官方〕）：
- 顺序执行；首败即停；未执行项统一 `"Not executed: an earlier computer action in this turn failed."`
- 批末**自动附加截图**（Claude 官方：省一个往返且保证模型总看到最新状态）
- 同一动作连续 3 次无状态变化 → skill 强制打破循环（截图+求助）

**验证闭环**：OSWorld 2.0 的核心教训——失败主因不是点不准，而是**跳过验证**〔论文〕。
所以 SKILL.md 规定终态必须用 marks/screenshot 确认，禁止凭动作返回值宣布成功。

---

## 6. 视觉通道工程

- 降采样到 **≤1280 宽**（Anthropic WXGA 口径；每图 ≈1500 visual token）；
  文本密集场景用 PNG，一般用 JPEG q75〔官方建议：别依赖 API 端自动缩放，超限直接报错〕。
- 读取路径：DSH 插件把截图存 `$DSH_HOME/data/computer-use/shots/`，模型 `read_image` 该路径
  （dsh-attachment 管线投影给 deepseek-flash〔DSH 源码〕）；
  MCP 路径下图片块经 dsh-mcp-client 自动桥接成附件（同管线）。
- stage-2：`zoom` 双分辨率（低清全屏 + 原分辨率局部裁剪，坐标系不变）——Claude toolset 已验证的范式〔官方〕。

---

## 7. 安全设计（比 Astra 更保守，因为操作的是真实主力机）

四件套（sandraschi SAFETY 模板〔社区〕）+ DSH 原生审批，分层：

| 层 | 机制 | 说明 |
|---|---|---|
| 策略层 | **automationMode 四档** × `policyDecision` 纯函数 → pre-execute `{allow,deny,ask}` | read-only=只观察；standard=每个 actuation 走 harness 审批卡（一次性授权，fail-closed）〔DSH 源码〕 |
| 高危分类 | alt+f4 / win+r / win+l / del 族 / close 窗口 / 密码框输入 → **任何模式下都 ask** | OpenAI 三级 taxonomy 的本地化〔官方〕 |
| 原则 | **"屏幕内容≠许可"** 写进 SKILL.md；consequential 动作（发送/删除/购买/权限/密码）必停 | OpenAI 原文模式 |
| 物理层 | 角落急停（光标左上角=拒绝一切注入）+ 拖拽人机接管探测 | worker 级，模型无法绕过 |
| 进程层 | `DSH_COMPUTER_USE_KILL=1` 拒启；`dryRun` 只记日志不注入；限速默认 60 动作/分钟 | env 开关 |
| 审计 | 全量 actuation JSONL（参数脱敏：type 文本只记长度）+ 截图存档目录 | `$DSH_HOME/data/computer-use/audit.jsonl` |
| 密码框 | type 前查 UIA `IsPassword`，命中即拒绝（除非显式 allowPassword，且策略层仍 ask） | 自研，借 UIA 属性 |
| 已知边界 | **UIPI**：非管理员 worker 驱不动提权窗口且**静默失败**（SendInput 返回 0 无 GetLastError 线索）〔MSDN〕——文档明示，不尝试提权 | 与 Astra 相同限制 |

---

## 8. 与 Astra 的差距账本（诚实版）

| 项 | Astra/Codex | 本方案 stage-0 | 差距与补法 |
|---|---|---|---|
| grounding 精度 | 原生视觉 SOTA（ScreenSpot-Pro 92.7%）| UIA+SoM 文本为主，视觉校验 | 结构化通道对标准控件**更稳**（不猜坐标）；纯视觉场景靠 deepseek-flash 的视觉能力 + stage-2 视觉检测器 |
| 单步延迟 | 3-8s/步（含模型推理） | 模型推理占大头；注入 ~50ms/次、截图 ~300ms、UIA 树 ~400ms〔实测〕 | 本机操作开销 <1s，非瓶颈 |
| turn 效率 | 批量 actions[] + 代码执行 | computer_batch + 批末附图已实现；代码执行 stage-2 | `computer_exec`（模型写 JS 直接调 core API，本地循环零往返）是最大杠杆〔OpenAI 官方口径〕 |
| 长任务记忆 | 持久 notes + 可搜索旧窗口 | DSH 会话记忆 | 无专属差距（宿主能力） |
| 后台化 | Windows 也仅前台 | 前台 | VM 方案不在 stage-0 |
| 护栏 | 企业级 requirements.toml | 四档审批+物理急停+审计 | 单机场景已覆盖企业清单主干 |

---

## 9. 路线图

**stage-0（本次交付）**：全部只读操作 + 全部 actuation + SoM + batch + 审批四件套，
worker 编译与运行已实测通过（capture 9KB JPEG / PNG 148KB@640px、UIA 树、剪贴板、
waitForIdle、窗口枚举、窗口关闭均验证）。

**stage-1（首跑补齐）**：
- worker 常驻进程在真实插件环境下联调（本次仅单发模式实测——沙箱管道限制）；
  Node 侧看门狗：op 超时杀进程重启（core 已有超时，重启路径待联调）；
- marks 标注截图进模型消息流（当前 text 表 + 存盘路径双通道，read_image 兜底）；
- 高危窗口黑名单（密码管理器/银行进程 → 截图自动像素化）。

**stage-2（逼近 Astra 的三件事）**：
1. `computer_exec`：vm 沙箱内执行模型写的 JS，直接调 core API（await 循环/条件/局部重试零往返）；
2. DXGI Desktop Duplication / Windows.Graphics.Capture 截图后端（240fps 级 vs 当前 GDI ~75fps 级），
   WGC 顺带原生光标捕获；
3. 视觉检测器并入 marks（YOLO 图标检测本地 onnxruntime，UFO² 混合检测 IoU 去重），
   以及 zoom 双分辨率工具。

---

## 10. 部署与回滚

`scripts/deploy.ps1`（先全量备份 `~/.dsh` → `<backup-dir> (a full copy of $DSH_HOME taken before the deploy)`，铁律#3）：
0. **预检**：`node build/verify-tools-schema.mjs`（加载期守卫，见 §11-8）+ 编译 worker；
2. web+desktop 双 profile：复制两个包进 `node_modules`、旧版本改名 `.trash-<ts>` 不删（铁律#2；
   单文件热修时先删再拷，防 pnpm 硬连带写）、
   package.json 精确锁版本 + **`dsh.profile.bundles`** 注册（注意键路径含 `.profile.` 层——
   v0 写成 `dsh.bundles` 静默跳过导致插件未激活，已修复）+ UTF-8 无 BOM（铁律#5）；
3. skill 装入 `$DSH_HOME/skills/computer-use`；
4. 可选 `-McpInsert`：home 级 cordis.patch.yml 插入 dsh-mcp-client 条目（stdio，
   `DSH_CU_ALLOW_INPUT=1`，因为审批已由原生插件层负责）；
5. 提示重启两个宿主；回滚=恢复备份目录。

日常使用建议：settings 里 automationMode=**standard**（观察自由、actuation 逐次审批），
跑熟后按任务放宽到 autonomous；`DSH_COMPUTER_USE_KILL=1` 是家长开关。

---

## 11. 已知限制（诚实清单）

1. **提权窗口**（管理员 CMD/UAC）：非提权 worker 注入静默失败（UIPI）——按设计不绕过；
2. **WER 弹窗**：worker 崩溃理论上可能留 "应用程序错误" 对话框（本次开发期间出现于修复前，
   deploy 后如见 `worker.exe - 应用程序错误` 窗口直接关掉并报告）；
3. **Chromium 页面内容**需要 accessibility 激活（UIA 首次查询通常自动触发；
   若浏览器内容拿不到，用 vision 通道兜底）；
4. **BitBlt 抓不到硬件光标本体**（已用 DrawIconEx 手绘替代）与部分独占全屏场景；
5. GDI 截图 ~200-400ms/帧，不适合 >2fps 的连续视觉监控（stage-2 DXGI 解决）；
6. marks 依赖 UIA，Electron/Qt 部分自绘控件可能不在树里——SKILL 已规定此时退回坐标+视觉校验；
7. 单发模式实测通过；常驻 NDJSON 模式因会话沙箱管道限制未在本环境联调（插件宿主环境无此限制）。

### 11.8 部署期事故记录（2026-09-12，已修复，引以为戒）

两次真实事故，均在用户机器上发生并当场修复：

1. **bundle 注册键写错**：deploy.ps1 v0 把 bundles 写到 `dsh.bundles`，真实键是
   `dsh.profile.bundles`（中间多一层 `profile`）。guard `if ($pkg.dsh -and $pkg.dsh.bundles)`
   静默为假 → 插件文件全部就位但从未进层叠栈，apply() 不执行。症状：skill 能加载、
   worker 能编译，但 `~/.dsh/data/computer-use` 目录不出现。修复：repair-bundles.ps1 +
   deploy.ps1 修正（备份：`<backup-dir>-repair-*`）。
2. **dsh-tools schema DSL 硬约束**：`type:'object'` 节点必须显式声明
   `additionalProperties: true|false`（无默认值），而 parameters 走另一条编译路径
   （property map）不受此约束——所以只有 17 个 `output.schema` 踩雷。defineTool() 在
   apply() 期抛错 → 整个 Cordis 插件树加载失败 → **DSH Desktop 重启即崩**（用户机器实测）。
   修复：17 处补 `additionalProperties: true`（zcode 执行，三份副本逐字节一致）；
   新增 `build/verify-tools-schema.mjs` 加载期守卫（真实 defineTool + 桩 ctx 编译全部工具，
   零副作用），**今后每次改 tools.js 后、重启宿主前必跑**：
   `node build/verify-tools-schema.mjs`（当前实测 exit 0，17 工具全过）。
   回滚点：`profiles\{web,desktop}\node_modules\dsh-computer-use\lib\tools.js.bak-20260912-103622`。

### 11.9 首跑期事故记录·第二轮（2026-09-12，已修复）

`computer_state` 在宿主中全栈跑通后，`computer_marks` 暴露两个真 bug（均在用户机器上
现场定位、复现、修复，并已同步双 profile + 全局 worker 缓存 `3BB6FC204E0D1EDD`）：

3. **JavaScriptSerializer 的数组类型陷阱**（worker.cs Annotate）：JSON 数组反序列化为
   **`System.Collections.ArrayList`** 而非 `object[]`——`m is IEnumerable<object>` 恒为
   false → "marks required"。诊断手段：临时 `echoargs` 调试 op 返回每个 args 值的
   `GetType().FullName`（该 op 保留在 worker 里）。修复：改用非泛型
   `System.Collections.IEnumerable` 判定。152KB 生产尺寸请求复现→修复→回归全通过。
   **教训：net48 JavaScriptSerializer 的嵌套类型 = Dictionary<string,object> / ArrayList /
   Int32 / Boolean，写 `is` 判型前先 echoargs 看真实类型。**
4. **core ensureWorker 并发竞态**：`screenState` 用 `Promise.all` 并行发 3 个调用
   （windows/cursor/uia），旧 guard `if (this.proc && this.ready) return` 挡不住并发
   冷启动——连 spawn 3 个 worker、互相覆盖 `this.proc`、泄漏进程（现场实测：单次
   computer_state 泄漏 3 个 pid）。修复：single-flight（`this._ensuring` 单例 promise，
   所有并发方 await 同一次 spawn）。**教训：任何"懒初始化常驻子进程"的入口都必须
   单飞化，Promise.all 是竞态放大器。**

另：会话沙箱内 Node `child_process` 管道 spawn 一律 EPERM（AGENTS.md 铁律#9 的又一实证，
`build/chain-test.mjs` 复现）——core 全链路只能在宿主或沙箱外验证。

### 11.10 实战期事故记录·第三轮（2026-09-12 微信首任务，已定位，修复已staged）

5. **审批卡抢焦点**：standard 模式下每个 actuation 弹审批卡，用户点"批准"的动作把
   键盘焦点转移到宿主窗口——后续 ctrl+f/粘贴/enter 全部落错窗口（首次微信尝试
   无效的根因）。**规则：凡依赖键盘焦点的批处理，第一步必须重新激活目标窗口**
   （activate 或对目标内控件 click）。修复落 SKILL.md 待更新；行为规则见 HANDOFF.md。
6. **宿主工具队列卡死**：computer_batch 返回值含 `view: undefined` 键 → dsh-tools
   "value is not lossless JSON" 拒收 → 此后所有 computer_* 调用 15s 整超时（worker
   本身健康）。判断为串行执行槽未释放。修复：tools.js 不再产出 undefined 值键
   （已同步双 profile）；**恢复手段 = 重启宿主**。
7. **worker 卡死与看门狗**：waitForIdle 轮询 UIA FocusedElement 时被挂起的
   accessibility provider（微信 Qt 是嫌疑人）无限阻塞 worker 单线程循环；旧 core
   超时只拒绝 promise 不杀进程 → 后续调用排队等死。修复：call() 超时即
   `proc.kill()`，下次调用自动换血（~300ms）。已同步双 profile。
8. **用户产品反馈已实现（worker 侧，热生效）**：①鼠标移动动画化——
   AnimatedMove 缓动插值（默认 250ms），指针肉眼可见滑行；②物理移动容差预算——
   检测到自发移动 >40px 计 1 次，容忍 2 次、第 3 次拒绝执行，观察类操作重置预算，
   左上角急停保持零容忍；③点击/拖拽遇漂移先"重新对准再执行"而不是立即中止。

---

## 12. 参考文献（调研来源）

- OpenAI：developers.openai.com computer use 指南与 integration 配方；learn.chatgpt.com/docs/computer-use、app-server、managed-configuration（部分经二手交叉）
- Anthropic：platform.claude.com computer use tool（toolset 20260801、批量协议、分辨率口径）；claude-quickstarts computer.py
- MCP 规范 2026-07-28：transports / tools / server features
- Microsoft：SendInput / mouse_event / High DPI / Windows.Graphics.Capture / UI Automation 文档；UFO² Hybrid Detection
- 社区：CursorTouch/Windows-MCP（~7k★）、zavora-ai/computer-use-mcp、sandraschi/windows-computer-use-mcp（SAFETY.md）、microsoft/OmniParser、microsoft/SoM、bytedance/UI-TARS、zai-org/CogAgent、OS-Copilot/OS-ATLAS、DeepSeek-VL2
- 本地：DSH Desktop 2.0.9 asar 考古（工具注册/审批/MCP/附件管线/模型目录）、@anweat/dsh-browser 插件范本、AGENTS.md 铁律、DSH插件安装规范.md
