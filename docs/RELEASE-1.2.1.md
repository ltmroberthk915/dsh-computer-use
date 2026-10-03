# 1.2.1 native attention request fix

Published to npm's `next` tag at **2026-10-03 07:01:19.645 UTC**. The 24-hour
publisher threshold is **2026-10-04 07:01:20 UTC / 北京时间 15:01:20**. Publication
verification confirmed `next: 1.2.1` and `latest: 1.2.0`; promotion is a separate
operation after that threshold, not an automatic consequence of elapsed time.

Issue [#2](https://github.com/ltmroberthk915/dsh-computer-use/issues/2) reports a
missing `randomUUID` import in `lib/attention-native.js`. In 1.2.0 the helper can
start normally, but both `probe` and `raise` throw before the request reaches its
stdin. Importing `randomUUID` from `node:crypto` restores that request path.
The native C# code and prebuilt binaries are unchanged.

The new Windows guard sends concurrent `probe` and `raise` requests through the
real JS/native transport, checks distinct UUIDs, validates the native journal's
matching responses, sends cleanup, and verifies disposal refuses later calls.
It targets an executable that does not exist inside a unique temporary directory,
so it cannot select or raise a user's application window. It reproduces
`ReferenceError: randomUUID is not defined` on 1.2.0 and passes on the fixed code.
This establishes request dispatch and response handling; it is not a new
foreground-window or focus-policy benchmark.

The release smoke test now sends a native probe after helper readiness. It still
uses an empty PATH and a cold cache, checks prebuilt helpers, and performs only
read-only desktop capture. The existing 16 attention event/approval tests pass.

The 326,611-byte npm archive was downloaded back from the registry and matched the
tested local package, SHA-256
`458600caa5ccdccc6302366a6294c7381f4c4b5b699ab883f70debba63fb5828`.
The actual official Desktop manager installed the packed artifact into an
isolated profile; its installed native request guard and cold-cache smoke test
passed. All 18 tool definitions compiled with the installed Desktop's real DSL.

A separate npm upgrade check reproduced the missing import in the published
1.2.0, upgraded to 1.2.1, and passed the native request and smoke tests against
the installed 1.2.1. Immediately re-adding that same new version then failed
pnpm's lockfile check with `ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION`, even though
both version exceptions were present. The already installed 1.2.1 remained
selected. This is a remaining host/package-manager release-age limitation;
same-version reinstallation during the cooling period is not claimed to work.
The release stays on `next` pending the normal age threshold and promotion.

Run against either the checkout or an extracted/installed package:

```sh
node build/test-attention-native.mjs [absolute-package-directory]
node scripts/verify-package.mjs [absolute-package-directory]
node scripts/smoke-native.mjs
```

Publication follows the [release procedure](RELEASE-1.2.0.md): publish 1.2.1 to
`next`, verify the registry archive and official Desktop install/update path,
then wait at least 24 hours before promoting `latest`. Until promotion, a normal
market update still follows the previous stable version. To explicitly select
the published fix, use `dsh-codex-style-computer-use@1.2.1`; strict release-age
policies still apply. A local source change alone is not proof of publication.
Replacing an already loaded module may require the restart reported by DSH.
