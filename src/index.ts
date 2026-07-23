import * as fs from "node:fs/promises";
import * as path from "node:path";

import {
  type FsConfig,
  type FsError,
  type AssetEntry,
  type AssetManifest,
  type ProjectMetadata,
  type GitCommit,
  type ProjectRevision,
  type LockData,
  type ActionLogEntry,
  type StorageStatus,
  type Result,
  ok,
  err,
} from "./types.js";

import { createProject } from "./project/create.js";
import { listProjects } from "./project/list.js";
import { getProject, resolveProjectDir } from "./project/get.js";
import { switchProject } from "./project/switch.js";
import { renameProject } from "./project/rename.js";
import { deleteProject } from "./project/delete.js";

import { createAsset } from "./asset/create.js";
import { listAssets } from "./asset/list.js";
import { deleteAsset } from "./asset/delete.js";
import { renameAsset } from "./asset/rename.js";
import { getManifest } from "./asset/manifest.js";
import {
  type AssetStatus,
  type AssetStatusInput,
  type GetAssetStatusOptions,
  computeAssetStatus,
  getAssetStatus,
} from "./asset/status.js";

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
import { migrateLegacySidecar } from "./git/init.js";
import {
  getMetadataDb,
  highestMetadataMigrationVersion,
} from "./db/metadata-client.js";
import {
  recordPromptRow,
  listPromptHistoryRows,
  countPromptHistoryRows,
  type PromptHistoryEntry,
  type RecordPromptArgs,
  type ListPromptHistoryArgs,
} from "./db/prompt-history.js";
import { recoverOnStartup } from "./db/recover.js";
import {
  type PendingTask,
  type GenerationError,
  type FailureInfo,
  type WritePendingTaskInput,
  type WritePendingTaskResult,
  writePendingTask,
  markPendingTaskCompleting,
  clearPendingTaskCompleting,
  readPendingTask,
  deletePendingTask,
  findAllPendingTasks,
  findPendingTaskByExternalId,
  findAllGenerationErrors,
  writeGenerationError,
  readGenerationError,
  clearGenerationError,
  failPendingTask,
  forceFailPendingTask,
  getPendingTaskOwner,
} from "./pending-task/index.js";
import {
  type AssetMeta,
  type AssetOwnerKind,
  type AssetView,
  type AssetWorkKind,
  type BeginAssetWorkInput,
  beginAssetWork,
  completeAssetWork,
  failAssetWork,
  renewAssetWork,
  markAssetSeen,
  readAssetRow,
  listAssetRows,
} from "./asset/work.js";
import { recoverAssetsTable, recoverAssetRow } from "./asset/recover.js";
import { startAssetReaper, runReaperPass } from "./asset/reaper.js";
import {
  checkProjectSchemaVersion,
  type VersionCheckResult,
} from "./db/version-guard.js";
import { highestMigrationVersion as highestStateVersion } from "./db/migrate.js";
import type {
  EntityDocument,
  EntityType,
  NotebookDocument,
  NotebookRun,
} from "./notebook/types.js";
import { Catalog } from "./storage/catalog.js";
import {
  acquireCatalog,
  releaseCatalog,
} from "./storage/context.js";

export interface VideocityFs {
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
  deleteProject(
    slug: string,
  ): Promise<
    Result<
      { slug: string; deleted_at: string; default_project_slug: string | null },
      FsError
    >
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
  getAssetStatus(
    assetId: string,
    projectSlug: string,
    options?: GetAssetStatusOptions,
  ): Promise<Result<AssetStatus, FsError>>;

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

  // Prompt history (per-surface, persisted in metadata.sqlite)
  recordPrompt(
    args: RecordPromptArgs,
    projectSlug: string,
  ): Promise<Result<{ id: number }, FsError>>;
  listPromptHistory(
    args: ListPromptHistoryArgs,
    projectSlug: string,
  ): Promise<PromptHistoryEntry[]>;
  countPromptHistory(surface: string, projectSlug: string): Promise<number>;

  // Query
  slugTaken(slug: string, projectSlug: string): Promise<boolean>;

  // Pending tasks (external long-running provider jobs tracked in state.sqlite)
  pendingTasks: ProjectScopedPendingTasks;

  // Generation errors (terminal failure markers, sibling table to pending_tasks)
  generationErrors: ProjectScopedGenerationErrors;

  // Asset work APIs: durable status leases for asset-mutating handlers.
  // beginAssetWork/completeAssetWork/failAssetWork/renewAssetWork all CAS on
  // owner_id; readAssetRow/listAssetRows are O(1) reads of the materialized state.
  assetWork: ProjectScopedAssetWork;

  // Re-derive a single asset row from disk + tables. Called by restoreAsset
  // and clearGenerationError.
  recoverAssetRow(
    projectSlug: string,
    assetId: string,
  ): Promise<Result<void, FsError>>;

  // Walk every asset directory and rebuild assets-table rows. Called at boot.
  recoverAssetsTable(
    projectSlug: string,
  ): Promise<Result<{ recovered: number }, FsError>>;

  // Start the deadline-driven reaper for this project. Returns a stop handle.
  startAssetReaper(
    projectSlug: string,
    opts: { intervalMs: number },
  ): Promise<{ stop: () => void } | null>;

  // Persistent queue (state.sqlite) — see src/queue/index.ts
  queue: ProjectScopedQueue;

  // Resolve a project slug to a directory; null if not present.
  resolveProjectDir(slug?: string): Promise<string | null>;

  // Idempotent initialization: ensures .videocity/ exists, opens state DB,
  // applies gitignore patterns. Safe to call on every boot or enqueue.
  ensureProjectInitialized(slug: string): Promise<void>;

  // Abort any orphan recovery_journal rows from a prior process generation.
  // Returns the number of rows aborted.
  recoverIncompleteOperations(slug: string): Promise<number>;

  // Refuse to open if a SQLite file in this project records a higher schema
  // version than this build supports (downgrade guard). Returns the check result.
  checkSchemaVersion(slug: string): Promise<VersionCheckResult>;

  // Close all open SQLite handles (call before process exit).
  close(): void;
}

export interface RunOperationInput {
  projectSlug: string;
  operation: string;
  assetId?: string;
  details?: Record<string, unknown>;
  author?: string;
}

export interface VideobookFs extends VideocityFs {
  runOperation<T>(
    input: RunOperationInput,
    mutate: (projectDir: string) => Promise<T>,
  ): Promise<Result<{ value: T; revision: ProjectRevision }, FsError>>;
  importFile(sourcePath: string): Promise<
    Result<{ hash: string; size: number; path: string }, FsError>
  >;
  getProjectHistory(
    projectSlug: string,
    limit?: number,
  ): Promise<ProjectRevision[]>;
  readFileAtRevision(
    assetId: string,
    filename: string,
    revision: string,
    projectSlug: string,
  ): Promise<Result<string, FsError>>;
  resolveRevision(
    revision: string,
    projectSlug: string,
  ): Promise<ProjectRevision | null>;
  getStorageStatus(): Promise<StorageStatus>;
  sync(): Promise<StorageStatus>;
  createNotebook(
    name: string,
    projectSlug: string,
  ): Promise<Result<NotebookDocument, FsError>>;
  listNotebooks(projectSlug: string): Promise<NotebookDocument[]>;
  readNotebook(
    notebookId: string,
    projectSlug: string,
  ): Promise<Result<NotebookDocument, FsError>>;
  writeNotebook(
    notebook: NotebookDocument,
    projectSlug: string,
  ): Promise<Result<ProjectRevision, FsError>>;
  deleteNotebook(
    notebookId: string,
    projectSlug: string,
  ): Promise<Result<{ deleted_at: string }, FsError>>;
  recordNotebookRun(
    run: NotebookRun,
    projectSlug: string,
  ): Promise<Result<ProjectRevision, FsError>>;
  createEntity(
    type: EntityType,
    name: string,
    projectSlug: string,
    input?: Partial<EntityDocument>,
  ): Promise<Result<EntityDocument, FsError>>;
  listEntities(
    projectSlug: string,
    type?: EntityType,
  ): Promise<EntityDocument[]>;
  readEntity(
    entityId: string,
    projectSlug: string,
  ): Promise<Result<EntityDocument, FsError>>;
  writeEntity(
    entity: EntityDocument,
    projectSlug: string,
  ): Promise<Result<ProjectRevision, FsError>>;
  deleteEntity(
    entityId: string,
    projectSlug: string,
  ): Promise<Result<{ deleted_at: string }, FsError>>;
}

export interface ProjectScopedPendingTasks {
  write(
    projectSlug: string,
    input: WritePendingTaskInput,
    expectedOwnerId: string,
  ): Promise<Result<WritePendingTaskResult | null, FsError>>;
  read(
    projectSlug: string,
    assetId: string,
  ): Promise<Result<PendingTask | null, FsError>>;
  /** CAS by (asset_id, task_id). When expectedTaskId is omitted, deletes by asset_id alone. */
  delete(
    projectSlug: string,
    assetId: string,
    expectedTaskId?: string,
  ): Promise<Result<boolean, FsError>>;
  markCompleting(
    projectSlug: string,
    assetId: string,
  ): Promise<Result<boolean, FsError>>;
  clearCompleting(
    projectSlug: string,
    assetId: string,
  ): Promise<Result<boolean, FsError>>;
  findAll(projectSlug: string): Promise<Result<PendingTask[], FsError>>;
  findByExternalId(
    projectSlug: string,
    taskId: string,
  ): Promise<Result<PendingTask | null, FsError>>;
  /** Legacy: fail by asset_id alone (no CAS). */
  fail(
    projectSlug: string,
    assetId: string,
    info: FailureInfo,
  ): Promise<Result<GenerationError | null, FsError>>;
  /** CAS by (asset_id, task_id). Writes generation_errors + fails assets row in one txn. */
  fail(
    projectSlug: string,
    assetId: string,
    expectedTaskId: string,
    info: FailureInfo,
  ): Promise<Result<GenerationError | null, FsError>>;
  forceFail(
    projectSlug: string,
    assetId: string,
    info: FailureInfo,
  ): Promise<Result<GenerationError | null, FsError>>;
  /** Returns owner_id stored on (asset_id, task_id) row, or null if no match. */
  getOwner(
    projectSlug: string,
    assetId: string,
    taskId: string,
  ): Promise<string | null>;
}

export interface ProjectScopedAssetWork {
  begin(
    projectSlug: string,
    assetId: string,
    input: BeginAssetWorkInput,
  ): Promise<{ ownerId: string } | null>;
  complete(
    projectSlug: string,
    assetId: string,
    ownerId: string,
  ): Promise<boolean>;
  fail(
    projectSlug: string,
    assetId: string,
    ownerId: string,
    failure: { message: string; code?: string },
  ): Promise<boolean>;
  renew(
    projectSlug: string,
    assetId: string,
    ownerId: string,
    extendMs: number,
  ): Promise<boolean>;
  markSeen(projectSlug: string, assetId: string): Promise<boolean>;
  read(
    projectSlug: string,
    assetId: string,
  ): Promise<Result<AssetView | null, FsError>>;
  list(projectSlug: string): Promise<Result<AssetView[], FsError>>;
}

export interface ProjectScopedGenerationErrors {
  write(
    projectSlug: string,
    assetId: string,
    info: FailureInfo,
  ): Promise<Result<GenerationError, FsError>>;
  read(
    projectSlug: string,
    assetId: string,
  ): Promise<Result<GenerationError | null, FsError>>;
  clear(
    projectSlug: string,
    assetId: string,
  ): Promise<Result<boolean, FsError>>;
  findAll(projectSlug: string): Promise<Result<GenerationError[], FsError>>;
}

export interface ProjectScopedQueue {
  enqueue(
    projectSlug: string,
    opts: import("./queue/types.js").EnqueueOptions,
  ): Promise<import("./queue/types.js").EnqueueResult | null>;
  enqueueAndWait<T = unknown>(
    projectSlug: string,
    opts: import("./queue/types.js").EnqueueOptions,
    timeoutMs?: number,
  ): Promise<T>;
  getJob(
    projectSlug: string,
    id: number,
  ): Promise<import("./queue/types.js").Job | null>;
  findByExternal(
    projectSlug: string,
    type: string,
    externalTaskId: string,
  ): Promise<import("./queue/types.js").Job | null>;
  list(
    projectSlug: string,
    opts?: import("./queue/list.js").ListOptions,
  ): Promise<import("./queue/types.js").Job[]>;
  count(
    projectSlug: string,
    opts?: import("./queue/list.js").ListOptions,
  ): Promise<number>;
  complete(
    projectSlug: string,
    id: number,
    opts?: import("./queue/types.js").CompleteOptions,
  ): Promise<void>;
  fail(
    projectSlug: string,
    id: number,
    opts: import("./queue/types.js").FailOptions,
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
    opts?: import("./queue/reconcile.js").ReconcileOptions,
  ): Promise<Awaited<ReturnType<QueueApi["reconcileFromSidecars"]>>>;
  createRunner(
    projectSlug: string,
    config: import("./queue/runner.js").RunnerConfig,
  ): Promise<import("./queue/runner.js").QueueRunner | null>;
}

export function createFs(config: FsConfig): VideobookFs {
  const { projectsDir, objectStore, objectPrefix, branch, gitPath } = config;
  const dataDir = config.dataDir ?? `${projectsDir}.data`;
  const catalog = acquireCatalog(
    projectsDir,
    () =>
      new Catalog({
        projectsDir,
        dataDir,
        ...(objectStore ? { objectStore } : {}),
        ...(objectPrefix ? { objectPrefix } : {}),
        ...(branch ? { branch } : {}),
      }),
  );
  void catalog.prepare();

  async function resolve(projectSlug: string): Promise<string | null> {
    return resolveProjectDir(projectsDir, projectSlug);
  }

  async function withProject<T>(
    projectSlug: string,
    fn: (dir: string) => Promise<Result<T, FsError>>,
  ): Promise<Result<T, FsError>> {
    const dir = await resolve(projectSlug);
    if (!dir) return err({ code: "NOT_FOUND", message: "Project not found" });
    return fn(dir);
  }

  const api: VideobookFs = {
    // Project
    createProject: async (slug) => {
      const result = await createProject(projectsDir, slug, gitPath);
      if (!result.ok) return result;
      await catalog.createProject(result.value.slug);
      await catalog.snapshotProject(result.value.path, {
        operation: "initialize_project",
        allowEmpty: true,
      });
      return result;
    },
    listProjects: (options) => listProjects(projectsDir, gitPath, options),
    getProject: (slug) => getProject(projectsDir, slug, gitPath),
    switchProject: (slug) => switchProject(projectsDir, slug),
    renameProject: async (oldSlug, newSlug) => {
      const result = await renameProject(
        projectsDir,
        oldSlug,
        newSlug,
        gitPath,
      );
      if (result.ok) await catalog.renameProject(oldSlug, result.value.newSlug);
      return result;
    },
    deleteProject: async (slug) => {
      const result = await deleteProject(projectsDir, slug, gitPath);
      if (result.ok) await catalog.deleteProject(slug);
      return result;
    },

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
    getAssetStatus: (assetId, projectSlug, options) =>
      withProject(projectSlug, (dir) =>
        getAssetStatus(dir, projectsDir, assetId, options),
      ),

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
      const commit = await commitOperation(
        dir,
        operation,
        assetId,
        details,
        gitPath,
      );
      return commit.status === "committed" ? commit.hash : null;
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

    // Prompt history (metadata.sqlite)
    recordPrompt: (args, projectSlug) =>
      withProject(projectSlug, async (dir) => {
        const db = getMetadataDb(dir);
        return ok(recordPromptRow(db, args));
      }),
    listPromptHistory: async (args, projectSlug) => {
      const dir = await resolve(projectSlug);
      if (!dir) return [];
      const db = getMetadataDb(dir);
      return listPromptHistoryRows(db, args);
    },
    countPromptHistory: async (surface, projectSlug) => {
      const dir = await resolve(projectSlug);
      if (!dir) return 0;
      const db = getMetadataDb(dir);
      return countPromptHistoryRows(db, surface);
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

    pendingTasks: makePendingTasks(resolve),
    generationErrors: makeGenerationErrors(resolve),
    assetWork: makeAssetWork(resolve),

    recoverAssetRow: async (slug, assetId) => {
      const dir = await resolve(slug);
      if (!dir) return err({ code: "NOT_FOUND", message: "Project not found" });
      return recoverAssetRow(dir, projectsDir, assetId);
    },
    recoverAssetsTable: async (slug) => {
      const dir = await resolve(slug);
      if (!dir) return err({ code: "NOT_FOUND", message: "Project not found" });
      return recoverAssetsTable(dir, projectsDir);
    },
    startAssetReaper: async (slug, opts) => {
      const dir = await resolve(slug);
      if (!dir) return null;
      return startAssetReaper(dir, opts);
    },

    queue: makeQueue(resolve),

    resolveProjectDir: (slug) => resolve(slug ?? ""),

    ensureProjectInitialized: async (slug) => {
      const dir = await resolve(slug);
      if (!dir) return;
      // Upgrade legacy `.clipfirst/` sidecars before opening the state DB.
      await migrateLegacySidecar(dir, gitPath);
      // Opening the state DB is idempotent and creates .videocity/ as a side-effect.
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
          buildMetadataVersion: highestMetadataMigrationVersion(),
        };
      }
      return checkProjectSchemaVersion(
        dir,
        highestStateVersion(),
        highestMetadataMigrationVersion(),
      );
    },

    runOperation: async (input, mutate) => {
      const dir = await resolve(input.projectSlug);
      if (!dir) {
        return err({ code: "NOT_FOUND", message: "Project not found" });
      }
      try {
        const value = await mutate(dir);
        const revision = await catalog.snapshotProject(dir, {
          operation: input.operation,
          ...(input.assetId ? { assetId: input.assetId } : {}),
          ...(input.details ? { details: input.details } : {}),
          ...(input.author ? { author: input.author } : {}),
          allowEmpty: true,
        });
        if (!revision) {
          return err({
            code: "STORAGE_ERROR",
            message: "Operation did not create a revision",
          });
        }
        return ok({ value, revision });
      } catch (error: unknown) {
        return err({
          code: "STORAGE_ERROR",
          message: (error as Error).message,
        });
      }
    },
    importFile: async (sourcePath) => {
      try {
        return ok(await catalog.importFile(sourcePath));
      } catch (error: unknown) {
        return err({
          code: "STORAGE_ERROR",
          message: (error as Error).message,
        });
      }
    },
    getProjectHistory: async (projectSlug, limit) =>
      catalog.hasProject(projectSlug)
        ? catalog.history(projectSlug, limit)
        : [],
    readFileAtRevision: (assetId, filename, revision, projectSlug) =>
      api.readFileAtCommit(assetId, filename, revision, projectSlug),
    resolveRevision: async (revision, projectSlug) =>
      catalog
        .history(projectSlug, 10_000)
        .find(
          (item) =>
            item.hash === revision || item.hash.startsWith(revision),
        ) ?? null,
    getStorageStatus: () => catalog.getStorageStatus(),
    sync: () => catalog.syncObjects(),
    createNotebook: async (name, projectSlug) => {
      const created = await api.createAsset("nb", name, projectSlug);
      if (!created.ok) return created;
      const now = new Date().toISOString();
      const notebook: NotebookDocument = {
        id: created.value.assetId,
        name,
        version: 2,
        cells: [],
        edges: [],
        createdAt: now,
        updatedAt: now,
      };
      const written = await api.writeFile(
        notebook.id,
        "notebook.json",
        JSON.stringify(notebook, null, 2),
        projectSlug,
      );
      return written.ok ? ok(notebook) : written;
    },
    listNotebooks: async (projectSlug) => {
      const assets = await api.listAssets(projectSlug);
      const notebooks: NotebookDocument[] = [];
      for (const asset of assets.filter((item) => item.id.startsWith("nb-"))) {
        const notebook = await api.readNotebook(asset.id, projectSlug);
        if (notebook.ok) notebooks.push(notebook.value);
      }
      return notebooks;
    },
    readNotebook: async (notebookId, projectSlug) => {
      const result = await api.readFile(
        notebookId,
        "notebook.json",
        projectSlug,
      );
      if (!result.ok) return result;
      try {
        return ok(
          JSON.parse(result.value.toString("utf8")) as NotebookDocument,
        );
      } catch (error: unknown) {
        return err({
          code: "STORAGE_ERROR",
          message: (error as Error).message,
        });
      }
    },
    writeNotebook: async (notebook, projectSlug) => {
      const next = { ...notebook, updatedAt: new Date().toISOString() };
      const result = await api.writeFile(
        notebook.id,
        "notebook.json",
        JSON.stringify(next, null, 2),
        projectSlug,
      );
      if (!result.ok) return result;
      const revision = (
        await api.getAssetHistory(notebook.id, projectSlug, 1)
      )[0];
      return revision
        ? ok(revision)
        : err({ code: "STORAGE_ERROR", message: "Revision not found" });
    },
    deleteNotebook: (notebookId, projectSlug) =>
      api.deleteAsset(notebookId, projectSlug),
    recordNotebookRun: async (run, projectSlug) => {
      const result = await api.writeFile(
        run.notebookId,
        `run-${run.id}.json`,
        JSON.stringify(run, null, 2),
        projectSlug,
      );
      if (!result.ok) return result;
      const revision = (
        await api.getAssetHistory(run.notebookId, projectSlug, 1)
      )[0];
      return revision
        ? ok(revision)
        : err({ code: "STORAGE_ERROR", message: "Revision not found" });
    },
    createEntity: async (type, name, projectSlug, input) => {
      const prefix = entityPrefix(type);
      const created = await api.createAsset(prefix, name, projectSlug);
      if (!created.ok) return created;
      const now = new Date().toISOString();
      const entity: EntityDocument = {
        id: created.value.assetId,
        type,
        name,
        ...(input?.description ? { description: input.description } : {}),
        ...(input?.prompt ? { prompt: input.prompt } : {}),
        data: input?.data ?? {},
        createdAt: now,
        updatedAt: now,
      };
      const written = await api.writeFile(
        entity.id,
        "entity.json",
        JSON.stringify(entity, null, 2),
        projectSlug,
      );
      return written.ok ? ok(entity) : written;
    },
    listEntities: async (projectSlug, type) => {
      const prefixes = type
        ? [entityPrefix(type)]
        : ["prm", "char", "scn"];
      const assets = await api.listAssets(projectSlug);
      const entities: EntityDocument[] = [];
      for (const asset of assets.filter((item) =>
        prefixes.some((prefix) => item.id.startsWith(`${prefix}-`)),
      )) {
        const entity = await api.readEntity(asset.id, projectSlug);
        if (entity.ok) entities.push(entity.value);
      }
      return entities;
    },
    readEntity: async (entityId, projectSlug) => {
      const result = await api.readFile(entityId, "entity.json", projectSlug);
      if (!result.ok) return result;
      try {
        return ok(JSON.parse(result.value.toString("utf8")) as EntityDocument);
      } catch (error: unknown) {
        return err({
          code: "STORAGE_ERROR",
          message: (error as Error).message,
        });
      }
    },
    writeEntity: async (entity, projectSlug) => {
      const next = { ...entity, updatedAt: new Date().toISOString() };
      const result = await api.writeFile(
        entity.id,
        "entity.json",
        JSON.stringify(next, null, 2),
        projectSlug,
      );
      if (!result.ok) return result;
      const revision = (
        await api.getAssetHistory(entity.id, projectSlug, 1)
      )[0];
      return revision
        ? ok(revision)
        : err({ code: "STORAGE_ERROR", message: "Revision not found" });
    },
    deleteEntity: (entityId, projectSlug) =>
      api.deleteAsset(entityId, projectSlug),
    close: () => {
      closeAllStateDbs();
      if (releaseCatalog(projectsDir, catalog)) catalog.close();
    },
  };
  return api;
}

function entityPrefix(type: EntityType): string {
  if (type === "prompt") return "prm";
  if (type === "character") return "char";
  return "scn";
}

function makePendingTasks(
  resolve: (slug: string) => Promise<string | null>,
): ProjectScopedPendingTasks {
  async function dirOrNotFound<T>(
    slug: string,
    fn: (dir: string) => Result<T, FsError>,
  ): Promise<Result<T, FsError>> {
    const dir = await resolve(slug);
    if (!dir) return err({ code: "NOT_FOUND", message: "Project not found" });
    return fn(dir);
  }
  return {
    write: (slug, input, expectedOwnerId) =>
      dirOrNotFound(slug, (dir) =>
        writePendingTask(dir, input, expectedOwnerId),
      ),
    read: (slug, assetId) =>
      dirOrNotFound(slug, (dir) => readPendingTask(dir, assetId)),
    delete: (slug, assetId, expectedTaskId) =>
      dirOrNotFound(slug, (dir) =>
        deletePendingTask(dir, assetId, expectedTaskId),
      ),
    markCompleting: (slug, assetId) =>
      dirOrNotFound(slug, (dir) => markPendingTaskCompleting(dir, assetId)),
    clearCompleting: (slug, assetId) =>
      dirOrNotFound(slug, (dir) => clearPendingTaskCompleting(dir, assetId)),
    findAll: (slug) => dirOrNotFound(slug, (dir) => findAllPendingTasks(dir)),
    findByExternalId: (slug, taskId) =>
      dirOrNotFound(slug, (dir) => findPendingTaskByExternalId(dir, taskId)),
    fail: ((
      slug: string,
      assetId: string,
      expectedTaskIdOrInfo: string | FailureInfo,
      maybeInfo?: FailureInfo,
    ): Promise<Result<GenerationError | null, FsError>> => {
      const expectedTaskId =
        typeof expectedTaskIdOrInfo === "string"
          ? expectedTaskIdOrInfo
          : undefined;
      const info: FailureInfo =
        typeof expectedTaskIdOrInfo === "string"
          ? (maybeInfo as FailureInfo)
          : expectedTaskIdOrInfo;
      return dirOrNotFound(slug, (dir) =>
        failPendingTask(dir, assetId, expectedTaskId, info),
      );
    }) as ProjectScopedPendingTasks["fail"],
    forceFail: (slug, assetId, info) =>
      dirOrNotFound(slug, (dir) => forceFailPendingTask(dir, assetId, info)),
    getOwner: async (slug, assetId, taskId) => {
      const dir = await resolve(slug);
      if (!dir) return null;
      return getPendingTaskOwner(dir, assetId, taskId);
    },
  };
}

function makeAssetWork(
  resolve: (slug: string) => Promise<string | null>,
): ProjectScopedAssetWork {
  return {
    begin: async (slug, assetId, input) => {
      const dir = await resolve(slug);
      if (!dir) return null;
      return beginAssetWork(dir, assetId, input);
    },
    complete: async (slug, assetId, ownerId) => {
      const dir = await resolve(slug);
      if (!dir) return false;
      return completeAssetWork(dir, assetId, ownerId);
    },
    fail: async (slug, assetId, ownerId, failure) => {
      const dir = await resolve(slug);
      if (!dir) return false;
      return failAssetWork(dir, assetId, ownerId, failure);
    },
    renew: async (slug, assetId, ownerId, extendMs) => {
      const dir = await resolve(slug);
      if (!dir) return false;
      return renewAssetWork(dir, assetId, ownerId, extendMs);
    },
    markSeen: async (slug, assetId) => {
      const dir = await resolve(slug);
      if (!dir) return false;
      return markAssetSeen(dir, assetId);
    },
    read: async (slug, assetId) => {
      const dir = await resolve(slug);
      if (!dir) return err({ code: "NOT_FOUND", message: "Project not found" });
      return readAssetRow(dir, assetId);
    },
    list: async (slug) => {
      const dir = await resolve(slug);
      if (!dir) return err({ code: "NOT_FOUND", message: "Project not found" });
      return listAssetRows(dir);
    },
  };
}

function makeGenerationErrors(
  resolve: (slug: string) => Promise<string | null>,
): ProjectScopedGenerationErrors {
  async function dirOrNotFoundSync<T>(
    slug: string,
    fn: (dir: string) => Result<T, FsError>,
  ): Promise<Result<T, FsError>> {
    const dir = await resolve(slug);
    if (!dir) return err({ code: "NOT_FOUND", message: "Project not found" });
    return fn(dir);
  }
  async function dirOrNotFoundAsync<T>(
    slug: string,
    fn: (dir: string) => Promise<Result<T, FsError>>,
  ): Promise<Result<T, FsError>> {
    const dir = await resolve(slug);
    if (!dir) return err({ code: "NOT_FOUND", message: "Project not found" });
    return fn(dir);
  }
  return {
    write: (slug, assetId, info) =>
      dirOrNotFoundSync(slug, (dir) =>
        writeGenerationError(dir, assetId, info),
      ),
    read: (slug, assetId) =>
      dirOrNotFoundSync(slug, (dir) => readGenerationError(dir, assetId)),
    clear: (slug, assetId) =>
      dirOrNotFoundAsync(slug, (dir) => clearGenerationError(dir, assetId)),
    findAll: (slug) =>
      dirOrNotFoundSync(slug, (dir) => findAllGenerationErrors(dir)),
  };
}

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
      opts: import("./queue/types.js").EnqueueOptions,
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
  ProjectRevision,
  RevisionFileChange,
  LockData,
  ActionLogEntry,
  AssetEntry,
  FsError,
  FsErrorCode,
  FsConfig,
  ContentStore,
  ContentStoreHead,
  StorageStatus,
  StorageSyncState,
} from "./types.js";
export type {
  EntityDocument,
  EntityType,
  NotebookCell,
  NotebookCellType,
  NotebookDocument,
  NotebookEdge,
  NotebookPosition,
  NotebookRun,
} from "./notebook/types.js";

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
export { runGitMaintenance } from "./git/init.js";
export { isValidProjectSlug } from "./project/slug.js";
export type { AudioWaveformRecord } from "./db/audio-waveforms.js";
export type {
  PromptHistoryEntry,
  RecordPromptArgs,
  ListPromptHistoryArgs,
} from "./db/prompt-history.js";

export type {
  PendingTask,
  GenerationError,
  FailureInfo,
  TaskType,
  WritePendingTaskInput,
  WritePendingTaskResult,
} from "./pending-task/index.js";
export { QUEUED_TASK_ID } from "./pending-task/index.js";

export type {
  AssetWorkKind,
  AssetOwnerKind,
  AssetMeta,
  AssetView,
  BeginAssetWorkInput,
} from "./asset/work.js";

export {
  beginAssetWork,
  completeAssetWork,
  failAssetWork,
  renewAssetWork,
  markAssetSeen,
  readAssetRow,
  listAssetRows,
} from "./asset/work.js";

export { recoverAssetRow, recoverAssetsTable } from "./asset/recover.js";
export { startAssetReaper, runReaperPass } from "./asset/reaper.js";

export type {
  AssetStatus,
  AssetStatusInput,
  GetAssetStatusOptions,
} from "./asset/status.js";
export { computeAssetStatus } from "./asset/status.js";

export {
  findAudioFile,
  findVideoFile,
  findPrimaryMediaFile,
  RENDER_ORIENTATIONS,
} from "./asset/media-files.js";
export type { RenderOrientation } from "./asset/media-files.js";

export {
  parseAssetTags,
  resolveAllAssets,
  expandSlotRefs,
} from "./asset/resolver.js";
export type { ResolvedAsset } from "./asset/resolver.js";

export {
  logUserTurn,
  logAssistantTurn,
  getRecentHistory,
  formatHistoryForPrompt,
} from "./chat-log.js";
export type { ChatLogEntry } from "./chat-log.js";
