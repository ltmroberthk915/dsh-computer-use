# GLM 核验与 1.1.1 本地优化报告

日期：2026-10-02。范围：DSH Desktop 0.2.0-rc.2、bigmodel-anthropic / glm-5.3-flash、本机 Windows。先完整备份，再改源码、对照测试、打包并安装。

## 已完成的优化与证据

| 项目 | 旧版实测 / 原始记录 | 新版实测与行为 |
|---|---|---|
| 按钮焦点下输入 | 同一自有测试窗口收到 7 个按键；编辑框仍为空，但 Type 返回 chars:7。原 GLM 会话同类事件为 16 字符、读回 0 字符 | Button 且没有可编辑 UIA pattern 时提前报 TYPE_FOCUS_NOT_EDITABLE / not-dispatched；收到 0 个按键，粘贴分支也在剪贴板操作前拒绝 |
| 输入兼容性 | 先聚焦编辑框可正常输入 | UIA focus 后输入读回 Probe77；无 Value/Text pattern 的自定义 Pane 编辑器仍读回 Custom7，不因未知控件一律拒绝 |
| 等待范围 | 全虚拟桌面采样包含目标外的变化；受控动画使全屏差异约 2%，静止目标区域为 0% | computer_wait 的 stable/change 支持观察到的 hwnd；默认仍为全虚拟桌面。1.6 秒上限的同环境对照：全屏 1761ms 后 stable:false，目标窗口 794ms 后 stable:true；目标移动/最小化时拒绝使用原范围 |
| 采样数组越界 | 2560×1600、步长 7，旧版 FrameSignature 抛 IndexOutOfRangeException | 返回完整 83814 个采样点 |
| 底部采样遗漏 | 33×33 区域、步长 16，旧版仅保留 4 点，底行变化 diff=0 | 新版保留 9 点，同一底行变化 diff=33.333% |
| 明确拒绝的回执 | 原始窗口几何变化被 worker 明确拒绝，JS 却归为 outcome=unknown | 已明确发生在请求动作之前的拒绝保留 code/outcome；没有明确证据的错误与超时仍为 unknown |
| STALE_MARK 诊断 | 原来的错误没有指出哪项比较变化 | 新错误区分 hwnd/pid/区域坐标/采样帧签名变化。保留原来的严格校验，没有降低阈值或忽略遮挡 |

焦点准备可能改变前台窗口；not-dispatched 指请求的动作未派发，不保证窗口焦点等准备状态完全不变。marks 的差异字段不等于动画来源鉴定。

技能规程同步补充了：invoke 后显式 focus 编辑区；按需用目标窗口等待；持续动画时用 UIA 读回；不把回执、像素不变或超时当成业务结果；记录准确模型、版本和实际工具覆盖范围。已有分级观察和完整快照取回仍保留。

## 视觉链路：有接口记录的随机盲测

使用本机安装的插件 image-output、从实际 app.asar 提取的 DSH 适配器与 Anthropic 转换逻辑，发送到当前配置的官方接口。适配器逻辑未改，只在沙箱增加内部函数导出用于测试。附件存储使用内存实现；因此这证明适配器、插件图块与模型接口之间可传图，不等同于对原聊天全部附件生命周期的端到端复现。

随机字符只在图片像素中，未放进提示词、文件名、UIA 或工具文字。没有传送私人截图，未打印凭据。

| 对照 | 期望 | 模型实际回答 | 耗时 | 返回总 token |
|---|---|---|---|---|
| 无图 | NO_IMAGE | NO_IMAGE | 2328ms | 130 |
| 用户消息附图 | 76T682PW | 76T682PW | 1954ms | 488 |
| 插件工具结果附图 | A9BMT89A | A9BMT89A | 1514ms | 556 |

三次均通过。请求侧记录了 endpoint、model、图像数量、字节数与 SHA-256；两个带图请求均含真实 image/base64 数据。总计 1174 token，不据此推算账单价格或普遍性能。

当前版本已经支持直接附图；本轮保留该能力，无需凭模型自述改回仅返回路径。原日志在切换为 Flash 后没有新的 shot/read_image 调用，不能据其总结判定 Flash 看不到图，也不能把昨天 glm-5.3 的调用算作今天 Flash 的新验证。

## 尚不能下结论的部分

- 原两次 STALE_MARK 由 Pet 引起：没有当时前后采样区域与遮挡的对照证据。受控实验只证明“外部动画能影响全屏等待”，不能追认原历史错误由 Pet 造成。此次增加失效字段，便于下一次按几何变化或帧变化分流取证。
- Notepad 关闭钮属于“悬停虚拟化”：记录能证明最小化时 0 个、恢复后 1 个，不能排除激活状态、可见性等其他因素。没有据此增加按名称首匹配的关闭行为。
- “光标闪烁时永远不静”：原记录只有一次约 8 秒超时；lastDiffPct=0.388 只表示最后一对采样，不能称为整个 8 秒持续相同，更不能证明来源一定是光标。
- “y≈1838 是扩展桌面”：本轮以 PerMonitorV2 感知测得主屏和虚拟桌面均为 2560×1600。不能把离屏坐标直接解释为额外显示器；这也不能反推历史每个时点的显示设置。
- 不声称 18 工具全覆盖、不声称滚轮正反回执已证明位置还原，也不以这些小样本声称对其他项目全面领先。

## 回归与安装

- 33 个 guard 脚本均已通过。首次总跑 32 通过、1 个 test-cycle-open 失败；原因是本次启动命令给了全局 EXIT_FILE，使该脚本自建 LOCALAPPDATA 沙箱的退出标记失效。取消该外层覆盖后，该脚本 34 项断言及 13 项变异检查通过。没有削弱断言或改生产逻辑来过测试。
- 新原生 fixture 包含 13 项检查；旧版使用同一 fixture、相同 DPI 感知方式做可适用的 8 项对照。新协议测试 11 项。它们包含在上述 guard 数中，不重复计数。
- 实际 DSH 0.2.0-rc.2 运行时 25 项兼容检查通过，含按 Agent 加载、隔离、完整快照、差分和真实 Node PTC。
- 打包后关键控制/协议检查通过；desktop、web、headless 三个已安装包实际 apply 注册测试均从 3 个入口变为 19 个注册工具。
- 三个 profile 均为本地 1.1.1，每份 30 个包文件逐一校验；原配置保留，其他插件文件校验无改动。Pet 保持 0.4.4-local.20261002.1。
- 常规 pnpm 安装遇到 Pet 本地修订与官方清单不一致，本轮未下载覆盖 Pet。随后在独立沙箱用 pnpm 解析锁文件，只同步目标包及其记录；校验 vendor 路径、SHA-512、根锁和 node_modules 锁、hoistedLocations 一致。
- DSH 经“应用→退出”正常退出并重新启动；新主进程 PID 33272，启动于 2026-10-02 10:59:09 +08:00。界面卡片的“运行中”标识未纳入本轮通过项：重启后界面工具出现 geometry unavailable，截图与目标窗口不一致，未据此操作或宣称卡片已核实。
- 本轮只完成本地安装，没有将 1.1.1 推送或发布到市场。

安装包 SHA-256：
bbe7beb55ef931eeb80bc0550db7fe53bafd78fb1aadf8f37757b21fedd7ac32

完整备份（27000 文件，逐文件核验）：
D:/BuyKey/dsh-before-glm-evidence-2026-10-02T02-31-12-025Z

证据目录：
C:/Users/Ming/Documents/Codex/2026-10-01/d-buykey-gpt-md/work/glm-evidence-20261002

关键原始证据：
- native-before-dpi.json / native-after-final.json
- vision-live.mjs / vision-results.json
- guards.log / guard-cycle-open-recheck.log
- runtime-result.json / installation.json / lock-paths.json
- packed.json / profiles-before.json

源码与可复跑测试位于 D:/BuyKey/dsh-computer-use；独立发布候选目录为 D:/BuyKey/_publish/releases/dsh-computer-use-v1.1.1。

