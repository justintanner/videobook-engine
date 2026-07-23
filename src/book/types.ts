import type { ProjectRevision, RevisionFileChange } from "../types.js";

export type BookActionPhase =
  | "requested"
  | "started"
  | "completed"
  | "failed"
  | "cancelled"
  | "conflicted";

export type BookActionScope =
  | "project"
  | "artifact"
  | "layout"
  | "external"
  | "system";

export type BookArtifactKind =
  | "prompt"
  | "image"
  | "video"
  | "character"
  | "scene"
  | "audio"
  | "script"
  | "final"
  | "notebook"
  | "unknown";

export interface BookLayout {
  stage: number;
  column: number;
}

export interface BookActionEvent {
  id: string;
  revision: string;
  phase: BookActionPhase;
  date: string;
  details: Record<string, unknown>;
  files: string[];
  fileChanges: RevisionFileChange[];
}

export interface BookArtifactRef {
  id: string;
  slug: string;
  kind: BookArtifactKind;
}

export interface BookAction {
  id: string;
  projectId: string;
  operation: string;
  title: string;
  scope: BookActionScope;
  actor: string;
  lane: string;
  date: string;
  phase: BookActionPhase;
  baseRevision?: string;
  rebasedOver?: string;
  parentActionIds: string[];
  inputArtifacts: BookArtifactRef[];
  outputArtifacts: BookArtifactRef[];
  targetArtifactId?: string;
  targetActionId?: string;
  layout?: BookLayout;
  details: Record<string, unknown>;
  events: BookActionEvent[];
}

export interface ProjectBook {
  projectId: string;
  slug: string;
  headRevision: string;
  actions: BookAction[];
  nextCursor?: string;
}

export interface GetProjectBookOptions {
  limit?: number;
  cursor?: string;
}

export interface RecordBookActionInput {
  projectSlug: string;
  actionId?: string;
  operation: string;
  phase?: BookActionPhase;
  scope?: BookActionScope;
  actor?: string;
  lane?: string;
  baseRevision?: string;
  parentActionIds?: string[];
  inputArtifactIds?: string[];
  outputArtifactIds?: string[];
  targetArtifactId?: string;
  targetActionId?: string;
  layout?: BookLayout;
  writeSet?: string[];
  details?: Record<string, unknown>;
}

export interface BookActionRevision {
  action: BookAction;
  revision: ProjectRevision;
}
