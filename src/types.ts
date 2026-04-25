// Asset type discriminator
export type AssetType = "video" | "image" | "script" | "final" | "audio" | "character";

// Asset manifest types
export interface AssetManifestFile {
  name: string;
  size_bytes: number;
  extension: string | null;
}

export interface AssetManifest {
  asset_id: string;
  path: string;
  file_count: number;
  files: AssetManifestFile[];
  directories?: Record<string, string[]>;
}

// Project metadata derived from git history and directory name
export interface ProjectMetadata {
  slug: string;
  created: number;
  path?: string;
  is_default?: boolean;
  last_activity?: number;
}

// Git commit entry
export interface GitCommit {
  hash: string;
  message: string;
  date: string;
  author?: string;
  files?: string[];
}

// Lock data stored in lock files
export interface LockData {
  created_at: number;
  timeout_at: number;
  pid?: number;
  [key: string]: unknown;
}

// Asset listing entry
export interface AssetEntry {
  id: string;
  type: AssetType;
  created_at: string;
  path: string;
}

// Error codes for FsError
export type FsErrorCode =
  | "NOT_FOUND"
  | "ALREADY_EXISTS"
  | "GIT_ERROR"
  | "INVALID_INPUT"
  | "IO_ERROR"
  | "LOCKED";

export interface FsError {
  code: FsErrorCode;
  message: string;
}

// Action log entry from git commit
export interface ActionLogEntry {
  hash: string;
  action: string;
  payload: string | Record<string, unknown>;
  date: string;
}

// Config for createFs
export interface FsConfig {
  projectsDir: string;
  gitPath?: string;
}

// Discriminated union for Result<T, E>
export type Result<T, E> = { ok: true; value: T } | { ok: false; error: E };

export function ok<T>(value: T): Result<T, never> {
  return { ok: true, value };
}

export function err<E>(error: E): Result<never, E> {
  return { ok: false, error };
}
