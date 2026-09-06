import type { SemanticTable } from "./schema.js";

export type ArtifactKind =
  | "video"
  | "image"
  | "audio"
  | "script"
  | "character"
  | "prompt"
  | "scene"
  | "final";

export const ENGINE_ERROR_CODES = [
  "NOT_FOUND",
  "ALREADY_EXISTS",
  "IN_USE",
  "INVALID_INPUT",
  "INVALID_RANGE",
  "INVALID_TIMEBASE",
  "IO_ERROR",
  "STORAGE_ERROR",
  "OBJECT_UNAVAILABLE",
  "MEDIA_MISSING",
  "UNSUPPORTED_MEDIA",
  "SCHEMA_INCOMPATIBLE",
  "MANIFEST_INCOMPATIBLE",
  "INDEX_INCOMPLETE",
  "STALE_REVISION",
  "ACTION_CONFLICT",
  "MERGE_CONFLICT",
  "MERGE_VIOLATION",
  "SOURCE_REPLACED",
  "TRACK_LOCKED",
  "LOCKED",
  "DIVERGED",
  "OFFLINE",
  "NOT_READY",
  "MODEL_UNAVAILABLE",
  "FEATURE_UNAVAILABLE",
  "CANCELLED",
  "RESOURCE_EXHAUSTED",
  "TIMEOUT",
  "INTERNAL_ERROR",
] as const;

export type EngineErrorCode = (typeof ENGINE_ERROR_CODES)[number];

export interface EngineError {
  code: EngineErrorCode;
  message: string;
  ownerId?: string;
  details?: Record<string, unknown>;
}

export type Result<T, E = EngineError> =
  { ok: true; value: T; revision?: string } | { ok: false; error: E };

export function ok<T>(value: T, revision?: string): Result<T, never> {
  return revision === undefined
    ? { ok: true, value }
    : { ok: true, value, revision };
}

export function err<E>(error: E): Result<never, E> {
  return { ok: false, error };
}

export interface ContentStoreHead {
  exists: boolean;
  size?: number;
}

export interface ContentStore {
  head(key: string): Promise<ContentStoreHead>;
  uploadFile(key: string, sourcePath: string): Promise<void>;
  downloadFile(key: string, destinationPath: string): Promise<void>;
  /**
   * Unpublishes an object. Deleting a key that does not exist is not an
   * error, so unpublish is idempotent.
   */
  delete(key: string): Promise<void>;
}

export interface CatalogBackupConfig {
  name: string;
  url: string;
}

export interface EngineIdentity {
  /** Name recorded as the author of semantic commits. */
  name: string;
  /** Email recorded as the author of semantic commits. */
  email: string;
}

export type SemanticCommitBoundary =
  | "after-semantic-mutation"
  | "before-sql-commit"
  | "after-sql-commit"
  | "after-table-stage"
  | "before-dolt-commit"
  | "after-dolt-commit"
  | "before-outbox-delete"
  | "before-outbox-clear-commit"
  | "after-outbox-clear";

interface EngineConfigBase {
  /** Required only when initializing an empty engine root. */
  initialBookName?: string;
  remoteObjects?: ContentStore;
  objectPrefix?: string;
  catalogBackup?: CatalogBackupConfig;
  /** Commit author identity; defaults to a generic Videobook author. */
  identity?: EngineIdentity;
  runtimeRetentionMs?: number;
  similarity?: SimilarityConfig;
  semanticCommitBoundary?: (
    boundary: SemanticCommitBoundary,
    operationId: string,
  ) => void;
  /**
   * Catalog `dolt_gc` policy. Default: GC on open when the catalog file is
   * larger than 64 MiB without verified compaction metadata, and GC on close
   * after any runtime or semantic write.
   * Periodic GC-after-N-writes is not offered: cached prepared statements
   * would have to be dropped, and `dolt_gc` cannot run inside `serial()` or
   * an open transaction.
   */
  catalogGc?: CatalogGcConfig;
}

export type EngineConfig = EngineConfigBase &
  (
    | { rootDir: string; dataDir?: never; workspaceDir?: never }
    | { rootDir?: never; dataDir: string; workspaceDir: string }
  );

/** Bytes above which an existing catalog is GC'd at open. */
export const DEFAULT_CATALOG_GC_BYTES_THRESHOLD = 64 * 1024 * 1024;

export interface CatalogGcConfig {
  /** File size that triggers GC-at-open without verified compaction metadata. Default 64 MiB. */
  bytesThreshold?: number;
  /** Run `dolt_gc` at open when the catalog is bloated. Default true. */
  onOpen?: boolean;
  /** Run `dolt_gc` at close after any write in this session. Default true. */
  onClose?: boolean;
}

export type CatalogGcTrigger = "open" | "close" | "manual";

export interface CatalogGcReport {
  trigger: CatalogGcTrigger;
  /** Human-readable `dolt_gc()` summary, e.g. "3 chunks removed, 42 chunks kept". */
  summary: string;
  bytesBefore: number;
  bytesAfter: number;
  chunksRemoved: number | null;
  chunksKept: number | null;
}

export interface CatalogIntegritySnapshot {
  head: string;
  logCount: number;
  book: Book;
  artifacts: Array<{ artifactId: string; kind: ArtifactKind; label: string | null }>;
  notebooks: Array<{ notebookId: string; name: string }>;
  doltStatus: Array<{ table_name: string; staged: number; status: string }>;
  tableRowCounts: Record<string, number>;
}

export type SimilarityKind = "image" | "video" | "audio" | "text";

export interface MediaOperationOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface SearchProviderNetworkAccess {
  readonly modelDownloads: boolean;
  readonly inference: boolean;
}

export interface SearchProviderConsent {
  readonly modelDownloads?: boolean;
  readonly inference?: boolean;
}

export interface SimilarityEmbeddingProvider {
  /** Required at runtime for injected providers; omission fails closed before dispatch. */
  readonly networkAccess?: SearchProviderNetworkAccess;
  readonly embeddingSpace: string;
  readonly dimensions: number;
  prepare(options?: MediaOperationOptions): Promise<void>;
  embedImage(sourcePath: string, options?: MediaOperationOptions): Promise<Float32Array>;
  embedVideo(sourcePath: string, options?: MediaOperationOptions): Promise<{
    vector: Float32Array;
    frameCount: number;
  }>;
}

export interface SimilarityTextChunk {
  startOffset: number;
  endOffset: number;
  vector: Float32Array;
}

export interface SimilarityTextEmbeddingProvider {
  /** Required at runtime for injected providers; omission fails closed before dispatch. */
  readonly networkAccess?: SearchProviderNetworkAccess;
  readonly embeddingSpace: string;
  readonly dimensions: number;
  prepare(options?: MediaOperationOptions): Promise<void>;
  embedText(text: string, options?: MediaOperationOptions): Promise<SimilarityTextChunk[]>;
}

export interface SimilarityAudioEmbeddingProvider {
  /** Required at runtime for injected providers; omission fails closed before dispatch. */
  readonly networkAccess?: SearchProviderNetworkAccess;
  readonly embeddingSpace: string;
  readonly dimensions: number;
  prepare(options?: MediaOperationOptions): Promise<void>;
  embedAudio(sourcePath: string, options?: MediaOperationOptions): Promise<Float32Array>;
}

export interface SimilarityAudioConfig {
  /** Application consent for this injected provider; does not inherit across modalities. */
  providerConsent?: SearchProviderConsent;
  /** A Hugging Face CLAP model ID or a local compatible model directory. */
  modelId?: string;
  /** A cache directory for the audio model. */
  modelCacheDir?: string;
  /** Refuse network downloads when the audio model is not already available. */
  allowModelDownload?: boolean;
  /** FFmpeg executable used to decode audio to mono PCM. */
  ffmpegPath?: string;
  /** Test and advanced-use escape hatch for a local audio embedding implementation. */
  provider?: SimilarityAudioEmbeddingProvider;
}

export interface SimilarityTextConfig {
  /** Application consent for this injected provider; does not inherit across modalities. */
  providerConsent?: SearchProviderConsent;
  /** A Hugging Face model ID or a local compatible model directory. */
  modelId?: string;
  /** A cache directory for the text model. */
  modelCacheDir?: string;
  /** Refuse network downloads when the text model is not already available. */
  allowModelDownload?: boolean;
  /** Maximum canonical text source size. Defaults to 1 MiB. */
  maxSourceBytes?: number;
  /** Maximum chunks per document. Defaults to 256. */
  maxChunks?: number;
  /** Test and advanced-use escape hatch for a local text embedding implementation. */
  provider?: SimilarityTextEmbeddingProvider;
}

export interface SimilarityConfig {
  /** Application consent for this injected provider; does not inherit across modalities. */
  providerConsent?: SearchProviderConsent;
  /** Enables local similarity when present on the engine configuration. */
  modelCacheDir?: string;
  /** A Hugging Face model ID or a local compatible model directory. */
  modelId?: string;
  /** Refuse network downloads when the model is not already available. */
  allowModelDownload?: boolean;
  ffmpegPath?: string;
  ffprobePath?: string;
  /** Test and advanced-use escape hatch for a local embedding implementation. */
  provider?: SimilarityEmbeddingProvider;
  /** Enables local CLAP audio similarity when present. */
  audio?: SimilarityAudioConfig;
  /** Enables semantic JSON, Markdown, and text similarity when present. */
  text?: SimilarityTextConfig;
}

export interface SimilarityIndexOptions extends MediaOperationOptions {
  force?: boolean;
}

export interface SimilarityQueryOptions extends MediaOperationOptions {
  limit?: number;
  minScore?: number;
  includeSelf?: boolean;
}

export interface SimilarityIndexResult {
  artifactId: string;
  kind: SimilarityKind;
  embeddingSpace: string;
  frameCount: number | null;
  chunkCount?: number;
  reused: boolean;
}

export interface SimilarityStatus {
  artifactId: string;
  kind: SimilarityKind;
  state: "not_indexed" | "ready";
  embeddingSpace: string;
  objectHash?: string;
  frameCount?: number | null;
  chunkCount?: number;
  contentHash?: string;
  updatedAt?: number;
}

export interface SimilarityMatch {
  artifactId: string;
  label?: string;
  kind: SimilarityKind;
  score: number;
  exactBytes: boolean;
  exactContent?: boolean;
  embeddingSpace: string;
  text?: {
    sourcePath: string;
    chunkIndex: number;
    startOffset: number;
    endOffset: number;
    excerpt: string;
    queryStartOffset?: number;
    queryEndOffset?: number;
  };
  signals: {
    global: number;
  };
}

export interface SimilarityStats {
  embeddingSpace: string;
  imageCount: number;
  videoCount: number;
  audioCount: number;
  textCount: number;
  embeddingSpaces: Partial<Record<SimilarityKind, string>>;
}

export interface SimilarityPrepareOptions extends MediaOperationOptions {
  kind?: SimilarityKind;
}

export type SimilarityTextQueryOptions = Omit<
  SimilarityQueryOptions,
  "includeSelf"
>;

export interface SimilarityApi {
  prepare(options?: SimilarityPrepareOptions): Promise<
    Result<
      {
        embeddingSpace: string;
        embeddingSpaces: Partial<Record<SimilarityKind, string>>;
      },
      EngineError
    >
  >;
  index(
    artifact: string,
    options?: SimilarityIndexOptions,
  ): Promise<Result<SimilarityIndexResult, EngineError>>;
  rebuild(options?: {
    kind?: SimilarityKind;
    force?: boolean;
  } & MediaOperationOptions): Promise<Result<SimilarityIndexResult[], EngineError>>;
  status(artifact: string): Result<SimilarityStatus, EngineError>;
  stats(): Result<SimilarityStats, EngineError>;
  findSimilar(
    artifact: string,
    options?: SimilarityQueryOptions,
  ): Promise<Result<SimilarityMatch[], EngineError>>;
  findSimilarText(
    query: string,
    options?: SimilarityTextQueryOptions,
  ): Promise<Result<SimilarityMatch[], EngineError>>;
}

export interface Book {
  bookId: string;
  name: string;
  createdAt: number;
}

export interface Artifact {
  artifactId: string;
  /** Free-text display label; never a reference handle. */
  label?: string;
  kind: ArtifactKind;
  createdAt: number;
  path: string;
}

export interface CreateArtifactInput {
  kind: ArtifactKind | string;
  /** Free-text display label; never parsed or referenced. */
  label?: string;
}

export interface DeleteArtifactOptions {
  /** Remove owned streams/transcripts when no editorial references remain. */
  deleteOwnedMedia?: boolean;
}

export interface RenameArtifactInput {
  artifact: string;
  /** New free-text display label. */
  label: string;
}

export interface ArtifactManifestFile {
  name: string;
  sizeBytes: number;
  extension: string | null;
  mimeType?: string;
  objectHash: string;
}

export interface ArtifactManifest {
  artifactId: string;
  label?: string;
  path: string;
  fileCount: number;
  files: ArtifactManifestFile[];
  directories?: Record<string, string[]>;
}

export interface Revision {
  hash: string;
  message: string;
  /** Commit time as an ISO-8601 UTC timestamp. */
  date: string;
  author?: string;
  operationId?: string;
  operation?: string;
  artifactId?: string;
  artifactLabel?: string;
  details?: Record<string, unknown>;
}

export interface OperationInput {
  operation: string;
  /**
   * Every semantic table the mutation may INSERT, UPDATE, or DELETE,
   * including tables reached through ON DELETE CASCADE. The store probes
   * and stages exactly this set, and persists it in the commit outbox so
   * crash recovery stages the same set. Omitting a written table strands
   * its rows in the working set until the open-time integrity sweep
   * faults; declaring an unwritten table costs one cheap probe.
   */
  tables: readonly SemanticTable[];
  artifactId?: string;
  details?: Record<string, unknown>;
  author?: string;
  baseRevision?: string;
  writeSet?: string[];
  /**
   * Mint a commit even when the mutation changed no semantic rows.
   * Provenance-only operations (history.recordOperation, history.logAction)
   * use this so the commit itself is their record.
   */
  allowEmpty?: boolean;
}

export interface LockData {
  id: string;
  resource: string;
  ownerId: string;
  created_at: number;
  timeout_at: number;
  pid?: number;
  state?: string;
  data?: Record<string, unknown>;
}

export interface LockOptions {
  durationMs: number;
  state?: string;
  data?: Record<string, unknown>;
  ownerId?: string;
}

export interface ActionLogEntry {
  hash: string;
  action: string;
  payload: string | Record<string, unknown>;
  date: string;
}

export interface PromptHistoryEntry {
  id: string;
  surface: string;
  prompt: string;
  context: Record<string, unknown>;
  createdAt: number;
}

export interface RecordPromptArgs {
  surface: string;
  prompt: string;
  context?: Record<string, unknown>;
}

export interface ListPromptHistoryArgs {
  surface?: string;
  limit?: number;
}

export type GenerationStatus =
  "dispatched" | "awaiting_provider" | "completed" | "failed";

export interface Generation {
  generationId: string;
  notebookId: string;
  cellId: string;
  outputCellId?: string;
  runId?: string;
  status: GenerationStatus;
  tool: string;
  provider?: string;
  model?: string;
  prompt?: string;
  resolvedPrompt?: string;
  providerArtifactId?: string;
  outputArtifactId?: string;
  error?: string;
  createdAt: number;
  updatedAt: number;
}

export interface RecordGenerationArgs {
  notebookId: string;
  cellId: string;
  tool: string;
  status?: GenerationStatus;
  outputCellId?: string;
  runId?: string;
  provider?: string;
  model?: string;
  prompt?: string;
  resolvedPrompt?: string;
  providerArtifactId?: string;
  outputArtifactId?: string;
}

export interface GenerationPatch {
  status?: GenerationStatus;
  outputCellId?: string | null;
  runId?: string | null;
  provider?: string | null;
  model?: string | null;
  prompt?: string | null;
  resolvedPrompt?: string | null;
  providerArtifactId?: string | null;
  outputArtifactId?: string | null;
  error?: string | null;
}

export interface ListGenerationsArgs {
  limit?: number;
}

export type BackupState =
  "unconfigured" | "pending" | "backed_up" | "offline" | "diverged";

export interface StorageStatus {
  state: BackupState;
  head: string;
  pendingObjects: number;
  lastError?: string;
}

/**
 * One place at HEAD that references a content object. `table` is the
 * semantic table holding the reference and `id` identifies the referencing
 * row (for example `artifact:<id>:<path>` for a file mapping).
 */
export interface ObjectReference {
  table: string;
  id: string;
}

export interface DeleteObjectOptions {
  /**
   * Delete even when the object is still referenced at HEAD. This is the
   * takedown path: referencing rows become tombstones (hash + size remain)
   * and later reads surface OBJECT_UNAVAILABLE.
   */
  force?: boolean;
  /**
   * Unpublish the object from the configured remote content store. Defaults
   * to true whenever a remote is configured — a forget that leaves remote
   * bytes readable is not a forget. Pass false to skip the remote
   * explicitly.
   */
  remote?: boolean;
}

export interface DeleteObjectResult {
  hash: string;
  sizeBytes: number;
  deletedLocal: boolean;
  deletedRemote: boolean;
  /** HEAD references that were forcibly cut; empty for a clean delete. */
  severedReferences: ObjectReference[];
  /**
   * True when the object was already forgotten and this call only retried
   * byte removal (local and remote). Retries are idempotent: deleteObject
   * on a forgotten object finishes an interrupted delete instead of
   * failing NOT_FOUND.
   */
  alreadyForgotten: boolean;
}

export interface CollectGarbageOptions {
  /** Report what would be collected without deleting anything. */
  dryRun?: boolean;
  /**
   * Also unpublish from the configured remote store. The remote pass covers
   * every forgotten object — not just the ones with local bytes or a
   * runtime publication row — so an interrupted deleteObject or a lost
   * runtime table cannot leave remote bytes readable forever.
   */
  remote?: boolean;
  /**
   * Minimum age in milliseconds before a stray local file (bytes with no
   * objects row) is swept. Guards against sweeping an import that has
   * written its bytes but not yet committed its objects row. Default
   * 600000 (10 minutes).
   */
  strayGraceMs?: number;
  /**
   * Run Dolt's `dolt_gc()` afterwards to physically reclaim chunks left by
   * dropped table data in the versioned catalog.
   */
  doltGc?: boolean;
}

export interface CollectedObject {
  hash: string;
  sizeBytes: number;
}

export interface CollectGarbageResult {
  dryRun: boolean;
  scannedObjects: number;
  referencedObjects: number;
  collected: CollectedObject[];
  reclaimedBytes: number;
  /** Summary returned by `dolt_gc()` when the `doltGc` option was set. */
  doltGc?: string;
}

export type JobState =
  "queued" | "running" | "completing" | "done" | "failed" | "aborted";

export interface JobError {
  message: string;
  code?: string;
}

export interface Job {
  id: number;
  operationId: string;
  type: string;
  artifactId: string | null;
  externalTaskId: string | null;
  state: JobState;
  payload: Record<string, unknown>;
  result: unknown;
  attempts: number;
  maxAttempts: number;
  error: JobError | null;
  enqueuedAt: number;
  startedAt: number | null;
  finishedAt: number | null;
  leaseExpiresAt: number | null;
  fence: number;
}

export interface EnqueueOptions {
  type: string;
  artifactId?: string | null;
  externalTaskId?: string | null;
  payload: Record<string, unknown>;
  maxAttempts?: number;
  dedupeKey?: string | null;
  initialState?: "queued" | "running";
  artifactWorkKind?: ArtifactWorkKind | null;
  artifactWorkOrientation?: "portrait" | "landscape" | "square" | null;
}

export interface EnqueueResult {
  inserted: boolean;
  job: Job;
}

export interface CompleteOptions {
  result?: unknown;
}

export interface FailOptions {
  error: JobError;
  allowRetry?: boolean;
  preserveArtifactState?: boolean;
}

export interface ListJobsOptions {
  states?: JobState[];
  type?: string;
  artifactId?: string;
  limit?: number;
}

export type JobHandler = (job: Job, signal?: AbortSignal) => Promise<unknown>;

export interface RunnerConfig {
  concurrency: number;
  leaseMs?: number;
  pollIntervalMs?: number;
  reapIntervalMs?: number;
  jobTypes?: readonly string[];
  preferredJobTypes?: readonly string[];
  resolveHandler: (type: string) => JobHandler | null;
}

export type ArtifactWorkKind =
  | "render"
  | "generate"
  | "transcribe"
  | "isolate"
  | "download"
  | "archive"
  | "trim"
  | "crop"
  | "splice"
  | "reverse"
  | "change_speed"
  | "replace_audio"
  | "process"
  | "analyze"
  | "delete"
  | "upload"
  | "describe"
  | "rewrite_script"
  | "extract"
  | "apply_cuts"
  | "apply_sfx"
  | "final";

export type ArtifactOwnerKind = "job" | "provider";
export type ArtifactRuntimeStatus = "pending" | "working" | "ready" | "error";

export interface ArtifactRuntimeMeta {
  kind?: ArtifactWorkKind | null;
  orientation?: "portrait" | "landscape" | "square" | null;
  queued?: boolean;
  progress?: number | null;
  error?: { message: string; code: string | null } | null;
  [extra: string]: unknown;
}

export interface BeginArtifactWorkInput {
  kind: ArtifactWorkKind;
  ownerKind: ArtifactOwnerKind;
  durationMs: number;
  pid?: number;
  meta?: Partial<ArtifactRuntimeMeta>;
}

export type BeginAssetWorkInput = BeginArtifactWorkInput;

export interface ArtifactView {
  artifactId: string;
  label?: string;
  status: ArtifactRuntimeStatus;
  meta: ArtifactRuntimeMeta;
  ownerId: string | null;
  ownerKind: ArtifactOwnerKind | null;
  pid: number | null;
  deadlineAt: number | null;
  updatedAt: number;
  seenAt: number | null;
}

export type TaskType = string;
export const QUEUED_TASK_ID = "queued";

export interface PendingTask {
  artifactId: string;
  taskId: string;
  taskType: TaskType;
  workspacePath: string;
  createdAt: number;
  meta: Record<string, unknown>;
  completing: boolean;
  ownerId: string | null;
}

export interface FailureInfo {
  message: string;
  failCode?: string;
  prompt?: string | null;
}

export interface GenerationError {
  artifactId: string;
  message: string;
  failCode?: string;
  prompt?: string | null;
  failedAt: number;
}

export interface WritePendingTaskInput {
  artifactId: string;
  taskId: string;
  taskType: TaskType;
  meta?: Record<string, unknown>;
}

export interface WritePendingTaskResult {
  task: PendingTask;
  inserted: boolean;
}

export type ArtifactStatus =
  | "uploading"
  | "loading"
  | "generating"
  | "processing"
  | "analyzing"
  | "trimming"
  | "cropping"
  | "splicing"
  | "reversing"
  | "changing-speed"
  | "replacing-audio"
  | "isolating"
  | "rendering"
  | "rendering-landscape"
  | "rendering-portrait"
  | "rendering-square"
  | "render-queued"
  | "render-queued-landscape"
  | "render-queued-portrait"
  | "render-queued-square"
  | "downloading"
  | "archiving"
  | "transcribing"
  | "error"
  | "deleting"
  | "ready";

export type AssetStatus = ArtifactStatus;

export interface ArtifactStatusInput {
  kind: ArtifactKind;
  fileNames: ReadonlySet<string>;
  primaryMediaName: string | null;
  hasOriginalMetadata: boolean;
  hasPartFile: boolean;
  lockData: LockData | null;
  pendingTask: PendingTask | null;
  generationError: GenerationError | null;
  artifactRow: {
    status: ArtifactRuntimeStatus;
    meta: ArtifactRuntimeMeta;
    deadlineAt?: number | null;
  } | null;
}

export type AssetStatusInput = ArtifactStatusInput;

export interface GetArtifactStatusOptions {
  primaryMediaName?: string | null;
}

export type GetAssetStatusOptions = GetArtifactStatusOptions;

export interface AudioWaveformRecord {
  artifactId: string;
  peaks: number[];
}

export interface ChatLogEntry {
  role: "user" | "assistant";
  text?: string;
  tool?: string;
  params?: Record<string, unknown>;
  message?: string;
  error?: boolean;
  ts: number;
}

export interface Message<T = Record<string, unknown>> {
  messageId: string;
  role: string;
  body: T;
  createdAt: number;
}

export interface AppendMessageInput<T = Record<string, unknown>> {
  role: string;
  body: T;
}

export interface VersionCheckResult {
  ok: boolean;
  currentVersion: number;
  supportedVersion: number;
  reason?: string;
}
