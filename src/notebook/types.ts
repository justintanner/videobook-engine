export type NotebookCellType =
  | "prompt"
  | "character"
  | "scene"
  | "asset"
  | "image"
  | "video";

export interface NotebookPosition {
  x: number;
  y: number;
}

export interface NotebookCell {
  id: string;
  type: NotebookCellType;
  title: string;
  position: NotebookPosition;
  entityId?: string;
  prompt?: string;
  model?: string;
  inputs?: Record<string, unknown>;
  outputArtifactId?: string;
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
