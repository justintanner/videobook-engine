# MVP release evidence

Audit date: September 6, 2026 (Asia/Bangkok). Functional baseline: engine
`8b235f2` plus the NFR measurement working tree, consumer `fc751e79`
(batch cadence, readiness, range scoping and hostile-content regressions).
Performance artifacts retain their original revision and hardware
qualifications.
This is an assessment of the requirements in
`docs/mvp-prd.md`, not a release approval. E4, E5 and the MVP remain incomplete.
Beads contains the work assignments and current status; this report records
the evidence and its limits at these revisions.

## Performance and quality

The available machine reports Apple M1 Pro, 10 logical CPUs and 16 GiB RAM.
The PRD specifies M2 Pro, 16 GB RAM and local SSD. Existing measurements retain
their actual hardware qualification; none is an M2 Pro acceptance run. The
reference-device measurements are tracked in `ve-ovz.22`.

| Requirement | Evidence inspected | Assessment and follow-up |
| --- | --- | --- |
| VE-NFR-001: 1,000-artifact open and semantic summary <2 s | Current-source runs on engine `8b235f2`: 206 ms same-process after a fresh 1,000-artifact/100,000-moment build (`temporal-100k-current-source.json`) and 960 ms in a fresh process reopening the retained fixture (`temporal-100k-current-source-reopen.json`); earlier `temporal-100k-fresh-process.json`: 1.14 s. All on M1 Pro. | Passes on measured hardware for the current source. The M2 Pro reference-device run remains outstanding and is tracked explicitly; M1 Pro results are not equated with it. |
| VE-NFR-002: metadata and imported normalized transcript searchable <5 s after semantic commit | Consumer `tests/v2/text-readiness.test.ts` times the real job queue on a real probed video: analysis metadata write to first lexical hit 688 ms (OCR text 689 ms), transcript import to first quoted speech hit 314 ms, both under the 5 s gate with model downloads disabled and no cached model. | Passes end to end through the application's actual enqueue, poll, index and lexical query path on M1 Pro. |
| VE-NFR-003: searchable coverage at least every 60 source seconds, resume last committed batch | Synthetic benchmark: 4,000 batches of at most 30 source seconds, every cursor checked, first coverage 45 ms. The consumer's fixed four-unit deep batches could exceed 60 s on videos longer than about seven minutes because frame sampling caps at 30 frames; `commitDeepBatches` now bounds each CLIP/CLAP batch by covered source seconds. Consumer `tests/v2/semantic-index-cadence.test.ts` verifies the bound and durable-cursor resume through the engine, and the explicit real-model case runs the actual CLIP pipeline on a real ten-minute video: 15 two-frame batches of at most 41.4 s, interruption after two batches, resume from cursor 4 without re-embedding committed frames, and retrieval of the source. | Passes for the actual model pipeline. A single sampled frame whose own span exceeds 60 s (videos over about 29 minutes) is committed alone; frame density itself is a quality question for the frozen corpus, not a cadence failure. |
| VE-NFR-004: 100k moments, warm p50 <500 ms, p95 <1.5 s including hybrid | Current-source fresh build on `8b235f2`: 50 warm reads per mode, p50/p95 image 62/67 ms, video 117/159 ms, hybrid 333/391 ms; fresh-process reopen: image 58/62 ms, video 115/148 ms, hybrid 322/359 ms. | Passes the full synthetic workload on the current source, M1 Pro. Reference-device run outstanding and tracked explicitly. |
| VE-NFR-005: 100-operation preview on 1,000 clips, p95 <250 ms, no mutation | `npm run benchmark:edits` (`docs/edit-performance.md`): 50 independent previews of fresh 100-operation batches against 1,000 clips, p50 106 ms, p95 110 ms, max 113 ms; head revision, every table row count and the canonical sequence projection unchanged after each preview. Recorded in `benchmarks/results/edit-100x1000-distribution.json`. | Passes with strict gates on M1 Pro. `tests/edit-transactions.test.ts` keeps its single-sample 500 ms tripwire for shared CI runners. |
| VE-NFR-006: same commit batch, p95 <1 s | Same run: 50 independent commits, p50 300 ms, p95 334 ms, max 335 ms; every commit advanced the head and applied all 100 transforms; reopened catalog exposes the last revision. | Passes on M1 Pro; no derived jobs run inside `edits.commit`. |
| VE-NFR-007: 100k query/index structures <4 GB RSS beyond loaded model | Current-source fresh build and query process peak 2.43 GiB including fixture construction; fresh-process reopen and 150 queries 2.32 GiB; no model loaded. | Passes on the current source, M1 Pro. Reference-device run outstanding. |
| VE-NFR-008: forced termination at every SQL/outbox/Dolt boundary | Baseline edit tests only threw exceptions and closed normally. Subsequent `tests/semantic-crash.test.ts` covers real SIGKILL at each semantic/outbox/table-staging/Dolt boundary for a multi-table edit and provenance operation, including interrupted recovery and an intervening write. | Kill matrix exposed and corrected duplicate provenance replay. See `docs/semantic-durability.md` for scope and invariants; tracked in `ve-ovz.10`. |
| VE-NFR-009: stable search ordering, identical canonical previews/hashes | Current-source temporal runs repeat every first query per mode against the unchanged generation and require identical hits; the edit distribution run previews each of 50 large batches twice and requires identical canonical operations, ranges, write sets, diffs and all hashes. | Passes for the exact 100-operation/1,000-clip workload and the 100k search workload. |
| VE-NFR-010: every application frozen-corpus quality threshold | E4 evaluator and small real-model fixtures exist | Full rights-cleared frozen corpus and judged ranges absent. `ve-s84` remains incomplete; synthetic scale data cannot replace it. |
| VE-NFR-011: with required models cached, search/index/edit/history initiates no network | Per-Engine local-media scopes; nine engine regressions and ten installed-app workflow cases. A real cached CLIP queue index/reference/library/temporal-search/edit/history workflow makes zero model or B2 HTTP requests. Missing-media cases also stay offline, including migration frame preparation. | Media hydration policy and these complete built-in workflows are verified in `ve-ovz.19`. Arbitrary callback networking and explicitly consented remote providers are separate boundaries; input scoping and the remaining owned-service privacy checks are complete in `ve-ovz.14`. |
| VE-NFR-012: bounded scale degradation, no corruption/unbounded React payloads/full-vector scan each query | Native ANN candidate retrieval, bounded video starts/windows, stable pagination, cache deletion/replacement regressions; current-source 100k runs index in 4,000 bounded batches (333 s including preparation) and page at most 100 hits per query; consumer deep batches are bounded by source seconds. | Search architecture and the measured 100k workload pass on the current source. Larger-than-100k books degrade through longer indexing only by design; no measurement beyond 100k moments exists. |

Detailed benchmark provenance and raw samples are linked from
`docs/temporal-search-performance.md`. Reused fixtures inherit original
indexing metrics; they do not measure a fresh index build. First-query times
include snapshot loading and are not warm-query latency or cold OS-cache tests.

## Security and privacy

| Section 13 requirement | Evidence inspected | Assessment and follow-up |
| --- | --- | --- |
| Opt-in/configurable, pinned, checksum-verified and disableable model downloads | Engine defaults local-only; built-in pinned model inventories carry upstream Git/LFS digests. The verified file resolver checks downloads and cached files before returning bytes or ONNX paths, including external weights. Real transfers, corrupt caches and installed-package rejection are tested. | Checksum hardening and custom commit pinning are integrated in consumer `80ce4f58`. Remote file requests must match the worker repository/revision, and embedding identities isolate revisions. See `docs/model-integrity.md` and `docs/model-revisions.md`. |
| Scoped provider inputs, local built-in provider, injected network declaration and application consent | Explicit download/inference declarations and separate application grants guard temporal and compatibility dispatch. Actual HTTP tests cover rejected and authorized providers, revocation, changed declarations, and per-Engine scope. CLIP/CLAP declare local inference. | Engine and consumer consent integration are verified. Identical registrations preserve overlapping searches; replacement/removal revokes later calls. Consumer `tests/v2/search-reference-range-scope.test.ts` proves the application's `search_moments` forwards only the prepared reference and the requested `reference_range` window: each window retrieves only its own moment, negative, zero-length and frame-less windows and image references with ranges fail before any search, and unknown reference ids are rejected. |
| Argument arrays, bounded outputs, timeouts, cancellation and scoped workspaces; no untrusted shell | Shared media-process limits and isolated model pool provide deadlines, process-group cancellation and owned scratch cleanup. Consumer actual queue tests cancel stalled model requests and preserve source bytes/status. | Engine isolation and consumer signal forwarding are implemented and tested. See `docs/media-limits.md` and `docs/model-isolation.md`. |
| Malformed codec, oversized image, decompression bomb and model OOM fail job without book corruption | Tests reject malformed/oversized/high-expansion inputs; an actual heap-exhausted worker leaves a live engine writable and reopenable and permits fresh-worker retry. Consumer cached-model queue tests verify malformed-image failure and corrected retry. | Process isolation, typed job failures and consumer integration are verified. The worker heap cap is not an OS-wide memory limit. |
| Excerpts/explanations treated as user content | Consumer `tests/v2/search-hostile-content.e2e.test.ts` seeds a real book whose name, artifact label and indexed description carry script, event-handler and javascript: payloads, serves it through the actual MCP server and Vite app in Chromium, and verifies the library search card header, excerpt, thumbnail alt text, signal chip title, notice text and media library dialog render the literal strings; injected hostile explanation and error responses render literally too. No window marker is set, no active element exists, and no page error occurs. | Complete for every owned search result surface (`vb-3esp`). Media response sandboxing remains separately verified. |
| Logs contain IDs/hashes/sizes/phases/codes rather than secrets/full content | Consumer `7cd32e85` routes owned runtime console and persistent diagnostics through fixed events and validated UUIDs, queue IDs, counts, enums and error codes. Tool/job names require trusted registration. Tests cover private returned/thrown errors, real queue/provider failures, book reopening, explicit chat history and a real subprocess with multi-megabyte private output. | `vb-wtu9` is complete: 3,160 default tests, 19 model/queue tests including all 3 real cached-model cases, media rollback E2E, lint/types/knip/builds and isolated clean install pass. Full caller/job error details and explicit chat content remain available; old diagnostic files are not rewritten. The remaining owned-service offline/privacy invariants are verified in `ve-ovz.14`. |
| Content hashes are identity, not authorization | Engine provider tests reject foreign artifact UUIDs and raw hash/path references. Actual HTTP file, manifest, and range tests reject mismatched owning books and raw hashes. All HTTP routes reject foreign Origin/Host before parsing or accessing content. | Consumer `9d0179ad` (`vb-0ujh`) enforces loopback Host/Origin policy and binds to `127.0.0.1`. It remains a local single-user service: native clients and accepted local origins can access all books. Hashes and UUIDs are not credentials; this is not a remote or multi-user authentication design. |
| Remote publication/backup explicit, never triggered by local search | Actual application B2 HTTP counters stay empty through cached indexing, reference preparation, search, edits and history. Explicit backup then performs HEAD/PUT/verification. A configured local catalog backup target stays absent through indexing/search/history and is written only by explicit backup. | The tested object-store and catalog publication boundaries are verified. This is not an authorization audit of every transport or remote service. Owning-book/API access and the remaining owned-service privacy checks are verified in `ve-ovz.14`. |

Remote hydration integrity is verified in engine `07f0515` and consumer
`20db91d1` (`ve-ovz.18` / `vb-fuib`). Eight engine HTTP/public-API cases cover
same-size wrong content, partial failures, concurrent valid/corrupt transfers,
state preservation, retry, cached reuse, and a forget during download. SHA-256
verification precedes local publication; a final synchronous tombstone check
and rename prevent an in-flight download from republishing forgotten bytes.
The actual application B2 adapter rejects a corrupt HTTP response and supports
valid retry and cached reads after the fixture server shuts down. Existing local
objects are not rehashed on every read. This evidence does not establish
cross-book authorization or the complete offline workflow.

Engine `bf952c5` adds `withLocalMedia`: asynchronous per-book scopes block implicit
CAS downloads with typed `MEDIA_MISSING`, while concurrent explicit reads and
other books remain independent. Compatibility and temporal search/indexing,
edits and history use the policy automatically. Restores succeed for committed
metadata when unavailable bytes prevent workspace hydration. Consumer `96892e26`
applies the scope to direct and queued semantic indexing (including migration
frames), temporary references, library asset projection, and ingest status/retry.
Auxiliary failures preserve source-media readiness. Nine missing-media app cases
exercise the actual B2 adapter and explicit retrieval retry; the additional
cached-model case covers search, edits, restoration and explicit backup.

This completes `ve-ovz.19` / `vb-ld4o`, not the complete security/privacy audit.
Cold-index preparation in the media picker was fixed separately in consumer
`185ec77c` (`vb-ackl`), with a real 1,200-vector queue/poll/retry and
persisted-index regression.

Consumer `64da847a` completes `vb-j3qy`: completed image-subject edits, Library
copies and Duplicate Asset schedule detached indexing jobs deduplicated by
artifact and source hash. Semantic indexing and frame preparation select stream
records matching the current file mapping, rather than an older stream for the
same path. The Library reports missing current-source CLIP coverage and offers
an explicit repair action; its MCP endpoint returns queued per-book jobs and the
client polls their status. Repair skips covered media, prepares missing video
frames, continues past per-asset failures and preserves source readiness.

Validation includes 3,176 default tests across 371 files, explicit cached-model
repair of zero-vector and stale-stream cases, corrupt-media continuation and
idempotence, and a real Chromium Library repair/poll/Similar-search flow. Lint,
test types, client/server builds, dead-code checks, generated command references
and isolated clean installation pass. The original failing edited image now
ranks itself first with no book errors. A saved-library repair resolved all 74
current-source coverage gaps; the final scan reports zero missing visual
indexes. One empty copied video was recovered from its exact preceding
nonempty artifact revision after SHA-256, dimensions and duration verification
(`vb-v9nq`), then indexed and retrieved successfully. These fixture and local
library results do not replace the frozen-corpus or reference-hardware gates.

Provider dispatch scoping is hardened in Engine `dffaf21` (`ve-ovz.20`).
Compatibility preparation and embedding receive a fresh options object containing
only the supplied cancellation signal and timeout. Actual HTTP fixtures showed
that the previous implementation transmitted extra application context and let
providers mutate query controls. Six regressions now verify all four modalities,
selected file/text transmission, caller-option isolation, rejected foreign-book
UUIDs and raw hash/path references, and temporal reference/query separation.
The engine's 347 default tests, types, dead-code checks, build and installed
package smoke test pass, as does Node 22/24 CI. See
`docs/search-provider-consent.md` for the trusted in-process provider boundary.
Consumer `0661c994` vendors the exact verified package (SHA-256
`cb71bf39f3a088058b44273e402569c0a7c90bbb8abb8866f4118979d5ddfbb8`).
Its 3,176 default tests, 35 explicit model/offline/repair cases, lint, test
types, client/server builds, dead-code checks and isolated clean install pass.
`vb-g3ai` is complete; its application commit was local at that validation point.

The HTTP audit reproduced private fixture disclosure through modern MCP with
an untrusted Origin and Host. Consumer `9d0179ad` fixes this at both the direct
MCP handler and Express entry, before CORS, body parsing, static files, or API
routes. The server binds to `127.0.0.1`, accepts loopback browser origins and
native clients, and permits the bundled extension's exact stable origin.
Twenty-three direct-handler cases and actual HTTP/Chromium tests cover foreign,
opaque and malformed origins; rebinding hosts; all routes including uploads and
archives; permitted preflight; extension-worker MCP discovery/tool calls; and
owning-book/hash/range denials. The public extension key pins a development ID,
not a credential. Consumer README documents the trusted local-client boundary.

A subsequent real browser fixture exposed another path: uploaded SVG scripts
ran in the media server's origin and read private book names through MCP.
Consumer `43d31b32` applies CSP sandbox and `nosniff` to media and archive
responses. The identical private-query fixture no longer executes. Browser
regressions verify blocked SVG/HTML scripts, forms, and external resource
requests, preserved inline SVG styling and image rendering, and actual H.264
playback. The final combined run also verifies the Library's real cached-model
repair and Similar search flow. All 3,199 default tests across 372 files,
seven explicit HTTP/Chromium/model E2E cases, lint, test types, dead-code checks,
client/server builds, and isolated clean installation pass.

`vb-0ujh`, `vb-sby1`, `vb-3esp`, and `vb-bkgq` are complete. Consumer
`fc751e79` adds the hostile search text browser checks and application provider
range/input evidence that close `ve-ovz.14`. Its full default suite passed
3,202 tests across 374 files, with lint, test types, dead-code checks, and both
builds passing. These local service checks do not establish authentication
for remote or multi-user deployments.

## Migration, consumer and packaging

Section 15.4 migration is covered by `tests/migration.test.ts`, the pinned v4
schema fixture and consumer migration tests. Evidence includes valid notebook
graphs/generation choices, properties/prompts/messages, real timed media,
empty and large catalogs, content-hash validation, unchanged source bytes,
identical reruns, cancellation/process interruption and source edits before
publication. Consumer queue tests cover durable status/cancel, archive/switch
recovery and idempotent reindex scheduling. `ve-ovz.5`, `ve-ovz.6` and `vb-6eu9`
are complete. This migration evidence does not prove general edit durability.

Engine `e328f5e` passed 341 default tests (12 opt-in cases skipped), typecheck
and knip. Runtime `bf952c5` also passed build and standalone installed-package
checks for local-media denial, explicit retry, checksum rejection, README usage,
and native image decoding. [Node 22/24 runtime CI](https://github.com/justintanner/videobook-engine/actions/runs/34007728660)
passed. `e328f5e` adds only the configured-catalog publication regression.
Consumer `96892e26` passed 3,171 default tests across 370 files (4 opt-in cases
skipped), 38 final explicit workflow/migration/indexing checks including the real
cached-model workflow, and the separate 19 model/queue cases with all three
cached-model cases enabled. Lint, test types, dead-code checks, client/server
builds and the final isolated worktree clean install passed. The initial full run
caught the migration-frame hydration bypass while it was being fixed; the final
full-source run is green.

The earlier model-revision baseline `3f9b37d` passed 324 tests (12 opt-in tests skipped), typecheck, knip,
build and the 22-group API benchmark smoke. Node 22/24 CI passed tests,
builds and clean-package verification at `5db34ef`, which differs only by a
bounded cleanup retry in a merge test. The first Node 24 run failed removing
that temporary database directory after its assertions passed; no runtime
source or semantic assertion changed in the cleanup correction. The consent package was also installed
locally with explicit cached CLIP/CLAP inference enabled. Eleven provider-access
tests exercise actual HTTP dispatch, denied/changed/revoked consent, identical
registration during an overlapping query, and compatibility modalities.

Earlier consumer `80ce4f58` passed 3,151 tests across 366 files, lint, test types,
dead-code checks and both builds. Its three real-model queue cases, skipped by
default, passed in the explicit 37-test focused run. Those cases include an
existing-image Similar reference and indexed source retrieval with downloads
disabled. Corrupt pinned caches fail both actual indexing and reference jobs
with `MODEL_UNAVAILABLE` while source bytes/status remain unchanged. This
integration exposed a preparation race: missing tokenizer failure could precede
a corrupt config check in the other branch. Engine `162bdcd` awaits both
branches and prioritizes integrity failure; repeated public-provider and
consumer queue tests verify the correction.

Both worktree and exact committed-source (`80ce4f58`) clean installs passed
native Sharp, MCP create/list, client delivery and graceful shutdown without a
sibling engine checkout.

Consumer `fc751e79` vendors `videobook-engine-5.3.1-dffaf21.tgz`, SHA-256
`cb71bf39f3a088058b44273e402569c0a7c90bbb8abb8866f4118979d5ddfbb8`.
Local package smoke and
vendored-consumer verification do not prove installation of a published
registry package: `ve-yc7` and `ve-orp` retain that release gate. Registry
authentication was rechecked on September 6, 2026 and `npm whoami` returned
E401. The obsolete 0.1.0 and 2.0.0 publication tickets are superseded by
`ve-yc7`; they are not additional release targets.

Subsequent checksum hardening adds verified file resolution for all built-in
model paths, complete upstream digest inventories for three pinned snapshots,
cache-staging cleanup and public-provider corruption regressions. Nine explicit
real-model tests pass, including MiniLM external ONNX weights and offline reopen.
The installed package rejects corrupt pinned configuration and runs cached
CLIP/CLAP inference. The consumer now includes this verified resolver and
explicit application-owned provider download consent.

All 12 explicit real-model checks passed at model-revision baseline `3f9b37d`. The custom-revision
suite serves actual cached CLIP/CLAP/MiniLM files under custom repository IDs,
verifies fixed revision URLs and integrity receipts, indexes and queries real
media, reopens offline, rejects reuse under a different revision, and loads
explicit local model directories. Sixteen default contract tests cover missing
or moving revisions, configuration snapshots, repository-name collisions,
worker file scope, separate modality defaults and legacy visual cache safety.

Legacy compatibility custom image models previously shared the built-in CLIP
vector identity without recording their provenance. The compatibility visual
space now uses `compat-visual-v2`, requiring a one-time reindex instead of
reusing ambiguous old vectors. Temporal index identities, including those used
by the media library, are unchanged. Source files remain intact. This migration
and the commit requirement for custom remote models are documented in
`docs/model-revisions.md`; `ve-ovz.15` and consumer `vb-3f45` are complete.

The NFR measurement pass (`ve-ovz.9`) records current-source distributions
for VE-NFR-001/002/004/005/006/007/009/012 and the actual model-pipeline
cadence for VE-NFR-003 in this document, `docs/edit-performance.md` and
`docs/temporal-search-performance.md`. Every measured gate passes on the
available M1 Pro; the M2 Pro reference device named by the PRD has not been
measured and M1 Pro results are recorded as M1 Pro results only. The full
quality corpus (`ve-s84`), reference-device runs (`ve-ovz.22`), and published-package
verification (`ve-yc7`, `ve-orp`) prevent closing E4/E5/MVP.
