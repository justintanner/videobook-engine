# Vendored adm-zip (CVE-2026-76845)

onnxruntime-node 1.29.0 depends on `adm-zip@^0.6.0`. Every published
release is in the GHSA-vwc7-r8mq-g2x9 range (`>=0.5.9 <=0.6.0`):
extraction follows a pre-existing destination symlink and can overwrite
a file outside the extraction root when `overwrite` is enabled.

There is no patched npm version. This tree is adm-zip 0.6.0 plus
[cthackers/adm-zip#576](https://github.com/cthackers/adm-zip/pull/576)
(`c4e433234147656bca0e9e308aaa070899dc6b7b`), which rejects attacker-
controlled symlinks inside the extraction root without flagging OS-level
ancestor links such as macOS `/var` → `/private/var`.

The package version is `0.6.1` so GitHub Dependabot and `npm audit`
treat it as outside the advisory range. Drop this vendor copy when
upstream publishes a real patched release.

## Distribution in the engine

The engine bundles the official `onnxruntime-node@1.29.0` npm package and its
installer dependencies. This includes this patched ZIP implementation, so a
plain consumer install uses it before the ONNX postinstall script runs. The
engine's development override alone does not propagate to consumers; bundling
only `adm-zip` also lets a hoisted ONNX package resolve another, vulnerable copy.

Bundling retains official runtime binaries for every supported platform without
rebuilding them. The engine archive is about 102 MB (97 MiB), below the
consumer's 100 MiB GitHub vendoring limit. `scripts/prepare-onnx-bundle.mjs`
excludes optional CUDA provider downloads identified by ONNX's own install
metadata. It also omits the unused macOS `libonnxruntime.1.29.0.dylib` duplicate,
after checking that its bytes match `libonnxruntime.1.dylib`. The latter is the
install name used by both the native binding and library, verified with `otool`;
it ships as an ordinary file with unchanged bytes. Those CUDA providers are
installed separately by the unchanged upstream installer when requested. The
CPU CI jobs skip those optional downloads.

`npm run test:package` resolves ZIP from the installed ONNX installer and checks
normal file overwrites plus directory and file symlink attacks against sync,
async, and single-entry extraction. It also runs the normal engine/native/media
checks and the unchanged production audit. Windows exercises directory junctions;
Unix also exercises symlink leaves. The unpatched 0.6.0 package fails the same
symlink regression. `tests/onnx-packaging.test.ts` verifies that npm's real packer
includes and installs every platform's runtime files with their original bytes,
while excluding downloaded CUDA providers and the unused duplicate. The package
smoke also enforces the archive size limit.

Once a patched official ZIP release is available, verify it on these installed
consumer tests, then remove the vendor copy, override, ONNX bundle declaration,
and bundle-preparation script. Repair: `ve-4vv`; upstream removal: `ve-a54`.
