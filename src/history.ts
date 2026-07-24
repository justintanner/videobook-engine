import { rm } from "node:fs/promises";

import type { DoltDiffRow } from "@dolthub/doltlite";
import { v7 as uuidv7 } from "uuid";

import type {
  GetHistoryActionsOptions,
  HistoryAction,
  HistoryActionEvent,
  HistoryActionPage,
  HistoryActionPhase,
  HistoryActionRevision,
  HistoryActionScope,
  HistoryArtifactKind,
  HistoryArtifactRef,
  RecordActionInput,
} from "./history-types.js";
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
  syncResultOf,
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
  operation: string;
  scope: HistoryActionScope;
  actor: string;
  lane: string;
  phase: HistoryActionPhase;
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
  phase: HistoryActionPhase;
  details_json: string;
  created_at: number;
}

interface HistoricalArtifactRow extends ArtifactRow {}

interface MetadataSnapshotRow {
  key: string;
  value_json: string;
  updated_at: number;
}

interface ArtifactMetadataSnapshotRow extends MetadataSnapshotRow {
  artifact_id: string;
}

interface WaveformSnapshotRow {
  artifact_id?: string;
  peaks_json: string;
  updated_at: number;
}

interface EntitySnapshotRow {
  entity_id: string;
  type: string;
  name: string;
  description: string | null;
  prompt: string | null;
  data_json: string;
  created_at: number;
  updated_at: number;
  deleted_at: number | null;
}

interface NotebookSnapshotRow {
  notebook_id: string;
  name: string;
  version: number;
  properties_json: string;
  created_at: number;
  updated_at: number;
  deleted_at: number | null;
}

interface NotebookCellSnapshotRow {
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
}

interface NotebookEdgeSnapshotRow {
  notebook_id: string;
  edge_id: string;
  source_cell_id: string;
  target_cell_id: string;
  target_input: string;
  ordinal: number;
}

interface NotebookRunSnapshotRow {
  run_id: string;
  notebook_id: string;
  status: string;
  started_at: number;
  completed_at: number | null;
  cell_order_json: string;
  outputs_json: string;
  error: string | null;
}

interface TimelineSnapshotRow {
  singleton: number;
  render: string;
  data_json: string;
  updated_at: number;
}

interface TimelineSlotSnapshotRow {
  slot_id: string;
  artifact_id: string | null;
  ordinal: number;
  data_json: string;
}

interface TimelineAudioSnapshotRow {
  audio_id: string;
  artifact_id: string | null;
  ordinal: number;
  data_json: string;
}

interface PromptSnapshotRow {
  prompt_id: number;
  surface: string;
  prompt: string;
  context_json: string;
  created_at: number;
}

interface MessageSnapshotRow {
  message_id: string;
  role: string;
  body_json: string;
  created_at: number;
}

interface ActiveRuntimeJobRow {
  id: number;
  artifact_id: string | null;
  type: string;
  payload_json: string;
  result_json: string | null;
  started_at: number | null;
}

export function createHistoryApi(context: EngineContext) {
  return {
    revisions: (limit = 20): Revision[] =>
      revisionHistory(context, limit),
    artifact: (artifact: string, limit = 20): Revision[] =>
      artifactHistory(context, artifact, limit),
    resolveRevision: (revision: string): Revision | null =>
      resolveRevision(context, revision),
    recordOperation: (
      operation: string,
      artifact?: string,
      details?: Record<string, unknown>,
    ): Promise<Result<Revision, EngineError>> =>
      recordOperation(context, operation, artifact, details),
    restoreArtifact: (
      artifactId: string,
      revision: string,
      slug?: string,
    ): Promise<Result<Revision, EngineError>> =>
      restoreArtifact(context, artifactId, revision, slug),
    restore: (revision: string): Promise<Result<Revision, EngineError>> =>
      restoreBook(context, revision),
    logAction: (
      action: string,
      payload: string | Record<string, unknown>,
    ): Promise<Result<ActionLogEntry, EngineError>> =>
      logAction(context, action, payload),
    actionLog: (
      options?: { limit?: number; action?: string },
    ): ActionLogEntry[] => actionLog(context, options),
    actions: (
      options?: GetHistoryActionsOptions,
    ): Result<HistoryActionPage, EngineError> => actions(context, options),
    action: (actionId: string): Result<HistoryAction, EngineError> =>
      action(context, actionId),
    recordAction: (
      input: RecordActionInput,
    ): Promise<Result<HistoryActionRevision, EngineError>> =>
      recordAction(context, input),
  };
}

function revisionForHash(context: EngineContext, hash: string): Revision {
  const commit = context.store.db
    .doltLog()
    .find((item) => item.commit_hash === hash);
  if (!commit) {
    throw new EngineFault({
      code: "NOT_FOUND",
      message: `Revision not found: ${hash}`,
    });
  }
  return {
    hash,
    message: commit.message,
    date: commit.date,
    author: commit.committer,
  };
}

function revisionHistory(context: EngineContext, limit: number): Revision[] {
  return allRevisions(context).slice(0, Math.max(0, limit));
}

function artifactHistory(
  context: EngineContext,
  artifactReference: string,
  limit: number,
): Revision[] {
  const artifact = context.artifactRow(artifactReference, true);
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
      const writeSet = parseJson<string[]>(operation.write_set_json, []);
      const artifactSlugAtRevision = operation.artifact_id
        ? artifactSlugAt(context, operation.artifact_id, commit.commit_hash)
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
): Revision | null {
  const historical = allRevisions(context).find(
    (revision) =>
      revision.hash === reference || revision.hash.startsWith(reference),
  );
  if (historical) return historical;
  const commit = context.store.db.doltLog().find(
    (item) =>
      item.commit_hash === reference || item.commit_hash.startsWith(reference),
  );
  return commit
    ? {
        hash: commit.commit_hash,
        message: commit.message,
        date: commit.date,
        author: commit.committer,
      }
    : null;
}

function requiredRevision(
  context: EngineContext,
  reference: string,
): Revision {
  const revision = resolveRevision(context, reference);
  if (!revision) {
    throw new EngineFault({
      code: "NOT_FOUND",
      message: `Revision not found: ${reference}`,
    });
  }
  return revision;
}

async function recordOperation(
  context: EngineContext,
  operation: string,
  artifactReference?: string,
  details?: Record<string, unknown>,
): Promise<Result<Revision, EngineError>> {
  return resultOf(async () => {
    const artifact = artifactReference
      ? context.artifactRow(artifactReference)
      : null;
    const mutation = await context.store.semantic(
      {
        operation,
        ...(artifact ? { artifactId: artifact.artifact_id } : {}),
        details: {
          ...(details ?? {}),
          ...(artifact ? { artifactSlug: artifact.slug } : {}),
        },
        writeSet: artifact
          ? [`artifact:${artifact.artifact_id}`]
          : ["book"],
      },
      [],
      () => undefined,
    );
    return ok(revisionForHash(context, mutation.revision), mutation.revision);
  });
}

async function restoreArtifact(
  context: EngineContext,
  artifactId: string,
  revisionReference: string,
  replacementSlug?: string,
): Promise<Result<Revision, EngineError>> {
  return resultOf(async () => {
    const revision = requiredRevision(context, revisionReference);
    const target = context.store.db
      .prepare(
        `SELECT artifact_id, slug, kind, data_json,
                created_at, updated_at, deleted_at
         FROM dolt_at_artifacts(?)
         WHERE artifact_id=?`,
      )
      .get(revision.hash, artifactId) as unknown as
      | HistoricalArtifactRow
      | undefined;
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
        `SELECT artifact_id FROM artifacts
         WHERE slug=? AND deleted_at IS NULL AND artifact_id<>?`,
      )
      .get(desiredSlug, artifactId) as unknown as
      | { artifact_id: string }
      | undefined;
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
         FROM dolt_at_artifact_metadata(?) WHERE artifact_id=?`,
      )
      .all(revision.hash, artifactId) as unknown as MetadataSnapshotRow[];
    const waveform = context.store.db
      .prepare(
        `SELECT peaks_json, updated_at
         FROM dolt_at_audio_waveforms(?) WHERE artifact_id=?`,
      )
      .get(revision.hash, artifactId) as unknown as
      | WaveformSnapshotRow
      | undefined;
    const mutation = await context.store.semantic(
      {
        operation: "restore_artifact",
        artifactId,
        details: { fromRevision: revision.hash, slug: desiredSlug },
        writeSet: [
          `artifact:${artifactId}`,
          `artifact-slug:${desiredSlug}`,
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
              artifact_id, slug, kind, data_json,
              created_at, updated_at, deleted_at
            ) VALUES (?, ?, ?, ?, ?, ?, NULL)
            ON CONFLICT(artifact_id) DO UPDATE SET
              slug=excluded.slug,
              kind=excluded.kind,
              data_json=excluded.data_json,
              updated_at=excluded.updated_at,
              deleted_at=NULL`,
          )
          .run(
            target.artifact_id,
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
          insertMetadata.run(artifactId, row.key, row.value_json, row.updated_at);
        }
        if (waveform) {
          context.store.db
            .prepare(
              `INSERT INTO audio_waveforms(
                artifact_id, peaks_json, updated_at
              ) VALUES (?, ?, ?)`,
            )
            .run(artifactId, waveform.peaks_json, waveform.updated_at);
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
        resetArtifactRuntime(context, artifactId, now);
      },
    );
    await rm(context.artifactPath(artifactId), { recursive: true, force: true });
    await materializeArtifact(context, artifactId);
    return ok(revisionForHash(context, mutation.revision), mutation.revision);
  });
}

async function restoreBook(
  context: EngineContext,
  revisionReference: string,
): Promise<Result<Revision, EngineError>> {
  return resultOf(async () => {
    const revision = requiredRevision(context, revisionReference);
    const targetBook = context.store.db
      .prepare("SELECT book_id, slug FROM dolt_at_book(?) WHERE singleton=1")
      .get(revision.hash) as unknown as
      | { book_id: string; slug: string }
      | undefined;
    if (!targetBook) {
      throw new EngineFault({
        code: "NOT_FOUND",
        message: `Book did not exist at ${revision.hash}`,
      });
    }

    const targetArtifacts = context.store.db
      .prepare(
        `SELECT artifact_id, slug, kind, data_json,
                created_at, updated_at, deleted_at
         FROM dolt_at_artifacts(?)
         WHERE deleted_at IS NULL ORDER BY artifact_id`,
      )
      .all(revision.hash) as unknown as HistoricalArtifactRow[];
    const targetIds = targetArtifacts.map((row) => row.artifact_id);
    const targetFiles = rowsForArtifactIds<FileRow>(
      context,
      "artifact_files",
      "artifact_id, path, object_hash, size_bytes, mime_type, mtime_ms, created_at",
      revision.hash,
      targetIds,
    );
    const bookMetadata = context.store.db
      .prepare(
        `SELECT key, value_json, updated_at
         FROM dolt_at_book_metadata(?)`,
      )
      .all(revision.hash) as unknown as MetadataSnapshotRow[];
    const artifactMetadata = rowsForArtifactIds<ArtifactMetadataSnapshotRow>(
      context,
      "artifact_metadata",
      "artifact_id, key, value_json, updated_at",
      revision.hash,
      targetIds,
    );
    const waveforms = rowsForArtifactIds<WaveformSnapshotRow>(
      context,
      "audio_waveforms",
      "artifact_id, peaks_json, updated_at",
      revision.hash,
      targetIds,
    );
    const entities = context.store.db
      .prepare(
        `SELECT entity_id, type, name, description, prompt,
                data_json, created_at, updated_at, deleted_at
         FROM dolt_at_entities(?) WHERE deleted_at IS NULL`,
      )
      .all(revision.hash) as unknown as EntitySnapshotRow[];
    const notebooks = context.store.db
      .prepare(
        `SELECT notebook_id, name, version, properties_json,
                created_at, updated_at, deleted_at
         FROM dolt_at_notebooks(?) WHERE deleted_at IS NULL`,
      )
      .all(revision.hash) as unknown as NotebookSnapshotRow[];
    const notebookIds = notebooks.map((row) => row.notebook_id);
    const notebookCells = rowsForNotebookIds<NotebookCellSnapshotRow>(
      context,
      "notebook_cells",
      `notebook_id, cell_id, type, title, position_x, position_y,
       entity_id, prompt, model, inputs_json, output_artifact_id, ordinal`,
      revision.hash,
      notebookIds,
    );
    const notebookEdges = rowsForNotebookIds<NotebookEdgeSnapshotRow>(
      context,
      "notebook_edges",
      "notebook_id, edge_id, source_cell_id, target_cell_id, target_input, ordinal",
      revision.hash,
      notebookIds,
    );
    const notebookRuns = rowsForNotebookIds<NotebookRunSnapshotRow>(
      context,
      "notebook_runs",
      `run_id, notebook_id, status, started_at, completed_at,
       cell_order_json, outputs_json, error`,
      revision.hash,
      notebookIds,
    );
    const timeline = context.store.db
      .prepare(
        `SELECT singleton, render, data_json, updated_at
         FROM dolt_at_timelines(?) WHERE singleton=1`,
      )
      .get(revision.hash) as unknown as TimelineSnapshotRow | undefined;
    const timelineSlots = context.store.db
      .prepare(
        `SELECT slot_id, artifact_id, ordinal, data_json
         FROM dolt_at_timeline_slots(?)`,
      )
      .all(revision.hash) as unknown as TimelineSlotSnapshotRow[];
    const timelineAudio = context.store.db
      .prepare(
        `SELECT audio_id, artifact_id, ordinal, data_json
         FROM dolt_at_timeline_audio(?)`,
      )
      .all(revision.hash) as unknown as TimelineAudioSnapshotRow[];
    const prompts = context.store.db
      .prepare(
        `SELECT prompt_id, surface, prompt, context_json, created_at
         FROM dolt_at_prompt_entries(?)`,
      )
      .all(revision.hash) as unknown as PromptSnapshotRow[];
    const messages = context.store.db
      .prepare(
        `SELECT message_id, role, body_json, created_at
         FROM dolt_at_messages(?)`,
      )
      .all(revision.hash) as unknown as MessageSnapshotRow[];
    const currentArtifactIds = context.store.db
      .prepare("SELECT artifact_id FROM artifacts WHERE deleted_at IS NULL")
      .all()
      .map((row) => (row as { artifact_id: string }).artifact_id);

    const mutation = await context.store.semantic(
      {
        operation: "restore",
        details: { fromRevision: revision.hash },
        writeSet: ["book"],
      },
      [
        "book",
        "artifacts",
        "artifact_files",
        "book_metadata",
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
          .prepare("UPDATE book SET slug=? WHERE singleton=1")
          .run(targetBook.slug);
        context.store.db
          .prepare(
            `UPDATE artifacts SET deleted_at=?, updated_at=?
             WHERE deleted_at IS NULL`,
          )
          .run(now, now);
        const upsertArtifact = context.store.db.prepare(
          `INSERT INTO artifacts(
            artifact_id, slug, kind, data_json,
            created_at, updated_at, deleted_at
          ) VALUES (?, ?, ?, ?, ?, ?, NULL)
          ON CONFLICT(artifact_id) DO UPDATE SET
            slug=excluded.slug,
            kind=excluded.kind,
            data_json=excluded.data_json,
            updated_at=excluded.updated_at,
            deleted_at=NULL`,
        );
        const insertArtifactEvent = context.store.db.prepare(
          `INSERT INTO artifact_events(
            event_id, artifact_id, operation_id, event,
            details_json, created_at
          ) VALUES (?, ?, ?, 'restored', ?, ?)`,
        );
        for (const row of targetArtifacts) {
          upsertArtifact.run(
            row.artifact_id,
            row.slug,
            row.kind,
            row.data_json,
            row.created_at,
            now,
          );
          insertArtifactEvent.run(
            uuidv7(),
            row.artifact_id,
            operationId,
            canonicalJson({ fromRevision: revision.hash }),
            now,
          );
        }

        context.store.db.prepare("DELETE FROM artifact_files").run();
        context.store.db.prepare("DELETE FROM artifact_metadata").run();
        context.store.db.prepare("DELETE FROM audio_waveforms").run();
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
          if (!row.artifact_id) continue;
          insertWaveform.run(row.artifact_id, row.peaks_json, row.updated_at);
        }

        context.store.db.prepare("DELETE FROM book_metadata").run();
        const insertBookMetadata = context.store.db.prepare(
          `INSERT INTO book_metadata(key, value_json, updated_at)
           VALUES (?, ?, ?)`,
        );
        for (const row of bookMetadata) {
          insertBookMetadata.run(row.key, row.value_json, row.updated_at);
        }

        context.store.db
          .prepare(
            `UPDATE entities SET deleted_at=?, updated_at=?
             WHERE deleted_at IS NULL`,
          )
          .run(now, now);
        const upsertEntity = context.store.db.prepare(
          `INSERT INTO entities(
            entity_id, type, name, description, prompt,
            data_json, created_at, updated_at, deleted_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)
          ON CONFLICT(entity_id) DO UPDATE SET
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
            row.type,
            row.name,
            row.description,
            row.prompt,
            row.data_json,
            row.created_at,
            now,
          );
        }

        context.store.db.prepare("DELETE FROM notebook_edges").run();
        context.store.db.prepare("DELETE FROM notebook_cells").run();
        context.store.db.prepare("DELETE FROM notebook_runs").run();
        context.store.db
          .prepare(
            `UPDATE notebooks SET deleted_at=?, updated_at=?
             WHERE deleted_at IS NULL`,
          )
          .run(now, now);
        const upsertNotebook = context.store.db.prepare(
          `INSERT INTO notebooks(
            notebook_id, name, version, properties_json,
            created_at, updated_at, deleted_at
          ) VALUES (?, ?, ?, ?, ?, ?, NULL)
          ON CONFLICT(notebook_id) DO UPDATE SET
            name=excluded.name,
            version=excluded.version,
            properties_json=excluded.properties_json,
            updated_at=excluded.updated_at,
            deleted_at=NULL`,
        );
        for (const row of notebooks) {
          upsertNotebook.run(
            row.notebook_id,
            row.name,
            row.version,
            row.properties_json,
            row.created_at,
            now,
          );
        }
        insertNotebookChildren(context, notebookCells, notebookEdges, notebookRuns);

        context.store.db.prepare("DELETE FROM timeline_slots").run();
        context.store.db.prepare("DELETE FROM timeline_audio").run();
        context.store.db.prepare("DELETE FROM timelines").run();
        if (timeline) {
          context.store.db
            .prepare(
              `INSERT INTO timelines(singleton, render, data_json, updated_at)
               VALUES (1, ?, ?, ?)`,
            )
            .run(timeline.render, timeline.data_json, timeline.updated_at);
        }
        const insertSlot = context.store.db.prepare(
          `INSERT INTO timeline_slots(slot_id, artifact_id, ordinal, data_json)
           VALUES (?, ?, ?, ?)`,
        );
        for (const row of timelineSlots) {
          insertSlot.run(row.slot_id, row.artifact_id, row.ordinal, row.data_json);
        }
        const insertAudio = context.store.db.prepare(
          `INSERT INTO timeline_audio(audio_id, artifact_id, ordinal, data_json)
           VALUES (?, ?, ?, ?)`,
        );
        for (const row of timelineAudio) {
          insertAudio.run(row.audio_id, row.artifact_id, row.ordinal, row.data_json);
        }

        context.store.db.prepare("DELETE FROM prompt_entries").run();
        const insertPrompt = context.store.db.prepare(
          `INSERT INTO prompt_entries(
            prompt_id, surface, prompt, context_json, created_at
          ) VALUES (?, ?, ?, ?, ?)`,
        );
        for (const row of prompts) {
          insertPrompt.run(
            row.prompt_id,
            row.surface,
            row.prompt,
            row.context_json,
            row.created_at,
          );
        }
        context.store.db.prepare("DELETE FROM messages").run();
        const insertMessage = context.store.db.prepare(
          `INSERT INTO messages(message_id, role, body_json, created_at)
           VALUES (?, ?, ?, ?)`,
        );
        for (const row of messages) {
          insertMessage.run(row.message_id, row.role, row.body_json, row.created_at);
        }

        abortActiveJobs(context, now, "Book restored");
        context.store.db
          .prepare(
            `UPDATE runtime_resource_leases
             SET revoked_at=?, fence=fence+1 WHERE revoked_at IS NULL`,
          )
          .run(now);
        context.store.db
          .prepare("UPDATE runtime_workspace_entries SET invalidated_at=?")
          .run(now);
        context.store.db.prepare("DELETE FROM runtime_artifact_views").run();
        context.store.db.prepare("DELETE FROM runtime_pending_tasks").run();
        context.store.db.prepare("DELETE FROM runtime_generation_errors").run();
        for (const row of targetArtifacts) {
          resetArtifactRuntime(context, row.artifact_id, now);
        }
      },
    );

    for (const artifactId of new Set([...currentArtifactIds, ...targetIds])) {
      await rm(context.artifactPath(artifactId), { recursive: true, force: true });
    }
    for (const artifact of targetArtifacts) {
      await materializeArtifact(context, artifact.artifact_id);
    }
    return ok(revisionForHash(context, mutation.revision), mutation.revision);
  });
}

async function logAction(
  context: EngineContext,
  actionName: string,
  payload: string | Record<string, unknown>,
): Promise<Result<ActionLogEntry, EngineError>> {
  return resultOf(async () => {
    const result = await recordOperation(context, `action:${actionName}`, undefined, {
      payload,
    });
    if (!result.ok) throw new EngineFault(result.error);
    return {
      hash: result.value.hash,
      action: actionName,
      payload,
      date: result.value.date,
    };
  });
}

function actionLog(
  context: EngineContext,
  options: { limit?: number; action?: string } = {},
): ActionLogEntry[] {
  return revisionHistory(context, Math.max(options.limit ?? 100, 100))
    .filter(
      (revision) =>
        revision.operation?.startsWith("action:") &&
        (!options.action || revision.operation === `action:${options.action}`),
    )
    .slice(0, options.limit ?? 100)
    .map((revision) => ({
      hash: revision.hash,
      action: revision.operation!.slice("action:".length),
      payload:
        (revision.details?.payload as string | Record<string, unknown> | undefined) ??
        {},
      date: revision.date,
    }));
}

function actions(
  context: EngineContext,
  options: GetHistoryActionsOptions = {},
): Result<HistoryActionPage, EngineError> {
  return syncResultOf(() => {
    const limit = Math.max(1, options.limit ?? 200);
    const params: unknown[] = [];
    let cursorClause = "";
    if (options.cursor) {
      const cursor = context.store.db
        .prepare("SELECT created_at, action_id FROM actions WHERE action_id=?")
        .get(options.cursor) as unknown as
        | { created_at: number; action_id: string }
        | undefined;
      if (cursor) {
        cursorClause = "WHERE (created_at < ? OR (created_at = ? AND action_id < ?))";
        params.push(cursor.created_at, cursor.created_at, cursor.action_id);
      }
    }
    params.push(limit + 1);
    const rows = context.store.db
      .prepare(
        `${ACTION_SELECT}
         ${cursorClause}
         ORDER BY created_at DESC, action_id DESC
         LIMIT ?`,
      )
      .all(...params) as unknown as ActionRow[];
    const page = rows.slice(0, limit);
    return {
      headRevision: context.store.head,
      actions: page
        .map((row) => actionFromRow(context, row))
        .sort((left, right) => left.date.localeCompare(right.date)),
      ...(rows.length > limit ? { nextCursor: page.at(-1)?.action_id } : {}),
    };
  });
}

function action(
  context: EngineContext,
  actionId: string,
): Result<HistoryAction, EngineError> {
  return syncResultOf(() => requiredAction(context, actionId));
}

async function recordAction(
  context: EngineContext,
  input: RecordActionInput,
): Promise<Result<HistoryActionRevision, EngineError>> {
  return resultOf(async () => {
    assertWriteSet(context, input.baseRevision, input.writeSet ?? []);
    const actionId = input.actionId ?? uuidv7();
    const phase = input.phase ?? "completed";
    const scope = input.scope ?? "book";
    const actor = input.actor ?? "videobook";
    const inputArtifacts = resolveArtifactReferences(
      context,
      input.inputArtifactIds ?? [],
    );
    const outputArtifacts = resolveArtifactReferences(
      context,
      input.outputArtifactIds ?? [],
    );
    const targetArtifactId = input.targetArtifactId
      ? context.artifactRow(input.targetArtifactId).artifact_id
      : null;
    const mutation = await context.store.semantic(
      {
        operation: `action:${input.operation}`,
        ...(targetArtifactId ? { artifactId: targetArtifactId } : {}),
        details: {
          ...(input.details ?? {}),
          actionId,
          phase,
          scope,
          lane: input.lane ?? actor,
        },
        ...(input.baseRevision ? { baseRevision: input.baseRevision } : {}),
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
              action_id, operation, scope, actor, lane, phase,
              base_revision, target_artifact_id, target_action_id,
              layout_json, details_json, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(action_id) DO UPDATE SET
              operation=excluded.operation,
              scope=excluded.scope,
              actor=excluded.actor,
              lane=excluded.lane,
              phase=excluded.phase,
              base_revision=excluded.base_revision,
              target_artifact_id=excluded.target_artifact_id,
              target_action_id=excluded.target_action_id,
              layout_json=excluded.layout_json,
              details_json=excluded.details_json,
              updated_at=excluded.updated_at`,
          )
          .run(
            actionId,
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
    return ok(
      {
        action: requiredAction(context, actionId),
        revision: revisionForHash(context, mutation.revision),
      },
      mutation.revision,
    );
  });
}

function requiredAction(context: EngineContext, actionId: string): HistoryAction {
  const row = context.store.db
    .prepare(`${ACTION_SELECT} WHERE action_id=?`)
    .get(actionId) as unknown as ActionRow | undefined;
  if (!row) {
    throw new EngineFault({
      code: "NOT_FOUND",
      message: `History action not found: ${actionId}`,
    });
  }
  return actionFromRow(context, row);
}

function actionFromRow(
  context: EngineContext,
  row: ActionRow,
): HistoryAction {
  const parents = (
    context.store.db
      .prepare("SELECT parent_action_id FROM action_parents WHERE action_id=?")
      .all(row.action_id) as unknown as Array<{ parent_action_id: string }>
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
       FROM action_events WHERE action_id=?
       ORDER BY created_at, event_id`,
    )
    .all(row.action_id) as unknown as ActionEventRow[];
  const revisionsByOperation = new Map(
    allRevisions(context).map((revision) => [revision.operationId, revision]),
  );
  return {
    id: row.action_id,
    operation: row.operation,
    title: titleForOperation(row.operation),
    scope: row.scope,
    actor: row.actor,
    lane: row.lane,
    date: new Date(row.created_at).toISOString(),
    phase: row.phase,
    ...(row.base_revision ? { baseRevision: row.base_revision } : {}),
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
    ...(row.target_action_id ? { targetActionId: row.target_action_id } : {}),
    ...(row.layout_json
      ? {
          layout: parseJson(row.layout_json, { stage: 0, column: 0 }),
        }
      : {}),
    details: parseJson<Record<string, unknown>>(row.details_json, {}),
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
      } satisfies HistoryActionEvent;
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
  for (const parent of new Set(parents)) insertParent.run(actionId, parent);
  const insertArtifact = context.store.db.prepare(
    `INSERT INTO action_artifacts(action_id, artifact_id, direction)
     VALUES (?, ?, ?)`,
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
  for (const resource of new Set(writeSet)) insertResource.run(actionId, resource);
}

function assertWriteSet(
  context: EngineContext,
  baseRevision: string | undefined,
  writeSet: string[],
): void {
  if (!baseRevision || baseRevision === context.store.head) return;
  const revisions = allRevisions(context);
  let baseIndex = revisions.findIndex(
    (revision) =>
      revision.hash === baseRevision || revision.hash.startsWith(baseRevision),
  );
  if (baseIndex < 0) {
    const commit = context.store.db.doltLog().find(
      (item) =>
        item.commit_hash === baseRevision || item.commit_hash.startsWith(baseRevision),
    );
    if (!commit) {
      throw new EngineFault({
        code: "STALE_REVISION",
        message: `Base revision not found: ${baseRevision}`,
      });
    }
    // Initialization has no operation record, so it is older than every
    // operation-bearing revision we can inspect for a write-set conflict.
    baseIndex = revisions.length;
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
      message: `Action conflicts with newer changes: ${[...conflicts].join(", ")}`,
      details: { resources: [...conflicts] },
    });
  }
}

function resetArtifactRuntime(
  context: EngineContext,
  artifactId: string,
  now: number,
): void {
  context.store.db
    .prepare(
      `INSERT INTO runtime_artifact_views(
        artifact_id, status, meta_json, updated_at
      ) VALUES (?, 'ready', '{}', ?)
      ON CONFLICT(artifact_id) DO UPDATE SET
        status='ready', meta_json='{}', owner_id=NULL,
        owner_kind=NULL, pid=NULL, deadline_at=NULL,
        updated_at=excluded.updated_at, fence=fence+1`,
    )
    .run(artifactId, now);
  context.store.db
    .prepare(
      `INSERT INTO runtime_workspace_entries(
        artifact_id, path, invalidated_at, last_accessed_at
      ) VALUES (?, ?, ?, ?)
      ON CONFLICT(artifact_id) DO UPDATE SET
        invalidated_at=excluded.invalidated_at,
        hydrated_at=NULL,
        last_accessed_at=excluded.last_accessed_at`,
    )
    .run(artifactId, context.artifactPath(artifactId), now, now);
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

function abortActiveJobs(
  context: EngineContext,
  now: number,
  message: string,
): void {
  const jobs = context.store.db
    .prepare(
      `SELECT id, artifact_id, type, payload_json, result_json, started_at
       FROM runtime_jobs
       WHERE state IN ('queued','running','completing')`,
    )
    .all() as unknown as ActiveRuntimeJobRow[];
  const update = context.store.db.prepare(
    `UPDATE runtime_jobs
     SET state='aborted', error_json=?, finished_at=?,
         lease_expires_at=NULL, pid=NULL, fence=fence+1
     WHERE id=?`,
  );
  const insertRun = context.store.db.prepare(
    `INSERT INTO job_runs(
      run_id, artifact_id, job_type, state,
      payload_json, result_json, error_json, started_at, finished_at
    ) VALUES (?, ?, ?, 'aborted', ?, ?, ?, ?, ?)`,
  );
  for (const job of jobs) {
    const errorJson = canonicalJson({ message });
    update.run(errorJson, now, job.id);
    insertRun.run(
      uuidv7(),
      job.artifact_id,
      job.type,
      job.payload_json,
      job.result_json,
      errorJson,
      job.started_at,
      now,
    );
  }
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
       FROM dolt_at_artifact_files(?) WHERE artifact_id=? ORDER BY path`,
    )
    .all(revision, artifactId) as unknown as FileRow[];
}

function rowsForArtifactIds<T>(
  context: EngineContext,
  table: "artifact_files" | "artifact_metadata" | "audio_waveforms",
  columns: string,
  revision: string,
  artifactIds: string[],
): T[] {
  if (artifactIds.length === 0) return [];
  const placeholders = artifactIds.map(() => "?").join(", ");
  return context.store.db
    .prepare(
      `SELECT ${columns} FROM dolt_at_${table}(?)
       WHERE artifact_id IN (${placeholders})`,
    )
    .all(revision, ...artifactIds) as unknown as T[];
}

function rowsForNotebookIds<T>(
  context: EngineContext,
  table: "notebook_cells" | "notebook_edges" | "notebook_runs",
  columns: string,
  revision: string,
  notebookIds: string[],
): T[] {
  if (notebookIds.length === 0) return [];
  const placeholders = notebookIds.map(() => "?").join(", ");
  return context.store.db
    .prepare(
      `SELECT ${columns} FROM dolt_at_${table}(?)
       WHERE notebook_id IN (${placeholders})`,
    )
    .all(revision, ...notebookIds) as unknown as T[];
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

function insertNotebookChildren(
  context: EngineContext,
  cells: NotebookCellSnapshotRow[],
  edges: NotebookEdgeSnapshotRow[],
  runs: NotebookRunSnapshotRow[],
): void {
  const insertCell = context.store.db.prepare(
    `INSERT INTO notebook_cells(
      notebook_id, cell_id, type, title, position_x, position_y,
      entity_id, prompt, model, inputs_json, output_artifact_id, ordinal
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const row of cells) {
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
      notebook_id, edge_id, source_cell_id, target_cell_id, target_input, ordinal
    ) VALUES (?, ?, ?, ?, ?, ?)`,
  );
  for (const row of edges) {
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
      run_id, notebook_id, status, started_at, completed_at,
      cell_order_json, outputs_json, error
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const row of runs) {
    insertRun.run(
      row.run_id,
      row.notebook_id,
      row.status,
      row.started_at,
      row.completed_at,
      row.cell_order_json,
      row.outputs_json,
      row.error,
    );
  }
}

function operationFromDiff(row: DoltDiffRow): OperationDiff | null {
  const prefix = row.diff_type === "removed" ? "from_" : "to_";
  const operationId = row[`${prefix}operation_id`];
  const operation = row[`${prefix}operation`];
  const detailsJson = row[`${prefix}details_json`];
  const writeSetJson = row[`${prefix}write_set_json`];
  const createdAt = row[`${prefix}created_at`];
  const author = row[`${prefix}author`];
  if (
    typeof operationId !== "string" ||
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
    operation,
    artifact_id: typeof artifactId === "string" ? artifactId : null,
    details_json: detailsJson,
    write_set_json: writeSetJson,
    base_revision: typeof baseRevision === "string" ? baseRevision : null,
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
    const toPath = typeof row.to_path === "string" ? row.to_path : undefined;
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
      `SELECT slug FROM dolt_at_artifacts(?) WHERE artifact_id=?`,
    )
    .get(revision, artifactId) as unknown as { slug: string } | undefined;
  return row?.slug;
}

function resolveArtifactReferences(
  context: EngineContext,
  references: string[],
): string[] {
  return [
    ...new Set(
      references.map((reference) => context.artifactRow(reference).artifact_id),
    ),
  ];
}

function artifactRef(
  context: EngineContext,
  artifactId: string,
): HistoryArtifactRef {
  try {
    const artifact = context.artifactRowById(artifactId);
    return {
      id: artifact.artifact_id,
      slug: artifact.slug,
      kind: historyArtifactKind(artifact.kind),
    };
  } catch {
    return { id: artifactId, slug: artifactId, kind: "unknown" };
  }
}

function historyArtifactKind(kind: ArtifactRow["kind"]): HistoryArtifactKind {
  return kind;
}

function titleForOperation(operation: string): string {
  return operation.replaceAll("_", " ").replaceAll("-", " ");
}

const ACTION_SELECT = `
  SELECT action_id, operation, scope, actor, lane, phase,
         base_revision, target_artifact_id, target_action_id,
         layout_json, details_json, created_at, updated_at
  FROM actions
`;
