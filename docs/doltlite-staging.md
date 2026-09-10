# DoltLite staging and native merge verification

The engine pins official `@dolthub/doltlite@0.50.9`, released September 10,
2026. It replaces the temporary `0.50.6-videobook.1` GitHub fork. The
[native release](https://github.com/dolthub/doltlite/releases/tag/v0.50.9)
includes the ignored-runtime merge fix from
[PR 2664](https://github.com/dolthub/doltlite/pull/2664), so the engine no longer
needs a custom DoltLite artifact or a copy of that merged source patch.

## Package provenance

- Native source: [`8328682f8fc56f7dbc9c989cc492b358dd8f1b60`](https://github.com/dolthub/doltlite/commit/8328682f8fc56f7dbc9c989cc492b358dd8f1b60), tag `v0.50.9`.
- Node wrapper: [`31d6fdf47abf02e75b5b3489742f254e6e88d8ef`](https://github.com/dolthub/doltlite-node/commit/31d6fdf47abf02e75b5b3489742f254e6e88d8ef), also recorded in npm's `gitHead`.
- [Registry tarball](https://registry.npmjs.org/@dolthub/doltlite/-/doltlite-0.50.9.tgz) SHA256: `6a6d4675fa0187f0e774d0c1059bdc16d27e2179f62927e9928e4ce82b54af3c`.
- Lockfile integrity: `sha512-LULaianLg8H4hcjZCnoB/tolFkBM0gAK/M85mHyFJGr3EIIHnW2+JgvfYRSbMVZ03MaWLj3/i8GjayYZ+fYZlg==`.
- Installed macOS arm64 addon SHA256: `31fa312d84c6caa757452d3acbc9632dbeddff2cf07dbe8a97f382d2a999a452`, matching the [upstream release asset](https://github.com/dolthub/doltlite-node/releases/tag/v0.50.9).

All five platform builds and npm publication passed in the
[publish workflow](https://github.com/dolthub/doltlite-node/actions/runs/34429883840).
The separate [wrapper CI](https://github.com/dolthub/doltlite-node/actions/runs/34429882878)
passed its nine Node 18/20/22 jobs on Linux, macOS, and Windows; its additional
Windows release-toolchain test crashed under Bun 1.4.2. This is not an all-green
upstream CI claim. The engine supports Node 22 and later.

The registry package provides prebuilt addons for Linux x64/arm64, macOS
x64/arm64, and Windows x64. Its source-build fallback still invokes `node-gyp`,
so that engine dependency remains. The install policy uses the ordinary
`@dolthub/doltlite@0.50.9` key. Official builds report
`doltVersion() = "doltlite-amalgamation"`; package smoke checks the installed
package version against the exact manifest pin instead of the former fork's
native commit stamp.

## Native regression checks

These commands pass against the installed official 0.50.9 package:

```sh
node scripts/dolt-staging-probe.cjs @dolthub/doltlite
node scripts/dolt-staging-probe.cjs @dolthub/doltlite --stage-all
node scripts/dolt-ignored-merge-probe.cjs @dolthub/doltlite --without-runtime
node scripts/dolt-ignored-merge-probe.cjs @dolthub/doltlite --without-index
node scripts/dolt-ignored-merge-probe.cjs @dolthub/doltlite
node scripts/native-full-catalog-merge-probe.mjs @dolthub/doltlite
```

The full probe covers 59 engine tables, 23 runtime tables, and 113 schema
objects. It checks fast-forward and three-way merges, ignored runtime rows,
indexes, integrity, foreign keys, conflict rollback, CAS contents, queued jobs,
and deleted job ID high-water marks through merge and reopen. An isolated
0.50.9 addon also passed on a catalog created by the previous fork, followed by
reopen and allocation using that previous binding. Each process loads only one
DoltLite addon. All probes use temporary synthetic catalogs and remove them
on exit.

`npm run test:package` repeats the full native probe against a clean installed
engine package. `tests/fork-flow.test.ts` covers URL bootstrap, catalog cloning,
lazy object reads, writes and reopen; `tests/merge-policy.test.ts` covers the
engine's merge policies and complete catalog. The dependency change requires
no engine schema migration or file-format conversion.

September 10 engine validation: 442 tests pass with 12 optional skips;
typecheck, lint, and build pass. Clean-package browser/API/tag/reopen/native,
media, and cached CLIP/CLAP inference checks pass with model downloads disabled.
The pre-existing `adm-zip` packaging defect visible in
[baseline CI](https://github.com/justintanner/videobook-engine/actions/runs/34435585747)
came from a development vendor override that did not propagate to consumers. The `ve-4vv`
repair bundles official ONNX Runtime with its patched ZIP dependency;
installed ZIP security regressions and the unchanged audit now pass. See the
[ZIP distribution notes](https://github.com/justintanner/videobook-engine/blob/main/vendor/adm-zip/VENDOR.md)
for the archive-size tradeoff. No new engine npm release is part of this source
change.

## Remaining native and wrapper fixes

Two recorded fixes are still absent from both official 0.50.9 and the former
fork. Their defects were reproduced again on the installed official binary:

- [Hard reset and ignored sequence state](../patches/doltlite/hard-reset-ignored-sequence.md):
  hard reset drops explicitly ignored `sqlite_sequence` while preserving its
  AUTOINCREMENT table; the next insert fails with a malformed-database error.
  Engine production code does not call `dolt_reset`. Supported merge and reopen
  paths retain their separate sequence checks.
- [Node wrapper merge outcome](../patches/doltlite-node/README.md):
  `doltMerge()` still returns `fast_forward: 0` for a real fast-forward.
  The engine's `fastForward` field remains advisory; no engine control flow
  branches on it. Actual merge ancestry and stored rows are checked directly.

These source patches remain available for upstream work; neither is applied
at installation. The registry switch removes the fork while preserving shipped
behavior. Tracking: engine adoption `ve-m3i.1`, broader consumer adoption and
the remaining fixes `ve-m3i`.

## Historical staging and merge failures

Incremental staging corrupted committed UNIQUE-index roots on 0.11.37 and
0.50.5. It was fixed by [PR 2646](https://github.com/dolthub/doltlite/pull/2646)
in 0.50.6. A separate ignored-runtime merge failure remained in 0.50.6 and led
to PR 2664 and the temporary fork. The old fork's source and release evidence
remain in git history and [release-evidence.md](release-evidence.md).

The staging fix prevents new corrupt commits; it does not rewrite previously
corrupted history. Snapshot bootstrap remains available for a healthy working
catalog whose old committed schema cannot be cloned. The engine keeps its
application policies, including singleton reconciliation and forget-wins
object handling.
