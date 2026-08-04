import type {
  SearchQuery,
  SearchSignal,
} from "../mvp-contracts.js";
import type { SearchLocation } from "../mvp-time.js";
import type { NotebookCellType } from "../schema.js";

export type { NotebookCellType } from "../schema.js";

export type NotebookReferenceKind =
  | "artifact"
  | "stream"
  | "source-range"
  | "transcript"
  | "sequence"
  | "cell-output";

export interface NotebookCellReference {
  id: string;
  kind: NotebookReferenceKind;
  targetId: string;
  snapshot: Record<string, unknown>;
  ordinal: number;
}

export interface PinnedSearchResult {
  id: string;
  artifactId: string;
  objectHash: string;
  location: SearchLocation;
  representativeTick?: number;
  query: SearchQuery;
  signals: SearchSignal[];
  selectedRevision: string;
  ordinal: number;
  createdAt: number;
}

export interface NotebookGridSlot {
  row: number;
  column: number;
}

export interface NotebookCell {
  id: string;
  type: NotebookCellType;
  label?: string;
  slot: NotebookGridSlot;
  outputEntityId?: string;
  prompt?: string;
  provider?: string;
  model?: string;
  operation?: string;
  tool?: string;
  inputs?: Record<string, unknown>;
  outputArtifactId?: string;
  references?: NotebookCellReference[];
  pinnedResults?: PinnedSearchResult[];
}

export interface NotebookEdge {
  id: string;
  source: string;
  target: string;
  targetInput: string;
}

export interface NotebookCellExecution {
  fingerprint?: string;
  status?: string;
  outputArtifactId?: string;
  providerArtifactId?: string;
  runId?: string;
  completedAt?: string;
  startedAt?: string;
  updatedAt?: string;
  tool?: string;
  error?: string;
  stale?: boolean;
  fixtureBaseline?: boolean;
}

export interface NotebookGenerationPlan {
  planId: string;
  cellId: string;
  status: string;
  plan: Record<string, unknown>;
  outputArtifactId?: string;
  error?: string;
  createdAt: string;
  updatedAt: string;
}

export interface NotebookRunPlan {
  planId: string;
  status: string;
  plan: Record<string, unknown>;
  paidCellIds: string[];
  cellDefinitionFingerprints: Record<string, string>;
  knownCostUsd: number;
  unknownCostCount: number;
  createdAt: string;
  updatedAt: string;
  runId?: string;
  outputs?: Record<string, string>;
  error?: string;
}

export interface NotebookAudioSpine {
  artifactId: string;
  streamId: string;
  objectHash: string;
  sourcePath: string;
  sequenceId: string;
  sequenceRevision: string;
  trackId: string;
  clipId: string;
}

export interface NotebookCurrentSelection extends Record<string, unknown> {
  transcriptId?: string;
  transcriptRevision?: string;
  startWordId?: string;
  endWordId?: string;
}

export interface NotebookTranscriptEdit extends Record<string, unknown> {
  actionId: string;
  kind: string;
  restored?: boolean;
}

export interface NotebookTranscriptAttachment extends Record<string, unknown> {
  id: string;
}

export interface NotebookFixtureState extends Record<string, unknown> {
  version?: number;
  owner?: string;
}

export interface NotebookDocument {
  id: string;
  name: string;
  description?: string;
  lifecycleState?: string;
  workflowVersion?: number;
  analysisRevision?: string;
  audioSpine?: NotebookAudioSpine;
  currentSelection?: NotebookCurrentSelection;
  fixture?: NotebookFixtureState;
  execution?: Record<string, NotebookCellExecution>;
  generationPlans?: NotebookGenerationPlan[];
  notebookRunPlans?: NotebookRunPlan[];
  transcriptEdits?: NotebookTranscriptEdit[];
  transcriptAttachments?: NotebookTranscriptAttachment[];
  cells: NotebookCell[];
  edges: NotebookEdge[];
  createdAt: string;
}

export type EntityType = "prompt" | "character" | "scene";

export interface EntityDocument {
  id: string;
  type: EntityType;
  name: string;
  description?: string;
  prompt?: string;
  data: Record<string, unknown>;
  createdAt: string;
}

export interface NotebookRun {
  id: string;
  notebookId: string;
  status: "completed" | "failed" | "aborted";
  startedAt: string;
  completedAt: string;
  cellOrder: string[];
  outputs: Record<string, string>;
  error?: string;
}
