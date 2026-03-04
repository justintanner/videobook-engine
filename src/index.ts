import type {
  FsConfig,
  FsError,
  AssetEntry,
  AssetManifest,
  ProjectMetadata,
  GitCommit,
  LockData,
  OriginalMetadata,
  ToolParams,
} from './types.js';
import type { Result } from './result.js';

import { createProject } from './project/create.js';
import { listProjects } from './project/list.js';
import { getProject, resolveProjectDir } from './project/get.js';
import { switchProject } from './project/switch.js';

import { createAsset } from './asset/create.js';
import { listAssets } from './asset/list.js';
import { deleteAsset } from './asset/delete.js';
import { renameAsset } from './asset/rename.js';
import { getManifest } from './asset/manifest.js';

import { writeFile } from './file/write.js';
import { readFile } from './file/read.js';
import { writeMetadata, readMetadata } from './file/metadata.js';

import { commitOperation } from './git/commit.js';
import { getHistory, getAssetHistory } from './git/history.js';
import { restoreAsset } from './git/restore.js';

import { acquireLock } from './lock/acquire.js';
import { releaseLock } from './lock/release.js';
import { isLocked, getLockData } from './lock/query.js';
import { cleanStaleLocks } from './lock/orphan.js';

import { ok, err } from './result.js';

export interface ClipfirstFs {
  // Project
  createProject(slug?: string): Promise<Result<{ slug: string; path: string; is_default: boolean }, FsError>>;
  listProjects(): Promise<ProjectMetadata[]>;
  getProject(slug?: string): Promise<Result<{ metadata: ProjectMetadata; path: string }, FsError>>;
  switchProject(slug: string): Promise<Result<string, FsError>>;

  // Asset
  createAsset(prefix: string, name: string, projectSlug?: string): Promise<Result<{ assetId: string; path: string }, FsError>>;
  listAssets(projectSlug?: string): Promise<AssetEntry[]>;
  deleteAsset(assetId: string, projectSlug?: string): Promise<Result<{ deleted_at: string }, FsError>>;
  renameAsset(assetId: string, newName: string, projectSlug?: string): Promise<Result<{ old_asset_id: string; new_asset_id: string }, FsError>>;
  getManifest(assetId: string, projectSlug?: string): Promise<Result<AssetManifest, FsError>>;

  // File
  writeFile(assetId: string, filename: string, data: Buffer | string, projectSlug?: string): Promise<Result<string, FsError>>;
  readFile(assetId: string, filename: string, projectSlug?: string): Promise<Result<Buffer, FsError>>;
  writeMetadata(assetId: string, metadata: OriginalMetadata, projectSlug?: string): Promise<Result<OriginalMetadata, FsError>>;
  readMetadata(assetId: string, projectSlug?: string): Promise<Result<OriginalMetadata, FsError>>;

  // Git
  commitOperation(operation: string, assetId?: string, details?: Record<string, unknown>, projectSlug?: string): Promise<string | null>;
  getHistory(projectSlug?: string, limit?: number): Promise<GitCommit[]>;
  getAssetHistory(assetId: string, projectSlug?: string, limit?: number): Promise<GitCommit[]>;
  restoreAsset(assetId: string, commitHash: string, projectSlug?: string): Promise<string | null>;

  // Lock
  acquireLock(assetDir: string, lockName: string, data?: Record<string, unknown>): Promise<Result<LockData, FsError>>;
  releaseLock(assetDir: string, lockName: string): Promise<Result<boolean, FsError>>;
  isLocked(assetDir: string, lockName: string): Promise<boolean>;
  getLockData(assetDir: string, lockName: string): Promise<LockData | null>;
  cleanStaleLocks(assetDir: string): Promise<string[]>;
}

export function createFs(config: FsConfig): ClipfirstFs {
  const { outputDir, gitPath } = config;

  async function resolve(projectSlug?: string): Promise<string | null> {
    return resolveProjectDir(outputDir, projectSlug, gitPath);
  }

  async function resolveOrErr(projectSlug?: string): Promise<Result<string, FsError>> {
    const dir = await resolve(projectSlug);
    if (!dir) {
      return err({ code: 'NOT_FOUND', message: 'Project not found' });
    }
    return ok(dir);
  }

  return {
    // Project
    createProject: (slug) => createProject(outputDir, slug, gitPath),
    listProjects: () => listProjects(outputDir),
    getProject: (slug) => getProject(outputDir, slug, gitPath),
    switchProject: (slug) => switchProject(outputDir, slug),

    // Asset
    createAsset: async (prefix, name, projectSlug) => {
      const r = await resolveOrErr(projectSlug);
      if (!r.ok) return r;
      return createAsset(r.value, prefix, name, gitPath);
    },
    listAssets: async (projectSlug) => {
      const dir = await resolve(projectSlug);
      if (!dir) return [];
      return listAssets(dir);
    },
    deleteAsset: async (assetId, projectSlug) => {
      const r = await resolveOrErr(projectSlug);
      if (!r.ok) return r;
      return deleteAsset(r.value, assetId, gitPath);
    },
    renameAsset: async (assetId, newName, projectSlug) => {
      const r = await resolveOrErr(projectSlug);
      if (!r.ok) return r;
      return renameAsset(r.value, assetId, newName, gitPath);
    },
    getManifest: async (assetId, projectSlug) => {
      const r = await resolveOrErr(projectSlug);
      if (!r.ok) return r;
      return getManifest(r.value, assetId);
    },

    // File
    writeFile: async (assetId, filename, data, projectSlug) => {
      const r = await resolveOrErr(projectSlug);
      if (!r.ok) return r;
      return writeFile(r.value, assetId, filename, data, gitPath);
    },
    readFile: async (assetId, filename, projectSlug) => {
      const r = await resolveOrErr(projectSlug);
      if (!r.ok) return r;
      return readFile(r.value, assetId, filename);
    },
    writeMetadata: async (assetId, metadata, projectSlug) => {
      const r = await resolveOrErr(projectSlug);
      if (!r.ok) return r;
      return writeMetadata(r.value, assetId, metadata, gitPath);
    },
    readMetadata: async (assetId, projectSlug) => {
      const r = await resolveOrErr(projectSlug);
      if (!r.ok) return r;
      return readMetadata(r.value, assetId);
    },

    // Git
    commitOperation: async (operation, assetId, details, projectSlug) => {
      const dir = await resolve(projectSlug);
      if (!dir) return null;
      return commitOperation(dir, operation, assetId, details, gitPath);
    },
    getHistory: async (projectSlug, limit) => {
      const dir = await resolve(projectSlug);
      if (!dir) return [];
      return getHistory(dir, limit, gitPath);
    },
    getAssetHistory: async (assetId, projectSlug, limit) => {
      const dir = await resolve(projectSlug);
      if (!dir) return [];
      return getAssetHistory(dir, assetId, limit, gitPath);
    },
    restoreAsset: async (assetId, commitHash, projectSlug) => {
      const dir = await resolve(projectSlug);
      if (!dir) return null;
      return restoreAsset(dir, assetId, commitHash, gitPath);
    },

    // Lock
    acquireLock,
    releaseLock,
    isLocked,
    getLockData,
    cleanStaleLocks,
  };
}

// Re-export types
export type {
  AssetStatus,
  AssetType,
  Orientation,
  AssetManifest,
  AssetManifestFile,
  AssetManifestFrames,
  ProjectMetadata,
  GitCommit,
  LockData,
  AssetEntry,
  OriginalMetadata,
  ToolParams,
  FsError,
  FsErrorCode,
  FsConfig,
} from './types.js';

export type { Result } from './result.js';
export { ok, err } from './result.js';

// Re-export constants for consumers who need lock names, error filenames, etc.
export * from './constants.js';
