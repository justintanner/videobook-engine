import type {
  ArtifactKind,
  EngineError,
  EngineErrorCode,
  MediaOperationOptions,
} from "./engine-types.js";
import type {
  MediaSourceSnapshot,
  Rational,
  SearchLocation,
  SequenceRange,
  SourcePoint,
  SourceRange,
} from "./mvp-time.js";

export const MVP_CONTRACT_VERSION = 1 as const;
export const MVP_SCHEMA_VERSION = 24 as const;
export const MVP_LEGACY_SCHEMA_VERSION = 4 as const;
export const MVP_PREVIOUS_SCHEMA_VERSION = 5 as const;

export const MVP_CONTRACT_COMPATIBILITY = {
  contractVersion: MVP_CONTRACT_VERSION,
  schemaVersion: MVP_SCHEMA_VERSION,
  minimumReaderContractVersion: 1,
  legacySchemaVersions: [
    MVP_LEGACY_SCHEMA_VERSION,
    MVP_PREVIOUS_SCHEMA_VERSION,
  ],
  legacyTimelineApi: "compile-to-sequence",
  legacySimilarityApi: "read-only-adapter",
} as const;

export type MvpContractCompatibility = typeof MVP_CONTRACT_COMPATIBILITY;

export type MediaStreamKind = "video" | "audio";

export interface ArtifactStream {
  streamId: string;
  artifactId: string;
  sourcePath: string;
  objectHash: string;
  streamIndex: number;
  kind: MediaStreamKind;
  timeBase: Rational;
  durationTicks: number;
  codec: string;
  video?: {
    width: number;
    height: number;
    rotationDegrees: number;
    pixelAspect: Rational;
    nominalFrameRate?: Rational;
    averageFrameRate?: Rational;
  };
  audio?: {
    sampleRateHz: number;
    channels: number;
    channelLayout: string;
  };
}

export type RegisterArtifactStreamInput = Omit<ArtifactStream, "streamId"> & {
  streamId?: string;
};

export type MediaProfileState =
  "complete" | "partial" | "stale" | "failed" | "unsupported";

export interface MediaProfile {
  artifactId: string;
  sourcePath: string;
  objectHash: string;
  probeVersion: string;
  container: string;
  streams: ArtifactStream[];
  state: MediaProfileState;
  error?: EngineError;
  updatedAt: number;
}

export type TranscriptSegmentKind =
  "speech" | "music" | "sound" | "silence" | "other";

export interface TranscriptWord {
  wordId: string;
  ordinal: number;
  startTick: number;
  durationTicks: number;
  text: string;
  confidence?: number;
  corrected: boolean;
}

export interface TranscriptSegment {
  segmentId: string;
  ordinal: number;
  range: SourceRange;
  speaker?: string;
  text: string;
  confidence?: number;
  kind: TranscriptSegmentKind;
  words: TranscriptWord[];
}

export interface Transcript {
  transcriptId: string;
  artifactId: string;
  streamId: string;
  objectHash: string;
  /**
   * SHA-256 of the CAS object holding the segment/word text payload. Bulk
   * transcript text lives behind this hash so it can be forgotten by object
   * deletion; the versioned rows keep only structure (IDs, ticks, speaker,
   * confidence, kind). Reads of a transcript whose payload object was
   * deleted surface OBJECT_UNAVAILABLE.
   */
  payloadHash: string;
  /**
   * False when the payload object was forgotten (deleted from CAS): the
   * transcript keeps its structure (IDs, ticks, speaker, kind) but every
   * segment and word text is empty. `transcripts.list` degrades this way;
   * `transcripts.get` still surfaces OBJECT_UNAVAILABLE.
   */
  payloadAvailable: boolean;
  language: string;
  provider?: string;
  model?: string;
  revision: string;
  segments: TranscriptSegment[];
  createdAt: number;
}

export type ImportTranscriptWord = Omit<TranscriptWord, "wordId"> & {
  wordId?: string;
};

export type ImportTranscriptSegment = Omit<
  TranscriptSegment,
  "segmentId" | "words"
> & {
  segmentId?: string;
  words: ImportTranscriptWord[];
};

export interface ImportTranscriptInput {
  transcriptId?: string;
  artifactId: string;
  streamId: string;
  objectHash: string;
  language: string;
  provider?: string;
  model?: string;
  state?: "current" | "derived";
  segments: ImportTranscriptSegment[];
}

export interface ReviseTranscriptInput {
  transcriptId?: string;
  sourceTranscriptId: string;
  language?: string;
  provider?: string;
  model?: string;
  segments: ImportTranscriptSegment[];
}

export interface TranscriptSelection {
  transcriptId: string;
  transcriptRevision: string;
  startWordId: string;
  endWordId: string;
  range: SourceRange;
}

export type SequenceTrackKind = "video" | "audio" | "caption";

interface SequenceTrackBase {
  trackId: string;
  sequenceId: string;
  ordinal: number;
  name: string;
  enabled: boolean;
  locked: boolean;
}

export interface VideoTrack extends SequenceTrackBase {
  kind: "video";
  blendMode: "normal";
}

export interface AudioTrack extends SequenceTrackBase {
  kind: "audio";
  muted: boolean;
  solo: boolean;
}

export interface CaptionTrack extends SequenceTrackBase {
  kind: "caption";
}

export type SequenceTrack = VideoTrack | AudioTrack | CaptionTrack;

export interface ClipTransform {
  fit: "fit" | "fill" | "crop";
  positionX: number;
  positionY: number;
  scaleX: number;
  scaleY: number;
  anchorX: number;
  anchorY: number;
  rotationDegrees: number;
  cropTop: number;
  cropRight: number;
  cropBottom: number;
  cropLeft: number;
  opacity: number;
  blendMode: "normal";
}

export interface ClipAudio {
  gainDb: number;
  muted: boolean;
  fadeInFrames: number;
  fadeOutFrames: number;
}

interface SequenceClipBase {
  clipId: string;
  trackId: string;
  timelineStartFrame: number;
  durationFrames: number;
  enabled: boolean;
  linkGroupId?: string;
  transform?: ClipTransform;
  audio?: ClipAudio;
}

export interface StillSequenceClip extends SequenceClipBase {
  source: Extract<MediaSourceSnapshot, { kind: "still" }>;
}

export interface TimedSequenceClip extends SequenceClipBase {
  source: Extract<MediaSourceSnapshot, { kind: "timed" }>;
  speed: Rational;
  reverse: boolean;
  audioPolicy: "preserve-pitch" | "resample" | "mute";
}

export type SequenceClip = StillSequenceClip | TimedSequenceClip;

export interface SequenceTransition {
  transitionId: string;
  trackId: string;
  outgoingClipId: string;
  incomingClipId: string;
  kind: "cut" | "dissolve";
  durationFrames: number;
  alignment: "start" | "center" | "end";
}

export interface CaptionCue {
  cueId: string;
  trackId: string;
  timelineStartFrame: number;
  durationFrames: number;
  text: string;
  speaker?: string;
  styleId: string;
  transcriptSelection?: TranscriptSelection;
}

export interface Sequence {
  sequenceId: string;
  name: string;
  width: number;
  height: number;
  pixelAspect: Rational;
  frameRate: Rational;
  audioSampleRateHz: number;
  audioChannelLayout: string;
  backgroundRgba: [number, number, number, number];
  revision: string;
  tracks: SequenceTrack[];
  clips: SequenceClip[];
  transitions: SequenceTransition[];
  captions: CaptionCue[];
  createdAt: number;
}

export interface CreateSequenceInput {
  sequenceId?: string;
  name: string;
  width: number;
  height: number;
  pixelAspect?: Rational;
  frameRate: Rational;
  audioSampleRateHz?: number;
  audioChannelLayout?: string;
  backgroundRgba?: [number, number, number, number];
  videoTrackCount?: number;
  audioTrackCount?: number;
  captionTrackCount?: number;
}

export interface UpdateSequenceCanvasInput {
  width: number;
  height: number;
}

export interface UpdateSequenceTrackInput {
  name?: string;
  enabled?: boolean;
  locked?: boolean;
  muted?: boolean;
  solo?: boolean;
}

export interface CreateSequenceTrackInput {
  kind: "video" | "audio" | "caption";
  name?: string;
}

export type SourceSurface = "ui" | "slash" | "chat" | "system";

export type ConfirmationPolicy =
  "always" | "risk-based" | "reversible-single-step";

export interface ClipPlacement {
  trackId: string;
  timelineStartFrame: number;
  durationFrames: number;
  source: MediaSourceSnapshot;
  speed?: Rational;
  reverse?: boolean;
  audioPolicy?: "preserve-pitch" | "resample" | "mute";
  transform?: ClipTransform;
  audio?: ClipAudio;
}

export interface InsertClipOperation {
  kind: "insert-clip";
  clipId?: string;
  placement: ClipPlacement;
  mode: "insert" | "overwrite";
}

export interface RemoveRangeOperation {
  kind: "remove-range";
  trackIds: string[];
  range: SequenceRange;
  ripple: boolean;
}

export interface MoveClipOperation {
  kind: "move-clip";
  clipId: string;
  trackId: string;
  timelineStartFrame: number;
}

export interface TrimClipOperation {
  kind: "trim-clip";
  clipId: string;
  timelineStartFrame: number;
  durationFrames: number;
  sourceRange?: SourceRange;
}

export interface SplitClipOperation {
  kind: "split-clip";
  clipId: string;
  splitFrame: number;
  leftClipId?: string;
  rightClipId?: string;
}

export interface RestoreClipOperation {
  kind: "restore-clip";
  sourceActionId: string;
  sourceClipId: string;
  placement: ClipPlacement;
}

export interface SetClipTransformOperation {
  kind: "set-clip-transform";
  clipId: string;
  transform: ClipTransform;
}

export interface SetClipAudioOperation {
  kind: "set-clip-audio";
  clipId: string;
  audio: ClipAudio;
}

export interface SetClipSpeedOperation {
  kind: "set-clip-speed";
  clipId: string;
  speed: Rational;
  reverse: boolean;
  audioPolicy: "preserve-pitch" | "resample" | "mute";
}

export interface SetTransitionOperation {
  kind: "set-transition";
  transition: SequenceTransition | null;
  outgoingClipId: string;
  incomingClipId: string;
}

export interface UpsertCaptionCueOperation {
  kind: "upsert-caption-cue";
  cue: CaptionCue;
}

export interface BatchReplaceRangeOperation {
  kind: "batch-replace-range";
  range: SequenceRange;
  trackIds: string[];
  placements: ClipPlacement[];
  ripple: boolean;
}

export const MVP_EDIT_OPERATION_KINDS = [
  "insert-clip",
  "remove-range",
  "move-clip",
  "trim-clip",
  "split-clip",
  "restore-clip",
  "set-clip-transform",
  "set-clip-audio",
  "set-clip-speed",
  "set-transition",
  "upsert-caption-cue",
  "batch-replace-range",
] as const;

export type EditOperation =
  | InsertClipOperation
  | RemoveRangeOperation
  | MoveClipOperation
  | TrimClipOperation
  | SplitClipOperation
  | RestoreClipOperation
  | SetClipTransformOperation
  | SetClipAudioOperation
  | SetClipSpeedOperation
  | SetTransitionOperation
  | UpsertCaptionCueOperation
  | BatchReplaceRangeOperation;

export interface EditIntent {
  intentVersion: typeof MVP_CONTRACT_VERSION;
  commandId: string;
  sequenceId: string;
  baseRevision: string;
  actor: string;
  sourceSurface: SourceSurface;
  confirmationPolicy: ConfirmationPolicy;
  operations: EditOperation[];
}

export interface NormalizedEditOperation {
  operationId: string;
  ordinal: number;
  operation: EditOperation;
}

export type EditWarningCode =
  | "MEDIA_DERIVATION_REQUIRED"
  | "AUDIO_PITCH_CHANGE"
  | "CAPTION_OVERFLOW"
  | "TRANSITION_HANDLE_LIMIT"
  | "OFFLINE_OBJECT"
  | "ROUNDING_APPLIED";

export interface EditWarning {
  code: EditWarningCode;
  message: string;
  operationId?: string;
  range?: SequenceRange;
  details?: Record<string, unknown>;
}

export type EditConflictCode =
  | "STALE_REVISION"
  | "OVERLAPPING_WRITE"
  | "MISSING_RESOURCE"
  | "LOCKED_TRACK"
  | "SOURCE_REPLACED"
  | "PREVIEW_CHANGED";

export interface EditConflict {
  code: EditConflictCode;
  message: string;
  resource: string;
  operationId?: string;
  currentRevision?: string;
  details?: Record<string, unknown>;
}

export interface SequenceDiff {
  insertedClipIds: string[];
  removedClipIds: string[];
  changedClipIds: string[];
  changedTrackIds: string[];
  changedCaptionCueIds: string[];
  beforeDurationFrames: number;
  afterDurationFrames: number;
}

export interface EditPreview {
  commandId: string;
  sequenceId: string;
  baseRevision: string;
  valid: boolean;
  operations: NormalizedEditOperation[];
  affectedRanges: SequenceRange[];
  writeSet: string[];
  warnings: EditWarning[];
  conflicts: EditConflict[];
  diff: SequenceDiff;
  beforeHash: string;
  afterHash: string;
  previewHash: string;
}

export interface EditCommit {
  commandId: string;
  actionId: string;
  revision: string;
  sequence: Sequence;
  previewHash: string;
}

export interface EditBatchAudit {
  actionId: string;
  commandId: string;
  intentVersion: number;
  sourceSurface: SourceSurface;
  actor: string;
  sequenceId: string;
  baseRevision: string;
  committedRevision: string;
  operations: NormalizedEditOperation[];
  affectedRanges: SequenceRange[];
  writeSet: string[];
  previewHash: string;
  beforeHash: string;
  afterHash: string;
  confirmationPolicy: ConfirmationPolicy;
  warnings: EditWarning[];
  createdAt: number;
}

export interface EditRestoreRequest {
  targetActionId?: string;
  targetRevision?: string;
  actor: string;
  sourceSurface: SourceSurface;
  baseRevision: string;
}

export interface EditRestoreCommit {
  actionId: string;
  restoredFromActionId?: string;
  restoredFromRevision: string;
  revision: string;
  sequence: Sequence;
}

export type SearchModality =
  "auto" | "visual" | "speech" | "ocr" | "audio" | "metadata";

export type SearchReference =
  | { kind: "image"; artifact: string }
  | { kind: "frame"; source: SourcePoint }
  | { kind: "video"; range: SourceRange }
  | { kind: "audio"; range: SourceRange };

export interface PreparedSearchFingerprint {
  kind: string;
  value: string;
}

export interface PreparedSearchVideoSample {
  offsetMs: number;
  vector: number[];
}

export type PreparedSearchReference =
  | {
      kind: "image";
      embeddingSpace: string;
      vector: number[];
      fingerprints?: PreparedSearchFingerprint[];
    }
  | {
      kind: "video";
      embeddingSpace: string;
      durationMs?: number;
      samples: PreparedSearchVideoSample[];
    };

export interface PreparedSearchRange {
  startMs: number;
  durationMs?: number;
}

export interface PreparedSearchOptions {
  range?: PreparedSearchRange;
}

export interface SearchQuery {
  text?: string;
  reference?: SearchReference;
  modalities?: SearchModality[];
  artifactKinds?: ArtifactKind[];
  durationMs?: { min?: number; max?: number };
  orientations?: Array<"landscape" | "portrait" | "square">;
  labels?: string[];
  sourceArtifactIds?: string[];
  indexingStates?: SearchCoverageState[];
  createdAfter?: number;
  createdBefore?: number;
  minScore?: number;
  limit?: number;
  cursor?: string;
}

export type SearchSignalKind =
  "visual" | "speech" | "ocr" | "audio" | "metadata" | "exact" | "near";

export interface SearchSignal {
  kind: SearchSignalKind;
  rank: number;
  score?: number;
  explanation?: string;
}

export interface SearchHit {
  artifactId: string;
  artifactLabel?: string;
  artifactKind: ArtifactKind;
  location: SearchLocation;
  representativeTick?: number;
  score: number;
  signals: SearchSignal[];
  excerpt?: string;
  indexManifestIds: string[];
}

export type SearchCoverageState =
  "not-indexed" | "partial" | "ready" | "stale" | "failed" | "unsupported";

export type LanguageCoverage = "measured" | "best-effort" | "unsupported";

export interface SearchModalityCoverage {
  modality: Exclude<SearchModality, "auto">;
  state: SearchCoverageState;
  indexedUnits: number;
  totalUnits?: number;
  languageCoverage?: LanguageCoverage;
  manifestId?: string;
  error?: EngineError;
}

export interface SearchCoverage {
  state: SearchCoverageState;
  generation: string;
  modalities: SearchModalityCoverage[];
  indexedArtifactCount: number;
  totalArtifactCount: number;
  partialResults: boolean;
}

export interface SearchPage {
  hits: SearchHit[];
  nextCursor?: string;
  coverage: SearchCoverage;
}

export interface IndexManifest {
  manifestId: string;
  provider: string;
  modelId: string;
  modelRevision: string;
  license?: string;
  embeddingSpace: string;
  dimensions: number;
  modalities: Array<Exclude<SearchModality, "auto">>;
  supportedLanguages: string[];
  preprocessingVersion: string;
  extractorVersion: string;
  createdAt: number;
}

export type IndexPhase =
  | "probe"
  | "segment"
  | "transcript"
  | "ocr"
  | "visual"
  | "audio"
  | "lexical"
  | "activate";

export interface IndexCoverage {
  artifactId: string;
  objectHash: string;
  manifestId: string;
  phase: IndexPhase;
  state: SearchCoverageState;
  coveredRanges: SourceRange[];
  indexedUnits: number;
  totalUnits?: number;
  nextCursor?: string;
  retryable: boolean;
  error?: EngineError;
  updatedAt: number;
}

export interface IndexBatchRequest {
  artifactId: string;
  objectHash: string;
  manifestId: string;
  phase: IndexPhase;
  cursor?: string;
  maxUnits: number;
}

export interface IndexBatchResult {
  artifactId: string;
  manifestId: string;
  phase: IndexPhase;
  committedUnits: number;
  coveredRanges: SourceRange[];
  nextCursor?: string;
  complete: boolean;
  generation: string;
}

export type MediaSegmentKind =
  | "shot"
  | "window"
  | "frame"
  | "speech"
  | "ocr"
  | "audio-event"
  | "document"
  | "metadata";

export interface SegmentTextObservation {
  textId?: string;
  kind: "transcript" | "ocr" | "description" | "metadata" | "label";
  language?: string;
  text: string;
  startUtf8Byte?: number;
  endUtf8Byte?: number;
  confidence?: number;
  provenance?: Record<string, unknown>;
}

export interface SegmentEmbeddingObservation {
  embeddingId?: string;
  modality: Exclude<SearchModality, "auto" | "metadata">;
  embeddingSpace: string;
  vector: number[];
  sourceHash: string;
}

export interface SegmentFingerprintObservation {
  fingerprintId?: string;
  kind: "sha256" | "perceptual" | "frame";
  value: string;
  extractorVersion: string;
}

export interface TemporalIndexObservation {
  segmentId?: string;
  artifactId: string;
  objectHash: string;
  streamId?: string;
  range?: SourceRange;
  sourcePath?: string;
  kind: MediaSegmentKind;
  representativeTick?: number;
  segmentationVersion: string;
  texts: SegmentTextObservation[];
  embeddings: SegmentEmbeddingObservation[];
  fingerprints: SegmentFingerprintObservation[];
}

export interface CommitTemporalIndexBatchInput extends IndexBatchRequest {
  generation: string;
  observations: TemporalIndexObservation[];
  coveredRanges: SourceRange[];
  totalUnits?: number;
  complete: boolean;
  nextCursor?: string;
}

export interface TemporalIndexPlan {
  artifactId: string;
  objectHash: string;
  manifestId: string;
  generation: string;
  phases: IndexPhase[];
  pendingPhases: IndexPhase[];
  coverage: IndexCoverage[];
}

export interface TemporalSearchProvider {
  readonly manifestId: string;
  prepare(options?: MediaOperationOptions): Promise<void>;
  embedText(text: string, options?: MediaOperationOptions): Promise<Float32Array>;
}

export interface TemporalSearchStats {
  activeGenerations: number;
  segments: number;
  textObservations: number;
  embeddings: number;
  fingerprints: number;
}

export interface PrepareTemporalIndexOptions {
  manifestId?: string;
  generation?: string;
  signal?: AbortSignal;
  checkpoint?: "always" | "periodic";
}

export interface TemporalIndexPreparation {
  indexes: number;
  vectors: number;
  updatedVectors: number;
  loadedIndexes: number;
  persistedIndexes: number;
}

export type SearchBenchmarkClass =
  | "natural-language-visual"
  | "quoted-speech-ocr"
  | "reverse-image-exact"
  | "reverse-image-semantic"
  | "reverse-video"
  | "audio";

export interface SearchBenchmarkJudgment {
  artifactId: string;
  range?: SourceRange;
}

export interface SearchBenchmarkCase {
  caseId: string;
  class: SearchBenchmarkClass;
  query: SearchQuery;
  judgments: SearchBenchmarkJudgment[];
}

export interface SearchBenchmarkCaseResult {
  caseId: string;
  class: SearchBenchmarkClass;
  latencyMs: number;
  recallAt5: number;
  top1Correct: boolean;
  boundaryErrorMs?: number;
}

export interface SearchBenchmarkClassMetrics {
  class: SearchBenchmarkClass;
  caseCount: number;
  recallAt5: number;
  top1Accuracy: number;
}

export interface SearchBenchmarkReport {
  corpusVersion: string;
  manifestIds: string[];
  caseResults: SearchBenchmarkCaseResult[];
  classes: SearchBenchmarkClassMetrics[];
  latencyP50Ms: number;
  latencyP95Ms: number;
  medianBoundaryErrorMs?: number;
  passed: boolean;
  failures: string[];
}

export const MVP_JOB_TYPES = [
  "media-probe",
  "proxy-transcode",
  "thumbnail",
  "storyboard",
  "waveform",
  "loudness",
  "transcript-normalize",
  "media-segment",
  "ocr",
  "embed-visual",
  "embed-text",
  "embed-audio",
  "index-activate",
  "caption-derive",
  "preview-render",
  "final-render",
] as const;

export type MvpJobType = (typeof MVP_JOB_TYPES)[number];

export const MVP_JOB_FAILURE_CODES = [
  "UNSUPPORTED_MEDIA",
  "MISSING_OBJECT",
  "MODEL_UNAVAILABLE",
  "OFFLINE",
  "INVALID_OUTPUT",
  "RESOURCE_EXHAUSTED",
  "TIMEOUT",
  "CANCELLED",
  "INTERNAL_ERROR",
] as const;

export type MvpJobFailureCode = (typeof MVP_JOB_FAILURE_CODES)[number];

export interface JobProgress {
  phase: string;
  completedUnits: number;
  totalUnits?: number;
  percent?: number;
  elapsedMs: number;
  estimatedRemainingMs?: number;
}

export interface MvpJobFailure {
  code: MvpJobFailureCode;
  message: string;
  retryable: boolean;
  engineCode?: EngineErrorCode;
  details?: Record<string, unknown>;
}

export interface V4MigrationRequest {
  sourceRoot: string;
  destinationRoot: string;
  dryRun: boolean;
  expectedSourceBookId?: string;
  expectedSourceHead?: string;
  expectedMigrationKey?: string;
  signal?: AbortSignal;
  ffprobePath?: string;
  onProgress?: (progress: { phase: "copy-state" | "copy-objects" | "copy-notebooks" | "copy-timeline" | "publish"; completed: number; total: number }) => void;
}

export type MigrationIssueCode =
  | "MISSING_OBJECT"
  | "CORRUPT_OBJECT"
  | "UNSUPPORTED_MEDIA"
  | "INVALID_REFERENCE"
  | "PROBE_REQUIRED"
  | "REINDEX_REQUIRED";

export interface MigrationIssue {
  code: MigrationIssueCode;
  severity: "warning" | "error";
  resource: string;
  message: string;
  details?: Record<string, unknown>;
}

export interface V4MigrationDryRun {
  contractVersion: typeof MVP_CONTRACT_VERSION;
  sourceSchemaVersion: typeof MVP_LEGACY_SCHEMA_VERSION;
  destinationSchemaVersion: typeof MVP_SCHEMA_VERSION;
  sourceBookId: string;
  sourceHeadRevision: string;
  artifactCount: number;
  notebookCount: number;
  timelineSlotCount: number;
  timelineAudioCount: number;
  objectCount: number;
  estimatedReindexArtifacts: number;
  issues: MigrationIssue[];
  migrationKey: string;
}

export interface V4MigrationResult extends V4MigrationDryRun {
  destinationBookId: string;
  destinationRevision: string;
  importActionId: string;
  reportArtifactId: string;
  copiedObjectCount: number;
  reusedObjectCount: number;
  completedAt: number;
}
