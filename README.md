# videobook-engine

`videobook-engine` is a local-first, Dolt-native storage engine for one
videobook per engine root. It keeps book state, artifacts, files, metadata,
notebook graphs, revisions, and action history in a single catalog.

This is the 2.0 breaking model: there is no project layer. A fresh engine root
creates one singleton Book; reopening that root always returns the same book.

## Quick start

```ts
import { createEngine } from "videobook-engine";

const engine = createEngine({
  rootDir: ".videobook",
  initialBookSlug: "my-story",
});

const book = engine.book.get();
// { bookId: "…", slug: "my-story" }

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
views, caches, settings, and logs) share the same database but are never
staged. Artifact identity is a UUIDv7; the active slug is its human-facing
name and can be reused after the prior artifact is deleted.

The current catalog format is schema version 3. It intentionally rejects older
catalog schemas rather than migrating them; create a fresh engine root for the
single-book model.

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
- `engine.metadata` — book metadata, artifact metadata, timelines, and audio
  waveforms
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
book snapshot forward: book metadata, active artifacts and files, entities,
notebooks, timelines, prompts, and messages. Runtime work is invalidated and
active jobs are aborted during a restore.

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

Image and video sources must be named `original.<extension>`. Text similarity
supports `original.md`, `original.txt`, and `original.json` for `script`,
`character`, `prompt`, `scene`, and `final` artifacts. All similarity queries
search the single book-wide pool while preserving media kind and embedding-space
boundaries.

## Backups

Configure `remoteObjects` to publish content-addressed objects and
`catalogBackup` to push the Dolt catalog. `engine.storage.backup()` publishes
objects first, then pushes the catalog, so a restored catalog never points to
objects that have not been uploaded.
