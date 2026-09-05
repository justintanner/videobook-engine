# Temporal search scale measurements

Run the performance fixture through the public engine API:

```bash
npm run benchmark:temporal -- --output /tmp/temporal-search.json --assert
```

The default workload creates 1,000 synthetic video artifacts and 100,000
one-second moments with deterministic normalized 512-dimensional vectors.
Each artifact has indexed description text as well as visual embeddings.
The fixture uses synthetic bytes and declared stream metadata; it does not
run media probing or model inference and cannot measure indexing-model
throughput, recall, relevance, multilingual quality, or boundary accuracy.
Those release gates require the separate frozen, rights-cleared corpus.

Indexing uses batches of at most 30 moments by default. After every batch,
the harness reads the public index plan and verifies cumulative coverage
and its persisted next cursor. It activates the first partial batch and
checks that a reference query retrieves the source before indexing finishes.
After indexing, the engine closes and reopens the catalog and checks the
stored moment and indexed-artifact counts.
Each committed batch also calls `temporalSearch.prepare` with periodic
checkpointing, so native graph construction is included in indexing time.

The report records the first query for each mode, then repeats that query
outside the timing samples to check deterministic results. It measures
50 further queries per mode, varying the source across the book, and checks
that image and ordered-video queries retrieve their own source. Hybrid
queries combine indexed text matching, injected text vectors, ranking,
overlap collapse, and coverage reporting. No remote providers or embedding
models are loaded. Query timings include the complete public search call.
A first query is not a cold OS page-cache measurement, and the modes run
in image, video, hybrid order.

`peakRssBytes` is the process high-water RSS reported by Node, converted from
KiB, including the engine, index creation, and queries in a fresh fixture
run. Reusing a fixture measures query-process RSS without the original
seeding process. The report keeps these runs distinct and records actual
CPU, memory, Node version, source commit, dirty state, dimensions, raw timing
samples, coverage cadence, and whether the full-size repeated workload ran.
The PRD reference device is an M2 Pro with 16 GB RAM; measurements on another
device must retain that qualification.

For a short harness check:

```bash
npm run benchmark:temporal -- --moments 100 --artifacts 5 --reads 3
```

To compare retrieval implementations without recreating the fixture, use
`--retain-fixture` on the first run and `--fixture <printed-path>` on later
runs. Only fixtures with this harness's marker and manifest are accepted.
Reused fixture seeding metrics describe the original build, not the later
measurement. A short run intentionally fails the `fullScale` assertion.

## Initial 100,000-moment baseline

The [recorded baseline](../benchmarks/results/temporal-100k-baseline.json)
measured engine commit `c151c6e` on September 5, 2026, using an Apple M1 Pro
with 16 GB RAM and Node 24.10.0. Five warm queries per mode were sufficient
to establish a large performance failure; this is diagnostic evidence, not
the required 50-query acceptance run.

| Mode | Warm p50 | Warm p95 |
| --- | ---: | ---: |
| Prepared image | 2,475 ms | 2,515 ms |
| Prepared eight-second video | 14,344 ms | 14,425 ms |
| Hybrid text and visual | 2,800 ms | 2,851 ms |

Indexing took 138.8 seconds in 4,000 batches, each covering at most 30 seconds
of source time. First searchable coverage appeared after 49 ms. All 4,000
persisted resume cursors were verified. Open plus book/search summary took
963 ms, and the process peak RSS was 2.83 GiB.

This baseline did not meet the latency requirement. Its query path loaded all
segments and embeddings and evaluated every possible video window. Faster
timings alone cannot satisfy VE-NFR-012 if every query still scans the full
vector collection.


## Indexed candidate retrieval

The engine now caches segment metadata and vectors for the active generations
and uses a USearch HNSW index with F16 storage to select visual/audio/text
vector candidates. It recomputes shortlisted cosine scores from the original
F32 vectors before reciprocal-rank fusion. Each modality contributes up to
1,000 vector candidates, independently of the requested page size or cursor.
Pagination traverses the combined ranked candidate set, including lexical and
exact/near-fingerprint evidence. Restrictive filters are applied to candidate
eligibility; small eligible subsets are scored directly, and broader filters
expand the ANN shortlist until enough eligible candidates are found.

Ordered video searches use timed neighbors from every reference sample,
propose nearby start positions, then score bounded windows with timestamp
alignment and temporal coherence. At most 512 neighbor seeds produce at most
1,536 start positions. Each window uses at most 16 target samples; cached
query interpolation and prefix sums of continuity keep long-window scoring
bounded without treating skipped samples as gaps. Duration filters apply to
the resulting window. Still-image neighbors cannot displace timed candidates.

Committed indexing batches refresh only affected cache entries. Semantic
changes refresh metadata and remove deleted sources while preserving native
vectors, so a rename does not rebuild the graph. Generation changes and engine
close discard the relevant in-memory state. Regression tests cover native ANN
pagination across page sizes, vector/text replacement, source and label
filters, rename/deletion, ordered action, differing sampling densities, bounded
durations, and a long video reference surrounded by matching still images.

The [full indexed run](../benchmarks/results/temporal-100k-indexed.json) measures
the source committed as `db996f2` on the same M1 Pro/16 GB machine, with a newly
created 1,000-artifact/100,000-moment fixture and 50 warm queries per mode:

| Mode | Warm p50 | Warm p95 |
| --- | ---: | ---: |
| Prepared image | 54 ms | 63 ms |
| Prepared eight-second video | 105 ms | 140 ms |
| Hybrid text and visual | 284 ms | 331 ms |

This run passed all harness gates. Process peak RSS, including fixture
creation and index/query structures, was 3.26 GiB. It committed 4,000 batches
covering at most 30 source seconds each, verified every resume cursor, and
published the first searchable partial coverage after 45 ms. Open plus
book/search summary after closing the newly built fixture took 1.35 seconds.

Two limitations remained in that run. First, creating the native graph on the
first query took 139 seconds; warm-query success does not make that suitable
for an interactive request. `ve-s84.4` tracks preparing and persisting the
index through indexing work and validating fast query readiness after reopen.
Publication depends on that issue. Second, independent fresh-process opens
have spent over four seconds in automatic catalog GC; `ve-ovz.2` tracks that
cost, which the same-process reopen measurement does not consistently expose.
These measurements also do not replace the frozen corpus quality gate.

## Persisted preparation

Activate a generation after committing its first partial batch, then prepare
its search index inside a cancellable indexing job:

```ts
const activated = engine.temporalSearch.activate(manifestId, generation);
if (!activated.ok) throw new Error(activated.error.message);
const prepared = await engine.temporalSearch.prepare({
  manifestId,
  generation,
  signal,
  checkpoint: "periodic",
});
if (!prepared.ok) throw new Error(prepared.error.message);
```

Preparation yields between bounded native insertions. Already prepared
indexes update incrementally as committed batches are consumed. Periodic
checkpoints write after 5,000 changes; the default preparation mode and engine
close flush outstanding changes. Omitting the manifest and generation
prepares every active index, which supports background recovery of old books.
Collections of at most 1,000 vectors use direct scoring without a native graph.

Disposable snapshots live under `data/runtime-search`. Their identity includes
the full manifest, generation, modality, dimensions, native version, and index
configuration. A SHA-256 checksum protects the native bytes before loading;
stable vector keys and content digests validate the mapping against committed
vectors. Metadata is published by rename after a complete graph is saved.
A stale checkpoint can be reconciled from changed vectors; a corrupt or
incompatible checkpoint is rebuilt. Cancellation never publishes a partial
graph. The source vectors remain in the catalog.

An interactive query loads an exact valid snapshot, but never constructs a
missing large graph. It returns `NOT_READY` with
`error.details.requiresIndexPreparation === true` when preparation is needed.
Consumers should queue preparation, show its progress, and retry after the job
finishes. The index's preparation result separates loaded indexes, changed
vectors, and persisted indexes. `--prepare-existing` in the benchmark measures
explicit recovery before closing and reopening a retained older fixture.
