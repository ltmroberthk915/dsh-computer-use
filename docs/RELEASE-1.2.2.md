# 1.2.2 GitHub pre-release

This release includes commit `ca3e3f7`, which adds the DSH host approval-attribution patch utility and its regression suite. It also includes the native attention fix from 1.2.1. The computer-use input dispatch, approval rules and prebuilt native helpers retain their existing behavior.

## Downloads

- `dsh-codex-style-computer-use-1.2.2.tgz`: complete prebuilt plugin package, including the patch utility. Install through a host that accepts manual tarball installation; follow its restart indication.
- `computer-use-approval-patch-1.2.2.zip`: standalone patch preparation utility, upstream fixtures, policy module and 14 regression cases. Extract it and read its `README.md` before preparing a host patch.
- `SHA256SUMS.txt`: SHA-256 identities of both downloadable artifacts.

The host patch targets `@deepseek-ai/dsh-tools` from DSH Desktop 0.2.1-rc.2. With session policy `never`, it identifies an automatic rejection caused by disabled approval prompts instead of asserting that the user rejected the tool. The utility previews by default and writes only a separately named output file. Installing the plugin tarball does not replace the host module automatically. See [the patch scope and commands](APPROVAL-ATTRIBUTION.md).

## Validation

The release checks cover the 14 approval-attribution cases, existing policy and attention/release guards, native manifest identities and the actual packed plugin archive. The standalone toolkit is tested again after ZIP extraction. CI includes the approval-attribution regression guard.

The earlier local deployment was verified against the running DSH host and through an independent Electron loader. That result applies to the tested local host build; the release does not claim automatic host patch installation on another machine.

This is a GitHub pre-release. npm publication, the `latest` dist-tag and market availability are separate operations. This publication does not change them or restart a running DSH instance.

## 中文

此预发布包含本次审批误报修复提交 `ca3e3f7`，并保留 1.2.1 的原生提醒修复。提供完整插件包、独立宿主补丁工具 ZIP 及 SHA-256 校验文件。宿主补丁需要单独部署；只安装插件包不会自动修改 DSH 宿主。npm/市场发布与正式版提升另行进行。
