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
  type ActionLogEntry,
  type Result,
  ok,
  err,
} from "./types.js";

import { createProject } from "./project/create.js";
import { listProjects } from "./project/list.js";
import { getProject, resolveProjectDir } from "./project/get.js";
import { switchProject } from "./project/switch.js";
import { renameProject } from "./project/rename.js";

import { createAsset } from "./asset/create.js";
import { listAssets } from "./asset/list.js";
import { deleteAsset } from "./asset/delete.js";
import { renameAsset } from "./asset/rename.js";
import { getManifest } from "./asset/manifest.js";

import { writeFile } from "./file/write.js";
import { readFile } from "./file/read.js";
import { deleteFile } from "./file/delete.js";
import { renameFile } from "./file/rename.js";
import { copyFile } from "./file/copy.js";
import { resolveAssetDir } from "./file/resolve.js";
import { writeMetadata, readMetadata } from "./file/metadata.js";
import {
  writeAudioWaveform,
  readAudioWaveformRecord,
} from "./file/audio-waveform.js";
import type { AudioWaveformRecord } from "./db/audio-waveforms.js";
import { listAssetSubdir } from "./asset/list-subdir.js";
import { writeProjectMeta, readProjectMeta } from "./project/metadata.js";

import { commitOperation } from "./git/commit.js";
import { getHistory, getAssetHistory } from "./git/history.js";
import { restoreAsset } from "./git/restore.js";
import { readFileAtCommit } from "./git/show.js";
import { rewindProject } from "./git/rewind.js";
import { getHistoricalSlugs } from "./git/slugs.js";
import { logAction } from "./action/log.js";
import { readActionLog } from "./action/read.js";
import type { ActionLogOptions } from "./action/read.js";

import { acquireLock } from "./lock/acquire.js";
import { releaseLock } from "./lock/release.js";
import { isLocked, getLockData } from "./lock/query.js";
import { cleanStaleLock } from "./lock/clean.js";
import type { LockOptions } from "./lock/data.js";

import { appendLog } from "./log.js";
import { readLog } from "./log.js";

import { queueApi, type QueueApi } from "./queue/index.js";
import { ensureGitignorePatterns } from "./db/gitignore.js";
import { getStateDb, closeAllStateDbs } from "./db/client.js";
import { recoverOnStartup } from "./db/recover.js";
import {
  checkProjectSchemaVersion,
  type VersionCheckResult,
} from "./db/version-guard.js";
import { highestMigrationVersion as highestStateVersion } from "./db/migrate.js";

export interface ClipfirstFs {
  // Project
  createProject(
    slug?: string,
  ): Promise<
    Result<{ slug: string; path: string; is_default: boolean }, FsError>
  >;
  listProjects(options?: {
    sort?: "newest" | "oldest";
  }): Promise<ProjectMetadata[]>;
  getProject(
    slug?: string,
  ): Promise<Result<{ metadata: ProjectMetadata; path: string }, FsError>>;
  switchProject(slug: string): Promise<Result<string, FsError>>;
  renameProject(
    oldSlug: string,
    newSlug: string,
  ): Promise<
    Result<{ oldSlug: string; newSlug: string; path: string }, FsError>
  >;

  // Asset
  createAsset(
    prefix: string,
    name: string,
    projectSlug: string,
  ): Promise<Result<{ assetId: string; path: string }, FsError>>;
  listAssets(
    projectSlug: string,
    options?: { sort?: "newest" | "oldest" },
  ): Promise<AssetEntry[]>;
  deleteAsset(
    assetId: string,
    projectSlug: string,
  ): Promise<Result<{ deleted_at: string }, FsError>>;
  renameAsset(
    assetId: string,
    newName: string,
    projectSlug: string,
  ): Promise<Result<{ old_asset_id: string; new_asset_id: string }, FsError>>;
  getManifest(
    assetId: string,
    projectSlug: string,
    options?: { includeDotfiles?: boolean },
  ): Promise<Result<AssetManifest, FsError>>;

  // File
  writeFile(
    assetId: string,
    filename: string,
    data: Buffer | string,
    projectSlug: string,
  ): Promise<Result<string, FsError>>;
  readFile(
    assetId: string,
    filename: string,
    projectSlug: string,
  ): Promise<Result<Buffer, FsError>>;
  deleteFile(
    assetId: string,
    filename: string,
    projectSlug: string,
  ): Promise<Result<string, FsError>>;
  renameFile(
    assetId: string,
    oldFilename: string,
    newFilename: string,
    projectSlug: string,
  ): Promise<Result<{ oldPath: string; newPath: string }, FsError>>;
  copyFile(
    assetId: string,
    filename: string,
    destAssetId: string,
    destFilename: string,
    projectSlug: string,
  ): Promise<Result<string, FsError>>;
  resolveAssetDir(
    assetId: string,
    projectSlug: string,
  ): Promise<Result<string, FsError>>;
  writeMetadata(
    assetId: string,
    key: string,
    data: unknown,
    projectSlug: string,
  ): Promise<Result<string, FsError>>;
  readMetadata<T>(
    assetId: string,
    key: string,
    projectSlug: string,
  ): Promise<Result<T, FsError>>;
  writeAudioWaveform(
    assetId: string,
    peaks: number[],
    projectSlug: string,
  ): Promise<Result<string, FsError>>;
  readAudioWaveform(
    assetId: string,
    projectSlug: string,
  ): Promise<Result<AudioWaveformRecord, FsError>>;
  listAssetSubdir(
    assetId: string,
    subdirName: string,
    projectSlug: string,
  ): Promise<Result<string[], FsError>>;

  // Project metadata
  writeProjectMeta(
    key: string,
    data: unknown,
    projectSlug: string,
  ): Promise<Result<string, FsError>>;
  readProjectMeta<T>(
    key: string,
    projectSlug: string,
  ): Promise<Result<T, FsError>>;

  // Git
  commitOperation(
    operation: string,
    assetId: string | undefined,
    details: Record<string, unknown> | undefined,
    projectSlug: string,
  ): Promise<string | null>;
  getHistory(projectSlug: string, limit?: number): Promise<GitCommit[]>;
  getAssetHistory(
    assetId: string,
    projectSlug: string,
    limit?: number,
  ): Promise<GitCommit[]>;
  restoreAsset(
    assetId: string,
    commitHash: string,
    projectSlug: string,
  ): Promise<string | null>;
  readFileAtCommit(
    assetId: string,
    filename: string,
    commitHash: string,
    projectSlug: string,
  ): Promise<Result<string, FsError>>;
  rewindProject(
    commitHash: string,
    projectSlug: string,
  ): Promise<string | null>;
  // Lock
  acquireLock(
    assetDir: string,
    options: LockOptions,
  ): Promise<Result<LockData, FsError>>;
  releaseLock(assetDir: string): Promise<Result<boolean, FsError>>;
  isLocked(assetDir: string): Promise<boolean>;
  getLockData(assetDir: string): Promise<LockData | null>;
  cleanStaleLock(assetDir: string): Promise<boolean>;

  // Action log
  logAction(
    action: string,
    payload: string | Record<string, unknown>,
    projectSlug: string,
  ): Promise<Result<ActionLogEntry, FsError>>;
  getActionLog(
    options: ActionLogOptions | undefined,
    projectSlug: string,
  ): Promise<ActionLogEntry[]>;

  // Generic log (append-only JSONL, gitignored)
  appendLog(
    name: string,
    line: Record<string, unknown>,
    projectSlug: string,
  ): Promise<Result<string, FsError>>;
  readLog(
    name: string,
    projectSlug: string,
    options?: { limit?: number },
  ): Promise<Record<string, unknown>[]>;

  // Query
  slugTaken(slug: string, projectSlug: string): Promise<boolean>;

  // Persistent queue (state.sqlite) — see src/queue/index.ts
  queue: ProjectScopedQueue;

  // Resolve a project slug to a directory; null if not present.
  resolveProjectDir(slug?: string): Promise<string | null>;

  // Lazy bootstrap of .clipfirst/ for legacy projects (idempotent).
  ensureClipfirstSetup(slug: string): Promise<void>;

  // Abort any orphan recovery_journal rows from a prior process generation.
  // Returns the number of rows aborted.
  recoverIncompleteOperations(slug: string): Promise<number>;

  // Refuse to open if a SQLite file in this project records a higher schema
  // version than this build supports (downgrade guard). Returns the check result.
  checkSchemaVersion(slug: string): Promise<VersionCheckResult>;

  // Close all open SQLite handles (call before process exit).
  close(): void;
}

export interface ProjectScopedQueue {
  enqueue(
    projectSlug: string,
    opts: import("./queue/index.js").EnqueueOptions,
  ): Promise<import("./queue/index.js").EnqueueResult | null>;
  enqueueAndWait<T = unknown>(
    projectSlug: string,
    opts: import("./queue/index.js").EnqueueOptions,
    timeoutMs?: number,
  ): Promise<T>;
  getJob(
    projectSlug: string,
    id: number,
  ): Promise<import("./queue/index.js").Job | null>;
  findByExternal(
    projectSlug: string,
    type: string,
    externalTaskId: string,
  ): Promise<import("./queue/index.js").Job | null>;
  list(
    projectSlug: string,
    opts?: import("./queue/index.js").ListOptions,
  ): Promise<import("./queue/index.js").Job[]>;
  count(
    projectSlug: string,
    opts?: import("./queue/index.js").ListOptions,
  ): Promise<number>;
  complete(
    projectSlug: string,
    id: number,
    opts?: import("./queue/index.js").CompleteOptions,
  ): Promise<void>;
  fail(
    projectSlug: string,
    id: number,
    opts: import("./queue/index.js").FailOptions,
  ): Promise<void>;
  abort(projectSlug: string, id: number, reason: string): Promise<void>;
  markCompleting(projectSlug: string, id: number): Promise<void>;
  reap(projectSlug: string): Promise<ReturnType<QueueApi["reap"]>>;
  reapOnStartup(
    projectSlug: string,
  ): Promise<ReturnType<QueueApi["reapOnStartup"]>>;
  listLeased(projectSlug: string): Promise<ReturnType<QueueApi["listLeased"]>>;
  reconcileFromSidecars(
    projectSlug: string,
    opts?: import("./queue/index.js").ReconcileOptions,
  ): Promise<Awaited<ReturnType<QueueApi["reconcileFromSidecars"]>>>;
  createRunner(
    projectSlug: string,
    config: import("./queue/index.js").RunnerConfig,
  ): Promise<import("./queue/index.js").QueueRunner | null>;
}

export function createFs(config: FsConfig): ClipfirstFs {
  const { projectsDir, gitPath } = config;

  async function resolve(projectSlug: string): Promise<string | null> {
    return resolveProjectDir(projectsDir, projectSlug, gitPath);
  }

  async function withProject<T>(
    projectSlug: string,
    fn: (dir: string) => Promise<Result<T, FsError>>,
  ): Promise<Result<T, FsError>> {
    const dir = await resolve(projectSlug);
    if (!dir) return err({ code: "NOT_FOUND", message: "Project not found" });
    return fn(dir);
  }

  return {
    // Project
    createProject: (slug) => createProject(projectsDir, slug, gitPath),
    listProjects: (options) => listProjects(projectsDir, gitPath, options),
    getProject: (slug) => getProject(projectsDir, slug, gitPath),
    switchProject: (slug) => switchProject(projectsDir, slug),
    renameProject: (oldSlug, newSlug) =>
      renameProject(projectsDir, oldSlug, newSlug, gitPath),

    // Asset
    createAsset: (prefix, name, projectSlug) =>
      withProject(projectSlug, (dir) =>
        createAsset(dir, prefix, name, gitPath),
      ),
    listAssets: async (projectSlug, options) => {
      const dir = await resolve(projectSlug);
      if (!dir) return [];
      return listAssets(dir, gitPath, options);
    },
    deleteAsset: (assetId, projectSlug) =>
      withProject(projectSlug, (dir) => deleteAsset(dir, assetId, gitPath)),
    renameAsset: (assetId, newName, projectSlug) =>
      withProject(projectSlug, (dir) =>
        renameAsset(dir, assetId, newName, gitPath),
      ),
    getManifest: (assetId, projectSlug, options) =>
      withProject(projectSlug, (dir) => getManifest(dir, assetId, options)),

    // File
    writeFile: (assetId, filename, data, projectSlug) =>
      withProject(projectSlug, (dir) =>
        writeFile(dir, assetId, filename, data, gitPath),
      ),
    readFile: (assetId, filename, projectSlug) =>
      withProject(projectSlug, (dir) => readFile(dir, assetId, filename)),
    deleteFile: (assetId, filename, projectSlug) =>
      withProject(projectSlug, (dir) =>
        deleteFile(dir, assetId, filename, gitPath),
      ),
    renameFile: (assetId, oldFilename, newFilename, projectSlug) =>
      withProject(projectSlug, (dir) =>
        renameFile(dir, assetId, oldFilename, newFilename, gitPath),
      ),
    copyFile: (assetId, filename, destAssetId, destFilename, projectSlug) =>
      withProject(projectSlug, (dir) =>
        copyFile(dir, assetId, filename, destAssetId, destFilename, gitPath),
      ),
    resolveAssetDir: (assetId, projectSlug) =>
      withProject(projectSlug, (dir) => resolveAssetDir(dir, assetId)),
    writeMetadata: (assetId, key, data, projectSlug) =>
      withProject(projectSlug, (dir) =>
        writeMetadata(dir, assetId, key, data, gitPath),
      ),
    readMetadata: <T>(assetId: string, key: string, projectSlug: string) =>
      withProject(projectSlug, (dir) => readMetadata<T>(dir, assetId, key)),
    writeAudioWaveform: (assetId, peaks, projectSlug) =>
      withProject(projectSlug, (dir) =>
        writeAudioWaveform(dir, assetId, peaks, gitPath),
      ),
    readAudioWaveform: (assetId, projectSlug) =>
      withProject(projectSlug, (dir) => readAudioWaveformRecord(dir, assetId)),
    listAssetSubdir: (assetId, subdirName, projectSlug) =>
      withProject(projectSlug, (dir) =>
        listAssetSubdir(dir, assetId, subdirName),
      ),

    // Project metadata
    writeProjectMeta: (key, data, projectSlug) =>
      withProject(projectSlug, (dir) =>
        writeProjectMeta(dir, key, data, gitPath),
      ),
    readProjectMeta: <T>(key: string, projectSlug: string) =>
      withProject(projectSlug, (dir) => readProjectMeta<T>(dir, key)),

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
    readFileAtCommit: (assetId, filename, commitHash, projectSlug) =>
      withProject(projectSlug, (dir) =>
        readFileAtCommit(dir, assetId, filename, commitHash, gitPath),
      ),
    rewindProject: async (commitHash, projectSlug) => {
      const dir = await resolve(projectSlug);
      if (!dir) return null;
      return rewindProject(dir, commitHash, gitPath);
    },
    // Action log
    logAction: (action, payload, projectSlug) =>
      withProject(projectSlug, (dir) =>
        logAction(dir, action, payload, gitPath),
      ),
    getActionLog: async (options, projectSlug) => {
      const dir = await resolve(projectSlug);
      if (!dir) return [];
      return readActionLog(dir, options, gitPath);
    },

    // Generic log
    appendLog: (name, line, projectSlug) =>
      withProject(projectSlug, (dir) => appendLog(dir, name, line)),
    readLog: async (name, projectSlug, options) => {
      const dir = await resolve(projectSlug);
      if (!dir) return [];
      return readLog(dir, name, options);
    },

    // Lock — bound to projectsDir so callers can keep the (assetDir, options) shape
    acquireLock: (assetDir, options) =>
      acquireLock(projectsDir, assetDir, options),
    releaseLock: (assetDir) => releaseLock(projectsDir, assetDir),
    isLocked: (assetDir) => isLocked(projectsDir, assetDir),
    getLockData: (assetDir) => getLockData(projectsDir, assetDir),
    cleanStaleLock: (assetDir) => cleanStaleLock(projectsDir, assetDir),

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

    queue: makeQueue(resolve),

    resolveProjectDir: (slug) => resolve(slug ?? ""),

    ensureClipfirstSetup: async (slug) => {
      const dir = await resolve(slug);
      if (!dir) return;
      // Opening the state DB is idempotent and creates .clipfirst/ as a side-effect.
      getStateDb(dir);
      await ensureGitignorePatterns(dir);
    },

    recoverIncompleteOperations: async (slug) => {
      const dir = await resolve(slug);
      if (!dir) return 0;
      const result = await recoverOnStartup(dir);
      return result.aborted;
    },

    checkSchemaVersion: async (slug) => {
      const dir = await resolve(slug);
      if (!dir) {
        return {
          ok: true,
          recordedStateVersion: 0,
          recordedMetadataVersion: 0,
          buildStateVersion: highestStateVersion(),
          buildMetadataVersion: BUILD_METADATA_VERSION,
        };
      }
      return checkProjectSchemaVersion(
        dir,
        highestStateVersion(),
        BUILD_METADATA_VERSION,
      );
    },

    close: () => closeAllStateDbs(),
  };
}

// The metadata.sqlite migration count baked into this build. Bumped whenever
// a new metadata migration ships in src/db/migrations/metadata_*.ts.
const BUILD_METADATA_VERSION = 3;

function makeQueue(
  resolve: (slug: string) => Promise<string | null>,
): ProjectScopedQueue {
  async function dirOrThrow(slug: string): Promise<string> {
    const dir = await resolve(slug);
    if (!dir) throw new Error(`Project not found: ${slug}`);
    return dir;
  }
  return {
    enqueue: async (slug, opts) => {
      const dir = await resolve(slug);
      if (!dir) return null;
      return queueApi.enqueue(dir, opts);
    },
    enqueueAndWait: async <T = unknown>(
      slug: string,
      opts: import("./queue/index.js").EnqueueOptions,
      timeoutMs = 300_000,
    ): Promise<T> => {
      const dir = await dirOrThrow(slug);
      const enq = queueApi.enqueue(dir, opts);
      const start = Date.now();
      while (Date.now() - start < timeoutMs) {
        const job = queueApi.getJob(dir, enq.job.id);
        if (!job) throw new Error(`Job ${enq.job.id} disappeared`);
        if (job.state === "done") return job.result as T;
        if (job.state === "failed" || job.state === "aborted") {
          throw new Error(
            `Job ${job.id} ${job.state}: ${job.error?.message ?? "unknown"}`,
          );
        }
        await new Promise((r) => setTimeout(r, 50));
      }
      throw new Error(`Job ${enq.job.id} timed out after ${timeoutMs}ms`);
    },
    getJob: async (slug, id) => {
      const dir = await resolve(slug);
      return dir ? queueApi.getJob(dir, id) : null;
    },
    findByExternal: async (slug, type, externalTaskId) => {
      const dir = await resolve(slug);
      return dir ? queueApi.findByExternal(dir, type, externalTaskId) : null;
    },
    list: async (slug, opts) => {
      const dir = await resolve(slug);
      return dir ? queueApi.list(dir, opts) : [];
    },
    count: async (slug, opts) => {
      const dir = await resolve(slug);
      return dir ? queueApi.count(dir, opts) : 0;
    },
    complete: async (slug, id, opts) => {
      const dir = await dirOrThrow(slug);
      queueApi.complete(dir, id, opts);
    },
    fail: async (slug, id, opts) => {
      const dir = await dirOrThrow(slug);
      queueApi.fail(dir, id, opts);
    },
    abort: async (slug, id, reason) => {
      const dir = await dirOrThrow(slug);
      queueApi.abort(dir, id, reason);
    },
    markCompleting: async (slug, id) => {
      const dir = await dirOrThrow(slug);
      queueApi.markCompleting(dir, id);
    },
    reap: async (slug) => {
      const dir = await dirOrThrow(slug);
      return queueApi.reap(dir);
    },
    reapOnStartup: async (slug) => {
      const dir = await dirOrThrow(slug);
      return queueApi.reapOnStartup(dir);
    },
    listLeased: async (slug) => {
      const dir = await dirOrThrow(slug);
      return queueApi.listLeased(dir);
    },
    reconcileFromSidecars: async (slug, opts) => {
      const dir = await dirOrThrow(slug);
      return queueApi.reconcileFromSidecars(dir, opts);
    },
    createRunner: async (slug, config) => {
      const dir = await resolve(slug);
      if (!dir) return null;
      return queueApi.createRunner(dir, config);
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
  ActionLogEntry,
  AssetEntry,
  FsError,
  FsErrorCode,
  FsConfig,
} from "./types.js";

export type { ActionLogOptions } from "./action/read.js";

export type { LockOptions } from "./lock/data.js";
export type { Result } from "./types.js";
export { ok, err } from "./types.js";

export type {
  EnqueueOptions,
  EnqueueResult,
  CompleteOptions,
  FailOptions,
  Job,
  JobHandler,
  JobState,
} from "./queue/types.js";
export type {
  ListOptions,
  ReconcileOptions,
  RunnerConfig,
  QueueApi,
} from "./queue/index.js";
export type { VersionCheckResult } from "./db/version-guard.js";
export {
  canonicalize,
  dedupeKey,
  QueueRunner,
  queueApi,
} from "./queue/index.js";
export { closeAllStateDbs, closeStateDb, getStateDb } from "./db/client.js";
export { isValidProjectSlug } from "./project/slug.js";
export type { AudioWaveformRecord } from "./db/audio-waveforms.js";
