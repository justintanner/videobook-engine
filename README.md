# videobook-engine

A Dolt-native, local-first storage engine for Videobook projects, media,
notebooks, and runtime coordination.

## Storage model

Each engine instance owns one embedded database:

```text
dataDir/
  videobook.db          # Dolt catalog: semantic + runtime tables
  objects/sha256/       # immutable local CAS

workspaceDir/
  <project UUID>/
    <artifact UUID>/    # disposable materialized tool workspace
```

Semantic tables are selectively staged and committed to Dolt. Runtime tables
live in the same `videobook.db` but are never staged. There are no project Git
repositories, JSON sidecars, `state.sqlite`, `metadata.sqlite`, or
`runtime.sqlite` files.

Projects and artifacts have stable UUIDv7 identities. Slugs are active names:
deleting an artifact releases its slug immediately, and a replacement may use
that exact slug with a new UUID and an isolated workspace.

## Quick start

```ts
import { createEngine } from "videobook-engine";

const engine = createEngine({
  dataDir: "/srv/videobook/data",
  workspaceDir: "/srv/videobook/workspaces",
});
await engine.ready;

const project = await engine.projects.create("story");
if (!project.ok) throw new Error(project.error.message);

const video = await engine.artifacts.create({
  project: project.value.projectId,
  kind: "video",
  slug: "vid-cat",
});
if (!video.ok) throw new Error(video.error.message);

await engine.files.write(
  video.value.artifactId,
  "original.mp4",
  videoBytes,
  project.value.projectId,
);

await engine.artifacts.delete(
  video.value.artifactId,
  project.value.projectId,
);

const replacement = await engine.artifacts.create({
  project: project.value.projectId,
  kind: "video",
  slug: "vid-cat",
});

engine.close();
```

`replacement.value.artifactId` differs from the deleted artifact’s identity.
No files, jobs, leases, failures, or history leak across that reused slug.

## API

`createEngine()` returns a namespaced `Engine`. Await `engine.ready` during
application startup to finish recovery of any terminal runtime jobs:

- `projects` — create, list, get, switch, rename, and tombstone projects
- `artifacts` — lifecycle, stable-ID lookup, active-slug resolution and reuse
- `files` — CAS-backed reads/writes, explicit workspace ingest, historical reads
- `workspaces` — UUID workspace materialization and eviction
- `metadata` — project/artifact metadata, timelines, and waveforms
- `entities` and `notebooks` — normalized domain records
- `history` — Dolt revisions and forward-only artifact/project restores
- `jobs` — runtime queue, leases, pending providers, failures, and recovery
- `settings` — unversioned application/runtime state in the main Dolt database
- `prompts`, `messages`, and `logs` — semantic conversation data and runtime logs
- `resolver` and `status` — active artifact resolution and derived UI status
- `storage` — publish CAS objects, then push the Dolt catalog backup

All public domain mutations return a discriminated `Result`. Runtime queue and
lease primitives return direct values and use fencing where ownership matters.

## Backups

Configure `remoteObjects` with a `ContentStore` and `catalogBackup` with a Dolt
remote. `engine.storage.backup()` verifies and publishes every referenced CAS
object before it pushes `main`.

The engine does not pull a live catalog into an open database. Restore or
bootstrap a closed `videobook.db` snapshot into `dataDir` before opening the
engine. Configure the same `remoteObjects` store and missing CAS objects hydrate
on demand.

## Development

```bash
npm run typecheck
npm test
npm run build
npm run examples
```

Tests use real DoltLite databases and cover runtime/semantic separation,
concurrent slug claims, exact slug reuse, forward restores, terminal job audit,
interrupted-commit recovery, snapshot bootstrap, and object-before-catalog
backup ordering.
