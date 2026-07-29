import type { EngineErrorCode } from "./engine-types.js";
import {
  MVP_CONTRACT_COMPATIBILITY,
  MVP_CONTRACT_VERSION,
  MVP_SCHEMA_VERSION,
  type ArtifactStream,
  type CaptionCue,
  type EditCommit,
  type EditIntent,
  type EditOperation,
  type EditPreview,
  type IndexBatchResult,
  type IndexManifest,
  type JobProgress,
  type MvpJobFailure,
  type SearchPage,
  type Sequence,
  type Transcript,
  type V4MigrationDryRun,
  type V4MigrationResult,
} from "./mvp-contracts.js";
import {
  canonicalContractJson,
  type MediaSourceSnapshot,
  type Rational,
  type SourceRange,
} from "./mvp-time.js";

const frameRate: Rational = { numerator: 30, denominator: 1 };
const videoTimeBase: Rational = { numerator: 1, denominator: 30_000 };
const audioTimeBase: Rational = { numerator: 1, denominator: 48_000 };

const videoRange: SourceRange = {
  streamId: "0197-stream-video",
  objectHash: "sha256:video-object",
  startTick: 60_000,
  durationTicks: 150_000,
  timeBase: videoTimeBase,
};

const audioRange: SourceRange = {
  streamId: "0197-stream-audio",
  objectHash: "sha256:audio-object",
  startTick: 96_000,
  durationTicks: 240_000,
  timeBase: audioTimeBase,
};

const videoSource: MediaSourceSnapshot = {
  kind: "timed",
  artifactId: "0197-artifact-video",
  range: videoRange,
};

const stillSource: MediaSourceSnapshot = {
  kind: "still",
  artifactId: "0197-artifact-still",
  sourcePath: "original.jpg",
  objectHash: "sha256:still-object",
};

const transform = {
  fit: "fill",
  positionX: 0,
  positionY: 0,
  scaleX: 1,
  scaleY: 1,
  anchorX: 0.5,
  anchorY: 0.5,
  rotationDegrees: 0,
  cropTop: 0,
  cropRight: 0,
  cropBottom: 0,
  cropLeft: 0,
  opacity: 1,
  blendMode: "normal",
} as const;

const audio = {
  gainDb: -3,
  muted: false,
  fadeInFrames: 6,
  fadeOutFrames: 6,
} as const;

const caption: CaptionCue = {
  cueId: "0197-caption-1",
  trackId: "0197-track-caption",
  timelineStartFrame: 0,
  durationFrames: 90,
  text: "The red van arrives at dusk.",
  speaker: "Narrator",
  styleId: "clean",
  transcriptSelection: {
    transcriptId: "0197-transcript",
    transcriptRevision: "dolt-transcript-revision",
    startWordId: "0197-word-1",
    endWordId: "0197-word-6",
    range: audioRange,
  },
};

export const MVP_EDIT_OPERATION_FIXTURES = [
  {
    kind: "insert-clip",
    clipId: "0197-clip-video",
    placement: {
      trackId: "0197-track-video-1",
      timelineStartFrame: 0,
      durationFrames: 150,
      source: videoSource,
      speed: { numerator: 1, denominator: 1 },
      reverse: false,
      audioPolicy: "preserve-pitch",
      transform,
    },
    mode: "insert",
  },
  {
    kind: "remove-range",
    trackIds: ["0197-track-video-1"],
    range: {
      sequenceId: "0197-sequence-main",
      startFrame: 60,
      durationFrames: 30,
    },
    ripple: true,
  },
  {
    kind: "move-clip",
    clipId: "0197-clip-video",
    trackId: "0197-track-video-2",
    timelineStartFrame: 180,
  },
  {
    kind: "trim-clip",
    clipId: "0197-clip-video",
    timelineStartFrame: 0,
    durationFrames: 120,
    sourceRange: {
      ...videoRange,
      durationTicks: 120_000,
    },
  },
  {
    kind: "split-clip",
    clipId: "0197-clip-video",
    splitFrame: 75,
    leftClipId: "0197-clip-left",
    rightClipId: "0197-clip-right",
  },
  {
    kind: "restore-clip",
    sourceActionId: "0197-action-remove",
    sourceClipId: "0197-clip-removed",
    placement: {
      trackId: "0197-track-video-1",
      timelineStartFrame: 210,
      durationFrames: 90,
      source: stillSource,
      transform,
    },
  },
  {
    kind: "set-clip-transform",
    clipId: "0197-clip-video",
    transform,
  },
  {
    kind: "set-clip-audio",
    clipId: "0197-clip-video",
    audio,
  },
  {
    kind: "set-clip-speed",
    clipId: "0197-clip-video",
    speed: { numerator: 2, denominator: 1 },
    reverse: false,
    audioPolicy: "preserve-pitch",
  },
  {
    kind: "set-transition",
    outgoingClipId: "0197-clip-left",
    incomingClipId: "0197-clip-right",
    transition: {
      transitionId: "0197-transition",
      trackId: "0197-track-video-1",
      outgoingClipId: "0197-clip-left",
      incomingClipId: "0197-clip-right",
      kind: "dissolve",
      durationFrames: 12,
      alignment: "center",
    },
  },
  {
    kind: "upsert-caption-cue",
    cue: caption,
  },
  {
    kind: "batch-replace-range",
    range: {
      sequenceId: "0197-sequence-main",
      startFrame: 0,
      durationFrames: 150,
    },
    trackIds: ["0197-track-video-1"],
    placements: [
      {
        trackId: "0197-track-video-1",
        timelineStartFrame: 0,
        durationFrames: 90,
        source: stillSource,
        transform,
      },
      {
        trackId: "0197-track-video-1",
        timelineStartFrame: 90,
        durationFrames: 60,
        source: videoSource,
        speed: { numerator: 1, denominator: 1 },
        reverse: false,
        audioPolicy: "preserve-pitch",
        transform,
      },
    ],
    ripple: false,
  },
] as const satisfies readonly EditOperation[];

const stream: ArtifactStream = {
  streamId: videoRange.streamId,
  artifactId: videoSource.artifactId,
  sourcePath: "original.mp4",
  objectHash: videoRange.objectHash,
  streamIndex: 0,
  kind: "video",
  timeBase: videoTimeBase,
  durationTicks: 900_000,
  codec: "h264",
  video: {
    width: 1920,
    height: 1080,
    rotationDegrees: 0,
    pixelAspect: { numerator: 1, denominator: 1 },
    nominalFrameRate: frameRate,
    averageFrameRate: frameRate,
  },
};

const transcript: Transcript = {
  transcriptId: "0197-transcript",
  artifactId: "0197-artifact-audio",
  streamId: audioRange.streamId,
  objectHash: audioRange.objectHash,
  payloadHash: "sha256:transcript-payload",
  language: "en",
  provider: "fixture",
  model: "fixture-word-timing-v1",
  revision: "dolt-transcript-revision",
  segments: [
    {
      segmentId: "0197-segment-1",
      ordinal: 0,
      range: audioRange,
      speaker: "Narrator",
      text: "The red van arrives at dusk.",
      confidence: 0.98,
      kind: "speech",
      words: [
        {
          wordId: "0197-word-1",
          ordinal: 0,
          startTick: 96_000,
          durationTicks: 24_000,
          text: "The",
          confidence: 0.99,
          corrected: false,
        },
        {
          wordId: "0197-word-6",
          ordinal: 5,
          startTick: 288_000,
          durationTicks: 48_000,
          text: "dusk.",
          confidence: 0.96,
          corrected: false,
        },
      ],
    },
  ],
  createdAt: 1_750_000_000_000,
};

const sequence: Sequence = {
  sequenceId: "0197-sequence-main",
  name: "Main",
  width: 1920,
  height: 1080,
  pixelAspect: { numerator: 1, denominator: 1 },
  frameRate,
  audioSampleRateHz: 48_000,
  audioChannelLayout: "stereo",
  backgroundRgba: [0, 0, 0, 1],
  revision: "dolt-sequence-revision",
  tracks: [
    {
      trackId: "0197-track-video-1",
      sequenceId: "0197-sequence-main",
      kind: "video",
      ordinal: 0,
      name: "Video 1",
      enabled: true,
      locked: false,
      blendMode: "normal",
    },
    {
      trackId: "0197-track-video-2",
      sequenceId: "0197-sequence-main",
      kind: "video",
      ordinal: 1,
      name: "Video 2",
      enabled: true,
      locked: false,
      blendMode: "normal",
    },
    {
      trackId: "0197-track-audio-1",
      sequenceId: "0197-sequence-main",
      kind: "audio",
      ordinal: 0,
      name: "Narration",
      enabled: true,
      locked: false,
      muted: false,
      solo: false,
    },
    {
      trackId: "0197-track-caption",
      sequenceId: "0197-sequence-main",
      kind: "caption",
      ordinal: 0,
      name: "Captions",
      enabled: true,
      locked: false,
    },
  ],
  clips: [
    {
      clipId: "0197-clip-video",
      trackId: "0197-track-video-1",
      timelineStartFrame: 0,
      durationFrames: 150,
      enabled: true,
      source: videoSource,
      speed: { numerator: 1, denominator: 1 },
      reverse: false,
      audioPolicy: "preserve-pitch",
      transform,
    },
  ],
  transitions: [],
  captions: [caption],
  createdAt: 1_750_000_000_000,
};

const editIntent: EditIntent = {
  intentVersion: MVP_CONTRACT_VERSION,
  commandId: "command-fixture-1",
  sequenceId: sequence.sequenceId,
  baseRevision: "dolt-base-revision",
  actor: "fixture-user",
  sourceSurface: "slash",
  confirmationPolicy: "risk-based",
  operations: MVP_EDIT_OPERATION_FIXTURES.map((operation) => ({ ...operation })),
};

const editPreview: EditPreview = {
  commandId: editIntent.commandId,
  sequenceId: editIntent.sequenceId,
  baseRevision: editIntent.baseRevision,
  valid: true,
  operations: editIntent.operations.map((operation, ordinal) => ({
    operationId: `operation-${String(ordinal + 1).padStart(2, "0")}`,
    ordinal,
    operation,
  })),
  affectedRanges: [
    {
      sequenceId: sequence.sequenceId,
      startFrame: 0,
      durationFrames: 300,
    },
  ],
  writeSet: [
    `sequence:${sequence.sequenceId}`,
    "track:0197-track-video-1",
    "track:0197-track-video-2",
    "track:0197-track-caption",
  ],
  warnings: [
    {
      code: "AUDIO_PITCH_CHANGE",
      message: "Two-times speed may alter pitch when preserve-pitch is unavailable.",
      operationId: "operation-09",
    },
  ],
  conflicts: [],
  diff: {
    insertedClipIds: ["0197-clip-left", "0197-clip-right"],
    removedClipIds: [],
    changedClipIds: ["0197-clip-video"],
    changedTrackIds: ["0197-track-video-1", "0197-track-video-2"],
    changedCaptionCueIds: [caption.cueId],
    beforeDurationFrames: 150,
    afterDurationFrames: 300,
  },
  beforeHash: "sha256:before",
  afterHash: "sha256:after",
  previewHash: "sha256:preview",
};

const editCommit: EditCommit = {
  commandId: editIntent.commandId,
  actionId: "0197-action-edit",
  revision: "dolt-committed-revision",
  sequence: {
    ...sequence,
    revision: "dolt-committed-revision",
  },
  previewHash: editPreview.previewHash,
};

const manifest: IndexManifest = {
  manifestId: "manifest-visual-v1",
  provider: "local",
  modelId: "fixture-multimodal",
  modelRevision: "sha256:model",
  license: "fixture-only",
  embeddingSpace: "fixture-visual-v1",
  dimensions: 4,
  modalities: ["visual", "metadata"],
  supportedLanguages: ["en"],
  preprocessingVersion: "frames-v1",
  extractorVersion: "extractor-v1",
  createdAt: 1_750_000_000_000,
};

const searchPage: SearchPage = {
  hits: [
    {
      artifactId: videoSource.artifactId,
      artifactSlug: "vid-red-van",
      artifactKind: "video",
      location: videoSource,
      representativeTick: 120_000,
      score: 0.91,
      signals: [
        {
          kind: "visual",
          rank: 1,
          score: 0.92,
          explanation: "red van arriving at dusk",
        },
        {
          kind: "metadata",
          rank: 2,
          score: 0.7,
          explanation: "user label: exterior",
        },
      ],
      excerpt: "Red van enters frame from the left.",
      indexManifestIds: [manifest.manifestId],
    },
  ],
  nextCursor: "generation-1:page-2",
  coverage: {
    state: "partial",
    generation: "generation-1",
    modalities: [
      {
        modality: "visual",
        state: "partial",
        indexedUnits: 12,
        totalUnits: 20,
        languageCoverage: "measured",
        manifestId: manifest.manifestId,
      },
      {
        modality: "speech",
        state: "ready",
        indexedUnits: 1,
        totalUnits: 1,
        languageCoverage: "measured",
        manifestId: "manifest-text-v1",
      },
    ],
    indexedArtifactCount: 1,
    totalArtifactCount: 2,
    partialResults: true,
  },
};

const indexBatch: IndexBatchResult = {
  artifactId: videoSource.artifactId,
  manifestId: manifest.manifestId,
  phase: "visual",
  committedUnits: 12,
  coveredRanges: [videoRange],
  nextCursor: "segment-12",
  complete: false,
  generation: "generation-1",
};

const jobProgress: JobProgress = {
  phase: "embed-visual",
  completedUnits: 12,
  totalUnits: 20,
  percent: 60,
  elapsedMs: 12_000,
  estimatedRemainingMs: 8_000,
};

const jobFailure: MvpJobFailure = {
  code: "MODEL_UNAVAILABLE",
  message: "The pinned visual model is not installed.",
  retryable: true,
  engineCode: "MODEL_UNAVAILABLE",
};

const migrationDryRun: V4MigrationDryRun = {
  contractVersion: MVP_CONTRACT_VERSION,
  sourceSchemaVersion: 4,
  destinationSchemaVersion: MVP_SCHEMA_VERSION,
  sourceBookId: "0197-book-v4",
  sourceHeadRevision: "dolt-v4-head",
  artifactCount: 8,
  notebookCount: 1,
  timelineSlotCount: 4,
  timelineAudioCount: 1,
  objectCount: 12,
  estimatedReindexArtifacts: 6,
  issues: [
    {
      code: "REINDEX_REQUIRED",
      severity: "warning",
      resource: "book:0197-book-v4",
      message: "Schema-v4 similarity rows are rebuilt under v5 manifests.",
    },
  ],
  migrationKey: "sha256:migration-key",
};

const migrationResult: V4MigrationResult = {
  ...migrationDryRun,
  destinationBookId: migrationDryRun.sourceBookId,
  destinationRevision: "dolt-v5-import",
  importActionId: "0197-action-import",
  reportArtifactId: "0197-artifact-migration-report",
  copiedObjectCount: 10,
  reusedObjectCount: 2,
  completedAt: 1_750_000_100_000,
};

export interface MvpContractFixtures {
  compatibility: typeof MVP_CONTRACT_COMPATIBILITY;
  engineErrorCodes: EngineErrorCode[];
  stream: ArtifactStream;
  transcript: Transcript;
  sequence: Sequence;
  editOperations: EditOperation[];
  editIntent: EditIntent;
  editPreview: EditPreview;
  editCommit: EditCommit;
  indexManifest: IndexManifest;
  searchPage: SearchPage;
  indexBatch: IndexBatchResult;
  jobProgress: JobProgress;
  jobFailure: MvpJobFailure;
  migrationDryRun: V4MigrationDryRun;
  migrationResult: V4MigrationResult;
}

const fixtureErrorCodes: EngineErrorCode[] = [
  "INVALID_RANGE",
  "INVALID_TIMEBASE",
  "MEDIA_MISSING",
  "UNSUPPORTED_MEDIA",
  "MANIFEST_INCOMPATIBLE",
  "INDEX_INCOMPLETE",
  "STALE_REVISION",
  "ACTION_CONFLICT",
  "TRACK_LOCKED",
  "MODEL_UNAVAILABLE",
  "CANCELLED",
  "RESOURCE_EXHAUSTED",
  "TIMEOUT",
  "INTERNAL_ERROR",
];

export const MVP_CONTRACT_FIXTURES: MvpContractFixtures = {
  compatibility: MVP_CONTRACT_COMPATIBILITY,
  engineErrorCodes: fixtureErrorCodes,
  stream,
  transcript,
  sequence,
  editOperations: MVP_EDIT_OPERATION_FIXTURES.map((operation) => ({ ...operation })),
  editIntent,
  editPreview,
  editCommit,
  indexManifest: manifest,
  searchPage,
  indexBatch,
  jobProgress,
  jobFailure,
  migrationDryRun,
  migrationResult,
};

export const MVP_CONTRACT_FIXTURES_JSON = canonicalContractJson(
  MVP_CONTRACT_FIXTURES,
);
