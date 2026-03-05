import * as fs from "node:fs/promises";
import * as path from "node:path";

import {
  type FsConfig,
  type FsError,
  type AssetEntry,
  type AssetManifest,
  type ProjectMetadata,
  type GitCommit,
  type LockData,
  type Result,
  ok,
  err,
} from "./types.js";

import { createProject } from "./project/create.js";
import { listProjects } from "./project/list.js";
import { getProject, resolveProjectDir } from "./project/get.js";
import { switchProject } from "./project/switch.js";

import { createAsset } from "./asset/create.js";
import { listAssets } from "./asset/list.js";
import { deleteAsset } from "./asset/delete.js";
import { renameAsset } from "./asset/rename.js";
import { getManifest } from "./asset/manifest.js";

import { writeFile } from "./file/write.js";
import { readFile } from "./file/read.js";

import { commitOperation } from "./git/commit.js";
import { getHistory, getAssetHistory } from "./git/history.js";
import { restoreAsset } from "./git/restore.js";
import { rewindProject } from "./git/rewind.js";
import { getHistoricalSlugs } from "./git/slugs.js";

import { getPromptLog } from "./project/prompt-log.js";

import { acquireLock } from "./lock/acquire.js";
import { releaseLock } from "./lock/release.js";
import { isLocked, getLockData } from "./lock/query.js";
import { cleanStaleLock } from "./lock/clean.js";
import type { LockOptions } from "./lock/data.js";

export interface ClipfirstFs {
  // Project
  createProject(
    slug?: string,
  ): Promise<
    Result<{ slug: string; path: string; is_default: boolean }, FsError>
  >;
  listProjects(): Promise<ProjectMetadata[]>;
  getProject(
    slug?: string,
  ): Promise<Result<{ metadata: ProjectMetadata; path: string }, FsError>>;
  switchProject(slug: string): Promise<Result<string, FsError>>;

  // Asset
  createAsset(
    prefix: string,
    name: string,
    projectSlug?: string,
  ): Promise<Result<{ assetId: string; path: string }, FsError>>;
  listAssets(projectSlug?: string): Promise<AssetEntry[]>;
  deleteAsset(
    assetId: string,
    projectSlug?: string,
  ): Promise<Result<{ deleted_at: string }, FsError>>;
  renameAsset(
    assetId: string,
    newName: string,
    projectSlug?: string,
  ): Promise<Result<{ old_asset_id: string; new_asset_id: string }, FsError>>;
  getManifest(
    assetId: string,
    projectSlug?: string,
  ): Promise<Result<AssetManifest, FsError>>;

  // File
  writeFile(
    assetId: string,
    filename: string,
    data: Buffer | string,
    projectSlug?: string,
  ): Promise<Result<string, FsError>>;
  readFile(
    assetId: string,
    filename: string,
    projectSlug?: string,
  ): Promise<Result<Buffer, FsError>>;

  // Git
  commitOperation(
    operation: string,
    assetId?: string,
    details?: Record<string, unknown>,
    projectSlug?: string,
  ): Promise<string | null>;
  getHistory(projectSlug?: string, limit?: number): Promise<GitCommit[]>;
  getAssetHistory(
    assetId: string,
    projectSlug?: string,
    limit?: number,
  ): Promise<GitCommit[]>;
  restoreAsset(
    assetId: string,
    commitHash: string,
    projectSlug?: string,
  ): Promise<string | null>;
  rewindProject(
    commitHash: string,
    projectSlug?: string,
  ): Promise<string | null>;
  getPromptLog(
    projectSlug?: string,
    limit?: number,
  ): Promise<Record<string, unknown>[]>;

  // Lock
  acquireLock(
    assetDir: string,
    options: LockOptions,
  ): Promise<Result<LockData, FsError>>;
  releaseLock(assetDir: string): Promise<Result<boolean, FsError>>;
  isLocked(assetDir: string): Promise<boolean>;
  getLockData(assetDir: string): Promise<LockData | null>;
  cleanStaleLock(assetDir: string): Promise<boolean>;

  // Query
  slugTaken(slug: string, projectSlug?: string): Promise<boolean>;
}

export function createFs(config: FsConfig): ClipfirstFs {
  const { outputDir, gitPath } = config;

  async function resolve(projectSlug?: string): Promise<string | null> {
    return resolveProjectDir(outputDir, projectSlug, gitPath);
  }

  async function withProject<T>(
    projectSlug: string | undefined,
    fn: (dir: string) => Promise<Result<T, FsError>>,
  ): Promise<Result<T, FsError>> {
    const dir = await resolve(projectSlug);
    if (!dir) return err({ code: "NOT_FOUND", message: "Project not found" });
    return fn(dir);
  }

  return {
    // Project
    createProject: (slug) => createProject(outputDir, slug, gitPath),
    listProjects: () => listProjects(outputDir, gitPath),
    getProject: (slug) => getProject(outputDir, slug, gitPath),
    switchProject: (slug) => switchProject(outputDir, slug),

    // Asset
    createAsset: (prefix, name, projectSlug) =>
      withProject(projectSlug, (dir) =>
        createAsset(dir, prefix, name, gitPath),
      ),
    listAssets: async (projectSlug) => {
      const dir = await resolve(projectSlug);
      if (!dir) return [];
      return listAssets(dir, gitPath);
    },
    deleteAsset: (assetId, projectSlug) =>
      withProject(projectSlug, (dir) => deleteAsset(dir, assetId, gitPath)),
    renameAsset: (assetId, newName, projectSlug) =>
      withProject(projectSlug, (dir) =>
        renameAsset(dir, assetId, newName, gitPath),
      ),
    getManifest: (assetId, projectSlug) =>
      withProject(projectSlug, (dir) => getManifest(dir, assetId)),

    // File
    writeFile: (assetId, filename, data, projectSlug) =>
      withProject(projectSlug, (dir) =>
        writeFile(dir, assetId, filename, data, gitPath),
      ),
    readFile: (assetId, filename, projectSlug) =>
      withProject(projectSlug, (dir) => readFile(dir, assetId, filename)),

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
    rewindProject: async (commitHash, projectSlug) => {
      const dir = await resolve(projectSlug);
      if (!dir) return null;
      return rewindProject(dir, commitHash, gitPath);
    },
    getPromptLog: async (projectSlug, limit) => {
      const dir = await resolve(projectSlug);
      if (!dir) return [];
      return getPromptLog(dir, limit);
    },

    // Lock
    acquireLock,
    releaseLock,
    isLocked,
    getLockData,
    cleanStaleLock,

    // Query
    slugTaken: async (slug, projectSlug) => {
      const dir = await resolve(projectSlug);
      if (!dir) return false;
      try {
        await fs.access(path.join(dir, slug));
        return true;
      } catch {}
      const historical = await getHistoricalSlugs(dir, gitPath);
      return historical.has(slug);
    },
  };
}

// Re-export types
export type {
  AssetType,
  AssetManifest,
  AssetManifestFile,
  ProjectMetadata,
  GitCommit,
  LockData,
  AssetEntry,
  FsError,
  FsErrorCode,
  FsConfig,
} from "./types.js";

export type { LockOptions } from "./lock/data.js";
export type { Result } from "./types.js";
export { ok, err } from "./types.js";
