import type {
  EntityDocument,
  EntityType,
  NotebookCell,
  NotebookCellExecution,
  NotebookCellReference,
  NotebookDocument,
  NotebookEdge,
  NotebookGenerationPlan,
  NotebookReferenceKind,
  NotebookRun,
  NotebookRunPlan,
  NotebookTranscriptAttachment,
  NotebookTranscriptEdit,
  PinnedSearchResult,
} from "./notebook/types.js";
import type { EngineError, Result, Revision } from "./engine-types.js";
import type { SearchQuery, SearchSignal } from "./mvp-contracts.js";
import type { SearchLocation } from "./mvp-time.js";
import { ok } from "./engine-types.js";
import { normalizeSearchLocation } from "./mvp-time.js";
import { EngineContext, resultOf, syncResultOf } from "./context.js";
import { assertUuidV7, newUuidV7 } from "./ids.js";
import { isValidNotebookCellSlug, NOTEBOOK_CELL_TYPES } from "./schema.js";
import {
  firstEmptyNotebookGridSlots,
  isNotebookGridSlot,
} from "./notebook-grid.js";
import { canonicalJson, parseJson } from "./store.js";
import { EngineFault } from "./store.js";

interface EntityRow {
  entity_id: string;
  type: EntityType;
  name: string;
  description: string | null;
  prompt: string | null;
  data_json: string;
  created_at: number;
}

interface NotebookRow {
  notebook_id: string;
  name: string;
  created_at: number;
}

interface NotebookFieldRow {
  field:
    | "description"
    | "lifecycle_state"
    | "workflow_version"
    | "analysis_revision"
    | "audio_spine"
    | "current_selection"
    | "fixture";
  value_json: string;
}

interface NotebookCellExecutionRow {
  cell_id: string;
  fingerprint: string | null;
  status: string | null;
  output_artifact_id: string | null;
  provider_artifact_id: string | null;
  run_id: string | null;
  completed_at: string | null;
  started_at: string | null;
  updated_at: string | null;
  tool: string | null;
  error: string | null;
  stale: number;
  fixture_baseline: number;
}

interface NotebookGenerationPlanRow {
  plan_id: string;
  cell_id: string;
  status: string;
  plan_json: string;
  output_artifact_id: string | null;
  error: string | null;
  created_at: string;
  updated_at: string;
}

interface NotebookRunPlanRow {
  plan_id: string;
  status: string;
  plan_json: string;
  paid_cell_ids_json: string;
  cell_fingerprints_json: string;
  known_cost_usd: number;
  unknown_cost_count: number;
  created_at: string;
  updated_at: string;
  run_id: string | null;
  outputs_json: string | null;
  error: string | null;
}

interface NotebookTranscriptEditRow {
  action_id: string;
  kind: string;
  restored: number;
  payload_json: string;
}

interface NotebookTranscriptAttachmentRow {
  attachment_id: string;
  payload_json: string;
}

interface NotebookCellRow {
  cell_id: string;
  type: string;
  slug: string;
  grid_row: number;
  grid_column: number;
  output_entity_id: string | null;
  prompt: string | null;
  provider: string | null;
  model: string | null;
  operation: string | null;
  tool: string | null;
  inputs_json: string;
  output_artifact_id: string | null;
}

const NOTEBOOK_CELL_TYPE_SET = new Set<NotebookCell["type"]>(
  NOTEBOOK_CELL_TYPES,
);

interface NotebookEdgeRow {
  edge_id: string;
  source_cell_id: string;
  target_cell_id: string;
  target_input: string;
}

interface NotebookReferenceRow {
  cell_id: string;
  reference_id: string;
  kind: NotebookReferenceKind;
  target_id: string;
  snapshot_json: string;
  ordinal: number;
}

interface PinnedSearchResultRow {
  cell_id: string;
  result_id: string;
  artifact_id: string;
  object_hash: string;
  location_json: string;
  representative_json: string | null;
  query_json: string;
  signals_json: string;
  selected_revision: string;
  ordinal: number;
  created_at: number;
}

type NewNotebookCell = Omit<NotebookCell, "id"> & { id?: string };
type NewNotebookEdge = Omit<NotebookEdge, "id"> & { id?: string };

export function createEntitiesApi(context: EngineContext) {
  return {
    create: (
      type: EntityType,
      name: string,
      input: Partial<EntityDocument> = {},
    ): Promise<Result<EntityDocument, EngineError>> =>
      createEntity(context, type, name, input),
    list: (type?: EntityType): EntityDocument[] => listEntities(context, type),
    read: (entityId: string): Result<EntityDocument, EngineError> =>
      syncResultOf(() => requiredEntity(context, entityId)),
    write: (entity: EntityDocument): Promise<Result<Revision, EngineError>> =>
      writeEntity(context, entity),
    delete: (
      entityId: string,
    ): Promise<Result<{ entityId: string }, EngineError>> =>
      deleteEntity(context, entityId),
  };
}

export function createNotebooksApi(context: EngineContext) {
  return {
    create: (name: string): Promise<Result<NotebookDocument, EngineError>> =>
      createNotebook(context, name),
    createCell: (input: NewNotebookCell): NotebookCell => ({
      ...input,
      id: callerOrNewId(input.id, "Cell ID"),
    }),
    createEdge: (input: NewNotebookEdge): NotebookEdge => ({
      ...input,
      id: callerOrNewId(input.id, "Edge ID"),
    }),
    list: (): NotebookDocument[] => listNotebooks(context),
    read: (notebookId: string): Result<NotebookDocument, EngineError> =>
      syncResultOf(() => requiredNotebook(context, notebookId)),
    write: (
      notebook: NotebookDocument,
    ): Promise<Result<Revision, EngineError>> =>
      writeNotebook(context, notebook),
    insertCell: (
      notebookId: string,
      cell: NotebookCell,
    ): Promise<Result<Revision, EngineError>> =>
      insertNotebookCell(context, notebookId, cell),
    updateCell: (
      notebookId: string,
      cell: NotebookCell,
    ): Promise<Result<Revision, EngineError>> =>
      updateNotebookCell(context, notebookId, cell),
    moveCell: (
      notebookId: string,
      cellId: string,
      slot: NotebookCell["slot"],
    ): Promise<Result<Revision, EngineError>> =>
      moveNotebookCell(context, notebookId, cellId, slot),
    removeCell: (
      notebookId: string,
      cellId: string,
    ): Promise<Result<Revision, EngineError>> =>
      removeNotebookCell(context, notebookId, cellId),
    delete: (
      notebookId: string,
    ): Promise<Result<{ notebookId: string }, EngineError>> =>
      deleteNotebook(context, notebookId),
    recordRun: (run: NotebookRun): Promise<Result<Revision, EngineError>> =>
      recordNotebookRun(context, run),
  };
}

async function createEntity(
  context: EngineContext,
  type: EntityType,
  name: string,
  input: Partial<EntityDocument>,
): Promise<Result<EntityDocument, EngineError>> {
  return resultOf(async () => {
    validateEntityType(type);
    const normalizedName = requiredText(name, "Entity name");
    const entityId = newUuidV7();
    const mutation = await context.store.semantic(
      {
        operation: "create_entity",
        tables: ["entities"],
        details: { entityId, type, name: normalizedName },
        writeSet: [`entity:${entityId}`],
      },
      (_operationId, now) => {
        context.store.db
          .prepare(
            `INSERT INTO entities(
              entity_id, type, name, description, prompt, data_json, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            entityId,
            type,
            normalizedName,
            input.description ?? null,
            input.prompt ?? null,
            canonicalJson(input.data ?? {}),
            now,
          );
      },
    );
    return ok(requiredEntity(context, entityId), mutation.revision);
  });
}

function listEntities(
  context: EngineContext,
  type?: EntityType,
): EntityDocument[] {
  if (type) validateEntityType(type);
  const rows = type
    ? (context.store.db
        .prepare(
          `${ENTITY_SELECT}
           WHERE type=? ORDER BY created_at, entity_id`,
        )
        .all(type) as unknown as EntityRow[])
    : (context.store.db
        .prepare(`${ENTITY_SELECT} ORDER BY created_at, entity_id`)
        .all() as unknown as EntityRow[]);
  return rows.map(rowToEntity);
}

async function writeEntity(
  context: EngineContext,
  entity: EntityDocument,
): Promise<Result<Revision, EngineError>> {
  return resultOf(async () => {
    assertUuidV7(entity.id, "Entity ID");
    requiredEntity(context, entity.id);
    validateEntityType(entity.type);
    const name = requiredText(entity.name, "Entity name");
    const mutation = await context.store.semantic(
      {
        operation: "write_entity",
        tables: ["entities"],
        details: { entityId: entity.id, type: entity.type },
        writeSet: [`entity:${entity.id}`],
      },
      () => {
        context.store.db
          .prepare(
            `UPDATE entities
             SET type=?, name=?, description=?, prompt=?, data_json=?
             WHERE entity_id=?`,
          )
          .run(
            entity.type,
            name,
            entity.description ?? null,
            entity.prompt ?? null,
            canonicalJson(entity.data),
            entity.id,
          );
      },
    );
    return ok(revisionFor(context, mutation.revision), mutation.revision);
  });
}

async function deleteEntity(
  context: EngineContext,
  entityId: string,
): Promise<Result<{ entityId: string }, EngineError>> {
  return resultOf(async () => {
    assertUuidV7(entityId, "Entity ID");
    requiredEntity(context, entityId);
    const cells = context.store.db
      .prepare(
        `SELECT notebook_id, cell_id FROM cells
         WHERE output_entity_id=? ORDER BY notebook_id, cell_id`,
      )
      .all(entityId) as unknown as Array<{
      notebook_id: string;
      cell_id: string;
    }>;
    if (cells.length > 0) {
      throw new EngineFault({
        code: "IN_USE",
        message: `Entity is still referenced: ${entityId}`,
        details: {
          references: cells.map((cell) => ({
            kind: "cell.output_entity",
            id: `${cell.notebook_id}/${cell.cell_id}`,
          })),
        },
      });
    }
    const mutation = await context.store.semantic(
      {
        operation: "delete_entity",
        tables: ["entities"],
        details: { entityId },
        writeSet: [`entity:${entityId}`],
      },
      () => {
        context.store.db
          .prepare("DELETE FROM entities WHERE entity_id=?")
          .run(entityId);
      },
    );
    return ok({ entityId }, mutation.revision);
  });
}

async function createNotebook(
  context: EngineContext,
  name: string,
): Promise<Result<NotebookDocument, EngineError>> {
  return resultOf(async () => {
    const normalizedName = requiredText(name, "Notebook name");
    const notebookId = newUuidV7();
    const mutation = await context.store.semantic(
      {
        operation: "create_notebook",
        tables: ["notebooks"],
        details: { notebookId, name: normalizedName },
        writeSet: [`notebook:${notebookId}`],
      },
      (_operationId, now) => {
        context.store.db
          .prepare(
            `INSERT INTO notebooks(
              notebook_id, name, created_at
            ) VALUES (?, ?, ?)`,
          )
          .run(notebookId, normalizedName, now);
      },
    );
    return ok(requiredNotebook(context, notebookId), mutation.revision);
  });
}

function listNotebooks(context: EngineContext): NotebookDocument[] {
  const rows = context.store.db
    .prepare(`${NOTEBOOK_SELECT} ORDER BY created_at, notebook_id`)
    .all() as unknown as NotebookRow[];
  return rows.map((row) => notebookFromRows(context, row));
}

async function writeNotebook(
  context: EngineContext,
  notebook: NotebookDocument,
): Promise<Result<Revision, EngineError>> {
  return resultOf(async () => {
    assertUuidV7(notebook.id, "Notebook ID");
    requiredNotebook(context, notebook.id);
    validateNotebook(context, notebook);
    const mutation = await context.store.semantic(
      {
        operation: "write_notebook",
        tables: [
          "notebooks",
          "notebook_fields",
          "cells",
          "notebook_cell_executions",
          "notebook_generation_plans",
          "notebook_run_plans",
          "notebook_transcript_edits",
          "notebook_transcript_attachments",
          "edges",
          "cell_references",
          "pinned_search_results",
        ],
        details: { notebookId: notebook.id },
        writeSet: [
          `notebook:${notebook.id}`,
          ...notebook.cells.map((cell) => `cell:${notebook.id}:${cell.id}`),
          ...notebook.edges.map((edge) => `edge:${notebook.id}:${edge.id}`),
        ],
      },
      () => {
        context.store.db
          .prepare(`UPDATE notebooks SET name=? WHERE notebook_id=?`)
          .run(requiredText(notebook.name, "Notebook name"), notebook.id);
        synchronizeNotebookChildren(context, notebook);
        synchronizeNotebookState(context, notebook);
      },
    );
    return ok(revisionFor(context, mutation.revision), mutation.revision);
  });
}

async function insertNotebookCell(
  context: EngineContext,
  notebookId: string,
  cell: NotebookCell,
): Promise<Result<Revision, EngineError>> {
  return resultOf(async () => {
    assertUuidV7(notebookId, "Notebook ID");
    const notebook = requiredNotebook(context, notebookId);
    if (notebook.cells.some((existing) => existing.id === cell.id)) {
      throw new Error(`Cell already exists: ${cell.id}`);
    }
    const prospective = { ...notebook, cells: [...notebook.cells, cell] };
    validateCellFields(context, prospective, cell);
    assertCellSlugFree(context, notebookId, cell);
    assertCellSlotFree(context, notebookId, cell);
    const mutation = await context.store.semantic(
      {
        operation: "insert_cell",
        tables: ["cells", "cell_references", "pinned_search_results"],
        details: { notebookId, cellId: cell.id },
        writeSet: [`notebook:${notebookId}`, `cell:${notebookId}:${cell.id}`],
      },
      () => {
        upsertNotebookCell(context, notebookId, cell);
        repairCellSlots(context, notebookId, cell.id);
      },
    );
    return ok(revisionFor(context, mutation.revision), mutation.revision);
  });
}

async function updateNotebookCell(
  context: EngineContext,
  notebookId: string,
  cell: NotebookCell,
): Promise<Result<Revision, EngineError>> {
  return resultOf(async () => {
    assertUuidV7(notebookId, "Notebook ID");
    const notebook = requiredNotebook(context, notebookId);
    if (!notebook.cells.some((existing) => existing.id === cell.id)) {
      throw new EngineFault({
        code: "NOT_FOUND",
        message: `Cell not found: ${cell.id}`,
      });
    }
    const prospective = {
      ...notebook,
      cells: notebook.cells.map((existing) =>
        existing.id === cell.id ? cell : existing,
      ),
    };
    validateCellFields(context, prospective, cell);
    assertCellSlugFree(context, notebookId, cell);
    assertCellSlotFree(context, notebookId, cell);
    const mutation = await context.store.semantic(
      {
        operation: "update_cell",
        tables: ["cells", "cell_references", "pinned_search_results"],
        details: { notebookId, cellId: cell.id },
        writeSet: [`notebook:${notebookId}`, `cell:${notebookId}:${cell.id}`],
      },
      () => {
        upsertNotebookCell(context, notebookId, cell);
        repairCellSlots(context, notebookId, cell.id);
      },
    );
    return ok(revisionFor(context, mutation.revision), mutation.revision);
  });
}

async function moveNotebookCell(
  context: EngineContext,
  notebookId: string,
  cellId: string,
  slot: NotebookCell["slot"],
): Promise<Result<Revision, EngineError>> {
  return resultOf(async () => {
    assertUuidV7(notebookId, "Notebook ID");
    assertUuidV7(cellId, "Cell ID");
    const notebook = requiredNotebook(context, notebookId);
    const existing = notebook.cells.find((cell) => cell.id === cellId);
    if (!existing) {
      throw new EngineFault({
        code: "NOT_FOUND",
        message: `Cell not found: ${cellId}`,
      });
    }
    return updateNotebookCell(context, notebookId, { ...existing, slot });
  });
}

async function removeNotebookCell(
  context: EngineContext,
  notebookId: string,
  cellId: string,
): Promise<Result<Revision, EngineError>> {
  return resultOf(async () => {
    assertUuidV7(notebookId, "Notebook ID");
    assertUuidV7(cellId, "Cell ID");
    requiredNotebook(context, notebookId);
    const found = context.store.db
      .prepare(
        "SELECT 1 AS present FROM cells WHERE notebook_id=? AND cell_id=?",
      )
      .get(notebookId, cellId);
    if (!found) {
      throw new EngineFault({
        code: "NOT_FOUND",
        message: `Cell not found: ${cellId}`,
      });
    }
    const mutation = await context.store.semantic(
      {
        operation: "remove_cell",
        tables: [
          "cells",
          "notebook_cell_executions",
          "notebook_generation_plans",
          "edges",
          "cell_references",
          "pinned_search_results",
        ],
        details: { notebookId, cellId },
        writeSet: [`notebook:${notebookId}`, `cell:${notebookId}:${cellId}`],
      },
      () => {
        context.store.db
          .prepare("DELETE FROM cells WHERE notebook_id=? AND cell_id=?")
          .run(notebookId, cellId);
        repairCellSlots(context, notebookId);
      },
    );
    return ok(revisionFor(context, mutation.revision), mutation.revision);
  });
}

function assertCellSlugFree(
  context: EngineContext,
  notebookId: string,
  cell: NotebookCell,
): void {
  const found = context.store.db
    .prepare(
      `SELECT cell_id FROM cells
       WHERE notebook_id=? AND slug=? AND cell_id<>?`,
    )
    .get(notebookId, cell.slug, cell.id) as unknown as
    { cell_id: string } | undefined;
  if (found) {
    throw new Error(`Duplicate cell slug: ${cell.slug}`);
  }
}

function assertCellSlotFree(
  context: EngineContext,
  notebookId: string,
  cell: NotebookCell,
): void {
  const found = context.store.db
    .prepare(
      `SELECT cell_id FROM cells
       WHERE notebook_id=? AND grid_row=? AND grid_column=? AND cell_id<>?`,
    )
    .get(notebookId, cell.slot.row, cell.slot.column, cell.id) as unknown as
    { cell_id: string } | undefined;
  if (found) {
    throw new Error(
      `Cell slot is occupied: ${cell.slot.row}:${cell.slot.column}`,
    );
  }
}

function repairCellSlots(
  context: EngineContext,
  notebookId: string,
  protectedCellId?: string,
): void {
  const rows = context.store.db
    .prepare(
      `SELECT cell_id, grid_row, grid_column FROM cells
       WHERE notebook_id=?
       ORDER BY grid_row, grid_column, cell_id`,
    )
    .all(notebookId) as unknown as Array<{
    cell_id: string;
    grid_row: number;
    grid_column: number;
  }>;
  const slots = new Map<string, typeof rows>();
  for (const row of rows) {
    const key = `${row.grid_row}:${row.grid_column}`;
    const group = slots.get(key) ?? [];
    group.push(row);
    slots.set(key, group);
  }
  const occupied: NotebookCell["slot"][] = [];
  const losers: string[] = [];
  for (const group of slots.values()) {
    const winner =
      protectedCellId && group.some((row) => row.cell_id === protectedCellId)
        ? protectedCellId
        : group[0]!.cell_id;
    const winnerRow = group.find((row) => row.cell_id === winner)!;
    occupied.push({
      row: winnerRow.grid_row,
      column: winnerRow.grid_column,
    });
    losers.push(
      ...group
        .filter((row) => row.cell_id !== winner)
        .map((row) => row.cell_id),
    );
  }
  const destinations = firstEmptyNotebookGridSlots(occupied, losers.length);
  const move = context.store.db.prepare(
    `UPDATE cells SET grid_row=?, grid_column=?
     WHERE notebook_id=? AND cell_id=?`,
  );
  for (const [index, cellId] of losers.entries()) {
    const slot = destinations[index]!;
    move.run(slot.row, slot.column, notebookId, cellId);
  }
}

/**
 * `UNIQUE(notebook_id, slug)` is immediate and the upsert loop writes cells
 * one at a time, so a document that validly swaps or rotates slugs between
 * surviving cells would collide mid-loop. Every surviving cell whose slug is
 * about to change is first parked on a unique temporary slug derived from
 * its current one — same type prefix, so the slug/type CHECK holds — and
 * the upsert pass then assigns the final slugs.
 */
function evacuateChangedCellSlugs(
  context: EngineContext,
  notebook: NotebookDocument,
): void {
  const existing = context.store.db
    .prepare("SELECT cell_id, slug FROM cells WHERE notebook_id=?")
    .all(notebook.id) as unknown as Array<{ cell_id: string; slug: string }>;
  if (existing.length === 0) return;
  const incomingSlugs = new Map(
    notebook.cells.map((cell) => [
      cell.id,
      normalizeCellForWrite(cell).slug ?? "",
    ]),
  );
  const evacuate = context.store.db.prepare(
    "UPDATE cells SET slug=? WHERE notebook_id=? AND cell_id=?",
  );
  for (const row of existing) {
    const nextSlug = incomingSlugs.get(row.cell_id);
    if (nextSlug === undefined || nextSlug === row.slug) continue;
    evacuate.run(
      `${row.slug}-evac-${newUuidV7().replace(/-/g, "")}`,
      notebook.id,
      row.cell_id,
    );
  }
}

function upsertNotebookCell(
  context: EngineContext,
  notebookId: string,
  cell: NotebookCell,
): void {
  const normalized = normalizeCellForWrite(cell);
  context.store.db
    .prepare(
      `INSERT INTO cells(
        notebook_id, cell_id, type, slug, grid_row, grid_column,
        output_entity_id, prompt, provider, model, operation, tool,
        inputs_json, output_artifact_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(notebook_id, cell_id) DO UPDATE SET
        type=excluded.type,
        slug=excluded.slug,
        grid_row=excluded.grid_row,
        grid_column=excluded.grid_column,
        output_entity_id=excluded.output_entity_id,
        prompt=excluded.prompt,
        provider=excluded.provider,
        model=excluded.model,
        operation=excluded.operation,
        tool=excluded.tool,
        inputs_json=excluded.inputs_json,
        output_artifact_id=excluded.output_artifact_id`,
    )
    .run(
      notebookId,
      normalized.id,
      normalized.type,
      requiredText(normalized.slug, "Cell slug"),
      normalized.slot.row,
      normalized.slot.column,
      normalized.outputEntityId ?? null,
      normalized.prompt ?? null,
      normalized.provider ?? null,
      normalized.model ?? null,
      normalized.operation ?? null,
      normalized.tool ?? null,
      canonicalJson(normalized.inputs ?? {}),
      normalized.outputArtifactId ?? null,
    );
  synchronizeCellReferences(context, notebookId, normalized);
  synchronizePinnedResults(context, notebookId, normalized);
}

async function deleteNotebook(
  context: EngineContext,
  notebookId: string,
): Promise<Result<{ notebookId: string }, EngineError>> {
  return resultOf(async () => {
    assertUuidV7(notebookId, "Notebook ID");
    requiredNotebook(context, notebookId);
    const mutation = await context.store.semantic(
      {
        operation: "delete_notebook",
        tables: [
          "notebooks",
          "notebook_fields",
          "cells",
          "notebook_cell_executions",
          "notebook_generation_plans",
          "notebook_run_plans",
          "notebook_transcript_edits",
          "notebook_transcript_attachments",
          "edges",
          "runs",
          "cell_references",
          "pinned_search_results",
        ],
        details: { notebookId },
        writeSet: [`notebook:${notebookId}`],
      },
      () => {
        context.store.db
          .prepare("DELETE FROM notebooks WHERE notebook_id=?")
          .run(notebookId);
      },
    );
    return ok({ notebookId }, mutation.revision);
  });
}

async function recordNotebookRun(
  context: EngineContext,
  run: NotebookRun,
): Promise<Result<Revision, EngineError>> {
  return resultOf(async () => {
    assertUuidV7(run.id, "Notebook run ID");
    assertUuidV7(run.notebookId, "Notebook ID");
    requiredNotebook(context, run.notebookId);
    validateRunStatus(run.status);
    const startedAt = requiredDate(run.startedAt, "Notebook run startedAt");
    const completedAt = requiredDate(
      run.completedAt,
      "Notebook run completedAt",
    );
    if (completedAt < startedAt) {
      throw new Error("Notebook run completedAt must not precede startedAt");
    }
    const mutation = await context.store.semantic(
      {
        operation: "record_notebook_run",
        tables: ["runs"],
        details: { notebookId: run.notebookId, runId: run.id },
        writeSet: [`run:${run.id}`],
      },
      () => {
        context.store.db
          .prepare(
            `INSERT INTO runs(
              run_id, notebook_id, status, started_at,
              completed_at, cell_order_json, outputs_json, error
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            run.id,
            run.notebookId,
            run.status,
            startedAt,
            completedAt,
            canonicalJson(run.cellOrder),
            canonicalJson(run.outputs),
            run.error ?? null,
          );
      },
    );
    return ok(revisionFor(context, mutation.revision), mutation.revision);
  });
}

function requiredEntity(
  context: EngineContext,
  entityId: string,
): EntityDocument {
  const row = context.store.db
    .prepare(`${ENTITY_SELECT} WHERE entity_id=?`)
    .get(entityId) as unknown as EntityRow | undefined;
  if (!row) throw new Error(`Entity not found: ${entityId}`);
  return rowToEntity(row);
}

function rowToEntity(row: EntityRow): EntityDocument {
  return {
    id: row.entity_id,
    type: row.type,
    name: row.name,
    ...(row.description ? { description: row.description } : {}),
    ...(row.prompt ? { prompt: row.prompt } : {}),
    data: parseJson<Record<string, unknown>>(row.data_json, {}),
    createdAt: new Date(row.created_at).toISOString(),
  };
}

function requiredNotebook(
  context: EngineContext,
  notebookId: string,
): NotebookDocument {
  const row = context.store.db
    .prepare(`${NOTEBOOK_SELECT} WHERE notebook_id=?`)
    .get(notebookId) as unknown as NotebookRow | undefined;
  if (!row) throw new Error(`Notebook not found: ${notebookId}`);
  return notebookFromRows(context, row);
}

function notebookFromRows(
  context: EngineContext,
  row: NotebookRow,
): NotebookDocument {
  const fields = context.store.db
    .prepare(
      `SELECT field, value_json
       FROM notebook_fields WHERE notebook_id=?
       ORDER BY field`,
    )
    .all(row.notebook_id) as unknown as NotebookFieldRow[];
  const cells = context.store.db
    .prepare(
      `SELECT cell_id, type, slug, grid_row, grid_column, output_entity_id,
              prompt, provider, model, operation, tool,
              inputs_json, output_artifact_id
       FROM cells WHERE notebook_id=?
       ORDER BY grid_row, grid_column, cell_id`,
    )
    .all(row.notebook_id) as unknown as NotebookCellRow[];
  const edges = context.store.db
    .prepare(
      `SELECT edge_id, source_cell_id, target_cell_id, target_input
       FROM edges WHERE notebook_id=? ORDER BY edge_id`,
    )
    .all(row.notebook_id) as unknown as NotebookEdgeRow[];
  const references = context.store.db
    .prepare(
      `SELECT cell_id, reference_id, kind, target_id, snapshot_json, ordinal
       FROM cell_references
       WHERE notebook_id=?
       ORDER BY cell_id, ordinal, reference_id`,
    )
    .all(row.notebook_id) as unknown as NotebookReferenceRow[];
  const pinnedResults = context.store.db
    .prepare(
      `SELECT cell_id, result_id, artifact_id, object_hash, location_json,
              representative_json, query_json, signals_json,
              selected_revision, ordinal, created_at
       FROM pinned_search_results
       WHERE notebook_id=?
       ORDER BY cell_id, ordinal, result_id`,
    )
    .all(row.notebook_id) as unknown as PinnedSearchResultRow[];
  const executions = context.store.db
    .prepare(
      `SELECT cell_id, fingerprint, status, output_artifact_id,
              provider_artifact_id, run_id, completed_at, started_at,
              updated_at, tool, error, stale, fixture_baseline
       FROM notebook_cell_executions
       WHERE notebook_id=? ORDER BY cell_id`,
    )
    .all(row.notebook_id) as unknown as NotebookCellExecutionRow[];
  const generationPlans = context.store.db
    .prepare(
      `SELECT plan_id, cell_id, status, plan_json, output_artifact_id,
              error, created_at, updated_at
       FROM notebook_generation_plans
       WHERE notebook_id=? ORDER BY created_at, plan_id`,
    )
    .all(row.notebook_id) as unknown as NotebookGenerationPlanRow[];
  const runPlans = context.store.db
    .prepare(
      `SELECT plan_id, status, plan_json, paid_cell_ids_json,
              cell_fingerprints_json, known_cost_usd, unknown_cost_count,
              created_at, updated_at, run_id, outputs_json, error
       FROM notebook_run_plans
       WHERE notebook_id=? ORDER BY created_at, plan_id`,
    )
    .all(row.notebook_id) as unknown as NotebookRunPlanRow[];
  const transcriptEdits = context.store.db
    .prepare(
      `SELECT action_id, kind, restored, payload_json
       FROM notebook_transcript_edits
       WHERE notebook_id=? ORDER BY action_id`,
    )
    .all(row.notebook_id) as unknown as NotebookTranscriptEditRow[];
  const transcriptAttachments = context.store.db
    .prepare(
      `SELECT attachment_id, payload_json
       FROM notebook_transcript_attachments
       WHERE notebook_id=? ORDER BY attachment_id`,
    )
    .all(row.notebook_id) as unknown as NotebookTranscriptAttachmentRow[];
  const field = new Map(
    fields.map((item) => [
      item.field,
      parseJson<unknown>(item.value_json, null),
    ]),
  );
  return {
    id: row.notebook_id,
    name: row.name,
    ...(typeof field.get("description") === "string"
      ? { description: field.get("description") as string }
      : {}),
    ...(typeof field.get("lifecycle_state") === "string"
      ? { lifecycleState: field.get("lifecycle_state") as string }
      : {}),
    ...(typeof field.get("workflow_version") === "number"
      ? { workflowVersion: field.get("workflow_version") as number }
      : {}),
    ...(typeof field.get("analysis_revision") === "string"
      ? { analysisRevision: field.get("analysis_revision") as string }
      : {}),
    ...(isRecord(field.get("audio_spine"))
      ? {
          audioSpine: field.get(
            "audio_spine",
          ) as NotebookDocument["audioSpine"],
        }
      : {}),
    ...(isRecord(field.get("current_selection"))
      ? {
          currentSelection: field.get(
            "current_selection",
          ) as NotebookDocument["currentSelection"],
        }
      : {}),
    ...(isRecord(field.get("fixture"))
      ? { fixture: field.get("fixture") as NotebookDocument["fixture"] }
      : {}),
    execution: Object.fromEntries(
      executions.map((execution) => [
        execution.cell_id,
        executionFromRow(execution),
      ]),
    ),
    generationPlans: generationPlans.map(generationPlanFromRow),
    notebookRunPlans: runPlans.map(runPlanFromRow),
    transcriptEdits: transcriptEdits.map(transcriptEditFromRow),
    transcriptAttachments: transcriptAttachments.map(
      transcriptAttachmentFromRow,
    ),
    cells: cells.map((cell) =>
      rowToCell(
        cell,
        references.filter((reference) => reference.cell_id === cell.cell_id),
        pinnedResults.filter((result) => result.cell_id === cell.cell_id),
      ),
    ),
    edges: edges.map(rowToEdge),
    createdAt: new Date(row.created_at).toISOString(),
  };
}

function validateNotebook(
  context: EngineContext,
  notebook: NotebookDocument,
): void {
  const cellIds = new Set<string>();
  const cellSlugs = new Set<string>();
  const occupiedSlots = new Set<string>();
  for (const cell of notebook.cells) {
    if (cellIds.has(cell.id)) throw new Error(`Duplicate cell ID: ${cell.id}`);
    cellIds.add(cell.id);
    if (cellSlugs.has(cell.slug)) {
      throw new Error(`Duplicate cell slug: ${cell.slug}`);
    }
    cellSlugs.add(cell.slug);
    const slot = `${cell.slot.row}:${cell.slot.column}`;
    if (occupiedSlots.has(slot))
      throw new Error(`Duplicate cell slot: ${slot}`);
    occupiedSlots.add(slot);
    validateCellFields(context, notebook, cell);
  }
  const edgeIds = new Set<string>();
  const occupiedInputs = new Set<string>();
  for (const edge of notebook.edges) {
    assertUuidV7(edge.id, "Edge ID");
    if (edgeIds.has(edge.id)) throw new Error(`Duplicate edge ID: ${edge.id}`);
    edgeIds.add(edge.id);
    if (!cellIds.has(edge.source) || !cellIds.has(edge.target)) {
      throw new Error(`Edge ${edge.id} must reference cells in the notebook`);
    }
    const targetInput = requiredText(edge.targetInput, "Edge targetInput");
    const inputKey = `${edge.target}:${targetInput}`;
    if (occupiedInputs.has(inputKey)) {
      throw new Error(`Duplicate target input: ${edge.target} ${targetInput}`);
    }
    occupiedInputs.add(inputKey);
  }
}

function validateCellFields(
  context: EngineContext,
  notebook: NotebookDocument,
  cell: NotebookCell,
): void {
  assertUuidV7(cell.id, "Cell ID");
  if (!NOTEBOOK_CELL_TYPE_SET.has(cell.type)) {
    throw new Error(`Invalid cell type: ${cell.type}`);
  }
  const slug = requiredText(cell.slug, "Cell slug");
  if (slug !== cell.slug || !isValidNotebookCellSlug(cell.type, slug)) {
    throw new Error(`Invalid ${cell.type} cell slug: ${cell.slug}`);
  }
  if (!isNotebookGridSlot(cell.slot)) {
    throw new Error(
      `Cell slot must be within @a1-@z13: ${cell.id}`,
    );
  }
  if (cell.outputEntityId) {
    assertUuidV7(cell.outputEntityId, "Cell output entity ID");
    requiredEntity(context, cell.outputEntityId);
  }
  if (cell.outputArtifactId) {
    assertUuidV7(cell.outputArtifactId, "Cell output artifact ID");
    context.artifactRowById(cell.outputArtifactId);
  }
  validateCellReferences(context, notebook, cell);
  validatePinnedResults(context, cell);
}

function synchronizeNotebookChildren(
  context: EngineContext,
  notebook: NotebookDocument,
): void {
  deleteMissing(
    context,
    "edges",
    "edge_id",
    notebook.id,
    notebook.edges.map((edge) => edge.id),
  );
  deleteMissing(
    context,
    "cells",
    "cell_id",
    notebook.id,
    notebook.cells.map((cell) => cell.id),
  );
  evacuateChangedCellSlugs(context, notebook);
  for (const cell of notebook.cells) {
    upsertNotebookCell(context, notebook.id, cell);
  }
  repairCellSlots(context, notebook.id);
  const upsertEdge = context.store.db.prepare(
    `INSERT INTO edges(
      notebook_id, edge_id, source_cell_id, target_cell_id, target_input
    ) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(notebook_id, edge_id) DO UPDATE SET
      source_cell_id=excluded.source_cell_id,
      target_cell_id=excluded.target_cell_id,
      target_input=excluded.target_input`,
  );
  for (const edge of notebook.edges) {
    upsertEdge.run(
      notebook.id,
      edge.id,
      edge.source,
      edge.target,
      edge.targetInput,
    );
  }
}

function synchronizeNotebookState(
  context: EngineContext,
  notebook: NotebookDocument,
): void {
  synchronizeNotebookFields(context, notebook);
  synchronizeCellExecutions(context, notebook);
  synchronizeGenerationPlans(context, notebook);
  synchronizeRunPlans(context, notebook);
  synchronizeTranscriptEdits(context, notebook);
  synchronizeTranscriptAttachments(context, notebook);
}

function synchronizeNotebookFields(
  context: EngineContext,
  notebook: NotebookDocument,
): void {
  const values = new Map<string, unknown>();
  if (notebook.description !== undefined) {
    values.set("description", notebook.description);
  }
  if (notebook.lifecycleState !== undefined) {
    values.set("lifecycle_state", notebook.lifecycleState);
  }
  if (notebook.workflowVersion !== undefined) {
    if (!Number.isSafeInteger(notebook.workflowVersion)) {
      throw new Error("Notebook workflow version must be an integer");
    }
    values.set("workflow_version", notebook.workflowVersion);
  }
  if (notebook.analysisRevision !== undefined) {
    values.set("analysis_revision", notebook.analysisRevision);
  }
  if (notebook.audioSpine !== undefined) {
    values.set("audio_spine", notebook.audioSpine);
  }
  if (notebook.currentSelection !== undefined) {
    values.set("current_selection", notebook.currentSelection);
  }
  if (notebook.fixture !== undefined) {
    values.set("fixture", notebook.fixture);
  }
  deleteMissingNotebookRows(context, "notebook_fields", "field", notebook.id, [
    ...values.keys(),
  ]);
  const upsert = context.store.db.prepare(
    `INSERT INTO notebook_fields(notebook_id, field, value_json)
     VALUES (?, ?, ?)
     ON CONFLICT(notebook_id, field) DO UPDATE SET
       value_json=excluded.value_json`,
  );
  for (const [field, value] of values) {
    upsert.run(notebook.id, field, canonicalJson(value));
  }
}

function synchronizeCellExecutions(
  context: EngineContext,
  notebook: NotebookDocument,
): void {
  const entries = Object.entries(notebook.execution ?? {});
  const cellIds = new Set(notebook.cells.map((cell) => cell.id));
  for (const [cellId] of entries) {
    if (!cellIds.has(cellId)) {
      throw new Error(`Notebook execution references missing cell: ${cellId}`);
    }
  }
  deleteMissingNotebookRows(
    context,
    "notebook_cell_executions",
    "cell_id",
    notebook.id,
    entries.map(([cellId]) => cellId),
  );
  const upsert = context.store.db.prepare(
    `INSERT INTO notebook_cell_executions(
       notebook_id, cell_id, fingerprint, status, output_artifact_id,
       provider_artifact_id, run_id, completed_at, started_at, updated_at,
       tool, error, stale, fixture_baseline
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(notebook_id, cell_id) DO UPDATE SET
       fingerprint=excluded.fingerprint,
       status=excluded.status,
       output_artifact_id=excluded.output_artifact_id,
       provider_artifact_id=excluded.provider_artifact_id,
       run_id=excluded.run_id,
       completed_at=excluded.completed_at,
       started_at=excluded.started_at,
       updated_at=excluded.updated_at,
       tool=excluded.tool,
       error=excluded.error,
       stale=excluded.stale,
       fixture_baseline=excluded.fixture_baseline`,
  );
  for (const [cellId, execution] of entries) {
    upsert.run(
      notebook.id,
      cellId,
      execution.fingerprint ?? null,
      execution.status ?? null,
      execution.outputArtifactId ?? null,
      execution.providerArtifactId ?? null,
      execution.runId ?? null,
      execution.completedAt ?? null,
      execution.startedAt ?? null,
      execution.updatedAt ?? null,
      execution.tool ?? null,
      execution.error ?? null,
      execution.stale === true ? 1 : 0,
      execution.fixtureBaseline === true ? 1 : 0,
    );
  }
}

function synchronizeGenerationPlans(
  context: EngineContext,
  notebook: NotebookDocument,
): void {
  const plans = notebook.generationPlans ?? [];
  assertUnique(
    plans.map((plan) => plan.planId),
    "generation plan ID",
  );
  deleteMissingNotebookRows(
    context,
    "notebook_generation_plans",
    "plan_id",
    notebook.id,
    plans.map((plan) => plan.planId),
  );
  const upsert = context.store.db.prepare(
    `INSERT INTO notebook_generation_plans(
       notebook_id, plan_id, cell_id, status, plan_json,
       output_artifact_id, error, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(notebook_id, plan_id) DO UPDATE SET
       cell_id=excluded.cell_id,
       status=excluded.status,
       plan_json=excluded.plan_json,
       output_artifact_id=excluded.output_artifact_id,
       error=excluded.error,
       created_at=excluded.created_at,
       updated_at=excluded.updated_at`,
  );
  for (const plan of plans) {
    upsert.run(
      notebook.id,
      requiredText(plan.planId, "Generation plan ID"),
      requiredText(plan.cellId, "Generation plan cell ID"),
      requiredText(plan.status, "Generation plan status"),
      canonicalJson(plan.plan),
      plan.outputArtifactId ?? null,
      plan.error ?? null,
      requiredText(plan.createdAt, "Generation plan created time"),
      requiredText(plan.updatedAt, "Generation plan updated time"),
    );
  }
}

function synchronizeRunPlans(
  context: EngineContext,
  notebook: NotebookDocument,
): void {
  const plans = notebook.notebookRunPlans ?? [];
  assertUnique(
    plans.map((plan) => plan.planId),
    "notebook run plan ID",
  );
  deleteMissingNotebookRows(
    context,
    "notebook_run_plans",
    "plan_id",
    notebook.id,
    plans.map((plan) => plan.planId),
  );
  const upsert = context.store.db.prepare(
    `INSERT INTO notebook_run_plans(
       notebook_id, plan_id, status, plan_json, paid_cell_ids_json,
       cell_fingerprints_json, known_cost_usd, unknown_cost_count,
       created_at, updated_at, run_id, outputs_json, error
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(notebook_id, plan_id) DO UPDATE SET
       status=excluded.status,
       plan_json=excluded.plan_json,
       paid_cell_ids_json=excluded.paid_cell_ids_json,
       cell_fingerprints_json=excluded.cell_fingerprints_json,
       known_cost_usd=excluded.known_cost_usd,
       unknown_cost_count=excluded.unknown_cost_count,
       created_at=excluded.created_at,
       updated_at=excluded.updated_at,
       run_id=excluded.run_id,
       outputs_json=excluded.outputs_json,
       error=excluded.error`,
  );
  for (const plan of plans) {
    upsert.run(
      notebook.id,
      requiredText(plan.planId, "Notebook run plan ID"),
      requiredText(plan.status, "Notebook run plan status"),
      canonicalJson(plan.plan),
      canonicalJson(plan.paidCellIds),
      canonicalJson(plan.cellDefinitionFingerprints),
      nonNegativeFinite(plan.knownCostUsd, "Notebook run plan known cost"),
      nonNegativeInteger(
        plan.unknownCostCount,
        "Notebook run plan unknown cost count",
      ),
      requiredText(plan.createdAt, "Notebook run plan created time"),
      requiredText(plan.updatedAt, "Notebook run plan updated time"),
      plan.runId ?? null,
      plan.outputs === undefined ? null : canonicalJson(plan.outputs),
      plan.error ?? null,
    );
  }
}

function synchronizeTranscriptEdits(
  context: EngineContext,
  notebook: NotebookDocument,
): void {
  const edits = notebook.transcriptEdits ?? [];
  assertUnique(
    edits.map((edit) => edit.actionId),
    "transcript edit action ID",
  );
  deleteMissingNotebookRows(
    context,
    "notebook_transcript_edits",
    "action_id",
    notebook.id,
    edits.map((edit) => edit.actionId),
  );
  const upsert = context.store.db.prepare(
    `INSERT INTO notebook_transcript_edits(
       notebook_id, action_id, kind, restored, payload_json
     ) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(notebook_id, action_id) DO UPDATE SET
       kind=excluded.kind,
       restored=excluded.restored,
       payload_json=excluded.payload_json`,
  );
  for (const edit of edits) {
    upsert.run(
      notebook.id,
      requiredText(edit.actionId, "Transcript edit action ID"),
      requiredText(edit.kind, "Transcript edit kind"),
      edit.restored === true ? 1 : 0,
      canonicalJson(edit),
    );
  }
}

function synchronizeTranscriptAttachments(
  context: EngineContext,
  notebook: NotebookDocument,
): void {
  const attachments = notebook.transcriptAttachments ?? [];
  assertUnique(
    attachments.map((attachment) => attachment.id),
    "transcript attachment ID",
  );
  deleteMissingNotebookRows(
    context,
    "notebook_transcript_attachments",
    "attachment_id",
    notebook.id,
    attachments.map((attachment) => attachment.id),
  );
  const upsert = context.store.db.prepare(
    `INSERT INTO notebook_transcript_attachments(
       notebook_id, attachment_id, payload_json
     ) VALUES (?, ?, ?)
     ON CONFLICT(notebook_id, attachment_id) DO UPDATE SET
       payload_json=excluded.payload_json`,
  );
  for (const attachment of attachments) {
    upsert.run(
      notebook.id,
      requiredText(attachment.id, "Transcript attachment ID"),
      canonicalJson(attachment),
    );
  }
}

function deleteMissingNotebookRows(
  context: EngineContext,
  table:
    | "notebook_fields"
    | "notebook_cell_executions"
    | "notebook_generation_plans"
    | "notebook_run_plans"
    | "notebook_transcript_edits"
    | "notebook_transcript_attachments",
  idColumn: "field" | "cell_id" | "plan_id" | "action_id" | "attachment_id",
  notebookId: string,
  ids: string[],
): void {
  if (ids.length === 0) {
    context.store.db
      .prepare(`DELETE FROM ${table} WHERE notebook_id=?`)
      .run(notebookId);
    return;
  }
  const placeholders = ids.map(() => "?").join(", ");
  context.store.db
    .prepare(
      `DELETE FROM ${table}
       WHERE notebook_id=? AND ${idColumn} NOT IN (${placeholders})`,
    )
    .run(notebookId, ...ids);
}

function deleteMissing(
  context: EngineContext,
  table: "cells" | "edges",
  idColumn: "cell_id" | "edge_id",
  notebookId: string,
  ids: string[],
): void {
  if (ids.length === 0) {
    context.store.db
      .prepare(`DELETE FROM ${table} WHERE notebook_id=?`)
      .run(notebookId);
    return;
  }
  const placeholders = ids.map(() => "?").join(", ");
  context.store.db
    .prepare(
      `DELETE FROM ${table}
       WHERE notebook_id=? AND ${idColumn} NOT IN (${placeholders})`,
    )
    .run(notebookId, ...ids);
}

function validateCellReferences(
  context: EngineContext,
  notebook: NotebookDocument,
  cell: NotebookCell,
): void {
  const ids = new Set<string>();
  const ordinals = new Set<number>();
  for (const reference of cell.references ?? []) {
    assertUuidV7(reference.id, "Cell reference ID");
    if (ids.has(reference.id)) {
      throw new Error(`Duplicate cell reference ID: ${reference.id}`);
    }
    ids.add(reference.id);
    validateOrdinal(reference.ordinal, "Cell reference ordinal");
    if (ordinals.has(reference.ordinal)) {
      throw new Error(`Duplicate cell reference ordinal: ${reference.ordinal}`);
    }
    ordinals.add(reference.ordinal);
    requiredText(reference.targetId, "Cell reference target ID");
    assertReferenceTarget(context, notebook, reference);
  }
}

function assertReferenceTarget(
  context: EngineContext,
  notebook: NotebookDocument,
  reference: NotebookCellReference,
): void {
  if (reference.kind === "artifact") {
    context.artifactRowById(reference.targetId);
    return;
  }
  if (reference.kind === "cell-output") {
    if (!notebook.cells.some((cell) => cell.id === reference.targetId)) {
      throw new Error(`Cell output target not found: ${reference.targetId}`);
    }
    return;
  }
  const table =
    reference.kind === "transcript"
      ? "transcripts"
      : reference.kind === "sequence"
        ? "sequences"
        : "artifact_streams";
  const column =
    reference.kind === "transcript"
      ? "transcript_id"
      : reference.kind === "sequence"
        ? "sequence_id"
        : "stream_id";
  const found = context.store.db
    .prepare(`SELECT 1 AS present FROM ${table} WHERE ${column}=?`)
    .get(reference.targetId);
  if (!found) {
    throw new Error(
      `${reference.kind} target not found: ${reference.targetId}`,
    );
  }
}

function validatePinnedResults(
  context: EngineContext,
  cell: NotebookCell,
): void {
  const ids = new Set<string>();
  const ordinals = new Set<number>();
  for (const result of cell.pinnedResults ?? []) {
    assertUuidV7(result.id, "Pinned search result ID");
    if (ids.has(result.id)) {
      throw new Error(`Duplicate pinned search result ID: ${result.id}`);
    }
    ids.add(result.id);
    validateOrdinal(result.ordinal, "Pinned search result ordinal");
    if (ordinals.has(result.ordinal)) {
      throw new Error(
        `Duplicate pinned search result ordinal: ${result.ordinal}`,
      );
    }
    ordinals.add(result.ordinal);
    context.artifactRowById(result.artifactId);
    requiredText(result.objectHash, "Pinned search result object hash");
    normalizeSearchLocation(result.location);
    requiredText(result.selectedRevision, "Pinned search result revision");
    if (!Number.isSafeInteger(result.createdAt) || result.createdAt < 0) {
      throw new Error(
        "Pinned search result createdAt must be a positive integer",
      );
    }
    const object = context.store.db
      .prepare("SELECT 1 AS present FROM objects WHERE object_hash=?")
      .get(result.objectHash);
    if (!object) {
      throw new Error(
        `Pinned search result object not found: ${result.objectHash}`,
      );
    }
  }
}

function validateOrdinal(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative safe integer`);
  }
}

function synchronizeCellReferences(
  context: EngineContext,
  notebookId: string,
  cell: NotebookCell,
): void {
  const references = cell.references ?? [];
  deleteMissingChildren(
    context,
    "cell_references",
    "reference_id",
    notebookId,
    cell.id,
    references.map((reference) => reference.id),
  );
  const upsert = context.store.db.prepare(
    `INSERT INTO cell_references(
      notebook_id, cell_id, reference_id, kind,
      target_id, snapshot_json, ordinal
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(notebook_id, cell_id, reference_id) DO UPDATE SET
      kind=excluded.kind,
      target_id=excluded.target_id,
      snapshot_json=excluded.snapshot_json,
      ordinal=excluded.ordinal`,
  );
  for (const reference of references) {
    upsert.run(
      notebookId,
      cell.id,
      reference.id,
      reference.kind,
      reference.targetId,
      canonicalJson(reference.snapshot),
      reference.ordinal,
    );
  }
}

function synchronizePinnedResults(
  context: EngineContext,
  notebookId: string,
  cell: NotebookCell,
): void {
  const pinnedResults = cell.pinnedResults ?? [];
  deleteMissingChildren(
    context,
    "pinned_search_results",
    "result_id",
    notebookId,
    cell.id,
    pinnedResults.map((result) => result.id),
  );
  const upsert = context.store.db.prepare(
    `INSERT INTO pinned_search_results(
      notebook_id, cell_id, result_id, artifact_id, object_hash,
      location_json, representative_json, query_json, signals_json,
      selected_revision, ordinal, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(notebook_id, cell_id, result_id) DO UPDATE SET
      artifact_id=excluded.artifact_id,
      object_hash=excluded.object_hash,
      location_json=excluded.location_json,
      representative_json=excluded.representative_json,
      query_json=excluded.query_json,
      signals_json=excluded.signals_json,
      selected_revision=excluded.selected_revision,
      ordinal=excluded.ordinal,
      created_at=excluded.created_at`,
  );
  for (const result of pinnedResults) {
    upsert.run(
      notebookId,
      cell.id,
      result.id,
      result.artifactId,
      result.objectHash,
      canonicalJson(normalizeSearchLocation(result.location)),
      result.representativeTick === undefined
        ? null
        : canonicalJson(result.representativeTick),
      canonicalJson(result.query),
      canonicalJson(result.signals),
      result.selectedRevision,
      result.ordinal,
      result.createdAt,
    );
  }
}

function deleteMissingChildren(
  context: EngineContext,
  table: "cell_references" | "pinned_search_results",
  idColumn: "reference_id" | "result_id",
  notebookId: string,
  cellId: string,
  ids: string[],
): void {
  if (ids.length === 0) {
    context.store.db
      .prepare(`DELETE FROM ${table} WHERE notebook_id=? AND cell_id=?`)
      .run(notebookId, cellId);
    return;
  }
  const placeholders = ids.map(() => "?").join(", ");
  context.store.db
    .prepare(
      `DELETE FROM ${table}
       WHERE notebook_id=? AND cell_id=? AND ${idColumn} NOT IN (${placeholders})`,
    )
    .run(notebookId, cellId, ...ids);
}

function rowToCellReference(row: NotebookReferenceRow): NotebookCellReference {
  return {
    id: row.reference_id,
    kind: row.kind,
    targetId: row.target_id,
    snapshot: parseJson<Record<string, unknown>>(row.snapshot_json, {}),
    ordinal: row.ordinal,
  };
}

function rowToPinnedSearchResult(
  row: PinnedSearchResultRow,
): PinnedSearchResult {
  const representativeTick =
    row.representative_json === null
      ? undefined
      : parseJson<number | undefined>(row.representative_json, undefined);
  return {
    id: row.result_id,
    artifactId: row.artifact_id,
    objectHash: row.object_hash,
    location: normalizeSearchLocation(
      parseJson<SearchLocation>(row.location_json, {
        kind: "still",
        artifactId: row.artifact_id,
        sourcePath: "unknown",
        objectHash: row.object_hash,
      }),
    ),
    ...(representativeTick === undefined ? {} : { representativeTick }),
    query: parseJson<SearchQuery>(row.query_json, {}),
    signals: parseJson<SearchSignal[]>(row.signals_json, []),
    selectedRevision: row.selected_revision,
    ordinal: row.ordinal,
    createdAt: row.created_at,
  };
}

function rowToCell(
  row: NotebookCellRow,
  references: NotebookReferenceRow[],
  pinnedResults: PinnedSearchResultRow[],
): NotebookCell {
  const inputs = parseJson<Record<string, unknown>>(row.inputs_json, {});
  const legacyProvider = optionalString(inputs.provider);
  const legacyOperation = optionalString(inputs.operation);
  const provider = optionalString(row.provider) ?? legacyProvider;
  const operation = optionalString(row.operation) ?? legacyOperation;
  const model = optionalString(row.model);
  const tool =
    optionalString(row.tool) ??
    (looksLikeGenerationTool(model) ? model : undefined);
  return {
    id: row.cell_id,
    type: notebookCellType(row.type),
    slug: row.slug,
    slot: { row: row.grid_row, column: row.grid_column },
    ...(row.output_entity_id ? { outputEntityId: row.output_entity_id } : {}),
    ...(row.prompt ? { prompt: row.prompt } : {}),
    ...(provider ? { provider } : {}),
    ...(model ? { model } : {}),
    ...(operation ? { operation } : {}),
    ...(tool ? { tool } : {}),
    inputs,
    ...(row.output_artifact_id
      ? { outputArtifactId: row.output_artifact_id }
      : {}),
    references: references.map(rowToCellReference),
    pinnedResults: pinnedResults.map(rowToPinnedSearchResult),
  };
}

function notebookCellType(type: string): NotebookCell["type"] {
  if (!NOTEBOOK_CELL_TYPE_SET.has(type as NotebookCell["type"])) {
    throw new Error(`Invalid cell type: ${type}`);
  }
  return type as NotebookCell["type"];
}

function normalizeCellForWrite(cell: NotebookCell): NotebookCell {
  const inputs = { ...(cell.inputs ?? {}) };
  const provider =
    optionalString(cell.provider) ?? optionalString(inputs.provider);
  const operation =
    optionalString(cell.operation) ?? optionalString(inputs.operation);
  const model = optionalString(cell.model);
  const tool =
    optionalString(cell.tool) ??
    (looksLikeGenerationTool(model) ? model : undefined);
  return {
    ...cell,
    ...(provider ? { provider } : { provider: undefined }),
    ...(operation ? { operation } : { operation: undefined }),
    ...(tool ? { tool } : { tool: undefined }),
    inputs,
  };
}

function optionalString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function looksLikeGenerationTool(value: string | undefined): boolean {
  if (!value) return false;
  return value.startsWith("generate_") || value.includes("/");
}

function rowToEdge(row: NotebookEdgeRow): NotebookEdge {
  return {
    id: row.edge_id,
    source: row.source_cell_id,
    target: row.target_cell_id,
    targetInput: row.target_input,
  };
}

function revisionFor(context: EngineContext, hash: string): Revision {
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

function requiredText(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${label} is required`);
  return normalized;
}

function requiredDate(value: string, label: string): number {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed))
    throw new Error(`${label} must be a valid date`);
  return parsed;
}

function validateEntityType(type: string): asserts type is EntityType {
  if (!["prompt", "character", "scene"].includes(type)) {
    throw new Error(`Invalid entity type: ${type}`);
  }
}

function validateRunStatus(
  status: string,
): asserts status is NotebookRun["status"] {
  if (!["completed", "failed", "aborted"].includes(status)) {
    throw new Error(`Invalid notebook run status: ${status}`);
  }
}

function executionFromRow(
  row: NotebookCellExecutionRow,
): NotebookCellExecution {
  return {
    ...(row.fingerprint ? { fingerprint: row.fingerprint } : {}),
    ...(row.status ? { status: row.status } : {}),
    ...(row.output_artifact_id
      ? { outputArtifactId: row.output_artifact_id }
      : {}),
    ...(row.provider_artifact_id
      ? { providerArtifactId: row.provider_artifact_id }
      : {}),
    ...(row.run_id ? { runId: row.run_id } : {}),
    ...(row.completed_at ? { completedAt: row.completed_at } : {}),
    ...(row.started_at ? { startedAt: row.started_at } : {}),
    ...(row.updated_at ? { updatedAt: row.updated_at } : {}),
    ...(row.tool ? { tool: row.tool } : {}),
    ...(row.error ? { error: row.error } : {}),
    ...(row.stale === 1 ? { stale: true } : {}),
    ...(row.fixture_baseline === 1 ? { fixtureBaseline: true } : {}),
  };
}

function generationPlanFromRow(
  row: NotebookGenerationPlanRow,
): NotebookGenerationPlan {
  return {
    planId: row.plan_id,
    cellId: row.cell_id,
    status: row.status,
    plan: parseJson<Record<string, unknown>>(row.plan_json, {}),
    ...(row.output_artifact_id
      ? { outputArtifactId: row.output_artifact_id }
      : {}),
    ...(row.error ? { error: row.error } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function runPlanFromRow(row: NotebookRunPlanRow): NotebookRunPlan {
  return {
    planId: row.plan_id,
    status: row.status,
    plan: parseJson<Record<string, unknown>>(row.plan_json, {}),
    paidCellIds: parseJson<string[]>(row.paid_cell_ids_json, []),
    cellDefinitionFingerprints: parseJson<Record<string, string>>(
      row.cell_fingerprints_json,
      {},
    ),
    knownCostUsd: row.known_cost_usd,
    unknownCostCount: row.unknown_cost_count,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.run_id ? { runId: row.run_id } : {}),
    ...(row.outputs_json
      ? {
          outputs: parseJson<Record<string, string>>(row.outputs_json, {}),
        }
      : {}),
    ...(row.error ? { error: row.error } : {}),
  };
}

function transcriptEditFromRow(
  row: NotebookTranscriptEditRow,
): NotebookTranscriptEdit {
  const payload = parseJson<Record<string, unknown>>(row.payload_json, {});
  return {
    ...payload,
    actionId: row.action_id,
    kind: row.kind,
    ...(row.restored === 1 ? { restored: true } : {}),
  };
}

function transcriptAttachmentFromRow(
  row: NotebookTranscriptAttachmentRow,
): NotebookTranscriptAttachment {
  const payload = parseJson<Record<string, unknown>>(row.payload_json, {});
  return {
    ...payload,
    id: row.attachment_id,
  };
}

function assertUnique(values: string[], label: string): void {
  const unique = new Set(values);
  if (unique.size !== values.length) {
    throw new Error(`Duplicate ${label}`);
  }
}

function nonNegativeFinite(value: number, label: string): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${label} must be a non-negative finite number`);
  }
  return value;
}

function nonNegativeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative integer`);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function callerOrNewId(id: string | undefined, label: string): string {
  const resolved = id ?? newUuidV7();
  assertUuidV7(resolved, label);
  return resolved;
}

const ENTITY_SELECT = `
  SELECT entity_id, type, name, description, prompt, data_json, created_at
  FROM entities
`;

const NOTEBOOK_SELECT = `
  SELECT notebook_id, name, created_at
  FROM notebooks
`;
