# Ignored AUTOINCREMENT sequence state across a hard reset

The [source patch](hard-reset-ignored-sequence.patch) fixes a native DoltLite
hard reset that dropped `sqlite_sequence` while preserving the untracked
`AUTOINCREMENT` tables whose high-water marks it holds.

This is a separate, pre-existing native bug from the
[ignored-runtime merge fix](README.md); it was found while validating that
one. Production engine source never calls `dolt_reset`, so no engine path is
affected today, but the corruption is real for any caller that does.

## Provenance

- Source: [dolthub/doltlite](https://github.com/dolthub/doltlite).
- Base: [`b3981dc9ed6b2e39c247b4d598b2691e19dd0b25`](https://github.com/justintanner/doltlite/commit/b3981dc9ed6b2e39c247b4d598b2691e19dd0b25),
  the native revision shipped in `@dolthub/doltlite 0.50.6-videobook.1`. The
  same defect is present in unpatched upstream 0.50.6.
- Patch SHA-256: `36f71feab3812882a59284368daaa980d7c7c824f68cadf75ee204d4bd3b0e14`.
- Validated September 7, 2026 on macOS arm64, Node 24.10.0, with Dolt 2.3.1 as
  the semantic reference.
- Beads: `ve-nia`.

It changes one native source file and adds five shell regression tests. It
changes no public API, file format, or package version.

## Behavior

`dolt_reset('--hard')` restores tracked tables from the target catalog and
carries untracked tables through unchanged. The scan that collects those
untracked tables excluded every `sqlite_%` name, so `sqlite_sequence` was
never carried — even when the tables it describes were.

The result on the reported shape (a committed `dolt_ignore` rule for
`runtime_%` and `sqlite_sequence`, an ignored
`runtime_jobs(id INTEGER PRIMARY KEY AUTOINCREMENT, …)` holding IDs 1 and 2
with 2 deleted):

| | Before | After |
| --- | --- | --- |
| `runtime_jobs` rows | preserved (id 1) | preserved (id 1) |
| `runtime_jobs` index | preserved | preserved |
| `sqlite_sequence` | dropped from the schema entirely | preserved, `runtime_jobs=2` |
| Next allocated ID | insert fails: `database disk image is malformed` | `3`, above the deleted ID |

The fix admits `sqlite_sequence` as a candidate and lets the existing
staged-catalog test decide, so an *ignored* `sqlite_sequence` is preserved
while a *tracked* one is still restored from the target catalog with the rest
of the tracked state. Nothing else about `sqlite_%` handling changes, and a
reset never invents a `sqlite_sequence` that did not exist.

## Validation

Built from source at the patched revision (`make sqlite3.c`, `make doltlite`,
plus the Node addon compiled against the regenerated amalgamation):

- `test/doltlite_reset.sh`: 92 pass, 0 fail, including five new cases. Against
  the unpatched build, exactly the two cases asserting the fixed behavior fail
  (`no such table: sqlite_sequence`, and allocation stuck at 1 because the
  insert fails); the three guard cases — preserved rows and index, tracked
  sequence rewind, no invented table — pass in both, so they pin the
  unchanged semantics rather than the fix.
- `test/doltlite_ignore.sh` 25/25, `test/doltlite_merge.sh` 230/230,
  `test/doltlite_merge_ignore_corners.sh` 3/3,
  `test/doltlite_merge_status.sh` 31/31,
  `test/doltlite_failed_merge_working_set.sh` 10/10.
- Dolt oracles against Dolt 2.3.1: `vc_oracle_reset_test.sh` 66/66,
  `vc_oracle_ignore_test.sh` 50/50, `vc_oracle_ignored_merge_test.sh` 10/10.
- Engine probe `scripts/native-full-catalog-merge-probe.mjs` against the
  patched addon: passed, covering fast-forward, three-way, all runtime rows,
  schema and indexes, integrity, foreign keys, reopen, runtime absent from
  HEAD, conflict rollback, `sqlite_sequence` preservation, deleted job ID not
  reused, published-binding reopen and allocation, CAS file contents, and a
  queued job.

## Adoption

Shipping this fix means rebuilding and republishing the fork package, which is
a release action and needs explicit authorization. Nothing in the engine
depends on it: `src/` never calls `dolt_reset`, and the supported
merge/rollback/reopen paths carry their own deleted-ID checks, which pass on
the published binary today.

The fix belongs upstream in `dolthub/doltlite`; it is recorded here so the
engine keeps the provenance either way.
