export { createEngine, Engine } from "./engine.js";

export type * from "./engine-types.js";
export {
  ENGINE_ERROR_CODES,
  QUEUED_TASK_ID,
  err,
  ok,
} from "./engine-types.js";

export type * from "./mvp-time.js";
export {
  canonicalContractJson,
  normalizeRational,
  normalizeSearchLocation,
  normalizeSequenceRange,
  normalizeSourcePoint,
  normalizeSourceRange,
  rationalEquals,
  rationalToNumber,
  sequenceFramesToSourceTicks,
  sequenceRangeEndFrame,
  sourceRangeEndTick,
  sourceTicksToSequenceFrames,
} from "./mvp-time.js";

export type * from "./mvp-contracts.js";
export {
  MVP_CONTRACT_COMPATIBILITY,
  MVP_CONTRACT_VERSION,
  MVP_EDIT_OPERATION_KINDS,
  MVP_JOB_FAILURE_CODES,
  MVP_JOB_TYPES,
  MVP_LEGACY_SCHEMA_VERSION,
  MVP_PREVIOUS_SCHEMA_VERSION,
  MVP_SCHEMA_VERSION,
} from "./mvp-contracts.js";

export {
  compareSearchBenchmarks,
  evaluateSearchBenchmark,
} from "./search-benchmark.js";

export {
  LOCAL_CLAP_MANIFEST,
  LOCAL_CLAP_MODEL_ID,
  LOCAL_CLAP_MODEL_REVISION,
  LOCAL_CLIP_MANIFEST,
  LOCAL_CLIP_MODEL_ID,
  LOCAL_CLIP_MODEL_REVISION,
  LocalClapTemporalProvider,
  LocalClipTemporalProvider,
  type LocalClapTemporalProviderOptions,
  type LocalClipTemporalProviderOptions,
} from "./temporal-models.js";

export {
  dryRunV4Migration,
  migrateV4,
  readV4BookIdentity,
} from "./migration.js";

export type { MvpContractFixtures } from "./mvp-contract-fixtures.js";
export {
  MVP_CONTRACT_FIXTURES,
  MVP_CONTRACT_FIXTURES_JSON,
  MVP_EDIT_OPERATION_FIXTURES,
} from "./mvp-contract-fixtures.js";

export type {
  CellHistoryEntry,
  ExecutionHistoryEntry,
  WriteNotebookOptions,
} from "./domain.js";

export type {
  EntityDocument,
  EntityType,
  NotebookCell,
  NotebookCellExecution,
  NotebookCellReference,
  NotebookCellType,
  NotebookDocument,
  NotebookEdge,
  NotebookFixtureState,
  NotebookGenerationPlan,
  NotebookGridSlot,
  NotebookReferenceKind,
  NotebookRun,
  NotebookRunPlan,
  PinnedSearchResult,
} from "./notebook/types.js";

export {
  assertNotebookGridSlot,
  firstEmptyNotebookGridSlot,
  firstEmptyNotebookGridSlots,
  isNotebookGridSlot,
  nearestOriginNotebookGridSlot,
  nextHorizontalSlotFrom,
  nextVerticalSlotFrom,
  nextWaveTileSlot,
  NOTEBOOK_GRID_CAPACITY,
  NOTEBOOK_GRID_COLUMN_COUNT,
  NOTEBOOK_GRID_FULL_ERROR,
  NOTEBOOK_GRID_ROW_COUNT,
  notebookGridAddress,
  notebookGridTag,
  parseNotebookGridAddress,
} from "./notebook-grid.js";

export {
  findGenerateImageOutputCell,
  findGenerateVideoOutputCell,
  resolveGeneratedVideoArtifact,
  resolveNotebookCellArtifactId,
} from "./notebook-media-artifact.js";

export type {
  NotebookMention,
  NotebookMentionReplacement,
} from "./notebook-mentions.js";
export {
  isNotebookGridAddress,
  normalizeNotebookReference,
  NOTEBOOK_GRID_ADDRESS_PATTERN,
  NOTEBOOK_GRID_ADDRESS_SOURCE,
  NOTEBOOK_MENTION_PATTERN,
  notebookMentionPrefixAtEnd,
  replaceNotebookMentions,
  scanNotebookMentions,
  stripNotebookMentions,
} from "./notebook-mentions.js";

export {
  findAudioFile,
  findPrimaryMediaFile,
  findVideoFile,
  RENDER_ORIENTATIONS,
  type RenderOrientation,
} from "./media.js";

export {
  computeArtifactStatus,
  hasPartialMediaFile,
} from "./status.js";

export { normalizeKind } from "./artifacts.js";
export { normalizeFilePath } from "./files.js";
export { isUuidV7 } from "./ids.js";
export { JobQueue, QueueRunner } from "./job-queue.js";
export {
  bootstrapFork,
  mergeBack,
  type ForkBootstrapOptions,
  type MergeBackOptions,
  type MergeBackResult,
  type RowConflict,
} from "./fork.js";
export type { StoredObject } from "./cas.js";
export {
  NOTEBOOK_CELL_TYPES,
  RUNTIME_TABLES,
  SCHEMA_VERSION,
  SEMANTIC_TABLES,
} from "./schema.js";
export {
  CELLS_TABLE_COLUMNS,
  CELLS_TABLE_SCHEMA,
  notebookCellTableRows,
  type CellTableColumn,
  type CellTableColumnType,
  type CellTableRow,
  type CellTableValue,
} from "./catalog-metadata.js";
export { isDestructiveEditOperation } from "./edit-policy.js";
