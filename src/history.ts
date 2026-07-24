import { rm } from "node:fs/promises";

import type { DoltDiffRow } from "@dolthub/doltlite";
import { v7 as uuidv7 } from "uuid";

import type {
  BookAction,
  BookActionEvent,
  BookActionPhase,
  BookActionRevision,
  BookActionScope,
  BookArtifactKind,
  BookArtifactRef,
  GetProjectBookOptions,
  ProjectBook,
  RecordBookActionInput,
} from "./book/types.js";
import type {
  ActionLogEntry,
  EngineError,
  Result,
  Revision,
  RevisionFileChange,
} from "./engine-types.js";
import { ok } from "./engine-types.js";
import {
  EngineContext,
  resultOf,
  type ArtifactRow,
  type FileRow,
} from "./context.js";
import { artifactSlug } from "./artifacts.js";
import { materializeArtifact } from "./files.js";
import {
  canonicalJson,
  EngineFault,
  parseJson,
} from "./store.js";

interface OperationDiff {
  operation_id: string;
  project_id: string;
  operation: string;
  artifact_id: string | null;
  details_json: string;
  write_set_json: string;
  base_revision: string | null;
  created_at: number;
  author: string;
}

interface ActionRow {
  action_id: string;
  project_id: string;
  operation: string;
  scope: BookActionScope;
  actor: string;
  lane: string;
  phase: BookActionPhase;
  base_revision: string | null;
  target_artifact_id: string | null;
  target_action_id: string | null;
  layout_json: string | null;
  details_json: string;
  created_at: number;
  updated_at: number;
}

interface ActionEventRow {
  event_id: string;
  action_id: string;
  operation_id: string;
  phase: BookActionPhase;
  details_json: string;
  created_at: number;
}

interface HistoricalArtifactRow {
  artifact_id: string;
  project_id: string;
  slug: string;
  kind: ArtifactRow["kind"];
  data_json: string;
  created_at: number;
  updated_at: number;
  deleted_at: number | null;
}

interface MetadataSnapshotRow {
  key: string;
  value_json: string;
  updated_at: number;
}

interface WaveformSnapshotRow {
  peaks_json: string;
  updated_at: number;
}

export function createHistoryApi(context: EngineContext) {
  return {
    project: (project: string, limit = 20): Revision[] =>
      projectHistory(context, project, limit),
    artifact: (
      artifact: string,
      project: string,
      limit = 20,
    ): Revision[] => artifactHistory(context, artifact, project, limit),
    resolveRevision: (
      revision: string,
      project: string,
    ): Revision | null =>
      resolveRevision(context, revision, project),
    recordOperation: (
      operation: string,
      artifact: string | undefined,
      details: Record<string, unknown> | undefined,
      project: string,
    ): Promise<Result<Revision, EngineError>> =>
      recordOperation(context, operation, artifact, details, project),
    restoreArtifact: (
      artifactId: string,
      revision: string,
      project: string,
      slug?: string,
    ): Promise<Result<Revision, EngineError>> =>
      restoreArtifact(context, artifactId, revision, project, slug),
    restoreProject: (
      revision: string,
      project: string,
    ): Promise<Result<Revision, EngineError>> =>
      restoreProject(context, revision, project),
    logAction: (
      action: string,
      payload: string | Record<string, unknown>,
      project: string,
    ): Promise<Result<ActionLogEntry, EngineError>> =>
      logAction(context, action, payload, project),
    actionLog: (
      project: string,
      options?: { limit?: number; action?: string },
    ): ActionLogEntry[] => actionLog(context, project, options),
    projectBook: (
      project: string,
      options?: GetProjectBookOptions,
    ): Result<ProjectBook, EngineError> =>
      projectBook(context, project, options),
    bookAction: (
      project: string,
      actionId: string,
    ): Result<BookAction, EngineError> =>
      bookAction(context, project, actionId),
    recordBookAction: (
      input: RecordBookActionInput,
    ): Promise<Result<BookActionRevision, EngineError>> =>
      recordBookAction(context, input),
  };
}

function revisionForHash(
  context: EngineContext,
  hash: string,
): Revision {
  const commit = context.store.db
    .doltLog()
    .find((item) => item.commit_hash === hash);
  return {
    hash,
    message: commit?.message ?? "",
    date: commit?.date ?? new Date().toISOString(),
    author: commit?.committer ?? "videobook",
  };
}

function projectHistory(
  context: EngineContext,
  projectReference: string,
  limit: number,
): Revision[] {
  const project = context.projectRow(projectReference);
  return allRevisions(context)
    .filter((revision) => revision.projectId === project.project_id)
    .slice(0, Math.max(0, limit));
}

function artifactHistory(
  context: EngineContext,
  artifactReference: string,
  projectReference: string,
  limit: number,
): Revision[] {
  const project = context.projectRow(projectReference);
  const artifact = context.artifactRow(
    project.project_id,
    artifactReference,
    true,
  );
  return allRevisions(context)
    .filter((revision) => revision.artifactId === artifact.artifact_id)
    .slice(0, Math.max(0, limit));
}

function allRevisions(context: EngineContext): Revision[] {
  const commits = context.store.db.doltLog();
  const revisions: Revision[] = [];
  for (let index = 0; index < commits.length - 1; index += 1) {
    const commit = commits[index]!;
    const parent = commits[index + 1]!;
    const operations = context.store
      .diff(parent.commit_hash, commit.commit_hash, "operations")
      .filter((row) => row.diff_type === "added")
      .map(operationFromDiff)
      .filter(
        (operation): operation is OperationDiff => operation !== null,
      );
    for (const operation of operations) {
      const details = parseJson<Record<string, unknown>>(
        operation.details_json,
        {},
      );
      const writeSet = parseJson<string[]>(
        operation.write_set_json,
        [],
      );
      const artifactSlugAtRevision = operation.artifact_id
        ? artifactSlugAt(
            context,
            operation.artifact_id,
            commit.commit_hash,
          )
        : undefined;
      const fileChanges = revisionFileChanges(
        context.store.diff(
          parent.commit_hash,
          commit.commit_hash,
          "artifact_files",
        ),
        operation.artifact_id,
      );
      revisions.push({
        hash: commit.commit_hash,
        message: commit.message,
        date: new Date(operation.created_at).toISOString(),
        author: operation.author,
        projectId: operation.project_id,
        operationId: operation.operation_id,
        operation: operation.operation,
        ...(operation.artifact_id
          ? { artifactId: operation.artifact_id }
          : {}),
        ...(artifactSlugAtRevision
          ? { artifactSlug: artifactSlugAtRevision }
          : {}),
        details: {
          ...details,
          ...(writeSet.length > 0 ? { writeSet } : {}),
          ...(operation.base_revision
            ? { baseRevision: operation.base_revision }
            : {}),
        },
        files: fileChanges.map((change) => change.file),
        fileChanges,
      });
    }
  }
  return revisions;
}

function resolveRevision(
  context: EngineContext,
  reference: string,
  projectReference: string,
): Revision | null {
  return (
    projectHistory(context, projectReference, 10_000).find(
      (revision) =>
        revision.hash === reference ||
        revision.hash.startsWith(reference),
    ) ?? null
  );
}

async function recordOperation(
  context: EngineContext,
  operation: string,
  artifactReference: string | undefined,
  details: Record<string, unknown> | undefined,
  projectReference: string,
): Promise<Result<Revision, EngineError>> {
  return resultOf(async () => {
    const project = context.projectRow(projectReference);
    const artifact = artifactReference
      ? context.artifactRow(project.project_id, artifactReference)
      : null;
    const mutation = await context.store.semantic(
      {
        projectId: project.project_id,
        operation,
        ...(artifact ? { artifactId: artifact.artifact_id } : {}),
        details: {
          ...(details ?? {}),
          ...(artifact ? { artifactSlug: artifact.slug } : {}),
        },
        writeSet: artifact
          ? [`artifact:${artifact.artifact_id}`]
          : [`project:${project.project_id}`],
      },
      [],
      () => undefined,
    );
    return ok(
      revisionForHash(context, mutation.revision),
      mutation.revision,
    );
  });
}

async function restoreArtifact(
  context: EngineContext,
  artifactId: string,
  revisionReference: string,
  projectReference: string,
  replacementSlug?: string,
): Promise<Result<Revision, EngineError>> {
  return resultOf(async () => {
    const project = context.projectRow(projectReference);
    const revision =
      resolveRevision(context, revisionReference, project.project_id) ??
      revisionForHash(context, revisionReference);
    const target = context.store.db
      .prepare(
        `SELECT artifact_id, project_id, slug, kind, data_json,
                created_at, updated_at, deleted_at
         FROM dolt_at_artifacts(?)
         WHERE artifact_id=? AND project_id=?`,
      )
      .get(
        revision.hash,
        artifactId,
        project.project_id,
      ) as unknown as HistoricalArtifactRow | undefined;
    if (!target) {
      throw new EngineFault({
        code: "NOT_FOUND",
        message: `Artifact ${artifactId} did not exist at ${revision.hash}`,
      });
    }
    const desiredSlug = replacementSlug
      ? artifactSlug(target.kind, replacementSlug)
      : target.slug;
    const owner = context.store.db
      .prepare(
        `SELECT artifact_id
         FROM artifacts
         WHERE project_id=? AND slug=? AND deleted_at IS NULL
           AND artifact_id<>?`,
      )
      .get(
        project.project_id,
        desiredSlug,
        artifactId,
      ) as unknown as { artifact_id: string } | undefined;
    if (owner) {
      throw new EngineFault({
        code: "SLUG_CONFLICT",
        message: `Slug ${desiredSlug} is owned by active artifact ${owner.artifact_id}`,
        ownerId: owner.artifact_id,
      });
    }
    const files = filesAt(context, revision.hash, artifactId);
    const metadata = context.store.db
      .prepare(
        `SELECT key, value_json, updated_at
         FROM dolt_at_artifact_metadata(?)
         WHERE artifact_id=?`,
      )
      .all(
        revision.hash,
        artifactId,
      ) as unknown as MetadataSnapshotRow[];
    const waveform = context.store.db
      .prepare(
        `SELECT peaks_json, updated_at
         FROM dolt_at_audio_waveforms(?)
         WHERE artifact_id=?`,
      )
      .get(
        revision.hash,
        artifactId,
      ) as unknown as WaveformSnapshotRow | undefined;
    const mutation = await context.store.semantic(
      {
        projectId: project.project_id,
        operation: "restore_artifact",
        artifactId,
        details: {
          fromRevision: revision.hash,
          slug: desiredSlug,
        },
        writeSet: [
          `artifact:${artifactId}`,
          `artifact-slug:${project.project_id}:${desiredSlug}`,
        ],
      },
      [
        "artifacts",
        "artifact_files",
        "artifact_metadata",
        "audio_waveforms",
        "artifact_events",
      ],
      (operationId, now) => {
        context.store.db
          .prepare(
            `INSERT INTO artifacts(
              artifact_id, project_id, slug, kind, data_json,
              created_at, updated_at, deleted_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL)
            ON CONFLICT(artifact_id) DO UPDATE SET
              project_id=excluded.project_id,
              slug=excluded.slug,
              kind=excluded.kind,
              data_json=excluded.data_json,
              updated_at=excluded.updated_at,
              deleted_at=NULL`,
          )
          .run(
            target.artifact_id,
            target.project_id,
            desiredSlug,
            target.kind,
            target.data_json,
            target.created_at,
            now,
          );
        context.store.db
          .prepare("DELETE FROM artifact_files WHERE artifact_id=?")
          .run(artifactId);
        context.store.db
          .prepare("DELETE FROM artifact_metadata WHERE artifact_id=?")
          .run(artifactId);
        context.store.db
          .prepare("DELETE FROM audio_waveforms WHERE artifact_id=?")
          .run(artifactId);
        insertFiles(context, files);
        const insertMetadata = context.store.db.prepare(
          `INSERT INTO artifact_metadata(
            artifact_id, key, value_json, updated_at
          ) VALUES (?, ?, ?, ?)`,
        );
        for (const row of metadata) {
          insertMetadata.run(
            artifactId,
            row.key,
            row.value_json,
            row.updated_at,
          );
        }
        if (waveform) {
          context.store.db
            .prepare(
              `INSERT INTO audio_waveforms(
                artifact_id, peaks_json, updated_at
              ) VALUES (?, ?, ?)`,
            )
            .run(
              artifactId,
              waveform.peaks_json,
              waveform.updated_at,
            );
        }
        context.store.db
          .prepare(
            `INSERT INTO artifact_events(
              event_id, artifact_id, operation_id, event,
              details_json, created_at
            ) VALUES (?, ?, ?, 'restored', ?, ?)`,
          )
          .run(
            uuidv7(),
            artifactId,
            operationId,
            canonicalJson({ fromRevision: revision.hash }),
            now,
          );
        resetArtifactRuntime(
          context,
          project.project_id,
          artifactId,
          now,
        );
      },
    );
    await rm(context.artifactPath(project.project_id, artifactId), {
      recursive: true,
      force: true,
    });
    await materializeArtifact(context, artifactId);
    return ok(
      revisionForHash(context, mutation.revision),
      mutation.revision,
    );
  });
}

async function restoreProject(
  context: EngineContext,
  revisionReference: string,
  projectReference: string,
): Promise<Result<Revision, EngineError>> {
  return resultOf(async () => {
    const project = context.projectRow(projectReference);
    const revision =
      resolveRevision(context, revisionReference, project.project_id) ??
      revisionForHash(context, revisionReference);
    const targetProject = context.store.db
      .prepare(
        `SELECT project_id, slug, created_at, updated_at, deleted_at
         FROM dolt_at_projects(?)
         WHERE project_id=?`,
      )
      .get(revision.hash, project.project_id) as unknown as
      | {
          project_id: string;
          slug: string;
          created_at: number;
          updated_at: number;
          deleted_at: number | null;
        }
      | undefined;
    if (!targetProject) {
      throw new EngineFault({
        code: "NOT_FOUND",
        message: `Project did not exist at ${revision.hash}`,
      });
    }
    const targetArtifacts = context.store.db
      .prepare(
        `SELECT artifact_id, project_id, slug, kind, data_json,
                created_at, updated_at, deleted_at
         FROM dolt_at_artifacts(?)
         WHERE project_id=? AND deleted_at IS NULL
         ORDER BY artifact_id`,
      )
      .all(
        revision.hash,
        project.project_id,
      ) as unknown as HistoricalArtifactRow[];
    const targetIds = targetArtifacts.map((row) => row.artifact_id);
    const targetFiles =
      targetIds.length === 0
        ? []
        : (context.store.db
            .prepare(
              `SELECT artifact_id, path, object_hash, size_bytes,
                      mime_type, mtime_ms, created_at
               FROM dolt_at_artifact_files(?)
               WHERE artifact_id IN (${targetIds
                 .map(() => "?")
                 .join(", ")})`,
            )
            .all(
              revision.hash,
              ...targetIds,
            ) as unknown as FileRow[]);
    const projectMetadata = context.store.db
      .prepare(
        `SELECT key, value_json, updated_at
         FROM dolt_at_project_metadata(?)
         WHERE project_id=?`,
      )
      .all(
        revision.hash,
        project.project_id,
      ) as unknown as MetadataSnapshotRow[];
    const artifactMetadata =
      targetIds.length === 0
        ? []
        : (context.store.db
            .prepare(
              `SELECT artifact_id, key, value_json, updated_at
               FROM dolt_at_artifact_metadata(?)
               WHERE artifact_id IN (${targetIds
                 .map(() => "?")
                 .join(", ")})`,
            )
            .all(revision.hash, ...targetIds) as unknown as Array<{
            artifact_id: string;
            key: string;
            value_json: string;
            updated_at: number;
          }>);
    const waveforms =
      targetIds.length === 0
        ? []
        : (context.store.db
            .prepare(
              `SELECT artifact_id, peaks_json, updated_at
               FROM dolt_at_audio_waveforms(?)
               WHERE artifact_id IN (${targetIds
                 .map(() => "?")
                 .join(", ")})`,
            )
            .all(revision.hash, ...targetIds) as unknown as Array<{
            artifact_id: string;
            peaks_json: string;
            updated_at: number;
          }>);
    const entities = context.store.db
      .prepare(
        `SELECT entity_id, project_id, type, name, description, prompt,
                data_json, created_at, updated_at, deleted_at
         FROM dolt_at_entities(?)
         WHERE project_id=? AND deleted_at IS NULL`,
      )
      .all(revision.hash, project.project_id) as unknown as Array<{
      entity_id: string;
      project_id: string;
      type: string;
      name: string;
      description: string | null;
      prompt: string | null;
      data_json: string;
      created_at: number;
      updated_at: number;
      deleted_at: null;
    }>;
    const notebooks = context.store.db
      .prepare(
        `SELECT notebook_id, project_id, name, version, properties_json,
                created_at, updated_at, deleted_at
         FROM dolt_at_notebooks(?)
         WHERE project_id=? AND deleted_at IS NULL`,
      )
      .all(revision.hash, project.project_id) as unknown as Array<{
      notebook_id: string;
      project_id: string;
      name: string;
      version: number;
      properties_json: string;
      created_at: number;
      updated_at: number;
      deleted_at: null;
    }>;
    const notebookIds = notebooks.map((row) => row.notebook_id);
    const notebookCells =
      notebookIds.length === 0
        ? []
        : (context.store.db
            .prepare(
              `SELECT notebook_id, cell_id, type, title,
                      position_x, position_y, entity_id, prompt, model,
                      inputs_json, output_artifact_id, ordinal
               FROM dolt_at_notebook_cells(?)
               WHERE notebook_id IN (${notebookIds
                 .map(() => "?")
                 .join(", ")})`,
            )
            .all(revision.hash, ...notebookIds) as unknown as Array<{
            notebook_id: string;
            cell_id: string;
            type: string;
            title: string;
            position_x: number;
            position_y: number;
            entity_id: string | null;
            prompt: string | null;
            model: string | null;
            inputs_json: string;
            output_artifact_id: string | null;
            ordinal: number;
          }>);
    const notebookEdges =
      notebookIds.length === 0
        ? []
        : (context.store.db
            .prepare(
              `SELECT notebook_id, edge_id, source_cell_id,
                      target_cell_id, target_input, ordinal
               FROM dolt_at_notebook_edges(?)
               WHERE notebook_id IN (${notebookIds
                 .map(() => "?")
                 .join(", ")})`,
            )
            .all(revision.hash, ...notebookIds) as unknown as Array<{
            notebook_id: string;
            edge_id: string;
            source_cell_id: string;
            target_cell_id: string;
            target_input: string;
            ordinal: number;
          }>);
    const notebookRuns =
      notebookIds.length === 0
        ? []
        : (context.store.db
            .prepare(
              `SELECT run_id, notebook_id, project_id, status,
                      started_at, completed_at, cell_order_json,
                      outputs_json, error
               FROM dolt_at_notebook_runs(?)
               WHERE notebook_id IN (${notebookIds
                 .map(() => "?")
                 .join(", ")})`,
            )
            .all(revision.hash, ...notebookIds) as unknown as Array<{
            run_id: string;
            notebook_id: string;
            project_id: string;
            status: string;
            started_at: number;
            completed_at: number | null;
            cell_order_json: string;
            outputs_json: string;
            error: string | null;
          }>);
    const timeline = context.store.db
      .prepare(
        `SELECT project_id, render, data_json, updated_at
         FROM dolt_at_timelines(?) WHERE project_id=?`,
      )
      .get(revision.hash, project.project_id) as unknown as
      | {
          project_id: string;
          render: string;
          data_json: string;
          updated_at: number;
        }
      | undefined;
    const timelineSlots = context.store.db
      .prepare(
        `SELECT project_id, slot_id, artifact_id, ordinal, data_json
         FROM dolt_at_timeline_slots(?) WHERE project_id=?`,
      )
      .all(revision.hash, project.project_id) as unknown as Array<{
      project_id: string;
      slot_id: string;
      artifact_id: string | null;
      ordinal: number;
      data_json: string;
    }>;
    const timelineAudio = context.store.db
      .prepare(
        `SELECT project_id, audio_id, artifact_id, ordinal, data_json
         FROM dolt_at_timeline_audio(?) WHERE project_id=?`,
      )
      .all(revision.hash, project.project_id) as unknown as Array<{
      project_id: string;
      audio_id: string;
      artifact_id: string | null;
      ordinal: number;
      data_json: string;
    }>;
    const prompts = context.store.db
      .prepare(
        `SELECT prompt_id, project_id, surface, prompt,
                context_json, created_at
         FROM dolt_at_prompt_entries(?) WHERE project_id=?`,
      )
      .all(revision.hash, project.project_id) as unknown as Array<{
      prompt_id: number;
      project_id: string;
      surface: string;
      prompt: string;
      context_json: string;
      created_at: number;
    }>;
    const messages = context.store.db
      .prepare(
        `SELECT message_id, project_id, role, body_json, created_at
         FROM dolt_at_messages(?) WHERE project_id=?`,
      )
      .all(revision.hash, project.project_id) as unknown as Array<{
      message_id: string;
      project_id: string;
      role: string;
      body_json: string;
      created_at: number;
    }>;
    const slugOwner = context.store.db
      .prepare(
        `SELECT project_id FROM projects
         WHERE slug=? AND deleted_at IS NULL AND project_id<>?`,
      )
      .get(targetProject.slug, project.project_id) as unknown as
      | { project_id: string }
      | undefined;
    if (slugOwner) {
      throw new EngineFault({
        code: "SLUG_CONFLICT",
        message: `Project slug ${targetProject.slug} is owned by active project ${slugOwner.project_id}`,
        ownerId: slugOwner.project_id,
      });
    }
    const currentIds = (
      context.store.db
        .prepare(
          "SELECT artifact_id FROM artifacts WHERE project_id=?",
        )
        .all(project.project_id) as unknown as Array<{
        artifact_id: string;
      }>
    ).map((row) => row.artifact_id);
    const currentNotebookIds = (
      context.store.db
        .prepare(
          "SELECT notebook_id FROM notebooks WHERE project_id=?",
        )
        .all(project.project_id) as unknown as Array<{
        notebook_id: string;
      }>
    ).map((row) => row.notebook_id);
    const mutation = await context.store.semantic(
      {
        projectId: project.project_id,
        operation: "restore_project",
        details: { fromRevision: revision.hash },
        writeSet: [`project:${project.project_id}`],
      },
      [
        "projects",
        "artifacts",
        "artifact_files",
        "project_metadata",
        "artifact_metadata",
        "audio_waveforms",
        "entities",
        "notebooks",
        "notebook_cells",
        "notebook_edges",
        "notebook_runs",
        "timelines",
        "timeline_slots",
        "timeline_audio",
        "prompt_entries",
        "messages",
        "artifact_events",
        "job_runs",
      ],
      (operationId, now) => {
        context.store.db
          .prepare(
            `UPDATE artifacts
             SET deleted_at=?, updated_at=?
             WHERE project_id=? AND deleted_at IS NULL`,
          )
          .run(now, now, project.project_id);
        context.store.db
          .prepare(
            `UPDATE projects
             SET slug=?, created_at=?, updated_at=?, deleted_at=NULL
             WHERE project_id=?`,
          )
          .run(
            targetProject.slug,
            targetProject.created_at,
            now,
            project.project_id,
          );
        const upsertArtifact = context.store.db.prepare(
          `INSERT INTO artifacts(
            artifact_id, project_id, slug, kind, data_json,
            created_at, updated_at, deleted_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL)
          ON CONFLICT(artifact_id) DO UPDATE SET
            project_id=excluded.project_id,
            slug=excluded.slug,
            kind=excluded.kind,
            data_json=excluded.data_json,
            updated_at=excluded.updated_at,
            deleted_at=NULL`,
        );
        for (const row of targetArtifacts) {
          upsertArtifact.run(
            row.artifact_id,
            row.project_id,
            row.slug,
            row.kind,
            row.data_json,
            row.created_at,
            now,
          );
          context.store.db
            .prepare(
              `INSERT INTO artifact_events(
                event_id, artifact_id, operation_id, event,
                details_json, created_at
              ) VALUES (?, ?, ?, 'restored_with_project', ?, ?)`,
            )
            .run(
              uuidv7(),
              row.artifact_id,
              operationId,
              canonicalJson({ fromRevision: revision.hash }),
              now,
            );
        }
        if (currentIds.length > 0) {
          context.store.db
            .prepare(
              `DELETE FROM artifact_files
               WHERE artifact_id IN (${currentIds
                 .map(() => "?")
                 .join(", ")})`,
            )
            .run(...currentIds);
          context.store.db
            .prepare(
              `DELETE FROM artifact_metadata
               WHERE artifact_id IN (${currentIds
                 .map(() => "?")
                 .join(", ")})`,
            )
            .run(...currentIds);
          context.store.db
            .prepare(
              `DELETE FROM audio_waveforms
               WHERE artifact_id IN (${currentIds
                 .map(() => "?")
                 .join(", ")})`,
            )
            .run(...currentIds);
        }
        insertFiles(context, targetFiles);
        const insertArtifactMetadata = context.store.db.prepare(
          `INSERT INTO artifact_metadata(
            artifact_id, key, value_json, updated_at
          ) VALUES (?, ?, ?, ?)`,
        );
        for (const row of artifactMetadata) {
          insertArtifactMetadata.run(
            row.artifact_id,
            row.key,
            row.value_json,
            row.updated_at,
          );
        }
        const insertWaveform = context.store.db.prepare(
          `INSERT INTO audio_waveforms(
            artifact_id, peaks_json, updated_at
          ) VALUES (?, ?, ?)`,
        );
        for (const row of waveforms) {
          insertWaveform.run(
            row.artifact_id,
            row.peaks_json,
            row.updated_at,
          );
        }
        context.store.db
          .prepare("DELETE FROM project_metadata WHERE project_id=?")
          .run(project.project_id);
        const insertMetadata = context.store.db.prepare(
          `INSERT INTO project_metadata(
            project_id, key, value_json, updated_at
          ) VALUES (?, ?, ?, ?)`,
        );
        for (const row of projectMetadata) {
          insertMetadata.run(
            project.project_id,
            row.key,
            row.value_json,
            row.updated_at,
          );
        }
        context.store.db
          .prepare(
            `UPDATE entities
             SET deleted_at=?, updated_at=?
             WHERE project_id=? AND deleted_at IS NULL`,
          )
          .run(now, now, project.project_id);
        const upsertEntity = context.store.db.prepare(
          `INSERT INTO entities(
            entity_id, project_id, type, name, description, prompt,
            data_json, created_at, updated_at, deleted_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
          ON CONFLICT(entity_id) DO UPDATE SET
            project_id=excluded.project_id,
            type=excluded.type,
            name=excluded.name,
            description=excluded.description,
            prompt=excluded.prompt,
            data_json=excluded.data_json,
            updated_at=excluded.updated_at,
            deleted_at=NULL`,
        );
        for (const row of entities) {
          upsertEntity.run(
            row.entity_id,
            row.project_id,
            row.type,
            row.name,
            row.description,
            row.prompt,
            row.data_json,
            row.created_at,
            now,
          );
        }
        if (currentNotebookIds.length > 0) {
          const placeholders = currentNotebookIds
            .map(() => "?")
            .join(", ");
          context.store.db
            .prepare(
              `DELETE FROM notebook_edges
               WHERE notebook_id IN (${placeholders})`,
            )
            .run(...currentNotebookIds);
          context.store.db
            .prepare(
              `DELETE FROM notebook_cells
               WHERE notebook_id IN (${placeholders})`,
            )
            .run(...currentNotebookIds);
          context.store.db
            .prepare(
              `DELETE FROM notebook_runs
               WHERE notebook_id IN (${placeholders})`,
            )
            .run(...currentNotebookIds);
        }
        context.store.db
          .prepare(
            `UPDATE notebooks
             SET deleted_at=?, updated_at=?
             WHERE project_id=? AND deleted_at IS NULL`,
          )
          .run(now, now, project.project_id);
        const upsertNotebook = context.store.db.prepare(
          `INSERT INTO notebooks(
            notebook_id, project_id, name, version, properties_json,
            created_at, updated_at, deleted_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL)
          ON CONFLICT(notebook_id) DO UPDATE SET
            project_id=excluded.project_id,
            name=excluded.name,
            version=excluded.version,
            properties_json=excluded.properties_json,
            updated_at=excluded.updated_at,
            deleted_at=NULL`,
        );
        for (const row of notebooks) {
          upsertNotebook.run(
            row.notebook_id,
            row.project_id,
            row.name,
            row.version,
            row.properties_json,
            row.created_at,
            now,
          );
        }
        const insertCell = context.store.db.prepare(
          `INSERT INTO notebook_cells(
            notebook_id, cell_id, type, title, position_x, position_y,
            entity_id, prompt, model, inputs_json,
            output_artifact_id, ordinal
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        );
        for (const row of notebookCells) {
          insertCell.run(
            row.notebook_id,
            row.cell_id,
            row.type,
            row.title,
            row.position_x,
            row.position_y,
            row.entity_id,
            row.prompt,
            row.model,
            row.inputs_json,
            row.output_artifact_id,
            row.ordinal,
          );
        }
        const insertEdge = context.store.db.prepare(
          `INSERT INTO notebook_edges(
            notebook_id, edge_id, source_cell_id,
            target_cell_id, target_input, ordinal
          ) VALUES (?, ?, ?, ?, ?, ?)`,
        );
        for (const row of notebookEdges) {
          insertEdge.run(
            row.notebook_id,
            row.edge_id,
            row.source_cell_id,
            row.target_cell_id,
            row.target_input,
            row.ordinal,
          );
        }
        const insertRun = context.store.db.prepare(
          `INSERT INTO notebook_runs(
            run_id, notebook_id, project_id, status,
            started_at, completed_at, cell_order_json,
            outputs_json, error
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        );
        for (const row of notebookRuns) {
          insertRun.run(
            row.run_id,
            row.notebook_id,
            row.project_id,
            row.status,
            row.started_at,
            row.completed_at,
            row.cell_order_json,
            row.outputs_json,
            row.error,
          );
        }
        context.store.db
          .prepare("DELETE FROM timeline_slots WHERE project_id=?")
          .run(project.project_id);
        context.store.db
          .prepare("DELETE FROM timeline_audio WHERE project_id=?")
          .run(project.project_id);
        context.store.db
          .prepare("DELETE FROM timelines WHERE project_id=?")
          .run(project.project_id);
        if (timeline) {
          context.store.db
            .prepare(
              `INSERT INTO timelines(
                project_id, render, data_json, updated_at
              ) VALUES (?, ?, ?, ?)`,
            )
            .run(
              timeline.project_id,
              timeline.render,
              timeline.data_json,
              timeline.updated_at,
            );
        }
        const insertSlot = context.store.db.prepare(
          `INSERT INTO timeline_slots(
            project_id, slot_id, artifact_id, ordinal, data_json
          ) VALUES (?, ?, ?, ?, ?)`,
        );
        for (const row of timelineSlots) {
          insertSlot.run(
            row.project_id,
            row.slot_id,
            row.artifact_id,
            row.ordinal,
            row.data_json,
          );
        }
        const insertAudio = context.store.db.prepare(
          `INSERT INTO timeline_audio(
            project_id, audio_id, artifact_id, ordinal, data_json
          ) VALUES (?, ?, ?, ?, ?)`,
        );
        for (const row of timelineAudio) {
          insertAudio.run(
            row.project_id,
            row.audio_id,
            row.artifact_id,
            row.ordinal,
            row.data_json,
          );
        }
        context.store.db
          .prepare("DELETE FROM prompt_entries WHERE project_id=?")
          .run(project.project_id);
        const insertPrompt = context.store.db.prepare(
          `INSERT INTO prompt_entries(
            prompt_id, project_id, surface, prompt,
            context_json, created_at
          ) VALUES (?, ?, ?, ?, ?, ?)`,
        );
        for (const row of prompts) {
          insertPrompt.run(
            row.prompt_id,
            row.project_id,
            row.surface,
            row.prompt,
            row.context_json,
            row.created_at,
          );
        }
        context.store.db
          .prepare("DELETE FROM messages WHERE project_id=?")
          .run(project.project_id);
        const insertMessage = context.store.db.prepare(
          `INSERT INTO messages(
            message_id, project_id, role, body_json, created_at
          ) VALUES (?, ?, ?, ?, ?)`,
        );
        for (const row of messages) {
          insertMessage.run(
            row.message_id,
            row.project_id,
            row.role,
            row.body_json,
            row.created_at,
          );
        }
        const jobs = context.store.db
          .prepare(
            `SELECT id, artifact_id, type, payload_json, result_json,
                    started_at
             FROM runtime_jobs
             WHERE project_id=?
               AND state IN ('queued','running','completing')`,
          )
          .all(project.project_id) as unknown as Array<{
          id: number;
          artifact_id: string | null;
          type: string;
          payload_json: string;
          result_json: string | null;
          started_at: number | null;
        }>;
        for (const job of jobs) {
          const errorJson = canonicalJson({
            message: "Project restored",
          });
          context.store.db
            .prepare(
              `UPDATE runtime_jobs
               SET state='aborted', error_json=?, finished_at=?,
                   lease_expires_at=NULL, pid=NULL, fence=fence+1
               WHERE id=?`,
            )
            .run(errorJson, now, job.id);
          context.store.db
            .prepare(
              `INSERT INTO job_runs(
                run_id, project_id, artifact_id, job_type, state,
                payload_json, result_json, error_json,
                started_at, finished_at
              ) VALUES (?, ?, ?, ?, 'aborted', ?, ?, ?, ?, ?)`,
            )
            .run(
              uuidv7(),
              project.project_id,
              job.artifact_id,
              job.type,
              job.payload_json,
              job.result_json,
              errorJson,
              job.started_at,
              now,
            );
        }
        context.store.db
          .prepare(
            `UPDATE runtime_resource_leases
             SET revoked_at=?, fence=fence+1
             WHERE project_id=? AND revoked_at IS NULL`,
          )
          .run(now, project.project_id);
        context.store.db
          .prepare(
            `UPDATE runtime_workspace_entries
             SET invalidated_at=? WHERE project_id=?`,
          )
          .run(now, project.project_id);
        context.store.db
          .prepare(
            "DELETE FROM runtime_artifact_views WHERE project_id=?",
          )
          .run(project.project_id);
        for (const row of targetArtifacts) {
          resetArtifactRuntime(
            context,
            project.project_id,
            row.artifact_id,
            now,
          );
        }
      },
    );
    await rm(context.projectPath(project.project_id), {
      recursive: true,
      force: true,
    });
    for (const artifact of targetArtifacts) {
      await materializeArtifact(context, artifact.artifact_id);
    }
    return ok(
      revisionForHash(context, mutation.revision),
      mutation.revision,
    );
  });
}

async function logAction(
  context: EngineContext,
  action: string,
  payload: string | Record<string, unknown>,
  projectReference: string,
): Promise<Result<ActionLogEntry, EngineError>> {
  return resultOf(async () => {
    const result = await recordOperation(
      context,
      `action:${action}`,
      undefined,
      { payload },
      projectReference,
    );
    if (!result.ok) throw new EngineFault(result.error);
    return {
      hash: result.value.hash,
      action,
      payload,
      date: result.value.date,
    };
  });
}

function actionLog(
  context: EngineContext,
  projectReference: string,
  options: { limit?: number; action?: string } = {},
): ActionLogEntry[] {
  return projectHistory(
    context,
    projectReference,
    Math.max(options.limit ?? 100, 100),
  )
    .filter(
      (revision) =>
        revision.operation?.startsWith("action:") &&
        (!options.action ||
          revision.operation === `action:${options.action}`),
    )
    .slice(0, options.limit ?? 100)
    .map((revision) => ({
      hash: revision.hash,
      action: revision.operation!.slice("action:".length),
      payload:
        (revision.details?.payload as
          | string
          | Record<string, unknown>
          | undefined) ?? {},
      date: revision.date,
    }));
}

function projectBook(
  context: EngineContext,
  projectReference: string,
  options: GetProjectBookOptions = {},
): Result<ProjectBook, EngineError> {
  try {
    const project = context.projectRow(projectReference);
    const limit = Math.max(1, options.limit ?? 200);
    const params: unknown[] = [project.project_id];
    let cursorClause = "";
    if (options.cursor) {
      const cursor = context.store.db
        .prepare(
          "SELECT created_at FROM actions WHERE action_id=? AND project_id=?",
        )
        .get(options.cursor, project.project_id) as unknown as
        | { created_at: number }
        | undefined;
      if (cursor) {
        cursorClause = "AND created_at < ?";
        params.push(cursor.created_at);
      }
    }
    params.push(limit + 1);
    const rows = context.store.db
      .prepare(
        `${ACTION_SELECT}
         WHERE project_id=? ${cursorClause}
         ORDER BY created_at DESC, action_id DESC
         LIMIT ?`,
      )
      .all(...params) as unknown as ActionRow[];
    const page = rows.slice(0, limit);
    return ok({
      projectId: project.project_id,
      slug: project.slug,
      headRevision: context.store.head,
      actions: page
        .map((row) => actionFromRow(context, row))
        .sort((left, right) => left.date.localeCompare(right.date)),
      ...(rows.length > limit
        ? { nextCursor: page.at(-1)?.action_id }
        : {}),
    });
  } catch (error) {
    return {
      ok: false,
      error:
        error instanceof EngineFault
          ? error.error
          : {
              code: "IO_ERROR",
              message:
                error instanceof Error ? error.message : String(error),
            },
    };
  }
}

function bookAction(
  context: EngineContext,
  projectReference: string,
  actionId: string,
): Result<BookAction, EngineError> {
  try {
    const project = context.projectRow(projectReference);
    const row = context.store.db
      .prepare(
        `${ACTION_SELECT}
         WHERE project_id=? AND action_id=?`,
      )
      .get(project.project_id, actionId) as unknown as
      | ActionRow
      | undefined;
    if (!row) {
      throw new EngineFault({
        code: "NOT_FOUND",
        message: `Book action not found: ${actionId}`,
      });
    }
    return ok(actionFromRow(context, row));
  } catch (error) {
    return {
      ok: false,
      error:
        error instanceof EngineFault
          ? error.error
          : {
              code: "IO_ERROR",
              message:
                error instanceof Error ? error.message : String(error),
            },
    };
  }
}

async function recordBookAction(
  context: EngineContext,
  input: RecordBookActionInput,
): Promise<Result<BookActionRevision, EngineError>> {
  return resultOf(async () => {
    const project = context.projectRow(input.projectSlug);
    assertWriteSet(
      context,
      project.project_id,
      input.baseRevision,
      input.writeSet ?? [],
    );
    const actionId = input.actionId ?? uuidv7();
    const phase = input.phase ?? "completed";
    const scope = input.scope ?? "project";
    const actor = input.actor ?? "videobook";
    const inputArtifacts = resolveArtifactReferences(
      context,
      project.project_id,
      input.inputArtifactIds ?? [],
    );
    const outputArtifacts = resolveArtifactReferences(
      context,
      project.project_id,
      input.outputArtifactIds ?? [],
    );
    const targetArtifactId = input.targetArtifactId
      ? context.artifactRow(
          project.project_id,
          input.targetArtifactId,
        ).artifact_id
      : null;
    const mutation = await context.store.semantic(
      {
        projectId: project.project_id,
        operation: `book:${input.operation}`,
        ...(targetArtifactId ? { artifactId: targetArtifactId } : {}),
        details: {
          ...(input.details ?? {}),
          actionId,
          phase,
          scope,
          lane: input.lane ?? actor,
        },
        ...(input.baseRevision
          ? { baseRevision: input.baseRevision }
          : {}),
        writeSet: input.writeSet ?? [],
      },
      [
        "actions",
        "action_events",
        "action_parents",
        "action_artifacts",
        "action_write_set",
      ],
      (operationId, now) => {
        context.store.db
          .prepare(
            `INSERT INTO actions(
              action_id, project_id, operation, scope, actor, lane,
              phase, base_revision, target_artifact_id, target_action_id,
              layout_json, details_json, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(action_id) DO UPDATE SET
              operation=excluded.operation,
              scope=excluded.scope,
              actor=excluded.actor,
              lane=excluded.lane,
              phase=excluded.phase,
              target_artifact_id=excluded.target_artifact_id,
              target_action_id=excluded.target_action_id,
              layout_json=excluded.layout_json,
              details_json=excluded.details_json,
              updated_at=excluded.updated_at`,
          )
          .run(
            actionId,
            project.project_id,
            input.operation,
            scope,
            actor,
            input.lane ?? actor,
            phase,
            input.baseRevision ?? null,
            targetArtifactId,
            input.targetActionId ?? null,
            input.layout ? canonicalJson(input.layout) : null,
            canonicalJson(input.details ?? {}),
            now,
            now,
          );
        context.store.db
          .prepare(
            `INSERT INTO action_events(
              event_id, action_id, operation_id, phase,
              details_json, created_at
            ) VALUES (?, ?, ?, ?, ?, ?)`,
          )
          .run(
            uuidv7(),
            actionId,
            operationId,
            phase,
            canonicalJson(input.details ?? {}),
            now,
          );
        replaceActionLinks(
          context,
          actionId,
          input.parentActionIds ?? [],
          inputArtifacts,
          outputArtifacts,
          input.writeSet ?? [],
        );
      },
    );
    const action = bookAction(
      context,
      project.project_id,
      actionId,
    );
    if (!action.ok) throw new EngineFault(action.error);
    return ok(
      {
        action: action.value,
        revision: revisionForHash(context, mutation.revision),
      },
      mutation.revision,
    );
  });
}

function actionFromRow(
  context: EngineContext,
  row: ActionRow,
): BookAction {
  const parents = (
    context.store.db
      .prepare(
        "SELECT parent_action_id FROM action_parents WHERE action_id=?",
      )
      .all(row.action_id) as unknown as Array<{
      parent_action_id: string;
    }>
  ).map((item) => item.parent_action_id);
  const links = context.store.db
    .prepare(
      `SELECT artifact_id, direction
       FROM action_artifacts WHERE action_id=?`,
    )
    .all(row.action_id) as unknown as Array<{
    artifact_id: string;
    direction: "input" | "output";
  }>;
  const events = context.store.db
    .prepare(
      `SELECT event_id, action_id, operation_id, phase,
              details_json, created_at
       FROM action_events
       WHERE action_id=?
       ORDER BY created_at, event_id`,
    )
    .all(row.action_id) as unknown as ActionEventRow[];
  const revisionsByOperation = new Map(
    allRevisions(context).map((revision) => [
      revision.operationId,
      revision,
    ]),
  );
  const details = parseJson<Record<string, unknown>>(
    row.details_json,
    {},
  );
  return {
    id: row.action_id,
    projectId: row.project_id,
    operation: row.operation,
    title: titleForOperation(row.operation),
    scope: row.scope,
    actor: row.actor,
    lane: row.lane,
    date: new Date(row.created_at).toISOString(),
    phase: row.phase,
    ...(row.base_revision
      ? { baseRevision: row.base_revision }
      : {}),
    parentActionIds: parents,
    inputArtifacts: links
      .filter((link) => link.direction === "input")
      .map((link) => artifactRef(context, link.artifact_id)),
    outputArtifacts: links
      .filter((link) => link.direction === "output")
      .map((link) => artifactRef(context, link.artifact_id)),
    ...(row.target_artifact_id
      ? { targetArtifactId: row.target_artifact_id }
      : {}),
    ...(row.target_action_id
      ? { targetActionId: row.target_action_id }
      : {}),
    ...(row.layout_json
      ? {
          layout: parseJson<{ stage: number; column: number }>(
            row.layout_json,
            { stage: 0, column: 0 },
          ),
        }
      : {}),
    details,
    events: events.map((event) => {
      const revision = revisionsByOperation.get(event.operation_id);
      return {
        id: event.event_id,
        revision: revision?.hash ?? context.store.head,
        phase: event.phase,
        date: new Date(event.created_at).toISOString(),
        details: parseJson(event.details_json, {}),
        files: revision?.files ?? [],
        fileChanges: revision?.fileChanges ?? [],
      } satisfies BookActionEvent;
    }),
  };
}

function replaceActionLinks(
  context: EngineContext,
  actionId: string,
  parents: string[],
  inputs: string[],
  outputs: string[],
  writeSet: string[],
): void {
  context.store.db
    .prepare("DELETE FROM action_parents WHERE action_id=?")
    .run(actionId);
  context.store.db
    .prepare("DELETE FROM action_artifacts WHERE action_id=?")
    .run(actionId);
  context.store.db
    .prepare("DELETE FROM action_write_set WHERE action_id=?")
    .run(actionId);
  const insertParent = context.store.db.prepare(
    "INSERT INTO action_parents(action_id, parent_action_id) VALUES (?, ?)",
  );
  for (const parent of new Set(parents)) {
    insertParent.run(actionId, parent);
  }
  const insertArtifact = context.store.db.prepare(
    `INSERT INTO action_artifacts(
      action_id, artifact_id, direction
    ) VALUES (?, ?, ?)`,
  );
  for (const artifactId of new Set(inputs)) {
    insertArtifact.run(actionId, artifactId, "input");
  }
  for (const artifactId of new Set(outputs)) {
    insertArtifact.run(actionId, artifactId, "output");
  }
  const insertResource = context.store.db.prepare(
    "INSERT INTO action_write_set(action_id, resource) VALUES (?, ?)",
  );
  for (const resource of new Set(writeSet)) {
    insertResource.run(actionId, resource);
  }
}

function assertWriteSet(
  context: EngineContext,
  projectId: string,
  baseRevision: string | undefined,
  writeSet: string[],
): void {
  if (!baseRevision || baseRevision === context.store.head) return;
  const revisions = allRevisions(context).filter(
    (revision) => revision.projectId === projectId,
  );
  const baseIndex = revisions.findIndex(
    (revision) =>
      revision.hash === baseRevision ||
      revision.hash.startsWith(baseRevision),
  );
  if (baseIndex < 0) {
    throw new EngineFault({
      code: "STALE_REVISION",
      message: `Base revision not found: ${baseRevision}`,
    });
  }
  const requested = new Set(writeSet);
  const conflicts = new Set<string>();
  for (const revision of revisions.slice(0, baseIndex)) {
    const changed = revision.details?.writeSet;
    if (!Array.isArray(changed)) continue;
    for (const resource of changed) {
      if (typeof resource === "string" && requested.has(resource)) {
        conflicts.add(resource);
      }
    }
  }
  if (conflicts.size > 0) {
    throw new EngineFault({
      code: "ACTION_CONFLICT",
      message: `Action conflicts with newer changes: ${[
        ...conflicts,
      ].join(", ")}`,
      details: { resources: [...conflicts] },
    });
  }
}

function resetArtifactRuntime(
  context: EngineContext,
  projectId: string,
  artifactId: string,
  now: number,
): void {
  context.store.db
    .prepare(
      `INSERT INTO runtime_artifact_views(
        artifact_id, project_id, status, meta_json, updated_at
      ) VALUES (?, ?, 'ready', '{}', ?)
      ON CONFLICT(artifact_id) DO UPDATE SET
        status='ready', meta_json='{}', owner_id=NULL,
        owner_kind=NULL, pid=NULL, deadline_at=NULL,
        updated_at=excluded.updated_at, fence=fence+1`,
    )
    .run(artifactId, projectId, now);
  context.store.db
    .prepare(
      `INSERT INTO runtime_workspace_entries(
        artifact_id, project_id, path, invalidated_at, last_accessed_at
      ) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(artifact_id) DO UPDATE SET
        invalidated_at=excluded.invalidated_at,
        hydrated_at=NULL,
        last_accessed_at=excluded.last_accessed_at`,
    )
    .run(
      artifactId,
      projectId,
      context.artifactPath(projectId, artifactId),
      now,
      now,
    );
  context.store.db
    .prepare("DELETE FROM runtime_pending_tasks WHERE artifact_id=?")
    .run(artifactId);
  context.store.db
    .prepare("DELETE FROM runtime_generation_errors WHERE artifact_id=?")
    .run(artifactId);
  context.store.db
    .prepare(
      `UPDATE runtime_resource_leases
       SET revoked_at=?, fence=fence+1
       WHERE artifact_id=? AND revoked_at IS NULL`,
    )
    .run(now, artifactId);
}

function filesAt(
  context: EngineContext,
  revision: string,
  artifactId: string,
): FileRow[] {
  return context.store.db
    .prepare(
      `SELECT artifact_id, path, object_hash, size_bytes, mime_type,
              mtime_ms, created_at
       FROM dolt_at_artifact_files(?)
       WHERE artifact_id=?
       ORDER BY path`,
    )
    .all(revision, artifactId) as unknown as FileRow[];
}

function insertFiles(context: EngineContext, files: FileRow[]): void {
  const insert = context.store.db.prepare(
    `INSERT INTO artifact_files(
      artifact_id, path, object_hash, size_bytes, mime_type,
      mtime_ms, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const row of files) {
    insert.run(
      row.artifact_id,
      row.path,
      row.object_hash,
      row.size_bytes,
      row.mime_type,
      row.mtime_ms,
      row.created_at,
    );
  }
}

function operationFromDiff(row: DoltDiffRow): OperationDiff | null {
  const prefix = row.diff_type === "removed" ? "from_" : "to_";
  const operationId = row[`${prefix}operation_id`];
  const projectId = row[`${prefix}project_id`];
  const operation = row[`${prefix}operation`];
  const detailsJson = row[`${prefix}details_json`];
  const writeSetJson = row[`${prefix}write_set_json`];
  const createdAt = row[`${prefix}created_at`];
  const author = row[`${prefix}author`];
  if (
    typeof operationId !== "string" ||
    typeof projectId !== "string" ||
    typeof operation !== "string" ||
    typeof detailsJson !== "string" ||
    typeof writeSetJson !== "string" ||
    typeof createdAt !== "number" ||
    typeof author !== "string"
  ) {
    return null;
  }
  const artifactId = row[`${prefix}artifact_id`];
  const baseRevision = row[`${prefix}base_revision`];
  return {
    operation_id: operationId,
    project_id: projectId,
    operation,
    artifact_id:
      typeof artifactId === "string" ? artifactId : null,
    details_json: detailsJson,
    write_set_json: writeSetJson,
    base_revision:
      typeof baseRevision === "string" ? baseRevision : null,
    created_at: createdAt,
    author,
  };
}

function revisionFileChanges(
  rows: DoltDiffRow[],
  artifactId: string | null,
): RevisionFileChange[] {
  const changes: RevisionFileChange[] = [];
  for (const row of rows) {
    const fromArtifact = row.from_artifact_id;
    const toArtifact = row.to_artifact_id;
    if (
      artifactId &&
      fromArtifact !== artifactId &&
      toArtifact !== artifactId
    ) {
      continue;
    }
    const fromPath =
      typeof row.from_path === "string" ? row.from_path : undefined;
    const toPath =
      typeof row.to_path === "string" ? row.to_path : undefined;
    const file = toPath ?? fromPath;
    if (!file) continue;
    changes.push({
      status: row.diff_type,
      file,
      ...(fromPath && toPath && fromPath !== toPath
        ? { oldFile: fromPath }
        : {}),
    });
  }
  return changes;
}

function artifactSlugAt(
  context: EngineContext,
  artifactId: string,
  revision: string,
): string | undefined {
  const row = context.store.db
    .prepare(
      `SELECT slug FROM dolt_at_artifacts(?)
       WHERE artifact_id=?`,
    )
    .get(revision, artifactId) as unknown as
    | { slug: string }
    | undefined;
  return row?.slug;
}

function resolveArtifactReferences(
  context: EngineContext,
  projectId: string,
  references: string[],
): string[] {
  return [
    ...new Set(
      references.map(
        (reference) =>
          context.artifactRow(projectId, reference).artifact_id,
      ),
    ),
  ];
}

function artifactRef(
  context: EngineContext,
  artifactId: string,
): BookArtifactRef {
  const artifact = context.artifactRowById(artifactId);
  return {
    id: artifact.artifact_id,
    slug: artifact.slug,
    kind: bookArtifactKind(artifact.kind),
  };
}

function bookArtifactKind(
  kind: ArtifactRow["kind"],
): BookArtifactKind {
  return kind;
}

function titleForOperation(operation: string): string {
  return operation
    .replace(/^book:/, "")
    .replaceAll("_", " ")
    .replaceAll("-", " ");
}

const ACTION_SELECT = `
  SELECT action_id, project_id, operation, scope, actor, lane, phase,
         base_revision, target_artifact_id, target_action_id,
         layout_json, details_json, created_at, updated_at
  FROM actions
`;
