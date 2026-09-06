# Edit preview and commit distributions

VE-NFR-005, VE-NFR-006 and VE-NFR-009 require a 100-operation batch against a
1,000-clip sequence to preview in under 250 ms p95 without storage mutation,
commit in under 1 second p95 on a healthy local catalog, and preview
deterministically. `tests/edit-transactions.test.ts` still measures one
preview and one commit as a coarse regression tripwire; distributions come
from the dedicated harness:

```bash
npm run benchmark:edits -- --output /tmp/edit-distribution.json --assert
```

The harness seeds one video stream and inserts `--clips` one-frame clips
(default 1,000) through a single edit commit. It then runs `--commits`
independent transactions (default 50). Every transaction:

1. reads the primary sequence at the current head and builds a fresh
   `--operations`-operation batch (default 100 `set-clip-transform`
   operations on a rotating window of distinct clips, with transform values
   that differ per transaction so each commit changes every addressed clip);
2. records the head revision, every table row count and the canonical
   sequence projection, previews the batch (timed as `preview`), and requires
   all three snapshots to be unchanged afterwards;
3. previews the identical intent again (timed as `preview.repeat`) and
   requires identical canonical operations, affected ranges, write set,
   diff, before/after hashes and preview hash;
4. commits with the preview hash (timed as `commit`), requires the head to
   advance to the returned revision, and requires the committed sequence to
   carry every transform.

After the last commit the catalog is closed and reopened, and the reopened
sequence must expose the final revision and clip count. The report records
nearest-rank p50/p95/max and every raw sample for `preview`,
`preview.repeat`, `commit` and the seeding operations, the invariant counters,
process peak RSS, Node/CPU/memory, source commit and dirty state, and the
gates: `fullScale` (1,000 clips, 100 operations, 50 commits),
`previewP95Under250Ms`, `commitP95Under1Second`, `noStorageMutation`,
`deterministicPreviews` and `everyCommitAdvancedRevision`. `--assert` exits
nonzero when any gate fails. `tests/edit-benchmark.test.ts` runs a small
workload and checks the report structure and invariants on every test run.

Commit timings exclude derived jobs, which the engine does not start from
`edits.commit`. The workload uses transform operations only; other operation
kinds share the same projection, validation and persistence path but are not
separately measured here.

## Recorded run

The [recorded distribution](../benchmarks/results/edit-100x1000-distribution.json)
measured the working tree on top of engine `8b235f2` on September 6, 2026,
using an Apple M1 Pro with 16 GB RAM and Node 24.10.0 while no other benchmark
was running:

| Measurement | Samples | p50 | p95 | Max |
| --- | ---: | ---: | ---: | ---: |
| Preview (100 operations, 1,000 clips) | 50 | 106 ms | 110 ms | 113 ms |
| Repeated preview of the same intent | 50 | 106 ms | 110 ms | 112 ms |
| Commit | 50 | 300 ms | 334 ms | 335 ms |

Seeding the 1,000 clips took 142 ms to preview and 297 ms to commit. All 50
previews left the head revision, row counts and sequence projection unchanged,
all 50 repeats were identical, all 50 commits advanced the head and applied
5,000 transforms, and every gate passed. Process peak RSS was 2.8 GiB
including the embedded Dolt database.

## DoltLite 0.50.6 candidate

Engine `c4f1d89` (5.3.2) was measured from a clean committed tree on the same
M1 Pro, 16 GB RAM, Node 24.10.0. The
[complete report](../benchmarks/results/edit-100x1000-doltlite-0506.json)
records 50 independent 100-operation transactions over 1,000 clips:

| Measurement | Samples | p50 | p95 | Max |
| --- | ---: | ---: | ---: | ---: |
| Preview | 50 | 105 ms | 114 ms | 118 ms |
| Repeated preview | 50 | 105 ms | 111 ms | 115 ms |
| Commit | 50 | 299 ms | 331 ms | 348 ms |

All mutation, determinism, revision, and applied-transform gates pass. Peak
process RSS is 1.54 GiB.
