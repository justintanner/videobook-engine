# Deterministic close in the Node wrapper

The [source patch](deterministic-close.patch) makes `DatabaseSync.close()`
finalize every statement prepared on the connection before closing it, as
`node:sqlite` does. Upstream tracks the defect as
[dolthub/doltlite-node#11](https://github.com/dolthub/doltlite-node/issues/11).

In the official wrapper, `close()` is `sqlite3_close_v2`, `StatementSync` has no
`finalize()`, and only the garbage collector's destructor finalizes a statement.
A connection with a live statement therefore stays open after `close()` returns
and keeps `videobook.db` (twice) and `.videobook.db-lock` open until a collection
runs. Linux and macOS delete open files, so this goes unnoticed there. Windows
refuses: the Windows archive job deleted source books right after
`Engine.close()` and failed with
`EBUSY: resource busy or locked, unlink '...\source\data\.videobook.db-lock'`
and the same for `videobook.db`
([run 42368177558](https://github.com/justintanner/videobook-engine/actions/runs/42368177558),
job 128390585268; earlier job 128389759519). The engine cannot work around it:
no call in the official API finalizes a statement.

The same lifecycle has a worse edge. Running a statement after its connection
was closed crashes the process with `SIGSEGV`: under Node with the installed
official 0.51.1, `prepare`, `close`, then `run` never returns. The engine does
not do this, but nothing in the wrapper stops it.

## Provenance

- Source: [dolthub/doltlite-node](https://github.com/dolthub/doltlite-node).
- Base: [`a07a2f5f38d226a7d3a606ff6bb35ce125f9800c`](https://github.com/dolthub/doltlite-node/commit/a07a2f5f38d226a7d3a606ff6bb35ce125f9800c),
  version 0.51.10, the upstream `main` and npm `latest` on November 9, 2026.
  Its `close()` is unchanged since the installed 0.51.1.
- The patch's source, typings and README changes also apply to the installed
  0.51.1 package, with fuzz in `statement.h` only: wrapper revisions 0.51.1
  (`45964131fc803de726be884d4ada9c44fde2536c`) and 0.51.10 differ only in the
  lazy `iterate()` that shipped in 0.51.8.
- Patch SHA-256: `a008a9efb5ff4a78d75d7cbe692231c8499df8e64766f6a534efc2da1818e1fa`.
- Beads: `ve-u1y`.

It changes four wrapper source files and the `close()` documentation in
`index.d.ts` and `README.md`, and adds four wrapper tests with one helper. It
changes no public API shape, native DoltLite source, file format, or package
version.

## Behavior

- Each `DatabaseSync` tracks the statements it prepared. `close()` finalizes
  them and then calls `sqlite3_close_v2`, which now closes the connection at
  once. Using one of those statements afterwards throws the wrapper's existing
  `Statement is finalised` error, as does an iterator left open across the
  close.
- Each statement holds a reference to its `DatabaseSync`, so the database cannot
  be collected before its statements. Before the patch it could be, leaving the
  statement with a dangling pointer; `node:sqlite` also keeps the database alive.
- When the environment is torn down, finalizers run in no particular order. A
  database destroyed before its statements detaches them, so their destructors
  neither finalize twice nor touch the freed database.
- `open()` after `close()` starts with no tracked statements.

For the engine this restores the meaning of `close()`: the catalog's files are
released, and the clean-close marker written, before it returns.
`closeCatalogDatabase` stays correct and becomes redundant rather than wrong.

## Validation

November 9, 2026, Linux x64, Node 24.22.2, node-gyp 12.4.0. Each build compiles
the official amalgamation that the package's own `scripts/download.js` fetches.

Engine, against the installed 0.51.1 package with its prebuild replaced in an
isolated copy of the repository:

- An unpatched local build behaves like the official prebuild:
  `tests/catalog-close.test.ts` passes 16/16, and
  `node scripts/close-handle-probe.mjs` exits 1 with `data/.videobook.db-lock`
  and `data/videobook.db` (twice) still open after `Engine.close()`.
- With the patch, the probe exits 0. Nothing under the book stays open after
  `Engine.close()`, the directory empties at once, and nothing reappears after
  forced collections. `tests/catalog-close.test.ts` passes 15/16; the failure is
  its first test, which pins the native deferred close and is meant to fail once
  the binding finalizes at close.
- Full suite with the patch: 534 pass, 12 optional skips, 6 failures. Two are
  expected: the native pin above, and the 1,000-clip edit budget, which failed
  the same way with the official prebuild on the same loaded host (2,020 ms
  commit, then 815 ms preview). The other four came from the isolated copy: two
  benchmarks need `git rev-parse HEAD` and two migration tests need `ffprobe`.
  With both supplied, all 22 tests in those three files pass.

Upstream wrapper suite at the base revision (`bun test test/`, Bun 1.4.4,
compiled against the official v0.51.10 amalgamation):

- With the patch: 142 pass, 0 fail.
- Without it, the 138 existing tests pass and three of the four new tests fail:
  running a statement after `close()` crashes the process (`SIGSEGV` at address
  `0x18`), the files stay open after `close()`, and an old statement keeps
  running after `close()` and `open()`. The fourth, a statement outliving a
  collected `DatabaseSync`, is undefined behavior and passed by chance.

## Adoption

The patch is not applied at installation; the engine stays on official 0.51.1.
Adopting it needs an upstream release or an authorized package rebuild, which
bead `ve-u1y` records.

When a binding that finalizes at close is adopted, invert the first test in
`tests/catalog-close.test.ts`, keep `closeCatalogDatabase` until that test has
passed on every platform, and run `npm run test:archives` on Windows with the
source books deleted inside the test process.
