# videobook-engine

`videobook-engine` is a local-first, Dolt-native storage engine for one
videobook per engine root. It keeps book state, artifacts, files, metadata,
notebook graphs, revisions, and action history in a single catalog.

The temporal search, sequence, and edit-engine requirements for the Videobook
MVP are in [docs/mvp-prd.md](docs/mvp-prd.md).

There is no project layer. A fresh engine root creates exactly one Book;
reopening that root always returns the same book.

## Quick start

```ts
import { createEngine } from "videobook-engine";

const engine = createEngine({
  rootDir: ".videobook",
  initialBookName: "My Story",
});

const book = engine.book.get();
// { bookId: "…", name: "My Story", createdAt: … }

const script = await engine.artifacts.create({
  kind: "script",
  label: "opening draft",
});
if (!script.ok) throw new Error(script.error.message);

const written = await engine.files.write(
  script.value.artifactId,
  "original.md",
  "# Opening\n\nA small cat waits by the window.",
);
if (!written.ok) throw new Error(written.error.message);

const history = engine.history.artifact(script.value.artifactId);
engine.close();
```

`initialBookName` is required only when `data/videobook.db` does not exist yet. On
later opens it is optional and never changes the stored book. Rename the book
explicitly with `await engine.book.rename("new-name")`.

`npm run test:package` packs the engine, installs it in a clean temporary
project, executes this quick start from the installed README, and verifies
that reopening the catalog preserves the book and artifact.

The package bundles its pinned Transformers.js runtime and uses one external
Sharp 0.35.4 image decoder with native ONNX dependencies. This avoids shipping
Transformers' older Sharp dependency or requiring consumer overrides. Build
provenance and third-party licenses are included under `dist/third-party/`.
The package smoke checks both resolution paths, `npm ls sharp`, image
decoding, duplicate native-library warnings, and the runtime dependency audit.
Run `VIDEOBOOK_RUN_MODEL_E2E=1 npm run test:package` with the pinned models
cached locally to verify packaged CLIP and CLAP inference with downloads
disabled. ONNX dependencies are external imports in the generated runtime,
so the source-only dependency lint excludes them from unused-dependency checks.

## MVP contracts

Contract version 1, introduced with schema v5 and carried by the current
schema v24 catalog, defines the media-time, stream, transcript, sequence,
temporal-search, edit-intent, job, and copy-forward migration boundary:

```ts
import {
  MVP_CONTRACT_VERSION,
  MVP_CONTRACT_FIXTURES,
  type EditIntent,
  type SearchPage,
  type Sequence,
  type SourceRange,
} from "videobook-engine";
```

The typed fixtures cover every P0 edit operation and the main cross-repository
projections. The equivalent checked-in JSON fixture is exported as
`videobook-engine/fixtures/v5`. Contract objects use rational, half-open media
ranges and immutable object-hash-qualified stream references. The legacy
schema-v4 timeline compiles into the sequences model at import; the schema-v4
similarity API remains a compatibility surface until it compiles into
temporal-search semantics.

See [schema-v4 migration](docs/v4-migration.md) for dry-run checks, media
conversion, cancellation, retry, and application switching requirements.

## Storage model

Each engine root owns exactly one book:

```text
rootDir/
  data/
    videobook.db       # Dolt semantic catalog and SQLite runtime state
    objects/sha256/    # content-addressed file objects
  workspaces/
    <artifact UUID>/   # disposable materialized artifact files
```

Semantic tables are committed as Dolt revisions. Runtime tables (jobs, leases,
views, caches, settings, and logs) share the same database, match the
versioned `runtime_%` ignore policy, and are never staged. Semantic surrogate
identities are UUIDv7 values. Artifact labels are free-text display names and can be
reused after hard deletion; immutable CAS objects remain available to history.

The current catalog format is schema version 24. Valid schema version 22 and 23
catalogs upgrade in place. Catalogs with cells outside the fixed 64-by-8
notebook grid are rejected, and other catalog versions require an explicit migration
or a fresh engine root.

The 33 versioned semantic tables are `engine_schema`, `book`, `artifacts`,
`objects`, `artifact_files`, `artifact_streams`, `book_metadata`,
`artifact_metadata`, `entities`, `notebooks`, `notebook_fields`, `cells`,
`notebook_cell_executions`, `notebook_generation_plans`,
`notebook_run_plans`, `edges`, `runs`, `cell_references`,
`pinned_search_results`, `transcripts`, `transcript_segments`,
`transcript_words`, `sequences`, `sequence_tracks`, `sequence_clips`,
`clip_links`, `clip_transforms`, `transitions`, `caption_cues`,
`audio_waveforms`, `prompt_entries`, `messages`, and `generations`. Dolt's versioned
`dolt_ignore` configuration table carries the local-table policy. Provenance
is the commit log itself: every semantic commit carries its operation,
parameters, and write set in a structured commit message, authored by the
configured engine identity.

The 23 local-only tables are `runtime_meta`, `runtime_jobs`, `job_runs`,
`runtime_resource_leases`, `runtime_object_publications`,
`runtime_workspace_entries`, `runtime_artifact_views`,
`runtime_pending_tasks`, `runtime_generation_errors`, `runtime_settings`,
`runtime_logs`, `runtime_commit_outbox`, `runtime_index_manifests`,
`runtime_index_generations`, `runtime_index_coverage`,
`runtime_media_segments`, `runtime_segment_text`,
`runtime_segment_embeddings`, `runtime_segment_fingerprints`,
`runtime_index_batches`, `runtime_similarity_embeddings`,
`runtime_text_similarity_documents`, and `runtime_text_similarity_chunks`.

See [the complete engine layout](docs/engine-layout.md) for every schema
column, relationship, index, runtime/CAS structure, current editing contract,
and the additional normalized structures a full non-linear editor will need.

## Artifacts, labels, and identity

Artifacts are identified by `artifact_id` (UUIDv7) — the only reference
handle. An optional free-text `label` exists purely for display: it is
non-unique, never parsed, and never used to look anything up. Media content
is addressed by `object_hash` in the CAS.

## API surface

- `engine.book` — `get()` and `rename(name)` for the singleton book
- `engine.artifacts` — create, list, get, rename (relabel), and delete
- `engine.files` and `engine.workspaces` — immutable object-backed files and
  disposable materialization
- `engine.metadata` — book metadata, artifact metadata, and audio waveforms
- `engine.sequences` and `engine.edits` — the sequence/track/clip timeline
  model and its transactional edit operations
- `engine.entities` and `engine.notebooks` — normalized characters, prompts,
  scenes, and notebook graph documents
- `engine.prompts` and `engine.messages` — semantic prompt and message history
- `engine.history` — revision listings, per-artifact history, and forward
  restores derived from the Dolt commit log
- `engine.jobs`, `engine.status`, `engine.settings`, and `engine.logs` —
  runtime coordination
- `engine.storage` — object publication and catalog backup
- `engine.similarity` — optional local media and text similarity

All APIs operate in the engine's one book. No method accepts or returns a
project ID.

### Full API benchmark

For the separate 100,000-moment temporal search workload, run
`npm run benchmark:temporal -- --output /tmp/temporal-search.json --assert`.
See [the measurement method and initial baseline](docs/temporal-search-performance.md)
for workload limits, fixture reuse, and the outstanding latency gate.

The deterministic benchmark exercises every top-level `Engine` API group,
reports latency distributions per operation, and identifies the smallest set
of operations responsible for at least 80% of measured time:

```bash
npm run benchmark:api
npm run benchmark:api -- --json --output /tmp/videobook-api-benchmark.json
npm run benchmark:api:smoke
```

The default workload creates 40 artifacts, indexes 2,000 temporal moments, and
repeats the read paths 100 times. Use `--artifacts`, `--moments`, and `--reads`
to select a different workload; use `--retain-fixture` to keep the generated
engine root for inspection.

Deleting an artifact or entity that is referenced by a live cell or clip
returns `IN_USE` with `details.references`. Deleting a notebook cascades
its owned cells, edges, and terminal runs. There are no tombstone rows.

## Revisions and restores

Every semantic mutation creates a Dolt revision. Use a revision hash (or an
unambiguous prefix) to inspect or restore state:

```ts
const revisions = engine.history.revisions();

await engine.history.restoreArtifact(artifactId, revisions[0]!.hash);

await engine.history.restore(revisions[0]!.hash);
```

`restoreArtifact` keeps the artifact UUID stable and restores its files,
metadata, and waveform as a new forward revision. `restore` mechanically
reloads every semantic table from its `dolt_at_*` projection at the target
revision — book metadata, artifacts and files, entities, notebooks, sequences,
prompts, messages, and the rest — so the restored state is exactly the state
that revision recorded. Runtime work is invalidated and active jobs are
aborted during a restore.

## Future forks

Schema v18 adds independently mergeable notebook workflow rows while retaining
the stable identities and normalized boundaries introduced in v17. A fork is a
separate catalog copy in another namespace,
keeps the same `bookId`, and can open a pull request against the upstream
`main` branch. User, origin, fork, and pull-request APIs are intentionally not
part of this release; an open engine still accepts only its local `main`
branch. Because provenance lives in authored Dolt commits rather than
engine-owned meta-history tables, merging a fork never requires merging a
parallel audit graph.

## Similarity

Custom remote similarity models require a full commit SHA in `modelRevision`; their vectors are isolated by repository and revision. Built-in defaults keep their existing pins. Older compatibility image/video vector caches require reindexing because they cannot distinguish custom models from the default; temporal indexes retain their identities. See [model revisions](docs/model-revisions.md) for custom configuration, offline reuse, and local directories.

Injected providers must explicitly declare network capabilities; remote access requires application-owned consent. See [search provider consent](docs/search-provider-consent.md) for registration, revocation, and the migration for existing custom providers.

Similarity is opt-in. Provide a media embedding provider or use the built-in
local CLIP configuration. Text similarity is enabled separately.

Local model loaders, including temporal CLIP/CLAP providers, use cached files by default. Downloads require `allowModelDownload: true` during an explicit preparation step. Missing cached models return `OFFLINE`; after preparing the models, reopen providers with downloads disabled or omitted for offline use. Built-in model revisions remain pinned during file discovery and loading.

Model files are checksum-verified before inference, including cached files and external ONNX weights. Corrupted files fail with `MODEL_UNAVAILABLE`. Built-in caches can be verified offline; custom remote-model caches without integrity metadata require explicit preparation. See [model integrity](docs/model-integrity.md) for verification, cache repair, and supported upstream metadata.

```ts
const engine = createEngine({
  rootDir: ".videobook",
  initialBookName: "Reference Library",
  similarity: {
    audio: {},
    text: {},
  },
});

await engine.similarity.index(imageArtifactId);
await engine.similarity.index(similarImageArtifactId);

const matches = await engine.similarity.findSimilar(imageArtifactId, {
  limit: 10,
  minScore: 0.7,
});
```

Image, video, and audio sources must be named `original.<extension>`. Audio
similarity is opt-in through `similarity.audio` and uses local CLAP embeddings
without Python. Supported audio extensions are MP3, WAV, OGG, FLAC, AAC, and
M4A. Text similarity supports `original.md`, `original.txt`, and
`original.json` for `script`, `character`, `prompt`, `scene`, and `final`
artifacts. All similarity queries search the single book-wide pool while
preserving media kind and embedding-space boundaries.

## Backups

Configure `remoteObjects` to publish content-addressed objects and
`catalogBackup` to push the Dolt catalog. `engine.storage.backup()` publishes
objects first, then pushes the catalog, so a restored catalog never points to
objects that have not been uploaded.

Missing local objects are downloaded through `ContentStore.downloadFile` into
unique temporary files. The engine streams a SHA-256 check before publishing the
requested object path or materializing it into a workspace. A mismatch returns
`OBJECT_UNAVAILABLE` with `details.reason = "checksum_mismatch"`; failed staging
files are removed and a later valid download can be retried. A concurrent forget
prevents the downloaded bytes from being published. This check applies to new
remote downloads; it does not rehash every existing local object on every read.
