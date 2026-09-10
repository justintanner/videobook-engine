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
