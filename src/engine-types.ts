export type ArtifactKind =
  | "video"
  | "image"
  | "audio"
  | "script"
  | "character"
  | "prompt"
  | "scene"
  | "notebook"
  | "final";

export type EngineErrorCode =
  | "NOT_FOUND"
  | "ALREADY_EXISTS"
  | "SLUG_CONFLICT"
  | "INVALID_INPUT"
  | "IO_ERROR"
  | "STORAGE_ERROR"
  | "OBJECT_UNAVAILABLE"
  | "SCHEMA_INCOMPATIBLE"
  | "STALE_REVISION"
  | "ACTION_CONFLICT"
  | "LOCKED"
  | "DIVERGED"
  | "OFFLINE"
  | "NOT_READY"
  | "FEATURE_UNAVAILABLE";

export interface EngineError {
  code: EngineErrorCode;
  message: string;
  ownerId?: string;
  details?: Record<string, unknown>;
}

export type Result<T, E = EngineError> =
  | { ok: true; value: T; revision?: string }
  | { ok: false; error: E };

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
}

export interface CatalogBackupConfig {
  name: string;
  url: string;
}

interface EngineConfigBase {
  remoteObjects?: ContentStore;
  objectPrefix?: string;
  catalogBackup?: CatalogBackupConfig;
  runtimeRetentionMs?: number;
  similarity?: SimilarityConfig;
}

export type EngineConfig = EngineConfigBase &
  (
    | { rootDir: string; dataDir?: never; workspaceDir?: never }
    | { rootDir?: never; dataDir: string; workspaceDir: string }
  );

export type SimilarityKind = "image" | "video" | "text";

export interface SimilarityEmbeddingProvider {
  readonly embeddingSpace: string;
  readonly dimensions: number;
  prepare(): Promise<void>;
  embedImage(sourcePath: string): Promise<Float32Array>;
  embedVideo(sourcePath: string): Promise<{
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
  readonly embeddingSpace: string;
  readonly dimensions: number;
  prepare(): Promise<void>;
  embedText(text: string): Promise<SimilarityTextChunk[]>;
}

export interface SimilarityTextConfig {
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
  /** Enables semantic JSON, Markdown, and text similarity when present. */
  text?: SimilarityTextConfig;
}

export interface SimilarityIndexOptions {
  force?: boolean;
}

export interface SimilarityQueryOptions {
  limit?: number;
  minScore?: number;
  includeSelf?: boolean;
}

export interface SimilarityIndexResult {
  artifactId: string;
  projectId: string;
  kind: SimilarityKind;
  embeddingSpace: string;
  frameCount: number | null;
  chunkCount?: number;
  reused: boolean;
}

export interface SimilarityStatus {
  artifactId: string;
  projectId: string;
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
  projectId: string;
  slug: string;
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
  textCount: number;
  embeddingSpaces: Partial<Record<SimilarityKind, string>>;
}

export interface SimilarityPrepareOptions {
  kind?: SimilarityKind;
}

export type SimilarityTextQueryOptions = Omit<
  SimilarityQueryOptions,
  "includeSelf"
>;

export interface SimilarityApi {
  prepare(
    options?: SimilarityPrepareOptions,
  ): Promise<
    Result<
      {
        embeddingSpace: string;
        embeddingSpaces: Partial<Record<SimilarityKind, string>>;
      },
      EngineError
    >
  >;
  index(
    project: string,
    artifact: string,
    options?: SimilarityIndexOptions,
  ): Promise<Result<SimilarityIndexResult, EngineError>>;
  rebuild(
    project: string,
    options?: { kind?: SimilarityKind; force?: boolean },
  ): Promise<Result<SimilarityIndexResult[], EngineError>>;
  status(project: string, artifact: string): Result<SimilarityStatus, EngineError>;
  stats(project: string): Result<SimilarityStats, EngineError>;
  findSimilar(
    project: string,
    artifact: string,
    options?: SimilarityQueryOptions,
  ): Promise<Result<SimilarityMatch[], EngineError>>;
  findSimilarText(
    project: string,
    query: string,
    options?: SimilarityTextQueryOptions,
  ): Promise<Result<SimilarityMatch[], EngineError>>;
}

export interface Project {
  projectId: string;
  slug: string;
  createdAt: number;
  updatedAt: number;
  path: string;
  isDefault: boolean;
}

export interface Artifact {
  artifactId: string;
  projectId: string;
  slug: string;
  kind: ArtifactKind;
  createdAt: number;
  updatedAt: number;
  path: string;
}

export interface CreateArtifactInput {
  project: string;
  kind: ArtifactKind | string;
  /** Name used to derive a canonical kind-prefixed slug. */
  name?: string;
  /** Explicit slug; the canonical kind prefix is added when omitted. */
  slug?: string;
}

export interface RenameArtifactInput {
  project: string;
  artifact: string;
  /** Name used to derive the artifact's new canonical slug. */
  name?: string;
  /** Explicit new slug; the canonical kind prefix is added when omitted. */
  slug?: string;
}

export interface ArtifactManifestFile {
  name: string;
  sizeBytes: number;
  extension: string | null;
  mtimeMs: number;
  mimeType?: string;
  objectHash: string;
}

export interface ArtifactManifest {
  artifactId: string;
  slug: string;
  path: string;
  fileCount: number;
  files: ArtifactManifestFile[];
  directories?: Record<string, string[]>;
}

export interface RevisionFileChange {
  status: string;
  file: string;
  oldFile?: string;
}

export interface Revision {
  hash: string;
  message: string;
  date: string;
  author?: string;
  projectId?: string;
  operationId?: string;
  operation?: string;
  artifactId?: string;
  artifactSlug?: string;
  details?: Record<string, unknown>;
  files?: string[];
  fileChanges?: RevisionFileChange[];
}

export interface OperationInput {
  projectId: string;
  operation: string;
  artifactId?: string;
  details?: Record<string, unknown>;
  author?: string;
  baseRevision?: string;
  writeSet?: string[];
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
  id: number;
  projectId: string;
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

export type BackupState =
  | "unconfigured"
  | "pending"
  | "backed_up"
  | "offline"
  | "diverged";

export interface StorageStatus {
  state: BackupState;
  head: string;
  pendingObjects: number;
  lastError?: string;
}

export type JobState =
  | "queued"
  | "running"
  | "completing"
  | "done"
  | "failed"
  | "aborted";

export interface JobError {
  message: string;
  code?: string;
}

export interface Job {
  id: number;
  operationId: string;
  projectId: string;
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

export type JobHandler = (job: Job) => Promise<unknown>;

export interface RunnerConfig {
  concurrency: number;
  leaseMs?: number;
  pollIntervalMs?: number;
  reapIntervalMs?: number;
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
  slug: string;
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
  artifactSlug: string;
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
  artifactSlug: string;
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
  artifactSlug: string;
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
  updatedAt: number;
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
  projectId: string;
  role: string;
  body: T;
  createdAt: number;
}

export interface AppendMessageInput<T = Record<string, unknown>> {
  role: string;
  body: T;
}

export interface ResolvedArtifact {
  tag: string;
  artifactId: string;
  artifactSlug: string;
  artifactType: ArtifactKind;
  filePath: string | null;
  workspacePath: string;
}

export interface VersionCheckResult {
  ok: boolean;
  currentVersion: number;
  supportedVersion: number;
  reason?: string;
}
