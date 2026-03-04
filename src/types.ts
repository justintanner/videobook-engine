// Asset status — matches clipfirst-ui/shared/schema.ts
export type AssetStatus =
  | 'downloading'
  | 'generating'
  | 'transcribing'
  | 'rendering'
  | 'rendering-landscape'
  | 'rendering-portrait'
  | 'rendering-square'
  | 'render-queued'
  | 'render-queued-landscape'
  | 'render-queued-portrait'
  | 'render-queued-square'
  | 'error'
  | 'render-error'
  | 'render-error-landscape'
  | 'render-error-portrait'
  | 'render-error-square'
  | 'ready'
  | 'unreviewed'
  | 'whitelisted'
  | 'corrupt';

// Asset type discriminator — matches clipfirst-ui/shared/schema.ts
export type AssetType = 'video' | 'image' | 'script' | 'final' | 'audio' | 'plan';

export type Orientation = 'landscape' | 'portrait' | 'square';

// Asset manifest types — matches clipfirst-ui/shared/schema.ts
export interface AssetManifestFile {
  name: string;
  size_bytes: number;
  extension: string | null;
}

export interface AssetManifestFrames {
  original_frames?: string[];
  landscape_frames?: string[];
  portrait_frames?: string[];
  square_frames?: string[];
}

export interface AssetManifest {
  asset_id: string;
  path: string;
  file_count: number;
  files: AssetManifestFile[];
  frames?: AssetManifestFrames;
}

// Project metadata as stored in .project file
export interface ProjectMetadata {
  slug: string;
  created: number;
  orientations?: string[];
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
}

// Lock data stored in lock files
export interface LockData {
  created_at: number;
  pid?: number;
  [key: string]: unknown;
}

// Asset listing entry
export interface AssetEntry {
  id: string;
  type: AssetType;
  status: AssetStatus;
  created_at: string;
  file_path: string | null;
  // video-specific
  width?: number;
  height?: number;
  duration?: number;
  origin?: string;
  has_subtitles?: boolean;
  source_url?: string;
  // script-specific
  prompt?: string;
  dialog_audio?: string | null;
  dialog_audio_hash?: string | null;
}

// Original metadata from .original.json
export interface OriginalMetadata {
  origin?: string;
  task_id?: string;
  source_url?: string;
  source_asset?: string;
  source_project?: string;
  renamed_from?: string;
  width?: number;
  height?: number;
  duration?: number;
  thumbnail?: string;
  osg_text?: string;
  osg_logo_text?: string;
  osg_qr_url?: string;
  [key: string]: unknown;
}

// Tool parameters from .tool.params.json
export interface ToolParams {
  tool?: string;
  model?: string;
  prompt?: string;
  created_at?: number;
  project_slug?: string;
  [key: string]: unknown;
}

// Error codes for FsError
export type FsErrorCode =
  | 'NOT_FOUND'
  | 'ALREADY_EXISTS'
  | 'LOCK_HELD'
  | 'LOCK_NOT_FOUND'
  | 'GIT_ERROR'
  | 'INVALID_INPUT'
  | 'IO_ERROR'
  | 'LOCKED';

export interface FsError {
  code: FsErrorCode;
  message: string;
}

// Config for createFs
export interface FsConfig {
  outputDir: string;
  gitPath?: string;
}
