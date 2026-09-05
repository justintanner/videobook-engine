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

The latency requirement is not met. The current query path loads all
segments and embeddings; ordered video also evaluates every possible window.
The next implementation must use indexed candidate retrieval with bounded
window reranking while preserving filters, generation invalidation, and
stable pagination. Faster timings alone cannot satisfy VE-NFR-012 if every
query still scans the full vector collection.
