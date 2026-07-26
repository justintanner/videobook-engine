# videobook-engine MVP Requirements

## Temporal media retrieval and a reversible edit engine

| Field | Value |
| --- | --- |
| Status | Proposed MVP baseline |
| Package | `videobook-engine` |
| Date | 2026-07-24 |
| Tracking | `ve-4i9` |
| Product dependency | `~/videobook/docs/mvp-prd.md` (`vb-c8a`) |
| Proposed release line | `3.x`, catalog schema v5 |

## 1. Executive contract

`videobook-engine` will be the provider-agnostic, local-first semantic core for
the Videobook MVP. It must make two product promises true:

1. any useful moment in a book can be retrieved by language, image/frame,
   video range, audio range, transcript, OCR, metadata, or exact similarity;
2. any edit proposed through UI, slash command, or chat can be previewed,
   validated, atomically committed, audited, and restored without mutating
   source media.

The engine owns media identity, rational source time, derived temporal indexes,
notebook truth, sequence truth, edit semantics, provenance, jobs, content
addressing, and revision integrity. It does not own React state, chat prompting,
hosted AI credentials, a cross-book catalog, or provider-specific generation
workflows.

The current whole-artifact similarity API and ordered-slot timeline are useful
foundations but cannot satisfy the MVP. Schema v5 is an intentional edit and
retrieval model expansion.

## 2. Scope and boundaries

### 2.1 Engine responsibilities

- exactly one durable book per engine root;
- stable UUIDv7 identity for books, artifacts, notebooks, cells, streams,
  transcripts, sequences, tracks, clips, captions, actions, and jobs;
- immutable CAS objects and versioned logical file mappings;
- media stream identity, source object identity, rational timebase, and exact
  source ranges;
- corrected transcripts, notebook graphs, sequences, captions, edit actions,
  and provenance as semantic state;
- local, rebuildable temporal text/visual/audio/OCR indexes;
- a provider interface for local or injected embedding/analysis
  implementations;
- deterministic hybrid retrieval and timecoded search results;
- deterministic edit preview, validation, conflict detection, and atomic
  commit;
- durable jobs, leases, fencing, recovery, and terminal job audit;
- forward-only Dolt revisions and copy-forward schema migration;
- storage health, optional content publication, and catalog backup.

### 2.2 Application responsibilities

- React presentation, interaction, keyboard behavior, and synchronized views;
- deterministic slash parsing into typed engine intents;
- conversational interpretation, clarification, and planning;
- all external AI/API access through `@apicity` providers;
- provider credentials, cost policy, and user consent;
- queue workers that run ffmpeg, transcription, OCR, provider calls, rendering,
  and engine index primitives;
- cross-book/library search federation and global archive behavior;
- HTTP media serving and packaged application lifecycle;
- user analytics and experiment assignment.

### 2.3 Engine non-goals for MVP

- a hosted service or multi-tenant database;
- direct calls to hosted LLM, vision, transcription, or generation APIs;
- UI command grammar or natural-language intent recognition;
- a global index spanning multiple engine roots;
- collaborative branches or live multi-user merge;
- arbitrary effect plugins, professional interchange, or a full compositor;
- model training;
- permanent storage of derived proxies or embeddings as semantic truth.

## 3. Current baseline and gap analysis

The audited 2.0.1 package and catalog schema v4 already provide:

- one isolated book and timeline per engine root;
- CAS objects, artifact file mappings, workspaces, metadata, and optional
  remote publication;
- notebooks, typed cells/edges, terminal notebook runs, prompts, and messages;
- forward-only Dolt semantic commits, operation provenance, high-level action
  DAGs, write sets, conflict checks, and restore;
- persistent jobs, leases, status projections, recovery, and terminal job
  records;
- a single ordered visual lane plus timed audio overlays and waveforms;
- opt-in local image/video similarity through CLIP-like vectors;
- opt-in local audio similarity through CLAP audio vectors;
- opt-in text-document similarity with chunk offsets;
- exact-byte reuse and in-memory approximate-nearest-neighbor indexes.

The current contracts do not meet the MVP because:

- video indexing samples up to 120 frames and stores their centroid as one
  vector, so results identify a file rather than a moment;
- image and video searches are isolated by media kind even though they can
  share an embedding space;
- the built-in visual provider does not expose a text encoder, so language
  cannot search visual content;
- audio uses one bounded source vector and does not return time ranges;
- text similarity searches text artifacts, not transcript/OCR ranges inside
  media;
- there is no unified hybrid query or score/rank explanation;
- the application does not configure or consume similarity;
- the timeline lacks source in/out, timeline start, duration, tracks,
  timebase, transforms, transitions, captions, and normalized edit decisions;
- notebook cells use source, note, selects, scene, and asset primitives with
  operation and tool metadata defining behavior;
- action history records workflows but there is no public deterministic edit
  plan/diff/commit contract.

## 4. Non-negotiable invariants

1. **One book, one root.** Cross-book behavior remains above the engine.
2. **Source bytes are immutable.** Editing changes semantic references and
   produces derived/final artifacts; it never rewrites a source object.
3. **Semantic state is versioned.** User corrections, selections, sequences,
   captions, and committed edit intents participate in Dolt history.
4. **Derived state is rebuildable.** Embeddings, ANN structures, OCR/vision
   observations, proxies, thumbnails, and readiness projections are runtime
   state keyed by source hash and extractor/model manifest.
5. **Time is exact.** Timeline positions are integer sequence frames; source
   positions are integer stream ticks with an explicit rational timebase.
   Floating-point seconds are presentation/input conveniences only.
6. **A result remains resolvable.** A pinned search hit records artifact,
   source object, stream, source range, index manifest, and book revision.
7. **A commit is atomic.** An edit batch either changes all requested semantic
   structures and records its action/operation or changes none.
8. **History moves forward.** Restore creates a new semantic revision; the
   live Dolt branch is never detached or rewound.
9. **Conflicts are explicit.** A stale base revision with overlapping writes
   cannot silently commit.
10. **Model identity is data.** Every derived observation names its embedding
    space, provider/model revision, preprocessing contract, dimensions, and
    extractor version.
11. **No secret enters a book.** API keys, access tokens, and secret-bearing
    provider configuration never enter semantic tables, runtime logs, action
    details, or metadata.
12. **Path access stays scoped.** All book and asset bytes pass through engine
    file/CAS/workspace APIs.

## 5. Time and media identity

### 5.1 Required public concepts

```ts
export interface Rational {
  numerator: number
  denominator: number
}

export interface SourceRange {
  streamId: string
  objectHash: string
  startTick: number
  durationTicks: number
  timeBase: Rational
}

export interface SourcePoint {
  streamId: string
  objectHash: string
  tick: number
  timeBase: Rational
}

export type MediaSourceSnapshot =
  | {
      kind: "still"
      artifactId: string
      sourcePath: string
      objectHash: string
    }
  | {
      kind: "timed"
      artifactId: string
      range: SourceRange
    }

export type SearchLocation =
  | MediaSourceSnapshot
  | {
      kind: "document"
      artifactId: string
      sourcePath: string
      objectHash: string
      startUtf8Byte: number
      endUtf8Byte: number
    }

export interface SequenceRange {
  sequenceId: string
  startFrame: number
  durationFrames: number
}
```

Names may change, but the semantics may not.

- All source, sequence, and text ranges are half-open: the start is included
  and the end (`start + duration`) is excluded.
- A media stream is tied to a logical artifact file and the CAS object that was
  probed. Stream source versions are immutable. Replacing an artifact file
  creates new stream IDs for the new object; prior stream rows remain while
  referenced. Existing committed clips keep their object-hash-qualified source
  reference until the user explicitly conforms them.
- `timeBase` expresses seconds per source tick. A 48 kHz audio stream can use
  `1/48000`; a video stream uses the probed stream timebase.
- A sequence defines a rational frame rate. Sequence frame `n` is mapped using
  rational arithmetic with documented rounding at edit boundaries.
- `durationTicks` and `durationFrames` are positive. A zero-length cursor
  selection is an input convenience, never a persisted clip or search hit.
- Still images have a CAS-qualified `still` source and a sequence duration but
  no invented source timebase. Timed audio/video use a stream range. Text
  documents use half-open UTF-8 byte offsets only for retrieval and cannot be
  inserted as media clips without a rendering step.
- Search result display seconds are derived and must not become the authority
  when a result is inserted.

### 5.2 Media profile

Every searchable audio/video artifact requires a runtime media profile keyed
by artifact ID, source path, object hash, probe version, and stream index. It
contains:

- container, codec, stream kind, duration, timebase, and start time;
- video dimensions, rotation, pixel aspect ratio, nominal/average frame rate,
  color metadata when available, and keyframe hints;
- audio sample rate, channel layout, duration, and loudness data when derived;
- whether the profile is complete, partial, stale, failed, or unsupported.

User-authored stream selection and sequence references are semantic. Re-probed
technical fields are runtime unless required to interpret a committed source
range, in which case the committed clip carries the necessary snapshot.

## 6. Semantic and runtime ownership

| Data | Ownership | Reason |
| --- | --- | --- |
| Artifact identity, source file mapping, object identity | Semantic | Required to reproduce and audit work |
| Corrected transcript text, speakers, word timing adjustments | Semantic | User-authored editorial truth |
| Raw provider transcript/analysis response | Versioned artifact file with provenance | Reproducible input without hard-coding provider schema |
| Notebook cells, saved queries, pinned selects | Semantic | Creative decisions |
| Sequence, tracks, clips, source ranges, transforms, transitions, captions | Semantic | Authoritative edit decision list |
| Normalized committed command intent and action lineage | Semantic | Audit, restore, and surface parity |
| Media probes, proxies, thumbnails, storyboards, loudness | Runtime | Derivable from source object |
| Shot/window segmentation, OCR, generated descriptions | Runtime until user corrects or pins | Model-derived observations |
| Text, visual, audio vectors and ANN/FTS structures | Runtime | Rebuildable and model-versioned |
| Index coverage, progress, errors, caches | Runtime | Operational state |
| Final renders | Semantic artifact/files | User-visible output pinned to a sequence revision |

Runtime observations selected into a notebook or sequence are snapshotted by
stable source identity/range and relevant display/explanation fields. The
runtime row ID itself is never the only durable reference.

## 7. Catalog schema v5 requirements

Exact SQL is an implementation decision, but schema v5 must normalize the
following concepts and constraints.

### 7.1 Media streams and transcripts

| Structure | Minimum fields and constraints |
| --- | --- |
| `artifact_streams` | UUIDv7 stream ID; artifact ID; logical source path; object hash; stream index; timed kind (`video` or `audio`); timebase numerator/denominator; duration ticks; codec snapshot; optional video/audio shape; unique artifact/object/stream index |
| `transcripts` | UUIDv7 transcript ID; artifact/stream ID; source object hash; language; provider/model provenance; current/derived state; created time |
| `transcript_segments` | UUIDv7 segment ID; transcript ID; ordinal; source start/duration ticks; speaker; text; confidence optional; segment kind |
| `transcript_words` | UUIDv7 word ID; segment ID; ordinal; source start/duration ticks; text; confidence optional; user-corrected flag |

Transcript segment and word ranges must be ordered and bounded by the source
stream. Correcting text does not change timing. Adjusting timing is an explicit
semantic operation with overlap/bounds validation.

### 7.2 Sequences and edit decisions

| Structure | Minimum fields and constraints |
| --- | --- |
| `sequences` | UUIDv7 sequence ID; name; width/height; pixel-aspect rational; frame-rate rational; audio sample rate/channel layout; background RGBA; created time |
| `sequence_tracks` | UUIDv7 track ID; sequence ID; kind (`video`, `audio`, `caption`); ordinal; name; enabled/locked; audio mute/solo; video blend mode |
| `sequence_clips` | UUIDv7 clip ID; track ID; discriminated still or timed `MediaSourceSnapshot`; timeline start/duration frames; timed sources carry source start/duration ticks and speed rational; reverse; enabled |
| `clip_links` | Stable link-group ID; clip ID; role; unique membership |
| `clip_transforms` | Clip ID; position, scale, anchor, rotation, crop edges, opacity, blend mode with validated finite ranges |
| `transitions` | UUIDv7 transition ID; track; outgoing/incoming clip IDs; kind; duration frames; alignment; parameters; adjacency and handle validation |
| `caption_cues` | UUIDv7 cue ID; caption track; timeline start/duration frames; text; speaker/style reference; source transcript references optional |

P0 transition kinds are cut and dissolve. P0 transforms are fit/fill/crop,
position, scale, rotation, opacity, and blend mode. The schema may allow future
effect/keyframe structures, but they are not a P0 implementation requirement.

Sequence rules:

- track ordinals are unique within sequence/kind;
- clips cannot have negative timeline positions or non-positive durations;
- source ranges must fit the referenced source snapshot after rational speed
  mapping;
- speed and reverse apply only to compatible timed sources; still clips use
  sequence duration without synthetic source ticks;
- video/caption overlap is allowed across tracks; overlap rules within a track
  are explicit and deterministic;
- audio overlap is allowed;
- locked tracks reject mutation;
- transitions require valid adjacency/overlap and sufficient media handles;
- deletion of referenced artifacts/streams is restricted;
- a new book has one primary sequence compatible with its default render
  orientation.

### 7.3 Notebook evolution

Schema v5 must support at least:

- `source`, `audio`, `transcript`, `note`, `search`, `selects`, `prompt`,
  `character`, `scene`, `image`, `video`, and `sequence` cell behaviors;
- typed references from cells to artifacts, streams/ranges, transcripts,
  sequences, and other cell outputs;
- saved query configuration and filters;
- pinned result snapshots;
- explicit cell execution state through existing job/run contracts.

The implementation may use a versioned cell payload plus normalized typed
reference tables. It may not rely on path strings or opaque UI-only state to
reconnect a notebook after reload.

### 7.4 Actions and edit batches

Existing `actions`, `action_events`, `action_parents`, `action_artifacts`, and
`action_write_set` remain the audit foundation.

A committed edit batch must record:

- intent schema version and source surface;
- actor, sequence, base revision, and committed revision;
- normalized operations in deterministic order;
- affected resource/write-set keys;
- input/output artifact and parent action links;
- preview hash or canonical before/after diff hash;
- confirmation policy and confirmation metadata without secret or prompt-body
  leakage;
- operation count, affected timeline ranges, and warnings accepted;
- failure/conflict events when a requested batch does not commit.

Plans that are never applied are runtime/application state unless the user
explicitly saves one in a message or notebook cell.

### 7.5 Runtime indexing structures

Schema v5 replaces or supersedes the three schema-v4 similarity tables with
runtime structures capable of many segments and modalities per artifact:

| Runtime concept | Required behavior |
| --- | --- |
| Index manifests | Identify provider, model ID/revision, license metadata, embedding space, dimensions, supported languages/modalities, preprocessing/extractor versions, and created time |
| Artifact coverage | Track source object, modality phases, indexed ranges, completeness, progress, error, retryability, and manifest |
| Media segments | Artifact/stream/object, source range, segment kind, representative tick, segmentation version, optional derived text |
| Segment text | Transcript/OCR/description/metadata text, language, half-open UTF-8 byte offsets or timed source ranges, confidence, provenance |
| Segment embeddings | Segment, modality, embedding space, dimensions, quantized vector, source hash, updated time; multiple spaces permitted |
| Exact/near duplicates | Cryptographic hash and optional perceptual/frame fingerprints with extractor version |
| Lexical index | FTS-capable index over transcript, OCR, descriptions, labels, slugs, and selected metadata |
| ANN indexes | Cached per embedding space and compatible query modality, rebuilt from runtime rows |

All runtime tables remain excluded from Dolt staging. A stale manifest or source
object invalidates only the affected derived rows.

## 8. Public API requirements

The API remains explicit, typed, named-export friendly, and uses
`Result<T, EngineError>` for expected failures.

### 8.1 Search contract

```ts
export type SearchModality =
  | "auto"
  | "visual"
  | "speech"
  | "ocr"
  | "audio"
  | "metadata"

export type SearchReference =
  | { kind: "image"; artifact: string }
  | { kind: "frame"; source: SourcePoint }
  | { kind: "video"; range: SourceRange }
  | { kind: "audio"; range: SourceRange }

export interface SearchQuery {
  text?: string
  reference?: SearchReference
  modalities?: SearchModality[]
  artifactKinds?: ArtifactKind[]
  durationMs?: { min?: number; max?: number }
  labels?: string[]
  createdAfter?: number
  createdBefore?: number
  minScore?: number
  limit?: number
  cursor?: string
}

export interface SearchSignal {
  kind: "visual" | "speech" | "ocr" | "audio" | "metadata" | "exact" | "near"
  rank: number
  score?: number
  explanation?: string
}

export interface SearchHit {
  artifactId: string
  artifactSlug: string
  artifactKind: ArtifactKind
  location: SearchLocation
  representativeTick?: number
  score: number
  signals: SearchSignal[]
  excerpt?: string
  indexManifestIds: string[]
}

export interface SearchPage {
  hits: SearchHit[]
  nextCursor?: string
  coverage: SearchCoverage
}
```

The final API must provide equivalents of:

- `prepare` or manifest/model readiness;
- an index plan for an artifact/source object;
- cancellable worker primitives for incremental index batches;
- artifact and book coverage/status/stats;
- hybrid query by text, reference media, or both;
- deterministic pagination;
- targeted invalidation and full rebuild;
- runtime cleanup by retired manifest/source object.

Indexing is a long-running queued operation in the consuming application. The
engine primitive must be idempotent, incremental, cancellation-aware, and safe
to retry after lease expiry.

### 8.2 Sequence and edit contract

```ts
export interface EditIntent {
  intentVersion: number
  commandId: string
  sequenceId: string
  baseRevision: string
  actor: string
  sourceSurface: "ui" | "slash" | "chat" | "system"
  operations: EditOperation[]
}

export interface EditPreview {
  commandId: string
  baseRevision: string
  valid: boolean
  operations: NormalizedEditOperation[]
  affectedRanges: SequenceRange[]
  writeSet: string[]
  warnings: EditWarning[]
  conflicts: EditConflict[]
  beforeHash: string
  afterHash: string
}

export interface EditCommit {
  commandId: string
  actionId: string
  revision: string
  sequence: Sequence
  previewHash: string
}
```

The engine must provide:

- sequence create/list/get/get-at-revision/rename/delete with reference checks;
- preview that resolves aliases, normalizes rational time, validates all
  operations, computes affected resources/ranges, and does not mutate state;
- atomic commit that verifies base revision and preview hash, records the
  action and semantic operation, then returns the committed revision;
- restore of a sequence or committed edit action as a new revision;
- stable before/after projection suitable for UI diffs;
- deterministic serialization for contract fixtures.

P0 edit operations:

| Operation | Required semantics |
| --- | --- |
| Insert/overwrite clip | Resolve source snapshot and range; place on target track; optionally replace overlapped range |
| Remove/ripple remove | Remove selected clips/ranges; ripple is explicit and scoped |
| Move | Change track and/or timeline start with lock/overlap validation |
| Trim | Change source in/out and timeline duration using rational mapping |
| Split | Produce two stable clips whose source/timeline ranges exactly cover the original |
| Restore removed source range | Recreate a clip from action/source provenance |
| Set transform | Validate and replace the P0 transform projection |
| Set gain/fades/mute | Apply finite audio values with defined units |
| Set speed/reverse | Preserve explicit source mapping and audio policy |
| Set transition | Validate adjacency, duration, handles, and supported kind |
| Upsert caption cue | Validate time range, text, track, and style reference |
| Batch replace range | Support transcript-driven and rough-cut plans atomically |

Units must be explicit in type/property names. Percent, decibels, linear gain,
milliseconds, frames, ticks, and seconds cannot be accepted interchangeably.

### 8.3 Transcript contract

The engine must provide:

- import of a validated timed transcript from an application/provider adapter;
- read by artifact/stream and at revision;
- text correction without media mutation;
- word/segment timing correction with rational validation;
- range delete/restore/reorder operations that compile to sequence edits;
- a stable mapping from transcript selections to source ranges and from
  sequence clips back to transcript ranges;
- caption cue generation input that remains tied to the chosen transcript
  revision.

Provider-specific JSON remains an artifact file. The normalized transcript API
accepts and returns the engine’s provider-neutral model.

## 9. Temporal multimodal retrieval

### 9.1 Segmentation

The engine search worker must support multiple overlapping evidence units:

- shot-bounded visual segments;
- short overlapping visual windows for long or uncut shots;
- representative frames and optional per-frame vectors;
- transcript segments/words with exact source timing;
- OCR spans with time coverage;
- audio-event windows;
- artifact-level metadata and user labels.

No fixed segmentation algorithm is mandated, but the manifest must identify it
and the acceptance benchmark must demonstrate moment-level recall. A whole-file
vector may contribute a global signal but may not be the only video/audio
representation.

The worker commits batches frequently enough to expose progressive results and
records covered source ranges. A crash cannot require successful earlier
batches to be recomputed.

### 9.2 Cross-modal spaces

The search-provider contract must distinguish:

- image/frame/video-segment encoders that share a comparable visual space;
- a text encoder for that same visual space;
- audio-window and optional audio-text encoders in a comparable audio space;
- semantic text encoders for transcript/OCR/document retrieval.

The current `embedImage`/centroid `embedVideo` interface is retained only as a
compatibility layer. MVP reverse image-to-video requires image and video
segments to search the same visual index. MVP natural-language visual search
requires text-to-visual encoding or an injected observation/ranking provider
that satisfies the same contract.

### 9.3 Reverse video

A reverse-video query uses a source range, not an artifact ID alone. It samples
multiple ordered query moments and scores candidates for both visual similarity
and temporal coherence. A single centroid match cannot satisfy the contract.

The exact order-aware algorithm is an implementation choice. It may use
multi-vector ANN candidates followed by sequence alignment, but it must:

- return one or more bounded candidate source ranges;
- penalize reversed or shuffled action unless the query requests it;
- avoid flooding results with overlapping windows from the same moment;
- preserve exact/near-duplicate signals separately from semantic similarity;
- meet the reverse-video benchmark in the application PRD.

### 9.4 Hybrid ranking

The engine must combine lexical and vector evidence without assuming raw scores
from different embedding spaces are calibrated. Reciprocal-rank fusion or a
documented equivalent is the default baseline.

Ranking requirements:

- exact byte and strong near-duplicate matches are deterministically promoted;
- quoted text strongly favors exact transcript/OCR matches;
- natural-language queries can retrieve visual-only moments;
- reference-plus-text queries use the text to refine rather than discard the
  reference;
- adjacent/overlapping hits are deduplicated into useful ranges;
- results are stably ordered using score, source identity/range, and artifact
  ID tie-breakers;
- every final hit retains contributing signal ranks/scores and a concise
  provider-neutral explanation;
- coverage reports whether the query language is measured, best-effort, or
  unsupported for each active semantic space;
- pagination is stable for an unchanged index generation.

### 9.5 Index lifecycle

- A manifest is immutable once used.
- Provider/model/preprocessing changes create a new manifest and index
  generation.
- New and old generations may coexist during rebuild.
- Queries use one coherent active generation per space; they never mix
  incompatible dimensions or preprocessing.
- Generation activation is atomic after minimum coverage is met.
- Retired generations are garbage-collected only when no running query/job or
  pinned diagnostic requires them.
- An artifact file/object change marks affected coverage stale and schedules
  reindex without deleting user selections.
- Search remains available from unaffected and previously active coverage
  during rebuild.

## 10. Edit preview and commit semantics

### 10.1 Preview

Preview is pure with respect to semantic and runtime storage. Given the same
head, intent, and source manifests, it returns byte-for-byte canonical
normalized operations and hashes.

Preview validates:

- IDs, references, source-object availability, stream/timebase compatibility;
- bounds, positive durations, rational overflow, and rounding;
- track kind, lock state, overlap policy, and transition handles;
- artifact deletion/replacement conflicts;
- stale base revision and overlapping writes since base;
- operation ordering and intra-batch dependencies;
- supported renderer/edit capabilities;
- missing media or derived work that will be required after commit.

### 10.2 Commit

Commit accepts the original intent plus the preview hash. It re-runs validation
inside the serialized semantic mutation boundary. If the current state no
longer produces that preview hash, it returns `STALE_REVISION` or
`ACTION_CONFLICT`.

One successful commit:

1. applies every sequence/transcript/notebook semantic row change;
2. writes the low-level `operations` record and commit outbox entry;
3. writes or advances the high-level action and its normalized write set;
4. records input/output artifact lineage and parent actions;
5. creates one forward Dolt revision;
6. returns the revision and semantic projection;
7. invalidates only affected runtime renders/proxies/search observations.

Derived jobs are enqueued or requested after the semantic commit and can be
reconciled from committed state. Their failure does not roll back the edit.

### 10.3 Restore

Restore materializes the selected sequence/notebook/transcript state from a
revision or action, validates it against source availability, and commits it as
a new revision. Immutable source and final objects remain addressable according
to retention policy.

## 11. Jobs and derived media

The existing runtime queue, leases, fences, and terminal `job_runs` remain the
coordination foundation.

P0 derived job types include:

- media probe;
- proxy/transcode;
- thumbnail/storyboard/waveform/loudness;
- transcription normalization;
- shot/window segmentation;
- OCR;
- visual/text/audio embedding batches;
- ANN/FTS generation activation;
- caption derivation;
- preview render and final render.

Job requirements:

- deterministic dedupe key includes book/source object, operation, and
  manifest/settings version;
- progress can report units completed/total and current phase;
- lease expiry and retry cannot cause duplicate semantic outputs;
- cancellation is cooperative and leaves previously committed index batches
  valid;
- failure codes distinguish unsupported media, missing object, provider/model
  unavailable, offline, invalid output, resource exhaustion, timeout, and
  internal error;
- jobs do not place secrets or full prompt/transcript bodies in logs;
- source replacement or sequence edit invalidates affected downstream work by
  identity, not path guessing.

Derived proxy/thumbnail files may live in disposable workspaces or a managed
runtime cache. A final or user-promoted derivative becomes a normal semantic
artifact/file mapping before it is relied on by history.

## 12. Performance and quality requirements

The reference beta device is an Apple M2 Pro with 16 GB RAM and local SSD.
Quality thresholds use the frozen corpus defined in the application PRD.

| ID | Area | Creator-beta requirement |
| --- | --- | --- |
| VE-NFR-001 | Open | Open a healthy 1,000-artifact book and return semantic summary within 2 seconds, excluding optional remote object fetches |
| VE-NFR-002 | Text readiness | New metadata and an imported normalized transcript become lexically searchable within 5 seconds of their semantic commit |
| VE-NFR-003 | Progressive visual indexing | Commit searchable coverage at least once per 60 seconds of source media analyzed and resume from the last committed batch |
| VE-NFR-004 | Query latency | On 100,000 indexed moments, warm p50 is under 500 ms and p95 under 1.5 seconds, including hybrid rank but excluding remote provider calls and preview-byte download |
| VE-NFR-005 | Edit preview | Preview a 100-operation batch against a 1,000-clip sequence in under 250 ms p95 without storage mutation |
| VE-NFR-006 | Edit commit | Commit that batch in under 1 second p95 on a healthy local catalog, excluding derived jobs |
| VE-NFR-007 | Memory | Query/index structures for 100,000 moments stay within 4 GB process RSS beyond memory required by an actively loaded embedding model |
| VE-NFR-008 | Durability | Forced termination at every SQL/outbox/Dolt boundary produces either the prior or committed semantic state after reopen, never a partial batch |
| VE-NFR-009 | Determinism | Repeating search against an unchanged active generation returns stable ordering; repeating preview returns identical canonical operations/hashes |
| VE-NFR-010 | Search quality | Meet every recall, duplicate, boundary-error, and latency threshold in `~/videobook/docs/mvp-prd.md` |
| VE-NFR-011 | Offline | With required models cached, no search/index/edit/history operation initiates network access |
| VE-NFR-012 | Scale behavior | Larger books degrade through longer indexing/pagination, not catalog corruption, unbounded React payloads, or full-vector scans on every query |

Index throughput is reported, benchmarked, and visible but is not fixed to one
number until the reference model is selected in G0. First useful partial
coverage and safe resume are release requirements.

## 13. Security and privacy

- Model downloads are opt-in/configurable, revision-pinned, checksum-verified
  when upstream metadata supports it, and can be disabled.
- Search providers receive only scoped file/range/text inputs. The built-in
  provider is local. Injected providers declare whether they can perform
  network access; the application owns consent.
- Media subprocesses use argument arrays, bounded output locations, timeouts,
  cancellation, and scoped workspaces; no untrusted value is interpreted by a
  shell.
- Malformed codecs, oversized images, decompression bombs, and model
  out-of-memory errors fail the job without corrupting the book.
- Search excerpts and explanations are treated as user content.
- Runtime logs use IDs, hashes, sizes, phases, and error codes rather than
  secrets or full content.
- Content hashes are identity values, not authorization tokens.
- Remote content publication and catalog backup remain explicit operations and
  are not triggered by local search.

## 14. Migration and compatibility

Schema v5 is released on a new package major because timeline and similarity
contracts change materially.

The supported path from schema v4 is copy-forward migration:

1. open v4 read-only and verify storage health;
2. create a separate v5 root;
3. preserve current book, artifact, entity, notebook, prompt/message, and
   content identities where valid;
4. preserve all object hashes and copy/hard-link bytes through engine CAS
   primitives;
5. convert ordered `timeline_slots` to sequential clips on the primary video
   track using probed source duration;
6. convert `timeline_audio` to clips on the first audio track;
7. convert render orientation into primary sequence dimensions/frame rate;
8. carry waveform and corrected semantic metadata where compatible;
9. discard schema-v4 similarity runtime rows and schedule v5 reindex;
10. create a migration report artifact plus one v5 import action/operation that
    records the v4 book ID, v4 head revision, conversion decisions, and hashes;
11. validate manifests, references, converted duration, and head state;
12. leave the v4 root untouched until the application explicitly switches.

Schema-v4 Dolt commit IDs and action/operation rows are not inserted into the
live v5 history because their table snapshots and base revisions use the old
schema. The migration report preserves a machine-readable audit summary and
the untouched v4 root remains the authority for full legacy revision browsing.
New v5 history begins with the import revision.

Migration requirements:

- idempotent for the same source/destination contract;
- interruptible and resumable or safely restartable;
- dry-run report with unsupported/missing media and estimated reindex work;
- real-fixture tests for empty, representative, large, and partially missing
  v4 books;
- no implicit in-place upgrade;
- a clear `SCHEMA_INCOMPATIBLE` result when a caller attempts an unsupported
  open.

A compatibility adapter may expose the old `timeline` and `similarity` APIs
during application transition, but it must compile into v5 sequence/search
semantics and be marked deprecated. It cannot maintain a second truth.

## 15. Verification and acceptance

All release-gate tests use real DoltLite, real filesystem/CAS paths, and real
ffmpeg/ffprobe where media is involved. Search quality gates use the pinned
local reference models, not deterministic test embeddings.

### 15.1 Temporal retrieval

- Index a video containing several distinct scenes and prove that a query
  returns the judged scene range rather than only the artifact.
- Query a selected frame and retrieve matching still images and ranges in other
  videos from one visual space.
- Query a five-second ordered action and distinguish the coherent action from
  clips containing the same objects in a different order.
- Query language with no transcript match and retrieve the correct visual-only
  range.
- Query quoted speech and OCR, verify exact evidence and time range, and show
  contributing signals.
- Replace a source object, preserve a pinned old selection, mark current
  coverage stale, rebuild progressively, and atomically activate the new
  generation.

### 15.2 Sequence correctness

- Insert, overwrite, move, trim, split, ripple remove, transform, fade, speed,
  reverse, dissolve, and caption operations round-trip through preview/commit.
- Rational-time property tests prove that a split followed by recombination
  covers the original source/timeline ranges without gaps or double frames.
- Locked tracks, invalid handles, out-of-bounds source ranges, and wrong stream
  kinds fail without mutation.
- The same normalized intent from UI/slash/chat fixtures produces equivalent
  semantic sequence state.

### 15.3 Concurrency and recovery

- A stale non-overlapping action can be explicitly rebased; an overlapping
  action conflicts.
- Killing the process before SQL commit, after SQL commit/before Dolt commit,
  and after Dolt commit/before outbox cleanup recovers to a valid single
  semantic outcome.
- Killing index jobs between batches preserves activated generation and
  completed coverage.
- Lease expiry with two workers cannot double-activate a generation or commit
  duplicate terminal semantic records.

### 15.4 Migration

- A representative v4 fixture migrates to v5 with identical artifact/file
  hashes, equivalent ordered playback, equivalent audio placement, preserved
  current notebooks/prompts/messages, a verified legacy-history report and
  source-head link, and no v4 source mutation.
- Missing objects are reported before switch and never replaced with silent
  placeholders.
- Re-running after interruption completes without duplicate semantic rows.

### 15.5 Performance and quality

- Automated benchmark records model/manifest, device, corpus version, index
  time, peak RSS, coverage cadence, query latency, recall, and boundary error.
- A release candidate cannot activate if it misses application search-quality
  thresholds or regresses a query class by more than the permitted margin.

## 16. Cross-repository contract fixtures

The engine repository publishes JSON/TypeScript fixtures for:

- source points/ranges and rational time conversion;
- each P0 `EditOperation`;
- intent normalization, preview warnings/conflicts, diff hashes, and commit
  result;
- sequence with video/audio/caption tracks;
- transcript and transcript selection mapping;
- text, reverse-image, reverse-video, and reverse-audio queries;
- search pages, signal explanations, coverage, stale/partial states;
- jobs and progress/failure codes;
- schema-v4 migration dry-run/result.

The application consumes these fixtures in integration tests. Contract changes
require a version increment and coordinated PRD/issue review. Copying engine
types into application source is not an acceptable integration strategy.

## 17. Delivery gates

Beads is the implementation source of truth. These gates define dependency
order and exit criteria rather than a second issue tracker.

| Gate | Engine slice | Exit criteria |
| --- | --- | --- |
| E0 — Contract | Time, stream, transcript, sequence, search, intent, preview, and migration types | Public types and cross-repo fixtures compile; invariants and error codes are fixed |
| E1 — Semantic model | Schema v5 tables/APIs, sequence read/write-at-revision, transcript normalization, action integration | Real Dolt integration tests and rational-time properties pass |
| E2 — Edit transactions | P0 preview/commit/restore operations and conflict/write-set behavior | Atomicity, surface fixture parity, and forced-crash suite pass |
| E3 — Temporal index | Media segments, manifests, progressive batches, visual/text/audio/OCR indexes, hybrid search | Moment, language-to-visual, reverse-frame, and partial-coverage scenarios pass |
| E4 — Reverse video and quality | Ordered multi-vector candidate rerank, deduplication, explanations, quality harness | Frozen reverse-video and full search benchmark thresholds pass |
| E5 — Migration and hardening | v4 copy-forward migration, compatibility adapter, cleanup, performance, security | Representative migrations, NFRs, pack dry run, and consumer build pass |

The application’s G1 search UI can begin against E3. Application G3 unified
commands depends on E2. Creator beta requires E5.

## 18. Risks and mitigations

| Risk | Consequence | Mitigation |
| --- | --- | --- |
| Schema v5 becomes an entire professional NLE | Engine work blocks product indefinitely | Implement only P0 tracks/clips/transforms/dissolve/captions; reserve extensions without building them |
| Local visual model lacks language or action quality | Search misses the differentiating promise | Provider-neutral multi-vector contract, frozen benchmark, injected alternative providers, progressive model replacement |
| Reverse video explodes index size or query cost | Poor local performance | ANN candidate generation, bounded ranges, multi-stage rerank, quantization, overlap collapse, measured scale budgets |
| Runtime indexes drift from semantic sources | Stale or irreproducible results | Object-hash and manifest-qualified coverage, atomic generation activation, pinned hit snapshots |
| Corrected transcript and provider transcript conflict | Captions/search/edit disagree | One normalized current semantic transcript; raw provider response retained only as provenance artifact |
| Preview and commit disagree | Unsafe edits | Canonical normalization/hash and mandatory revalidation inside commit boundary |
| Migration corrupts existing books | Data loss | Copy-forward only, source read-only, preflight/dry run, post-verify, explicit switch |
| Cross-book requests leak into engine | Broken one-book isolation | Keep engine query book-scoped; application federation includes owning book identity |
| Model downloads undermine offline trust | Unexpected network/storage use | Explicit prepare, pinned manifests, `allowModelDownload=false`, readiness errors, application consent |

## 19. Definition of engine MVP complete

The engine MVP is complete when schema v5 can copy-forward a real schema-v4
book; normalize transcripts and rational media time; progressively index and
retrieve judged timecoded moments by language, image/frame, video range, audio
range, transcript, OCR, metadata, and duplicate evidence; preview and atomically
commit every P0 edit operation with conflict detection and forward restore;
survive forced termination across semantic and indexing boundaries; meet the
frozen quality/performance thresholds; publish cross-repository fixtures; and
pass typecheck, tests, build, and package dry run without requiring hosted AI
access.
