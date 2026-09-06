# Preserve ignored local tables during native merges

A clean branch with a committed `dolt_ignore` rule and an untracked ignored
table currently refuses `dolt_merge` with an uncommitted-changes error. Adding
an index to that table also makes `dolt_status` incorrectly report it modified.

This change compares tracked state for merge eligibility and preserves ignored
table/index data in the live working catalog. The staged and committed result
excludes those objects. Installing the complete working catalog before schema
actions and index rebuilding also preserves ignored data across allocation
failures. Fast-forward, three-way, no-commit, squash, conflict rollback, and
explicit abort use the same separation. Tracked and staged changes still block,
and incoming object-name collisions refuse to overwrite local objects.

The status index pass now honors the parent table's ignore rule. A small
schema-loader error-path cleanup frees four decoded strings when appending a
schema entry fails, covering the leak found by the new allocation-failure test.

Validation on base `37a390eb7b021962d9d287a465a2da3c9f59c3cf`, macOS arm64:

- Focused testfixture regression: 4,156 checks, zero errors or memory leaks.
- All 126 native suites and all 33 C suites pass.
- New Dolt oracle: 10/10 pass; unpatched base fails all ten.
- Existing Dolt ignore and merge oracles: 50/50 and 104/104 pass using Dolt 2.3.1.
- Native lint and clean stock-SQLite parity pass.
- A full Videobook catalog passes merge, conflict rollback, reopen, and object
  contents checks across 56 tables, 23 ignored runtime tables, and 107 schema
  objects. Opening with published 0.50.6, merging with this patch in a separate
  process, then reopening with 0.50.6 also passes.

There is no public API or file-format version change.
