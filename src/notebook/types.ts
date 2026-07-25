import type {
  SearchQuery,
  SearchSignal,
} from "../mvp-contracts.js";
import type { SearchLocation } from "../mvp-time.js";

export type NotebookCellType =
  | "label"
  | "source"
  | "audio"
  | "transcript"
  | "note"
  | "search"
  | "selects"
  | "prompt"
  | "character"
  | "scene"
  | "asset"
  | "image"
  | "video"
  | "sequence"
  | "analysis"
  | "split"
  | "frame"
  | "export";

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
  title: string;
  slot: NotebookGridSlot;
  entityId?: string;
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

export interface NotebookDocument {
  id: string;
  name: string;
  properties?: Record<string, unknown>;
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
