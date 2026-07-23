export type AssetType =
  | "video"
  | "image"
  | "script"
  | "final"
  | "audio"
  | "character"
  | "prompt"
  | "scene"
  | "notebook";

export interface AssetManifestFile {
  name: string;
  size_bytes: number;
  extension: string | null;
  mtimeMs: number;
}

export interface AssetManifest {
  asset_id: string;
  path: string;
  file_count: number;
  files: AssetManifestFile[];
  directories?: Record<string, string[]>;
}

export interface ProjectMetadata {
  slug: string;
  created: number;
  path?: string;
  is_default?: boolean;
  last_activity?: number;
}

export interface RevisionFileChange {
  status: string;
  file: string;
  oldFile?: string;
}

export interface ProjectRevision {
  hash: string;
  message: string;
  date: string;
  author?: string;
  projectId?: string;
  operationId?: string;
  operation?: string;
  assetId?: string;
  details?: Record<string, unknown>;
  files?: string[];
  fileChanges?: RevisionFileChange[];
}

export type GitCommit = ProjectRevision;

export interface LockData {
  created_at: number;
  timeout_at: number;
  pid?: number;
  [key: string]: unknown;
}

export interface AssetEntry {
  id: string;
  type: AssetType;
  created_at: string;
  path: string;
}

export type FsErrorCode =
  | "NOT_FOUND"
  | "ALREADY_EXISTS"
  | "GIT_ERROR"
  | "STORAGE_ERROR"
  | "OBJECT_UNAVAILABLE"
  | "LEGACY_DATA_FOUND"
  | "SYNC_DIVERGED"
  | "INVALID_INPUT"
  | "IO_ERROR"
  | "LOCKED";

export interface FsError {
  code: FsErrorCode;
  message: string;
}

export interface ActionLogEntry {
  hash: string;
  action: string;
  payload: string | Record<string, unknown>;
  date: string;
}

export interface ContentStoreHead {
  exists: boolean;
  size?: number;
}

export interface ContentStore {
  head(key: string): Promise<ContentStoreHead>;
  uploadFile(key: string, sourcePath: string): Promise<void>;
  downloadFile(key: string, destinationPath: string): Promise<void>;
}

export type StorageSyncState =
  | "synced"
  | "ahead"
  | "offline"
  | "syncing"
  | "diverged"
  | "blocked";

export interface StorageStatus {
  state: StorageSyncState;
  head: string;
  pendingObjects: number;
  lastError?: string;
}

export interface FsConfig {
  projectsDir: string;
  dataDir?: string;
  objectStore?: ContentStore;
  objectPrefix?: string;
  branch?: string;
  gitPath?: string;
}

export type Result<T, E> = { ok: true; value: T } | { ok: false; error: E };

export function ok<T>(value: T): Result<T, never> {
  return { ok: true, value };
}

export function err<E>(error: E): Result<never, E> {
  return { ok: false, error };
}
