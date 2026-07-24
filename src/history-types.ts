import type { Revision, RevisionFileChange } from "./engine-types.js";
import type { ArtifactKind } from "./engine-types.js";

export type HistoryActionPhase =
  | "requested"
  | "started"
  | "completed"
  | "failed"
  | "cancelled"
  | "conflicted";

export type HistoryActionScope =
  | "book"
  | "artifact"
  | "layout"
  | "external"
  | "system";

export type HistoryArtifactKind = ArtifactKind | "unknown";

export interface HistoryLayout {
  stage: number;
  column: number;
}

export interface HistoryActionEvent {
  id: string;
  revision: string;
  phase: HistoryActionPhase;
  date: string;
  details: Record<string, unknown>;
  files: string[];
  fileChanges: RevisionFileChange[];
}

export interface HistoryArtifactRef {
  id: string;
  slug: string;
  kind: HistoryArtifactKind;
}

export interface HistoryAction {
  id: string;
  operation: string;
  title: string;
  scope: HistoryActionScope;
  actor: string;
  lane: string;
  date: string;
  phase: HistoryActionPhase;
  baseRevision?: string;
  rebasedOver?: string;
  parentActionIds: string[];
  inputArtifacts: HistoryArtifactRef[];
  outputArtifacts: HistoryArtifactRef[];
  targetArtifactId?: string;
  targetActionId?: string;
  layout?: HistoryLayout;
  details: Record<string, unknown>;
  events: HistoryActionEvent[];
}

export interface HistoryActionPage {
  headRevision: string;
  actions: HistoryAction[];
  nextCursor?: string;
}

export interface GetHistoryActionsOptions {
  limit?: number;
  cursor?: string;
}

export interface RecordActionInput {
  actionId?: string;
  operation: string;
  phase?: HistoryActionPhase;
  scope?: HistoryActionScope;
  actor?: string;
  lane?: string;
  baseRevision?: string;
  parentActionIds?: string[];
  inputArtifactIds?: string[];
  outputArtifactIds?: string[];
  targetArtifactId?: string;
  targetActionId?: string;
  layout?: HistoryLayout;
  writeSet?: string[];
  details?: Record<string, unknown>;
}

export interface HistoryActionRevision {
  action: HistoryAction;
  revision: Revision;
}
