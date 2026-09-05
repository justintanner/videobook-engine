# MVP release evidence

Audit date: September 6, 2026 (Asia/Bangkok). Engine source: `da41904`;
consumer source: `09647d69`. Subsequent verification updates are noted below.
This is an assessment of the requirements in
`docs/mvp-prd.md`, not a release approval. E4, E5 and the MVP remain incomplete.
Beads contains the work assignments and current status; this report records
the evidence and its limits at these revisions.

## Performance and quality

The available machine reports Apple M1 Pro, 10 logical CPUs and 16 GiB RAM.
The PRD specifies M2 Pro, 16 GB RAM and local SSD. Existing measurements retain
their actual hardware qualification; none is an M2 Pro acceptance run.

| Requirement | Evidence inspected | Assessment and follow-up |
| --- | --- | --- |
| VE-NFR-001: 1,000-artifact open and semantic summary <2 s | `benchmarks/results/temporal-100k-fresh-process.json`: 1.14 s on M1 Pro, healthy compacted retained fixture | Supported on measured hardware; current-source reference-device run remains in `ve-ovz.9`. |
| VE-NFR-002: metadata and imported normalized transcript searchable <5 s after semantic commit | Engine lexical query regressions and consumer `tests/v2/semantic-index-job.test.ts` exercise indexed text | No timed end-to-end semantic-commit-to-query evidence for both inputs. `ve-ovz.9`. |
| VE-NFR-003: searchable coverage at least every 60 source seconds, resume last committed batch | Full persisted synthetic benchmark: 4,000 batches, at most 30 source seconds per batch, every persisted cursor checked, first coverage about 40 ms. Consumer `commitDeepBatches` persists cursors. | Synthetic API cadence is proved; actual model/job pipeline cadence and interrupted resume need direct verification. `ve-ovz.9`. |
| VE-NFR-004: 100k moments, warm p50 <500 ms, p95 <1.5 s including hybrid | Safe-cache run: 50 reads per mode, p95 image 72 ms/video 151 ms/hybrid 371 ms; public query call includes ranking | Passes recorded synthetic workload on M1 Pro. Reference hardware/current-source qualification remains in `ve-ovz.9`. |
| VE-NFR-005: 100-operation preview on 1,000 clips, p95 <250 ms, no mutation | `tests/edit-transactions.test.ts` seeds the correct scale but measures one preview and allows 500 ms; other edit tests check deterministic preview | Existing timing assertion is weaker than the requirement. Repeated strict distribution and storage invariants required by `ve-ovz.9`. |
| VE-NFR-006: same commit batch, p95 <1 s | Same test measures one commit under 1 s | One sample cannot establish p95. `ve-ovz.9`. |
| VE-NFR-007: 100k query/index structures <4 GB RSS beyond loaded model | Full persisted run peak 3.58 GiB including fixture construction; safe-cache query/rebuild process 2.27 GiB; no model loaded | Supported for measured synthetic workload. Reference/current-source run remains in `ve-ovz.9`. |
| VE-NFR-008: forced termination at every SQL/outbox/Dolt boundary | Baseline edit tests only threw exceptions and closed normally. Subsequent `tests/semantic-crash.test.ts` covers real SIGKILL at each semantic/outbox/table-staging/Dolt boundary for a multi-table edit and provenance operation, including interrupted recovery and an intervening write. | Kill matrix exposed and corrected duplicate provenance replay. See `docs/semantic-durability.md` for scope and invariants; tracked in `ve-ovz.10`. |
| VE-NFR-009: stable search ordering, identical canonical previews/hashes | Temporal benchmark repeats queries against unchanged generations; temporal/edit regressions assert stable ordering and equivalent previews | Functional evidence present; include exact repeated large edit workload in `ve-ovz.9`. |
| VE-NFR-010: every application frozen-corpus quality threshold | E4 evaluator and small real-model fixtures exist | Full rights-cleared frozen corpus and judged ranges absent. `ve-s84` remains incomplete; synthetic scale data cannot replace it. |
| VE-NFR-011: cached search/index/edit/history initiates no network | Model policy HTTP counters and real cached CLIP/CLAP inference pass | Does not cover every complete operation, remote-backed missing media or injected providers. `ve-ovz.12` and `ve-ovz.14`. |
| VE-NFR-012: bounded scale degradation, no corruption/unbounded React payloads/full-vector scan each query | Native ANN candidate retrieval, bounded video starts/windows, stable pagination, cache deletion/replacement regressions; 100k benchmark | Search architecture and measured workload supported. End-to-end larger-book/payload evidence remains part of `ve-ovz.9`; malformed-input and recovery cases are separate. |

Detailed benchmark provenance and raw samples are linked from
`docs/temporal-search-performance.md`. Reused fixtures inherit original
indexing metrics; they do not measure a fresh index build. First-query times
include snapshot loading and are not warm-query latency or cold OS-cache tests.

## Security and privacy

| Section 13 requirement | Evidence inspected | Assessment and follow-up |
| --- | --- | --- |
| Opt-in/configurable, pinned, checksum-verified and disableable model downloads | Engine defaults local-only; consumer requires exact `VIDEOBOOK_MODEL_DOWNLOAD=enabled` or preparation CLI `--download`; real HTTP tests verify default zero requests and pinned revisions | Opt-in/pinning/offline discovery completed in `ve-ovz.7` and `vb-3tss`. Transformers hub loader uses size metadata but has no inspected model digest verification; `ve-ovz.11` must verify supported upstream digests. Native index SHA-256 is unrelated. |
| Scoped provider inputs, local built-in provider, injected network declaration and application consent | `TemporalSearchProvider` has `manifestId`, `prepare`, `embedText`; registration checks only manifest ID. CLIP/CLAP receive text or selected media paths/ranges. | Network capability/consent contract missing. `ve-ovz.12`; complete input-scoping verification in `ve-ovz.14`. |
| Argument arrays, bounded outputs, timeouts, cancellation and scoped workspaces; no untrusted shell | Shared media-process limits and isolated model pool provide deadlines, process-group cancellation and owned scratch cleanup. Consumer actual queue tests cancel stalled model requests and preserve source bytes/status. | Engine isolation and consumer signal forwarding are implemented and tested. See `docs/media-limits.md` and `docs/model-isolation.md`. |
| Malformed codec, oversized image, decompression bomb and model OOM fail job without book corruption | Tests reject malformed/oversized/high-expansion inputs; an actual heap-exhausted worker leaves a live engine writable and reopenable and permits fresh-worker retry. Consumer cached-model queue tests verify malformed-image failure and corrected retry. | Process isolation, typed job failures and consumer integration are verified. The worker heap cap is not an OS-wide memory limit. |
| Excerpts/explanations treated as user content | `MomentSearch.tsx` interpolates excerpt text and explanation title through React | Local inspection supports escaping on this surface; cross-surface hostile-content tests remain in `ve-ovz.14`. |
| Logs contain IDs/hashes/sizes/phases/codes rather than secrets/full content | Consumer logger accepts arbitrary arguments; `tools/log-wrapper.ts` includes first 300 characters of tool error text | Truncation is not redaction. Review and regression coverage required in `ve-ovz.14`. |
| Content hashes are identity, not authorization | Book-scoped engines exist; CAS can retrieve by hash through configured remote storage | Cross-book/API authorization cannot be inferred from hash identity. Complete access-path audit/tests in `ve-ovz.14`. |
| Remote publication/backup explicit, never triggered by local search | Inspected semantic indexing uses scoped engine reads, not publish/backup calls | Direct inspection is narrower than a complete operation-level invariant. Counter-based verification and missing-local-object behavior in `ve-ovz.14`. |

## Migration, consumer and packaging

Section 15.4 migration is covered by `tests/migration.test.ts`, the pinned v4
schema fixture and consumer migration tests. Evidence includes valid notebook
graphs/generation choices, properties/prompts/messages, real timed media,
empty and large catalogs, content-hash validation, unchanged source bytes,
identical reruns, cancellation/process interruption and source edits before
publication. Consumer queue tests cover durable status/cancel, archive/switch
recovery and idempotent reindex scheduling. `ve-ovz.5`, `ve-ovz.6` and `vb-6eu9`
are complete. This migration evidence does not prove general edit durability.

Engine `da41904` passed 281 tests (8 opt-in tests skipped), typecheck, knip,
build and clean package smoke with real cached CLIP/CLAP inference. Explicit
real-model transfer/offline and compatibility-media tests also passed. Engine
CI passed on Node 22 and 24. Consumer `09647d69` passed 3,149 tests across 366
files, lint, test types, dead-code checks and both builds. Its two cached-model
queue tests, skipped by default, passed in the explicit 27-test focused run.
Isolated installs from both the worktree and exact committed source exercised
native Sharp, MCP create/list, the client proxy and graceful shutdown without
a sibling engine checkout.

Consumer vendors `videobook-engine-5.3.1-da41904.tgz`, SHA-256
`d5a3e53a0fdc8f768a141fc907c52c4c5e7a9c8057129e3deee46956771b108f`.
Consumer commits are local per its repository policy. Local package smoke and
vendored-consumer verification do not prove installation of a published
registry package: `ve-yc7` and `ve-orp` retain that release gate. Registry
authentication is an unresolved external prerequisite, not retested here.

The full quality corpus, reference-device evidence, newly identified NFR and
security gaps, and published-package verification prevent closing E4/E5/MVP.
