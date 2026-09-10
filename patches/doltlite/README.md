# DoltLite upstream fixes

The engine now uses official `@dolthub/doltlite@0.50.9`. See
[dependency provenance and verification](../../docs/doltlite-staging.md)
for the installed package and regression checks.

## Merged: ignored runtime tables during native merge

[PR 2664](https://github.com/dolthub/doltlite/pull/2664) merged the engine's
ignored-runtime fix into upstream `master` as
[`9a3725f2758b7a66daa79e9ebaf18e6bd389e78c`](https://github.com/dolthub/doltlite/commit/9a3725f2758b7a66daa79e9ebaf18e6bd389e78c)
on September 6, 2026. Official 0.50.9 contains that commit and subsequent
upstream improvements. The engine's copy of the merged patch and draft PR
description have been removed; their original validation and provenance remain
in git history and the upstream PR.

The former `0.50.6-videobook.1` package combined native
`b3981dc9ed6b2e39c247b4d598b2691e19dd0b25` with Node wrapper
`4bed4889be31c683f81291e2f661d07e50b7a3fe`. Its GitHub release pin is no longer
an engine dependency.

## Remaining source patches

- [Hard reset must preserve ignored AUTOINCREMENT sequence state](hard-reset-ignored-sequence.md)
  (`ve-nia`). This native fix is still absent from official 0.50.9.
- [The Node wrapper must report the actual fast-forward outcome](../doltlite-node/README.md)
  (`ve-xkv`). This wrapper fix is also still absent from official 0.50.9.

Neither patch is applied by the engine. They retain their original source
revision, checksum, and validation evidence for later upstream adoption.
Native source licensing is recorded in [LICENSE.md](LICENSE.md).
