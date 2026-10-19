# 1.2.3 — automatic approval attribution compatibility

Normal plugin installation/update now installs the correction for affected `computer_*` calls, including batches. A disabled-prompt automatic refusal identifies the `never` policy and states that the user was not asked. An approval-channel refusal does not claim a human made that decision. The original reason remains available.

The plugin delegates to the existing host service before correcting the exact legacy message. Outcomes, cancellation and durable approval audit remain owned by that service. Other tools and already-corrected host messages pass through. On unload, the original service method is restored using its stored descriptor, including Cordis traced access. Hosts without this compatibility seam report its unavailability and retain their existing behavior.

The standalone host patch tool from 1.2.2 is still available for operators who need a host-wide correction. It is no longer required for the plugin's own calls on the tested DSH Desktop 0.2.1-rc.2 host. Follow the host's restart indication when updating an already loaded version.

The release includes the complete plugin with both prebuilt native helpers. Validation covers 23 attribution regressions (including installation/unload and traced method access), the actual packed module, existing approval policy, attention and release guards, native helper manifests and isolated native attention round trips. The adapter is also checked against the real running Cordis service using in-memory approval events, without input injection or writes to real sessions.

中文：此版本将修复集成到插件加载流程，正常安装或更新即可对 computer-use 调用生效，无需另行修改宿主文件。审批、取消、审计和原有按键策略保留。更新已加载版本后请按宿主提示重启。
