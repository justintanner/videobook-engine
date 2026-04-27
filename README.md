# clipfirst-fs

[![CI](https://github.com/justintanner/clipfirst-fs/actions/workflows/ci.yml/badge.svg)](https://github.com/justintanner/clipfirst-fs/actions/workflows/ci.yml)
[![Node.js](https://img.shields.io/badge/node-%3E%3D20-brightgreen)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.5-blue)](https://www.typescriptlang.org)

TypeScript/Node.js filesystem abstraction for managing video, image, audio, script, and character asset projects. Each project is a git repo with a sidecar `.clipfirst/` directory holding two SQLite databases: `state.sqlite` for ephemeral coordination (locks, job queue, recovery journal) and `metadata.sqlite` for content metadata (timeline, characters, asset metadata, audio waveforms). Every mutation produces an atomic git commit; metadata changes are mirrored to canonical JSON exports under `.clipfirst/export/` so git stays diffable.

## Install

```bash
npm install clipfirst-fs
```

## Quick Start

```typescript
import { createFs } from 'clipfirst-fs';

const fs = createFs({ projectsDir: '/path/to/projects' });

// Create a project (auto-generated slug)
const project = await fs.createProject();
if (!project.ok) {
  console.error(project.error.code, project.error.message);
  process.exit(1);
}
const slug = project.value.slug; // "bright-falcon-42"

// Create a video asset inside the project
const asset = await fs.createAsset('vid', 'intro-clip', slug);
if (asset.ok) {
  console.log(asset.value.assetId); // "vid-intro-clip"
}

// Write and read files (each write is an atomic git commit)
await fs.writeFile('vid-intro-clip', 'thumbnail.png', imageBuffer, slug);
const file = await fs.readFile('vid-intro-clip', 'thumbnail.png', slug);
if (file.ok) {
  console.log(file.value.length);
}
```

## Result Pattern

All mutating methods return `Result<T, FsError>` instead of throwing exceptions:

```typescript
type Result<T, E> = { ok: true; value: T } | { ok: false; error: E };

interface FsError {
  code: FsErrorCode;
  message: string;
}
```

**Error codes:** `NOT_FOUND` | `ALREADY_EXISTS` | `GIT_ERROR` | `INVALID_INPUT` | `IO_ERROR` | `LOCKED`

## Asset prefixes

Assets live as prefixed directories at the project root. Valid prefixes:

| Prefix | Type |
|--------|------|
| `vid-` | video |
| `img-` | image |
| `aud-` | audio |
| `script-` | script |
| `char-` | character |

The asset id `final` is reserved as a project-level singleton.

## API

All methods are available on the object returned by `createFs(config)`. Unless noted otherwise, every method that takes a `projectSlug` requires a project that already exists.

### Project

| Method | Return Type |
|--------|------------|
| `createProject(slug?)` | `Promise<Result<{ slug, path, is_default }, FsError>>` |
| `listProjects(options?)` | `Promise<ProjectMetadata[]>` |
| `getProject(slug?)` | `Promise<Result<{ metadata, path }, FsError>>` |
| `switchProject(slug)` | `Promise<Result<string, FsError>>` |
| `renameProject(oldSlug, newSlug)` | `Promise<Result<{ oldSlug, newSlug, path }, FsError>>` |
| `resolveProjectDir(slug?)` | `Promise<string \| null>` |

### Asset

| Method | Return Type |
|--------|------------|
| `createAsset(prefix, name, projectSlug)` | `Promise<Result<{ assetId, path }, FsError>>` |
| `listAssets(projectSlug, options?)` | `Promise<AssetEntry[]>` |
| `deleteAsset(assetId, projectSlug)` | `Promise<Result<{ deleted_at }, FsError>>` |
| `renameAsset(assetId, newName, projectSlug)` | `Promise<Result<{ old_asset_id, new_asset_id }, FsError>>` |
| `getManifest(assetId, projectSlug, options?)` | `Promise<Result<AssetManifest, FsError>>` |
| `listAssetSubdir(assetId, subdirName, projectSlug)` | `Promise<Result<string[], FsError>>` |
| `slugTaken(slug, projectSlug)` | `Promise<boolean>` |

### File

| Method | Return Type |
|--------|------------|
| `writeFile(assetId, filename, data, projectSlug)` | `Promise<Result<string, FsError>>` |
| `readFile(assetId, filename, projectSlug)` | `Promise<Result<Buffer, FsError>>` |
| `deleteFile(assetId, filename, projectSlug)` | `Promise<Result<string, FsError>>` |
| `renameFile(assetId, oldFilename, newFilename, projectSlug)` | `Promise<Result<{ oldPath, newPath }, FsError>>` |
| `copyFile(assetId, filename, destAssetId, destFilename, projectSlug)` | `Promise<Result<string, FsError>>` |
| `resolveAssetDir(assetId, projectSlug)` | `Promise<Result<string, FsError>>` |

### Metadata

`writeMetadata(assetId, 'character', record, ...)` is special-cased: the record is stored in the typed `characters` table in `metadata.sqlite`. Other keys are stored in the generic `asset_metadata` table. In both cases a `.{key}.json` sidecar is also written next to the asset and the operation produces a single git commit covering the SQLite file, the canonical export, and the sidecar.

| Method | Return Type |
|--------|------------|
| `writeMetadata(assetId, key, data, projectSlug)` | `Promise<Result<string, FsError>>` |
| `readMetadata<T>(assetId, key, projectSlug)` | `Promise<Result<T, FsError>>` |
| `writeAudioWaveform(assetId, peaks, projectSlug)` | `Promise<Result<string, FsError>>` |
| `readAudioWaveform(assetId, projectSlug)` | `Promise<Result<AudioWaveformRecord, FsError>>` |
| `writeProjectMeta(key, data, projectSlug)` | `Promise<Result<string, FsError>>` |
| `readProjectMeta<T>(key, projectSlug)` | `Promise<Result<T, FsError>>` |

### Git

| Method | Return Type |
|--------|------------|
| `commitOperation(operation, assetId?, details?, projectSlug)` | `Promise<string \| null>` |
| `getHistory(projectSlug, limit?)` | `Promise<GitCommit[]>` |
| `getAssetHistory(assetId, projectSlug, limit?)` | `Promise<GitCommit[]>` |
| `restoreAsset(assetId, commitHash, projectSlug)` | `Promise<string \| null>` |
| `readFileAtCommit(assetId, filename, commitHash, projectSlug)` | `Promise<Result<string, FsError>>` |
| `rewindProject(commitHash, projectSlug)` | `Promise<string \| null>` |

### Lock

Locks are SQLite rows in `state.sqlite`, one per asset directory (or one project-level lock keyed by `__PROJECT__`). The `assetDir` argument is an absolute filesystem path; the lock module resolves it back to `(projectDir, assetKey)`.

| Method | Return Type |
|--------|------------|
| `acquireLock(assetDir, options)` | `Promise<Result<LockData, FsError>>` |
| `releaseLock(assetDir)` | `Promise<Result<boolean, FsError>>` |
| `isLocked(assetDir)` | `Promise<boolean>` |
| `getLockData(assetDir)` | `Promise<LockData \| null>` |
| `cleanStaleLock(assetDir)` | `Promise<boolean>` |

`LockOptions` is `{ durationMs, data?, state? }`. `acquireLock` returns `LOCKED` if a non-expired lock is already held; expired or dead-pid locks are reaped automatically on the next acquire (or explicitly via `cleanStaleLock`).

### Action log

Append-only audit trail backed by git commits with structured payloads.

| Method | Return Type |
|--------|------------|
| `logAction(action, payload, projectSlug)` | `Promise<Result<ActionLogEntry, FsError>>` |
| `getActionLog(options?, projectSlug)` | `Promise<ActionLogEntry[]>` |

### Generic JSONL log

Per-project append-only logs under `logs/{name}.jsonl`. Not committed to git.

| Method | Return Type |
|--------|------------|
| `appendLog(name, line, projectSlug)` | `Promise<Result<string, FsError>>` |
| `readLog(name, projectSlug, options?)` | `Promise<Record<string, unknown>[]>` |

### Queue

A persistent job queue lives in `state.sqlite` (`pending_jobs`). Jobs are dedupe-keyed, support external task ids, and are leased with heartbeats so a `QueueRunner` can be coordinated across multiple processes. `fs.queue` exposes the project-scoped surface; the standalone `queueApi` and `QueueRunner` are also exported for callers that want the raw `Database` handle.

```typescript
const enq = await fs.queue.enqueue(slug, {
  type: 'transcode',
  assetId: 'vid-intro-clip',
  payload: { preset: '1080p' },
});

const result = await fs.queue.enqueueAndWait<RenderResult>(slug, {
  type: 'render',
  payload: { orientation: 'portrait' },
});
```

### Lifecycle

| Method | Return Type |
|--------|------------|
| `ensureClipfirstSetup(slug)` | `Promise<void>` — idempotently bootstrap `.clipfirst/` for a legacy project |
| `recoverIncompleteOperations(slug)` | `Promise<number>` — drain the recovery journal at startup |
| `checkSchemaVersion(slug)` | `Promise<VersionCheckResult>` — refuse to open a project written by a newer build |
| `close()` | `void` — close all SQLite handles before process exit |

## Atomic operations & recovery

Every metadata write follows the same shape:

1. Acquire the per-project git mutex (`proper-lockfile` on `.clipfirst/.project.lock`).
2. Open a `recovery_journal` row, run the SQLite work in a transaction, and rebuild the affected canonical JSON exports under `.clipfirst/export/`.
3. Stage the SQLite file, exports, and any sidecars in a single `git commit` whose body includes `op-id: <uuid>`.
4. Mark the journal row complete.

If the process dies mid-operation, `recoverIncompleteOperations()` replays the journal at startup: it re-derives the exports from `metadata.sqlite`, writes any missing sidecars, and produces a fresh `recover` commit. Sentinel `op-id` lookups in `git log` ensure idempotency. Schema migrations are checksummed in `schema_migrations`; mismatches are fatal.

## Configuration

```typescript
interface FsConfig {
  projectsDir: string;  // Root directory for all projects
  gitPath?: string;     // Custom git binary path (default: "git")
}
```

## Development

```bash
npm run build        # Compile TypeScript
npm run typecheck    # Type-check without emitting
npm test             # Run tests
npm run test:watch   # Run tests in watch mode
npm run bench        # Run vitest benches
```

## Requirements

- Node.js >= 20
- Git
