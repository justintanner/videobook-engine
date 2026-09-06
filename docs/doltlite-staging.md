# DoltLite staging and native merge verification

The engine pins DoltLite 0.50.6. It includes the fix for
[dolthub/doltlite#2644](https://github.com/dolthub/doltlite/issues/2644),
merged in [PR 2646](https://github.com/dolthub/doltlite/pull/2646) and
published in [0.50.6](https://github.com/dolthub/doltlite/releases/tag/v0.50.6).
The dependency adoption is tracked in `ve-ovz.23`; the remaining native-merge
failure stays in `ve-wsu`.

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
`tests/merge-policy.test.ts` verifies repeated full-catalog checkout preserves
all 56 engine tables, ignored runtime rows, indexed file lookups, and integrity.
The transcript and primary-sequence tests now perform both native merges
instead of inserting the second branch's expected rows directly. Native row
conflicts are mapped to `MERGE_CONFLICT` and preserve the accepted head.

The upstream change prevents new corrupt commits; it does not rewrite
previously corrupted history. Snapshot bootstrap remains available for a
healthy working catalog whose old committed schema cannot be cloned.

## Remaining: ignored runtime tables block native merge

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

The latter two commands deliberately exit nonzero when the defect reproduces.
All probes use temporary synthetic catalogs and remove them on exit. Replace
the package argument with an absolute installed-package directory to test a
future dependency version. The engine retains its working projection merge,
including singleton reconciliation and forget-wins object handling, while
this native merge gate remains unresolved.

A [native source patch with validation and reproduction steps](../patches/doltlite/README.md)
is now prepared on upstream commit `37a390eb7b021962d9d287a465a2da3c9f59c3cf`.
It passes 4,156 focused checks including allocation failures, all 126 native
suites, all 33 C suites, and the full 56-table engine catalog probe. Production
adoption still requires upstream review and validation of a published native
build; the dependency remains 0.50.6.

Compatibility smoke tests created separate synthetic catalogs with the previous
engine dependency (0.11.37) and the installed application dependency (0.11.51),
then opened them in separate 0.50.6 processes. Book identity, head, history
count, artifact/notebook projections, every table row count, source bytes, and
the runtime setting were preserved; historical restore, a new write, and
reopen passed. The engine fixture also retained the same semantic projections.
Dolt status diagnostics changed between versions and were compared separately
from stored state. These tests do not claim to repair old corrupt commits.
