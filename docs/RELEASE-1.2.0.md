# 1.2.0 release validation

This release uses the npm name `dsh-codex-style-computer-use`. The repository remains
`ltmroberthk915/dsh-computer-use`. The existing npm name `dsh-computer-use` points to
another author's repository, so legacy Git/tarball installations require one migration
through the plugin UI. Tool names, the settings namespace, approval gates and the
1.2.0-rc.2 native input behavior are retained.

## Verified locally on Windows, 2026-10-03

- All 37 regression scripts passed. The suite includes native input fixtures,
  approval/brake/cancellation contracts and 10 new installation cases. The optional
  exit-coherence native leg retains its existing opt-in policy.
- New installation coverage: no PowerShell on PATH, no available compiler with a
  valid prebuilt helper, stale source identity, damaged binary/cache, Unicode and
  space-containing paths, and four simultaneous cold starts.
- Both native helpers carry source and binary SHA-256 identities. Helpers run from
  a user cache outside `node_modules`, so a running helper does not lock package
  files during an update. Source checkouts use Windows' own .NET Framework compiler
  directly without invoking PowerShell.
- The actual npm tarball was installed through dshmarket's official desktop bridge
  and the unmodified DSH Desktop 0.2.0-rc.2 PluginManager into an isolated profile.
- The published npm candidate was downloaded and verified against the local archive,
  installed through that bridge, and reinstalled at the same version successfully.
  The market's actual update check detected `1.2.0-rc.3` → `1.2.0`; applying that
  update installed `1.2.0`, after which the check correctly reported no update.
  The registry download of the final release is byte-identical to the local archive.
- An empty-PATH, cold-cache smoke test against that installed package passed worker
  ping, cursor query, read-only screenshot capture and attention-helper startup.
  This smoke test does not inject desktop input.
- The installed plugin imports successfully through the official DSH runtime's
  package resolver. Its 18 desktop tool schemas compile with both the installed
  older CLI DSL and the official Desktop 0.2.0-rc.2 DSL.
- The tarball contains precompiled JavaScript, both native helpers and manifests,
  C# source, bundle patch and all skill references. It contains no install, prepare,
  prepack or prepublish lifecycle hooks and no package-manager bootstrap.

The isolated manager has no running UI/HMR service and correctly reports a restart
requirement. These checks do not establish live activation in every DSH version.
Follow the host's restart indication. Market catalog acceptance and propagation are
managed by the external marketplace, separately from npm publication.

## Release procedure

1. Run `node scripts/build-native.mjs` on Windows after modifying either C# source.
2. Run `node scripts/verify-package.mjs`, the regression suite and tool-schema guard.
3. Pack and test the actual archive; publish a candidate to the `next` tag.
4. Verify registry installation, same-version reinstall and update to the final
   stable release using the market bridge. Publish stable versions to `latest`.
5. Verify that the market catalog resolves the repository to the new npm name.

The npm package is discovered by the market from the repository's `package.json`
and its matching npm repository metadata. The source catalog does not accept an
`npm:` field in individual YAML entries.
