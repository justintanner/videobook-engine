# videobook-engine

DoltLite-backed local storage for multimodal notebooks, prompts, characters, scenes, images, video, and audio.

## Install

```bash
npm install videobook-engine
```

## Storage model

- `dataDir/videobook.db` is the versioned DoltLite catalog.
- `dataDir/objects/sha256/` is the immutable local content-addressed cache.
- `projectsDir/<project>/` contains materialized workspaces for media tools.
- `.videocity/state.sqlite` remains runtime-only queue, lease, lock, and recovery state.
- An optional `ContentStore` publishes immutable objects to B2 or another remote object store.

`projectsDir` and `dataDir` must not overlap. Existing Git repositories are not imported. Every restore and project rewind is forward-only: historical content is restored into the workspace and recorded as a new revision.

## Quick start

```typescript
import { createFs } from "videobook-engine";

const fs = createFs({
  projectsDir: "/srv/videobook/projects",
  dataDir: "/srv/videobook/data",
});

await fs.createProject("story");
const notebook = await fs.createNotebook("Scratch", "story");
const character = await fs.createEntity(
  "character",
  "Pilot",
  "story",
  { prompt: "A calm pilot in a silver flight suit" },
);

if (notebook.ok && character.ok) {
  notebook.value.cells.push({
    id: "cell-pilot",
    type: "character",
    title: "Pilot",
    position: { x: 120, y: 80 },
    entityId: character.value.id,
  });
  await fs.writeNotebook(notebook.value, "story");
}

console.log(await fs.getProjectHistory("story"));
fs.close();
```

## Core APIs

Project and asset compatibility:

- `createProject`, `listProjects`, `getProject`, `renameProject`, `deleteProject`
- `createAsset`, `listAssets`, `renameAsset`, `deleteAsset`
- `writeFile`, `readFile`, `copyFile`, `renameFile`, `deleteFile`
- `writeMetadata`, `readMetadata`, `writeProjectMeta`, `readProjectMeta`

Revision-native storage:

- `runOperation`
- `importFile`
- `getProjectHistory`
- `resolveRevision`
- `readFileAtRevision`
- `restoreAsset`
- `rewindProject`
- `getStorageStatus`
- `sync`

Notebook-native data:

- `createNotebook`, `listNotebooks`, `readNotebook`, `writeNotebook`, `deleteNotebook`
- `recordNotebookRun`
- `createEntity`, `listEntities`, `readEntity`, `writeEntity`, `deleteEntity`

The legacy `getHistory`, `readFileAtCommit`, and `GitCommit` names remain aliases so fork-time Videocity callers can move without a flag day. They operate on DoltLite revisions and never execute Git.

## Content store

```typescript
interface ContentStore {
  head(key: string): Promise<{ exists: boolean; size?: number }>;
  uploadFile(key: string, sourcePath: string): Promise<void>;
  downloadFile(key: string, destinationPath: string): Promise<void>;
}
```

Objects are addressed as:

```text
superlzy-media/videobook/sha256/<first-two-hash-chars>/<sha256>
```

A catalog revision can be created offline. `getStorageStatus()` reports `ahead` until every referenced object has been uploaded and verified.

## Development

```bash
npm run typecheck
npm test
npm run build
```

Integration tests use real DoltLite databases and verify exact-byte historical reads, forward restore, project-isolated rewind, object publication and hydration, notebook/entity revisions, and path isolation.
