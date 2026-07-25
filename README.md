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
  initialBookSlug: "my-story",
});

const book = engine.book.get();
// { bookId: "…", slug: "my-story", createdAt: … }

const script = await engine.artifacts.create({
  kind: "script",
  name: "opening draft",
});
if (!script.ok) throw new Error(script.error.message);

await engine.files.write(
  script.value.artifactId,
  "original.md",
  "# Opening\n\nA small cat waits by the window.",
);

const history = engine.history.artifact(script.value.artifactId);
engine.close();
```

`initialBookSlug` is required only when `videobook.db` does not exist yet. On
later opens it is optional and never changes the stored book. Rename the book
explicitly with `await engine.book.rename("new-name")`.

## MVP v5 contracts

Contract version 1 defines the schema-v5 media-time, stream, transcript,
sequence, temporal-search, edit-intent, job, and copy-forward migration
boundary before the schema implementation lands:

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
ranges and immutable object-hash-qualified stream references. The existing
schema-v4 timeline and similarity APIs remain compatibility surfaces until
they compile into schema-v5 sequence and temporal-search semantics.

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
identities are UUIDv7 values. Artifact slugs are human-facing names and can be
reused after hard deletion; immutable CAS objects remain available to history.

The current catalog format is schema version 4. It intentionally rejects v3
and older catalogs rather than migrating them; create a fresh engine root.

The 25 versioned semantic tables are `engine_schema`, `book`, `artifacts`,
`objects`, `artifact_files`, `book_metadata`, `artifact_metadata`,
`entities`, `notebooks`, `cells`, `edges`, `runs`, `timeline`,
`timeline_slots`, `timeline_audio`, `audio_waveforms`, `prompt_entries`,
`messages`, `operations`, `actions`, `action_events`, `action_parents`,
`action_artifacts`, `action_write_set`, and `job_runs`. Dolt's versioned
`dolt_ignore` configuration table carries the local-table policy.

The 14 local-only tables are `runtime_meta`, `runtime_jobs`,
`runtime_resource_leases`, `runtime_object_publications`,
`runtime_workspace_entries`, `runtime_artifact_views`,
`runtime_pending_tasks`, `runtime_generation_errors`, `runtime_settings`,
`runtime_logs`, `runtime_commit_outbox`, `runtime_similarity_embeddings`,
`runtime_text_similarity_documents`, and `runtime_text_similarity_chunks`.

See [the complete engine layout](docs/engine-layout.md) for every schema
column, relationship, index, runtime/CAS structure, current editing contract,
and the additional normalized structures a full non-linear editor will need.

## Artifacts and slugs

Artifact slugs are canonical and kind-prefixed. Supplying a `name` derives a
slug; supplying a `slug` validates it. Repeated name-based creation adds a
numeric suffix when needed.

| Kind | Prefix | Example |
| --- | --- | --- |
| `video` | `vid-` | `vid-opening-shot` |
| `image` | `img-` | `img-cat-portrait` |
| `audio` | `aud-` | `aud-ambient-bed` |
| `script` | `script-` | `script-opening-draft` |
| `character` | `char-` | `char-protagonist` |
| `prompt` | `prompt-` | `prompt-sunrise` |
| `scene` | `scene-` | `scene-rooftop` |
| `final` | `final` | `final` |

There is no `notebook` artifact kind or `book-` artifact prefix. Notebook
graphs remain available separately through `engine.notebooks`.

## API surface

- `engine.book` — `get()` and `rename(slug)` for the singleton book
- `engine.artifacts` — create, list, get, rename, delete, and resolve slugs
- `engine.files` and `engine.workspaces` — immutable object-backed files and
  disposable materialization
- `engine.metadata` — book metadata, artifact metadata, and audio waveforms
- `engine.timeline` — typed timeline reads, revision reads, replacement, and
  reset
- `engine.entities` and `engine.notebooks` — normalized characters, prompts,
  scenes, and notebook graph documents
- `engine.prompts` and `engine.messages` — semantic prompt and message history
- `engine.history` — revisions, generic action graph entries, and forward
  restores
- `engine.jobs`, `engine.status`, `engine.settings`, and `engine.logs` —
  runtime coordination
- `engine.storage` — object publication and catalog backup
- `engine.similarity` — optional local media and text similarity

All APIs operate in the engine's one book. No method accepts or returns a
project ID.

Deleting an artifact or entity that is referenced by a live cell or timeline
row returns `IN_USE` with `details.references`. Deleting a notebook cascades
its owned cells, edges, and terminal runs. There are no tombstone rows.

## Revisions and restores

Every semantic mutation creates a Dolt revision. Use a revision hash (or an
unambiguous prefix) to inspect or restore state:

```ts
const revisions = engine.history.revisions();

await engine.history.restoreArtifact(
  artifactId,
  revisions[0]!.hash,
  "script-restored-draft", // optional replacement slug
);

await engine.history.restore(revisions[0]!.hash);
```

`restoreArtifact` keeps the artifact UUID stable and restores its files,
metadata, and waveform as a new forward revision. `restore` replays the whole
book snapshot forward: book metadata, artifacts and files, entities,
notebooks, timeline, prompts, and messages. Runtime work is invalidated and
active jobs are aborted during a restore.

## Future forks

Schema v4 prepares stable row identities and normalized merge boundaries for
DoltHub-native forks. A fork is a separate catalog copy in another namespace,
keeps the same `bookId`, and can open a pull request against the upstream
`main` branch. User, origin, fork, and pull-request APIs are intentionally not
part of this release; an open engine still accepts only its local `main`
branch.

Generic action records are available for higher-level workflows:

```ts
const action = await engine.history.recordAction({
  operation: "generate_image",
  scope: "artifact",
  targetArtifactId: imageId,
  inputArtifactIds: [promptId],
  outputArtifactIds: [imageId],
  writeSet: [`artifact:${imageId}`],
});

const page = engine.history.actions({ limit: 50 });
```

## Similarity

Similarity is opt-in. Provide a media embedding provider or use the built-in
local CLIP configuration. Text similarity is enabled separately.

```ts
const engine = createEngine({
  rootDir: ".videobook",
  initialBookSlug: "reference-library",
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
