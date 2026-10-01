# 1.1.0

Desktop tasks can now activate their tools per Agent, recover an observed UIA control after replacement with explicit unique-evidence checks, and request incremental observations while retaining complete snapshots.

- Idle Agents receive three activation/safety tools; active Agents receive the existing 18 controls plus the activation entry. Other Agents and children activate independently.
- Scoped name/id UIA queries issue target handles. Opt-in rebinding refuses ambiguous, changed-context or incomplete evidence. Broad queries avoid witness overhead by default.
- Explicit since bases produce lossless changes, including order. Each Agent retains 64 full observations, retrievable with snapshot. Missing or unsuitable bases return full output.
- Native screenshot transport, approval modes, cycle ownership and human brakes remain in place. Public installs keep the existing standard approval default.

Validation: 31 Windows guard scripts passed on the flattened release tree; the production DSH runtime/Node PTC compatibility checks cover Agent isolation and snapshot retrieval. Controlled native fixtures test successful recovery and zero extra button callbacks on refusals. Earlier model tests used the configured DeepSeek route; these are small controlled samples, not a claim of universal speed or reliability.

Requires Windows, Node.js >=22 and a DSH host providing scoped tool registration (including @deepseek-ai/dsh-scope). progressiveTools:false retains the original global tool surface on hosts providing those packages.

中文：新增按 Agent 加载工具、显式且唯一的 UIA 目标恢复、增量观察与完整快照取回。宽查询默认不生成恢复句柄，以控制额外开销；人为刹车、审批和控制会话归属仍然生效。
