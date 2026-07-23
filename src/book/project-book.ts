import type {
  BookAction,
  BookActionEvent,
  BookActionPhase,
  BookActionScope,
  BookArtifactKind,
  BookArtifactRef,
  BookLayout,
  GetProjectBookOptions,
  ProjectBook,
} from "./types.js";
import type { ProjectRevision } from "../types.js";

const BOOK_ACTION_ID = "book_action_id";
const BOOK_BASE_REVISION = "book_base_revision";
const BOOK_INPUT_ARTIFACT_IDS = "book_input_artifact_ids";
const BOOK_LANE = "book_lane";
const BOOK_LAYOUT = "book_layout";
const BOOK_OUTPUT_ARTIFACT_IDS = "book_output_artifact_ids";
const BOOK_PARENT_ACTION_IDS = "book_parent_action_ids";
const BOOK_PHASE = "book_phase";
const BOOK_REBASED_OVER = "book_rebased_over";
const BOOK_SCOPE = "book_scope";
const BOOK_TARGET_ACTION_ID = "book_target_action_id";
const BOOK_TARGET_ARTIFACT_ID = "book_target_artifact_id";

interface ActionAccumulator {
  action: BookAction;
  firstRevisionIndex: number;
}

function stringValue(
  details: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = details[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function stringArray(
  details: Record<string, unknown>,
  key: string,
): string[] {
  const value = details[key];
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function actionPhase(details: Record<string, unknown>): BookActionPhase {
  const value = details[BOOK_PHASE];
  return value === "requested" ||
    value === "started" ||
    value === "completed" ||
    value === "failed" ||
    value === "cancelled" ||
    value === "conflicted"
    ? value
    : "completed";
}

function inferredScope(revision: ProjectRevision): BookActionScope {
  const value = revision.details?.[BOOK_SCOPE];
  if (
    value === "project" ||
    value === "artifact" ||
    value === "layout" ||
    value === "external" ||
    value === "system"
  ) {
    return value;
  }
  if (revision.operation?.includes("layout")) return "layout";
  if (revision.assetId) return "artifact";
  if (
    revision.operation === "create_project" ||
    revision.operation === "rename_project" ||
    revision.operation === "delete_project" ||
    revision.operation === "rewind"
  ) {
    return "project";
  }
  return revision.operation?.startsWith("action:") ? "project" : "system";
}

function bookLayout(details: Record<string, unknown>): BookLayout | undefined {
  const value = details[BOOK_LAYOUT];
  if (typeof value !== "object" || value === null) return undefined;
  const stage = "stage" in value ? value.stage : undefined;
  const column = "column" in value ? value.column : undefined;
  return Number.isInteger(stage) &&
    Number(stage) >= 0 &&
    Number.isInteger(column) &&
    Number(column) >= 0
    ? { stage: Number(stage), column: Number(column) }
    : undefined;
}

function artifactKind(slug: string): BookArtifactKind {
  if (slug.startsWith("prm-") || slug.startsWith("prompt-")) return "prompt";
  if (slug.startsWith("img-")) return "image";
  if (slug.startsWith("vid-")) return "video";
  if (slug.startsWith("char-")) return "character";
  if (slug.startsWith("scn-") || slug.startsWith("scene-")) return "scene";
  if (slug.startsWith("aud-")) return "audio";
  if (slug.startsWith("scr-")) return "script";
  if (slug === "final" || slug.startsWith("final-")) return "final";
  if (slug.startsWith("nb-")) return "notebook";
  return "unknown";
}

function artifactRef(id: string): BookArtifactRef {
  const slug = id.replace(/^@/, "");
  return { id: slug, slug: `@${slug}`, kind: artifactKind(slug) };
}

function uniqueArtifacts(ids: string[]): BookArtifactRef[] {
  return [
    ...new Map(ids.map((id) => {
      const artifact = artifactRef(id);
      return [artifact.id, artifact] as const;
    })).values(),
  ];
}

function titleForOperation(operation: string): string {
  return operation
    .replace(/^book:/, "")
    .replace(/^action:/, "")
    .replace(/^tool-/, "")
    .replaceAll("_", " ")
    .replaceAll("-", " ");
}

function eventFromRevision(
  revision: ProjectRevision,
  details: Record<string, unknown>,
): BookActionEvent {
  return {
    id: revision.operationId ?? revision.hash,
    revision: revision.hash,
    phase: actionPhase(details),
    date: revision.date,
    details,
    files: revision.files ?? [],
    fileChanges: revision.fileChanges ?? [],
  };
}

function actionFromRevision(
  revision: ProjectRevision,
  projectId: string,
): BookAction {
  const details = revision.details ?? {};
  const actionId =
    stringValue(details, BOOK_ACTION_ID) ??
    revision.operationId ??
    revision.hash;
  const inputIds = stringArray(details, BOOK_INPUT_ARTIFACT_IDS);
  const outputIds = stringArray(details, BOOK_OUTPUT_ARTIFACT_IDS);
  const targetArtifactId =
    stringValue(details, BOOK_TARGET_ARTIFACT_ID) ?? revision.assetId;
  if (
    outputIds.length === 0 &&
    revision.assetId &&
    !stringValue(details, BOOK_ACTION_ID)
  ) {
    outputIds.push(revision.assetId);
  }
  const operation = revision.operation ?? revision.message;
  const event = eventFromRevision(revision, details);
  return {
    id: actionId,
    projectId,
    operation,
    title: titleForOperation(operation),
    scope: inferredScope(revision),
    actor: revision.author ?? "videobook",
    lane: stringValue(details, BOOK_LANE) ?? revision.author ?? "videobook",
    date: revision.date,
    phase: event.phase,
    ...(stringValue(details, BOOK_BASE_REVISION)
      ? { baseRevision: stringValue(details, BOOK_BASE_REVISION) }
      : {}),
    ...(stringValue(details, BOOK_REBASED_OVER)
      ? { rebasedOver: stringValue(details, BOOK_REBASED_OVER) }
      : {}),
    parentActionIds: stringArray(details, BOOK_PARENT_ACTION_IDS),
    inputArtifacts: uniqueArtifacts(inputIds),
    outputArtifacts: uniqueArtifacts(outputIds),
    ...(targetArtifactId ? { targetArtifactId } : {}),
    ...(stringValue(details, BOOK_TARGET_ACTION_ID)
      ? { targetActionId: stringValue(details, BOOK_TARGET_ACTION_ID) }
      : {}),
    ...(bookLayout(details) ? { layout: bookLayout(details) } : {}),
    details,
    events: [event],
  };
}

function mergeAction(
  current: BookAction,
  revision: ProjectRevision,
): BookAction {
  const details = revision.details ?? {};
  const event = eventFromRevision(revision, details);
  const next = actionFromRevision(revision, current.projectId);
  return {
    ...current,
    operation: next.operation,
    title: next.title,
    scope: next.scope,
    actor: next.actor,
    lane: next.lane,
    phase: event.phase,
    ...(next.baseRevision ? { baseRevision: next.baseRevision } : {}),
    ...(next.rebasedOver ? { rebasedOver: next.rebasedOver } : {}),
    parentActionIds: [
      ...new Set([...current.parentActionIds, ...next.parentActionIds]),
    ],
    inputArtifacts: uniqueArtifacts([
      ...current.inputArtifacts.map((item) => item.id),
      ...next.inputArtifacts.map((item) => item.id),
    ]),
    outputArtifacts: uniqueArtifacts([
      ...current.outputArtifacts.map((item) => item.id),
      ...next.outputArtifacts.map((item) => item.id),
    ]),
    ...(next.targetArtifactId
      ? { targetArtifactId: next.targetArtifactId }
      : {}),
    ...(next.targetActionId ? { targetActionId: next.targetActionId } : {}),
    ...(next.layout ? { layout: next.layout } : {}),
    details,
    events: [...current.events, event].sort((left, right) =>
      left.date.localeCompare(right.date),
    ),
  };
}

export function projectBookFromRevisions(
  projectId: string,
  slug: string,
  headRevision: string,
  revisions: ProjectRevision[],
  options: GetProjectBookOptions = {},
): ProjectBook {
  const cursorIndex = options.cursor
    ? revisions.findIndex((revision) => revision.hash === options.cursor)
    : -1;
  const eligible = cursorIndex >= 0
    ? revisions.slice(cursorIndex + 1)
    : revisions;
  const accumulators = new Map<string, ActionAccumulator>();
  [...eligible].reverse().forEach((revision, reversedIndex) => {
    const index = eligible.length - 1 - reversedIndex;
    const details = revision.details ?? {};
    const actionId =
      stringValue(details, BOOK_ACTION_ID) ??
      revision.operationId ??
      revision.hash;
    const current = accumulators.get(actionId);
    if (current) {
      current.action = mergeAction(current.action, revision);
      current.firstRevisionIndex = Math.min(
        current.firstRevisionIndex,
        index,
      );
      return;
    }
    accumulators.set(actionId, {
      action: actionFromRevision(revision, projectId),
      firstRevisionIndex: index,
    });
  });
  const newest = [...accumulators.values()].sort(
    (left, right) => left.firstRevisionIndex - right.firstRevisionIndex,
  );
  const limit = Math.max(1, options.limit ?? 200);
  const page = newest.slice(0, limit);
  const actions = page
    .map((item) => item.action)
    .sort((left, right) => left.date.localeCompare(right.date));
  const nextCursor =
    newest.length > limit
      ? page.at(-1)?.action.events.at(-1)?.revision
      : undefined;
  return {
    projectId,
    slug,
    headRevision,
    actions,
    ...(nextCursor ? { nextCursor } : {}),
  };
}
