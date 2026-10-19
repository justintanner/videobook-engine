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
repair bundled official ONNX Runtime with its patched ZIP dependency;
installed ZIP security regressions and the unchanged audit passed. That bundle
increased the archive to about 97 MiB and was published in engine `5.4.2`;
see the [verified release evidence](release-evidence.md#published-542-patch-september-10).
The current source uses official adm-zip 0.6.1 through ONNX's installer dependency
and no longer vendors ZIP or bundles ONNX. The installed-consumer ZIP security
probe remains part of the package gate.

## Remaining native and wrapper fixes

October 18 recheck (`ve-3e4.2`): both defects still reproduce on the installed
official `@dolthub/doltlite@0.50.9` Linux x64 package, using Node 22.23.3 and
24.21.0. Run `npm run build`, then `node scripts/native-followup-probe.mjs`.
The probe uses disposable databases, reports both results, and exits **1** while
these upstream defects remain. It does not patch the dependency or belong to the
passing default test suite.

- Hard reset: the ignored runtime row with ID 1 survives, but `sqlite_sequence`
  disappears. Its pre-reset high-water mark was 2 (ID 2 had been deleted).
  Inserting the next row fails with `prepare: database disk image is malformed`;
  it cannot allocate the required ID above 2.
- Fast-forward: the resulting HEAD equals the incoming commit and the incoming
  row is present, but `mergeWithPolicy` reports `fastForward: false`.

These are live dependency regressions carried by published engine 5.4.5 and current
5.7.0. The engine does not call native hard reset, and `fastForward` is advisory;
the observed defects do not invalidate the separately passing merge/catalog
checks. Neither recorded patch is applied at installation. Adopting patched
native/wrapper bytes requires upstream adoption or an explicitly authorized
package rebuild. On October 19 the operator chose upstream submission under
`ve-3e4.2`, keeping official 0.50.9 installed. This verification and submission
change no dependency, version, tag, or published artifact.


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

These source patches remain unapplied at installation. Upstream delivery is
tracked by `ve-3e4.2`; the earlier official-package adoption `ve-m3i` is complete.

### Upstream submissions (October 19, 2026)

- Native: [DoltLite PR #4083](https://github.com/dolthub/doltlite/pull/4083),
  ported onto `df5c8a3e227b32ae5703ee9042b50e49a2a155dd`. The preservation scan
  now also handles views and triggers; the port retains the recorded sequence
  predicate and five regression cases. The original patch SHA-256 remains
  `36f71feab3812882a59284368daaa980d7c7c824f68cadf75ee204d4bd3b0e14`.
  `bash test/doltlite_reset.sh build/doltlite`: 113 pass with the fix;
  the same base rebuilt without it gives 111 pass and two expected failures
  (missing sequence and allocation above the deleted ID).
  The pinned Dolt 2.5.0 reset oracle also passes all 91 checks.
- Wrapper: [doltlite-node PR #7](https://github.com/dolthub/doltlite-node/pull/7),
  applying the recorded patch unchanged to
  `3c1824d5bf24f1b6c2e681d366fc02a395665809`; original SHA-256
  `ad3964c77fd49e153616cec9fd7271060f490e583ee46feec69996483df67964`.
  A local test build against the official 0.51.0 release amalgamation passes
  `bun test test/`: 135 tests across six files. Recompiling the original wrapper
  source gives 133 pass and two expected fast-forward failures. These isolated
  upstream test builds do not replace the installed engine dependency.

The installed-package diagnostic was repeated on Node 24.21.0/Linux x64 on
October 19 and produced the same two failures above. Upstream submission is
not package adoption: both defects remain in the engine dependency until an
authorized update incorporates and verifies released fixes.

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
