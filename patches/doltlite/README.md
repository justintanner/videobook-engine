# Ignored runtime tables in native merges

The [source patch](ignored-runtime-merge.patch) fixes a native DoltLite merge
failure when an otherwise clean working catalog contains ignored local tables.
It also keeps their rows and indexes local through merge, abort, reopen, and
allocation failures. Production still uses published DoltLite 0.50.6 and the
engine's projection merge. The patch is submitted for upstream review in
[DoltLite PR 2664](https://github.com/dolthub/doltlite/pull/2664).

## Provenance

- Source: [dolthub/doltlite](https://github.com/dolthub/doltlite).
- Base: [`37a390eb7b021962d9d287a465a2da3c9f59c3cf`](https://github.com/dolthub/doltlite/commit/37a390eb7b021962d9d287a465a2da3c9f59c3cf).
- Patch SHA-256: `73876308d3ae045bfba59d807eb027a58b556cec882c8554665b2e97d66d4008`.
- Submitted commit: [`b3981dc9ed6b2e39c247b4d598b2691e19dd0b25`](https://github.com/justintanner/doltlite/commit/b3981dc9ed6b2e39c247b4d598b2691e19dd0b25).
- Validated September 6, 2026 on Apple M1 Pro, 16 GiB RAM, macOS arm64,
  Node 24.10.0, with Dolt 2.3.1 as the semantic reference.
- DoltLite extensions are Apache-2.0, copyright 2024–2026 DoltHub, Inc.
  The upstream [license information](LICENSE.md) is included unchanged.
- Beads: preparation `ve-wsu.1`; published dependency adoption `ve-wsu`.

The patch changes four native source/header files, adds a focused regression
and a Dolt comparison suite, and registers both in their CI buckets.
It changes no public API, file-format version, or package version.

## Behavior

The pre-merge dirty check compares the tracked catalog with HEAD while carrying
untracked tables selected by `dolt_ignore` separately. Tracked, staged, ordinary
untracked, and metadata changes still refuse the merge. A tracked table remains
tracked even when its name matches an ignore rule.

The live working catalog receives ignored tables before schema actions rebuild
indexes. Only the staged and committed catalogs exclude those tables. This
ordering preserves local data if index rebuilding commits internally or fails
partway through. Incoming name collisions refuse the merge. Fast-forward,
three-way, no-commit, squash, conflict rollback, and explicit abort preserve
local table and index contents.

Status applies the table's ignore rule to its indexes. The allocation-failure
regression also exposed four decoded schema strings leaked when growing the
schema-entry array failed; the patch frees those strings on that error path.

## Native verification

| Gate | Result |
| --- | --- |
| Focused testfixture regression, including transient allocation failures | 4,156 checks; zero errors or memory leaks |
| Complete native shell suites | 126/126 |
| C suites | 33/33 |
| New ignored-merge comparisons against Dolt | 10/10 |
| Existing ignore comparisons against Dolt | 50/50 |
| Existing merge comparisons against Dolt | 104/104 |
| Native lint, layering, bucket, and automation checks | Pass |
| Clean stock-SQLite build and parity suite | Pass; included in the 126 suites |
| Patch application to the exact base | Pass |

On the unpatched base, the new comparison suite fails all ten cases, and the
focused fast-forward regression fails. Published 0.50.6 also reproduces the
two-table failure with and without a runtime index.

From a clean DoltLite checkout at the base above, set `VE_ENGINE_DIR` to this
engine checkout and apply the patch:

```sh
git apply --check "$VE_ENGINE_DIR/patches/doltlite/ignored-runtime-merge.patch"
git apply "$VE_ENGINE_DIR/patches/doltlite/ignored-runtime-merge.patch"
mkdir -p build build-stock
cd build
../configure
LIBRARY_PATH=/opt/homebrew/lib make -j8 doltlite doltlite-lib testfixture
cd ../build-stock
../configure
LIBRARY_PATH=/opt/homebrew/lib make -j8 DOLTLITE_PROLLY=0 sqlite3
cd ..
ln -s ../build-stock/sqlite3 build/sqlite3
cd build
./testfixture ../test/doltlite_merge_ignored.test
make lint
cd ..
bash test/run_doltlite_tests.sh
MAKEFLAGS=-j8 LIBRARY_PATH=/opt/homebrew/lib bash test/run_c_tests.sh build all
bash test/vc_oracle_ignored_merge_test.sh build/doltlite dolt
bash test/vc_oracle_ignore_test.sh build/doltlite dolt
bash test/vc_oracle_merge_test.sh build/doltlite dolt
bash test/check_oracle_buckets.sh
```

The separate stock build prevents accidentally using DoltLite objects for the
SQLite parity reference. Homebrew's library path is specific to this macOS
validation host. The oracle commands require the real `dolt` executable.

## Full engine catalog verification

The [application probe](../../scripts/native-full-catalog-merge-probe.mjs)
creates a synthetic book with the installed production binding, operates on it
in a separate process with a supplied native binding, then reopens it with the
production binding. Each process loads only one DoltLite native module.

With the patched native library and the published 0.50.6 Node binding sources,
the probe passes for all 56 engine tables, 23 ignored runtime tables, and 107
schema objects. It checks fast-forward and three-way merges, every runtime row,
schema and indexes, integrity, foreign keys, reopen, exclusion of runtime tables
from HEAD, conflict rollback, file contents in the object store, and a queued
job. The 0.50.6 → patched native → 0.50.6 reopen also passes.

```sh
npm run build
node scripts/native-full-catalog-merge-probe.mjs /absolute/path/to/patched-node-binding --keep
```

Omit `--keep` to remove the synthetic catalog after the run. The default binding
is `@dolthub/doltlite`; published 0.50.6 fails the clean-status assertion because
ignored indexed tables appear modified. The smaller
[`dolt-ignored-merge-probe.cjs`](../../scripts/dolt-ignored-merge-probe.cjs)
isolates the merge refusal itself.

The isolated binding used the unchanged `src/*.cpp` and `index.js` from
`@dolthub/doltlite@0.50.6`, its `binding.gyp` without amalgamation C sources,
headers from the patched `build/`, and that build's `libdoltlite.a`, `-lz`, and
`-lpthread`. It was rebuilt with the engine's `node-gyp` and `node-addon-api`.
The installed production dependency was not replaced.

## Adoption

The [prepared upstream PR description](UPSTREAM_PR.md) accompanies the patch.
[PR 2664](https://github.com/dolthub/doltlite/pull/2664) publishes the validated
eight-file change against upstream `master`.
[Hosted CI](https://github.com/justintanner/doltlite/actions/runs/34043532585)
is running against the submitted commit, including the oracle registration.
Upstream review, a published native build, and validation of that exact build
remain before production adoption. Local native validation passes on macOS
arm64; the hosted platform and sanitizer results remain pending.
The application remains 0.1.0 and engine patch 5.3.2 is published.
No 2.0.0 release or major-version bump is part of this work.
