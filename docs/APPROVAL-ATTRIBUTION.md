# Automatic approval refusals attributed to the user

DSH Desktop 0.2.1-rc.2 can report `the user rejected tool "computer_key"` even though no approval prompt was shown. The host approval service returns `rejected` for the session's `never` policy, and the host tool runtime interprets every `rejected` outcome as a human decision. The same issue affects `computer_batch` and other tools that ask for approval.

The correction snapshots the session's effective policy before requesting approval. A `never` rejection now names the disabled prompts and states that the request was rejected automatically without asking the user. An answerer rejection names the approval channel without asserting that a human made the decision. The original approval reason is included. Grants, cancellation, unavailable channels and approval audit events retain their existing behavior.

## Reproduce and prepare the patch

Run from this repository with Node.js 22 or newer:

```sh
node build/test-approval-attribution.mjs
node scripts/patch-approval-attribution.mjs --input /path/to/extracted/dsh-tools/lib/index.js
node scripts/patch-approval-attribution.mjs --input /path/to/extracted/dsh-tools/lib/index.js --output /path/to/new/index.fixed.js --fixed-length
```

The second command previews the change and its SHA-256 identities. The third writes a new file exclusively; it refuses to overwrite the input or an existing output. Unsupported source shapes fail before writing. Reapplying to an already corrected source returns `already-patched`. `--fixed-length` preserves the original UTF-8 byte length with trailing whitespace and refuses an oversized replacement.

The utility targets the compiled `@deepseek-ai/dsh-tools/lib/index.js` shipped in Desktop 0.2.1-rc.2 (Harness build `332895e0f7c9d4dbfb29729f5eb367fa263ff986`). An ASAR deployment also needs a backup, updated module integrity hashes and verification of the other archive entries. The utility prepares module source; it does not replace a desktop installation or change a running process. A different host build requires a fresh source comparison and verification.

## Verification and distribution

The 14 regression cases exercise the original shipped approval implementation against in-memory sessions: the erroneous baseline, automatic refusals, session policy overrides, a policy switch while an answer is pending, grants, cancellation, unavailable channels, request identity forwarding, unchanged key rules, fixed-length output, idempotency and unsupported inputs. Fixtures retain their upstream provenance and license.

The utility was also checked against the complete module used for the local repair: it generated the deployed payload byte for byte. The running desktop host returned the corrected refusal through its real approval service using an in-memory session. A separate Electron process loaded the corrected module from the installed archive. These checks performed no desktop input or writes to real sessions.

This commit ships the host patch utility and regression evidence. The computer-use plugin runtime remains version 1.2.1; it does not install the host patch automatically. The local host repair is independent of npm distribution, and a desktop upgrade can replace it.

## 中文说明

问题来自 DSH 宿主：会话审批策略为 `never` 时，审批服务直接返回 `rejected`，工具层却统一解释成“用户拒绝”。修复后会明确说明“审批弹窗已禁用，操作被自动拒绝，未询问用户”，并保留需要审批的原始原因；交互通道返回的拒绝会注明来自审批通道。

本工具生成宿主模块补丁，默认只预览，指定 `--output` 才写入一个新文件。它保留审批、取消、审计和 computer-use 的按键策略。上述 14 项回归和本机宿主验证已通过。仓库提交包含可复用补丁工具及测试，插件仍为 1.2.1；桌面安装包替换需单独部署，桌面端升级也可能覆盖本机修复。
