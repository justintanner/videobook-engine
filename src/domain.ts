import type {
  EntityDocument,
  EntityType,
  NotebookCell,
  NotebookCellReference,
  NotebookDocument,
  NotebookEdge,
  NotebookReferenceKind,
  NotebookRun,
  PinnedSearchResult,
} from "./notebook/types.js";
import type { EngineError, Result, Revision } from "./engine-types.js";
import type {
  SearchQuery,
  SearchSignal,
} from "./mvp-contracts.js";
import type { SearchLocation } from "./mvp-time.js";
import { ok } from "./engine-types.js";
import { normalizeSearchLocation } from "./mvp-time.js";
import {
  EngineContext,
  resultOf,
  syncResultOf,
} from "./context.js";
import { assertUuidV7, newUuidV7 } from "./ids.js";
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
  properties_json: string;
  created_at: number;
}

interface NotebookCellRow {
  cell_id: string;
  type: NotebookCell["type"];
  title: string;
  position_x: number;
  position_y: number;
  entity_id: string | null;
  prompt: string | null;
  provider: string | null;
  model: string | null;
  operation: string | null;
  tool: string | null;
  inputs_json: string;
  output_artifact_id: string | null;
}

const NOTEBOOK_CELL_TYPE_SET = new Set<NotebookCell["type"]>([
  "source",
  "audio",
  "transcript",
  "note",
  "search",
  "selects",
  "prompt",
  "character",
  "scene",
  "asset",
  "image",
  "video",
  "sequence",
  "analysis",
  "split",
  "frame",
  "export",
]);

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
    ): Promise<Result<Revision, EngineError>> => writeNotebook(context, notebook),
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
        details: { entityId, type, name: normalizedName },
        writeSet: [`entity:${entityId}`],
      },
      ["entities"],
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

function listEntities(context: EngineContext, type?: EntityType): EntityDocument[] {
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
        details: { entityId: entity.id, type: entity.type },
        writeSet: [`entity:${entity.id}`],
      },
      ["entities"],
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
         WHERE entity_id=? ORDER BY notebook_id, cell_id`,
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
            kind: "cell.entity",
            id: `${cell.notebook_id}/${cell.cell_id}`,
          })),
        },
      });
    }
    const mutation = await context.store.semantic(
      {
        operation: "delete_entity",
        details: { entityId },
        writeSet: [`entity:${entityId}`],
      },
      ["entities"],
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
        details: { notebookId, name: normalizedName },
        writeSet: [`notebook:${notebookId}`],
      },
      ["notebooks"],
      (_operationId, now) => {
        context.store.db
          .prepare(
            `INSERT INTO notebooks(
              notebook_id, name, properties_json, created_at
            ) VALUES (?, ?, '{}', ?)`,
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
        details: { notebookId: notebook.id },
        writeSet: [
          `notebook:${notebook.id}`,
          ...notebook.cells.map((cell) => `cell:${notebook.id}:${cell.id}`),
          ...notebook.edges.map((edge) => `edge:${notebook.id}:${edge.id}`),
        ],
      },
      [
        "notebooks",
        "cells",
        "edges",
        "cell_references",
        "pinned_search_results",
      ],
      () => {
        context.store.db
          .prepare(
            `UPDATE notebooks SET name=?, properties_json=?
             WHERE notebook_id=?`,
          )
          .run(
            requiredText(notebook.name, "Notebook name"),
            canonicalJson(notebook.properties ?? {}),
            notebook.id,
          );
        synchronizeNotebookChildren(context, notebook);
      },
    );
    return ok(revisionFor(context, mutation.revision), mutation.revision);
  });
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
        details: { notebookId },
        writeSet: [`notebook:${notebookId}`],
      },
      ["notebooks", "cells", "edges", "runs"],
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
        details: { notebookId: run.notebookId, runId: run.id },
        writeSet: [`run:${run.id}`],
      },
      ["runs"],
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

function requiredEntity(context: EngineContext, entityId: string): EntityDocument {
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
  const cells = context.store.db
    .prepare(
      `SELECT cell_id, type, title, position_x, position_y, entity_id,
              prompt, provider, model, operation, tool,
              inputs_json, output_artifact_id
       FROM cells WHERE notebook_id=? ORDER BY cell_id`,
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
  return {
    id: row.notebook_id,
    name: row.name,
    properties: parseJson<Record<string, unknown>>(row.properties_json, {}),
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
  for (const cell of notebook.cells) {
    assertUuidV7(cell.id, "Cell ID");
    if (cellIds.has(cell.id)) throw new Error(`Duplicate cell ID: ${cell.id}`);
    cellIds.add(cell.id);
    if (!NOTEBOOK_CELL_TYPE_SET.has(cell.type)) {
      throw new Error(`Invalid cell type: ${cell.type}`);
    }
    if (!Number.isFinite(cell.position.x) || !Number.isFinite(cell.position.y)) {
      throw new Error(`Cell position must be finite: ${cell.id}`);
    }
    if (cell.entityId) {
      assertUuidV7(cell.entityId, "Cell entity ID");
      requiredEntity(context, cell.entityId);
    }
    if (cell.outputArtifactId) {
      assertUuidV7(cell.outputArtifactId, "Cell output artifact ID");
      context.artifactRowById(cell.outputArtifactId);
    }
    validateCellReferences(context, notebook, cell);
    validatePinnedResults(context, cell);
  }
  const edgeIds = new Set<string>();
  for (const edge of notebook.edges) {
    assertUuidV7(edge.id, "Edge ID");
    if (edgeIds.has(edge.id)) throw new Error(`Duplicate edge ID: ${edge.id}`);
    edgeIds.add(edge.id);
    if (!cellIds.has(edge.source) || !cellIds.has(edge.target)) {
      throw new Error(`Edge ${edge.id} must reference cells in the notebook`);
    }
    requiredText(edge.targetInput, "Edge targetInput");
  }
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

  const upsertCell = context.store.db.prepare(
    `INSERT INTO cells(
      notebook_id, cell_id, type, title, position_x, position_y,
      entity_id, prompt, provider, model, operation, tool,
      inputs_json, output_artifact_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(notebook_id, cell_id) DO UPDATE SET
      type=excluded.type,
      title=excluded.title,
      position_x=excluded.position_x,
      position_y=excluded.position_y,
      entity_id=excluded.entity_id,
      prompt=excluded.prompt,
      provider=excluded.provider,
      model=excluded.model,
      operation=excluded.operation,
      tool=excluded.tool,
      inputs_json=excluded.inputs_json,
      output_artifact_id=excluded.output_artifact_id`,
  );
  for (const cell of notebook.cells) {
    const normalized = normalizeCellForWrite(cell);
    upsertCell.run(
      notebook.id,
      normalized.id,
      normalized.type,
      requiredText(normalized.title, "Cell title"),
      normalized.position.x,
      normalized.position.y,
      normalized.entityId ?? null,
      normalized.prompt ?? null,
      normalized.provider ?? null,
      normalized.model ?? null,
      normalized.operation ?? null,
      normalized.tool ?? null,
      canonicalJson(normalized.inputs ?? {}),
      normalized.outputArtifactId ?? null,
    );
  }
  synchronizeCellReferences(context, notebook);
  synchronizePinnedResults(context, notebook);

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
  const table = reference.kind === "transcript"
    ? "transcripts"
    : reference.kind === "sequence"
      ? "sequences"
      : "artifact_streams";
  const column = reference.kind === "transcript"
    ? "transcript_id"
    : reference.kind === "sequence"
      ? "sequence_id"
      : "stream_id";
  const found = context.store.db
    .prepare(`SELECT 1 AS present FROM ${table} WHERE ${column}=?`)
    .get(reference.targetId);
  if (!found) {
    throw new Error(`${reference.kind} target not found: ${reference.targetId}`);
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
      throw new Error(`Duplicate pinned search result ordinal: ${result.ordinal}`);
    }
    ordinals.add(result.ordinal);
    context.artifactRowById(result.artifactId);
    requiredText(result.objectHash, "Pinned search result object hash");
    normalizeSearchLocation(result.location);
    requiredText(result.selectedRevision, "Pinned search result revision");
    if (!Number.isSafeInteger(result.createdAt) || result.createdAt < 0) {
      throw new Error("Pinned search result createdAt must be a positive integer");
    }
    const object = context.store.db
      .prepare("SELECT 1 AS present FROM objects WHERE object_hash=?")
      .get(result.objectHash);
    if (!object) {
      throw new Error(`Pinned search result object not found: ${result.objectHash}`);
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
  notebook: NotebookDocument,
): void {
  context.store.db
    .prepare("DELETE FROM cell_references WHERE notebook_id=?")
    .run(notebook.id);
  const insert = context.store.db.prepare(
    `INSERT INTO cell_references(
      notebook_id, cell_id, reference_id, kind,
      target_id, snapshot_json, ordinal
    ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const cell of notebook.cells) {
    for (const reference of cell.references ?? []) {
      insert.run(
        notebook.id,
        cell.id,
        reference.id,
        reference.kind,
        reference.targetId,
        canonicalJson(reference.snapshot),
        reference.ordinal,
      );
    }
  }
}

function synchronizePinnedResults(
  context: EngineContext,
  notebook: NotebookDocument,
): void {
  context.store.db
    .prepare("DELETE FROM pinned_search_results WHERE notebook_id=?")
    .run(notebook.id);
  const insert = context.store.db.prepare(
    `INSERT INTO pinned_search_results(
      notebook_id, cell_id, result_id, artifact_id, object_hash,
      location_json, representative_json, query_json, signals_json,
      selected_revision, ordinal, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const cell of notebook.cells) {
    for (const result of cell.pinnedResults ?? []) {
      insert.run(
        notebook.id,
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
  const representativeTick = row.representative_json === null
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
  const tool = optionalString(row.tool)
    ?? (looksLikeGenerationTool(model) ? model : undefined);
  return {
    id: row.cell_id,
    type: row.type,
    title: row.title,
    position: { x: row.position_x, y: row.position_y },
    ...(row.entity_id ? { entityId: row.entity_id } : {}),
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

function normalizeCellForWrite(cell: NotebookCell): NotebookCell {
  const inputs = { ...(cell.inputs ?? {}) };
  const provider = optionalString(cell.provider)
    ?? optionalString(inputs.provider);
  const operation = optionalString(cell.operation)
    ?? optionalString(inputs.operation);
  const model = optionalString(cell.model);
  const tool = optionalString(cell.tool)
    ?? (looksLikeGenerationTool(model) ? model : undefined);
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
  if (!Number.isFinite(parsed)) throw new Error(`${label} must be a valid date`);
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
  SELECT notebook_id, name, properties_json, created_at
  FROM notebooks
`;
