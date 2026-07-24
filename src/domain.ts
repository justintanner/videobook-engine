import type {
  EntityDocument,
  EntityType,
  NotebookCell,
  NotebookDocument,
  NotebookEdge,
  NotebookRun,
} from "./notebook/types.js";
import type { EngineError, Result, Revision } from "./engine-types.js";
import { ok } from "./engine-types.js";
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
  model: string | null;
  inputs_json: string;
  output_artifact_id: string | null;
}

interface NotebookEdgeRow {
  edge_id: string;
  source_cell_id: string;
  target_cell_id: string;
  target_input: string;
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
      ["notebooks", "cells", "edges"],
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
              prompt, model, inputs_json, output_artifact_id
       FROM cells WHERE notebook_id=? ORDER BY cell_id`,
    )
    .all(row.notebook_id) as unknown as NotebookCellRow[];
  const edges = context.store.db
    .prepare(
      `SELECT edge_id, source_cell_id, target_cell_id, target_input
       FROM edges WHERE notebook_id=? ORDER BY edge_id`,
    )
    .all(row.notebook_id) as unknown as NotebookEdgeRow[];
  return {
    id: row.notebook_id,
    name: row.name,
    properties: parseJson<Record<string, unknown>>(row.properties_json, {}),
    cells: cells.map(rowToCell),
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
    if (
      !["prompt", "character", "scene", "asset", "image", "video"].includes(
        cell.type,
      )
    ) {
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
      entity_id, prompt, model, inputs_json, output_artifact_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(notebook_id, cell_id) DO UPDATE SET
      type=excluded.type,
      title=excluded.title,
      position_x=excluded.position_x,
      position_y=excluded.position_y,
      entity_id=excluded.entity_id,
      prompt=excluded.prompt,
      model=excluded.model,
      inputs_json=excluded.inputs_json,
      output_artifact_id=excluded.output_artifact_id`,
  );
  for (const cell of notebook.cells) {
    upsertCell.run(
      notebook.id,
      cell.id,
      cell.type,
      requiredText(cell.title, "Cell title"),
      cell.position.x,
      cell.position.y,
      cell.entityId ?? null,
      cell.prompt ?? null,
      cell.model ?? null,
      canonicalJson(cell.inputs ?? {}),
      cell.outputArtifactId ?? null,
    );
  }

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

function rowToCell(row: NotebookCellRow): NotebookCell {
  return {
    id: row.cell_id,
    type: row.type,
    title: row.title,
    position: { x: row.position_x, y: row.position_y },
    ...(row.entity_id ? { entityId: row.entity_id } : {}),
    ...(row.prompt ? { prompt: row.prompt } : {}),
    ...(row.model ? { model: row.model } : {}),
    inputs: parseJson<Record<string, unknown>>(row.inputs_json, {}),
    ...(row.output_artifact_id
      ? { outputArtifactId: row.output_artifact_id }
      : {}),
  };
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
