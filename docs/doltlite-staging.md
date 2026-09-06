# DoltLite staging and native merge verification

The engine pins the temporary DoltLite `0.50.6-videobook.1` fork package from
[justintanner/doltlite](https://github.com/justintanner/doltlite/tree/videobook-node-package/packaging/videobook-node).
Its native source is `b3981dc9ed6b2e39c247b4d598b2691e19dd0b25`; its Node
wrapper is the published 0.50.6 wrapper at `4bed4889be31c683f81291e2f661d07e50b7a3fe`.
The dependency uses the [versioned release tarball](https://github.com/justintanner/doltlite/releases/tag/videobook-node-v0.50.6-videobook.1) and lockfile integrity.
Tarball SHA256: `4968a0be9b32aad3d2052b556a5b89c465f9a7959f053e0f12148a2f9d0faf3c`.
All 12 [package CI jobs](https://github.com/justintanner/doltlite/actions/runs/34049056350) passed, including clean installs on all five platforms and a source rebuild.
It includes the fix for
[dolthub/doltlite#2644](https://github.com/dolthub/doltlite/issues/2644),
merged in [PR 2646](https://github.com/dolthub/doltlite/pull/2646) and
published in [0.50.6](https://github.com/dolthub/doltlite/releases/tag/v0.50.6).
The original adoption is tracked in `ve-ovz.23`; fork packaging and installed
native-merge verification are tracked in `ve-wsu.6`.

## Fixed: incremental staging corrupts index roots

Staging twelve newly created tables individually produced invalid committed
UNIQUE-index roots on 0.11.37 and 0.50.5. Indexed reads worked before checkout,
then failed after checking out a branch at the same commit. Both controls now
pass on 0.50.6:

```sh
node scripts/dolt-staging-probe.cjs @dolthub/doltlite
node scripts/dolt-staging-probe.cjs @dolthub/doltlite --stage-all
```

Full engine URL bootstrap, backed-up catalog cloning, lazy object reads,
post-clone writes and reopen are verified in `tests/fork-flow.test.ts`.
`tests/merge-policy.test.ts` verifies full-catalog checkout and native merges preserve
all 56 engine tables, ignored runtime rows, indexed file lookups, and integrity.
The transcript and primary-sequence tests now perform both native merges
instead of inserting the second branch's expected rows directly. Native row
conflicts are mapped to `MERGE_CONFLICT` and preserve the accepted head.

The upstream change prevents new corrupt commits; it does not rewrite
previously corrupted history. Snapshot bootstrap remains available for a
healthy working catalog whose old committed schema cannot be cloned.

## Fixed in the fork: ignored runtime tables block native merge

A separate failure reproduces on 0.50.6 with one versioned table and one
ignored runtime table. Native merge refuses with an uncommitted-changes error
even after checkout and hard reset. Without an index, `dolt_status` is empty;
with a secondary runtime index it also incorrectly reports the ignored table
as modified. The control without the runtime table passes:

```sh
node scripts/dolt-ignored-merge-probe.cjs @dolthub/doltlite --without-runtime
node scripts/dolt-ignored-merge-probe.cjs @dolthub/doltlite --without-index
node scripts/dolt-ignored-merge-probe.cjs @dolthub/doltlite
```

The latter two commands exit nonzero on unpatched 0.50.6. All three pass with
the pinned fork. All probes use temporary synthetic catalogs and remove them
on exit. Replace the package argument with an absolute installed-package
directory to test another build. The engine's merge-back flow keeps its
application policies, including singleton reconciliation and forget-wins
object handling.

A [native source patch with validation and reproduction steps](../patches/doltlite/README.md)
was prepared on upstream commit `37a390eb7b021962d9d287a465a2da3c9f59c3cf`.
It passes 4,156 focused checks including allocation failures, all 126 native
suites, all 33 C suites, and the full 56-table engine catalog probe. It was
merged upstream in [PR 2664](https://github.com/dolthub/doltlite/pull/2664).
The temporary package provides prebuilt addons for Linux x64/arm64, macOS
x64/arm64, and Windows x64, plus matching source for the existing build fallback.
Its `fork-provenance.json` records source commits and binary checksums.
For npm versions that enforce `allowScripts`, the policy key is the exact
release asset URL; a registry-style name/version key does not match this
remote tarball dependency.

`npm run test:package` installs the engine in an empty project and checks the
actual installed fork with `scripts/native-full-catalog-merge-probe.mjs`.
That probe preserves 23 runtime tables, 107 schema objects, and deleted job ID
high-water marks through fast-forward, three-way, conflict rollback, and reopen.
Replace the fork with an upstream release once that installed artifact passes
the same checks; remove the fork-version assertion in the package smoke at that
time. No schema or file-format change is required for this adoption.

Compatibility smoke tests created separate synthetic catalogs with the previous
engine dependency (0.11.37) and the installed application dependency (0.11.51),
then opened them in separate 0.50.6 processes. Book identity, head, history
count, artifact/notebook projections, every table row count, source bytes, and
the runtime setting were preserved; historical restore, a new write, and
reopen passed. The engine fixture also retained the same semantic projections.
Dolt status diagnostics changed between versions and were compared separately
from stored state. These tests do not claim to repair old corrupt commits.
