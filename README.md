# clipfirst-fs

[![CI](https://github.com/justintanner/clipfirst-fs/actions/workflows/ci.yml/badge.svg)](https://github.com/justintanner/clipfirst-fs/actions/workflows/ci.yml)
[![Node.js](https://img.shields.io/badge/node-%3E%3D20-brightgreen)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.5-blue)](https://www.typescriptlang.org)

TypeScript/Node.js filesystem abstraction for managing video and image asset projects. Provides structured project/asset lifecycles with integrated Git version control and distributed file locking. Every mutation produces an atomic git commit.

## Install

```bash
npm install clipfirst-fs
```

## Quick Start

```typescript
import { createFs } from 'clipfirst-fs';

const fs = createFs({ outputDir: '/path/to/projects' });

// Create a project
const project = await fs.createProject();
if (!project.ok) {
  console.error(project.error.code, project.error.message);
  process.exit(1);
}
console.log(project.value.slug); // "bright-falcon-42"

// Create a video asset
const asset = await fs.createAsset('vid', 'intro-clip');
if (asset.ok) {
  console.log(asset.value.assetId); // "vid-intro-clip"
}

// Write and read files (each write is an atomic git commit)
await fs.writeFile('vid-intro-clip', 'thumbnail.png', imageBuffer);
const file = await fs.readFile('vid-intro-clip', 'thumbnail.png');
if (file.ok) {
  console.log(file.value.length); // Buffer length
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

**Error codes:** `NOT_FOUND` | `ALREADY_EXISTS` | `LOCK_HELD` | `LOCK_NOT_FOUND` | `GIT_ERROR` | `INVALID_INPUT` | `IO_ERROR` | `LOCKED`

## API

All methods are available on the object returned by `createFs(config)`.

### Project

| Method | Return Type |
|--------|------------|
| `createProject(slug?)` | `Promise<Result<{ slug, path, is_default }, FsError>>` |
| `listProjects()` | `Promise<ProjectMetadata[]>` |
| `getProject(slug?)` | `Promise<Result<{ metadata, path }, FsError>>` |
| `switchProject(slug)` | `Promise<Result<string, FsError>>` |

### Asset

| Method | Return Type |
|--------|------------|
| `createAsset(prefix, name, projectSlug?)` | `Promise<Result<{ assetId, path }, FsError>>` |
| `listAssets(projectSlug?)` | `Promise<AssetEntry[]>` |
| `deleteAsset(assetId, projectSlug?)` | `Promise<Result<{ deleted_at }, FsError>>` |
| `renameAsset(assetId, newName, projectSlug?)` | `Promise<Result<{ old_asset_id, new_asset_id }, FsError>>` |
| `getManifest(assetId, projectSlug?)` | `Promise<Result<AssetManifest, FsError>>` |

### File

| Method | Return Type |
|--------|------------|
| `writeFile(assetId, filename, data, projectSlug?)` | `Promise<Result<string, FsError>>` |
| `readFile(assetId, filename, projectSlug?)` | `Promise<Result<Buffer, FsError>>` |
| `writeMetadata(assetId, metadata, projectSlug?)` | `Promise<Result<OriginalMetadata, FsError>>` |
| `readMetadata(assetId, projectSlug?)` | `Promise<Result<OriginalMetadata, FsError>>` |

### Git

| Method | Return Type |
|--------|------------|
| `commitOperation(operation, assetId?, details?, projectSlug?)` | `Promise<string \| null>` |
| `getHistory(projectSlug?, limit?)` | `Promise<GitCommit[]>` |
| `getAssetHistory(assetId, projectSlug?, limit?)` | `Promise<GitCommit[]>` |
| `restoreAsset(assetId, commitHash, projectSlug?)` | `Promise<string \| null>` |

### Lock

| Method | Return Type |
|--------|------------|
| `acquireLock(assetDir, lockName, data?)` | `Promise<Result<LockData, FsError>>` |
| `releaseLock(assetDir, lockName)` | `Promise<Result<boolean, FsError>>` |
| `isLocked(assetDir, lockName)` | `Promise<boolean>` |
| `getLockData(assetDir, lockName)` | `Promise<LockData \| null>` |
| `cleanStaleLocks(assetDir)` | `Promise<string[]>` |

### Configuration

```typescript
interface FsConfig {
  outputDir: string;  // Root directory for all projects
  gitPath?: string;   // Custom git binary path (default: "git")
}
```

## Development

```bash
npm run build        # Compile TypeScript
npm run typecheck    # Type-check without emitting
npm test             # Run tests
npm run test:watch   # Run tests in watch mode
```

## Requirements

- Node.js >= 20
- Git
