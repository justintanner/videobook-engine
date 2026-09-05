# DoltLite staging reproduction

Tracked in Beads `ve-wsu` and
[dolthub/doltlite#2644](https://github.com/dolthub/doltlite/issues/2644).

Staging twelve newly created tables individually can produce invalid
committed UNIQUE-index roots. Indexed reads work before checkout, then fail
after checking out a branch at the same commit. The reproduction uses only
DoltLite and Node, creates temporary files, and removes them on exit.

```sh
node scripts/dolt-staging-probe.cjs @dolthub/doltlite
node scripts/dolt-staging-probe.cjs @dolthub/doltlite --stage-all
```

The first command reproduces the defect and exits nonzero. The second uses
one staging operation and passes this reduced fixture. To compare another
installed DoltLite version, replace `@dolthub/doltlite` with its absolute
package directory.

Verified on macOS arm64 with Node 24.10.0 against the pinned 0.11.37 package
and the registry's 0.50.5 release. The latter reports
`sqlite_autoindex_items_4_2: invalid rootpage` after checkout.

The reduced fixture's successful bulk-staging control is not proof of a safe
engine workaround. An experiment applying it only to initial engine creation
still failed full-catalog integrity and native-merge checks. The engine keeps
its existing snapshot bootstrap and projection-based merge flow; an upstream
fix needs complete catalog, history, backup, checkout, and merge validation
before these workarounds can be removed.
