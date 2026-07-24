import { v7 as uuidv7 } from "uuid";

import type {
  EntityDocument,
  EntityType,
  NotebookCell,
  NotebookDocument,
  NotebookEdge,
  NotebookRun,
} from "./notebook/types.js";
import type {
  EngineError,
  Result,
  Revision,
} from "./engine-types.js";
import { ok } from "./engine-types.js";
import { EngineContext, resultOf } from "./context.js";
import { canonicalJson, parseJson } from "./store.js";

interface EntityRow {
  entity_id: string;
  type: EntityType;
  name: string;
  description: string | null;
  prompt: string | null;
  data_json: string;
  created_at: number;
  updated_at: number;
}

interface NotebookRow {
  notebook_id: string;
  name: string;
  version: number;
  properties_json: string;
  created_at: number;
  updated_at: number;
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
  ordinal: number;
}

interface NotebookEdgeRow {
  edge_id: string;
  source_cell_id: string;
  target_cell_id: string;
  target_input: string;
  ordinal: number;
}

export function createEntitiesApi(context: EngineContext) {
  return {
    create: (
      type: EntityType,
      name: string,
      project: string,
      input: Partial<EntityDocument> = {},
    ): Promise<Result<EntityDocument, EngineError>> =>
      createEntity(context, type, name, project, input),
    list: (project: string, type?: EntityType): EntityDocument[] =>
      listEntities(context, project, type),
    read: (
      entityId: string,
      project: string,
    ): Result<EntityDocument, EngineError> =>
      readEntity(context, entityId, project),
    write: (
      entity: EntityDocument,
      project: string,
    ): Promise<Result<Revision, EngineError>> =>
      writeEntity(context, entity, project),
    delete: (
      entityId: string,
      project: string,
    ): Promise<Result<{ deletedAt: number }, EngineError>> =>
      deleteEntity(context, entityId, project),
  };
}

export function createNotebooksApi(context: EngineContext) {
  return {
    create: (
      name: string,
      project: string,
    ): Promise<Result<NotebookDocument, EngineError>> =>
      createNotebook(context, name, project),
    list: (project: string): NotebookDocument[] =>
      listNotebooks(context, project),
    read: (
      notebookId: string,
      project: string,
    ): Result<NotebookDocument, EngineError> =>
      readNotebook(context, notebookId, project),
    write: (
      notebook: NotebookDocument,
      project: string,
    ): Promise<Result<Revision, EngineError>> =>
      writeNotebook(context, notebook, project),
    delete: (
      notebookId: string,
      project: string,
    ): Promise<Result<{ deletedAt: number }, EngineError>> =>
      deleteNotebook(context, notebookId, project),
    recordRun: (
      run: NotebookRun,
      project: string,
    ): Promise<Result<Revision, EngineError>> =>
      recordNotebookRun(context, run, project),
  };
}

async function createEntity(
  context: EngineContext,
  type: EntityType,
  name: string,
  projectReference: string,
  input: Partial<EntityDocument>,
): Promise<Result<EntityDocument, EngineError>> {
  return resultOf(async () => {
    if (!["prompt", "character", "scene"].includes(type)) {
      throw new Error(`Invalid entity type: ${type}`);
    }
    const project = context.projectRow(projectReference);
    const entityId = uuidv7();
    const mutation = await context.store.semantic(
      {
        projectId: project.project_id,
        operation: "create_entity",
        details: { entityId, type, name },
        writeSet: [`entity:${entityId}`],
      },
      ["entities"],
      (_operationId, now) => {
        context.store.db
          .prepare(
            `INSERT INTO entities(
              entity_id, project_id, type, name, description, prompt,
              data_json, created_at, updated_at, deleted_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
          )
          .run(
            entityId,
            project.project_id,
            type,
            name.trim(),
            input.description ?? null,
            input.prompt ?? null,
            canonicalJson(input.data ?? {}),
            now,
            now,
          );
      },
    );
    const entity = requiredEntity(context, project.project_id, entityId);
    return ok(entity, mutation.revision);
  });
}

function listEntities(
  context: EngineContext,
  projectReference: string,
  type?: EntityType,
): EntityDocument[] {
  const project = context.projectRow(projectReference);
  const rows = type
    ? (context.store.db
        .prepare(
          `${ENTITY_SELECT}
           WHERE project_id=? AND type=? AND deleted_at IS NULL
           ORDER BY created_at, entity_id`,
        )
        .all(project.project_id, type) as unknown as EntityRow[])
    : (context.store.db
        .prepare(
          `${ENTITY_SELECT}
           WHERE project_id=? AND deleted_at IS NULL
           ORDER BY created_at, entity_id`,
        )
        .all(project.project_id) as unknown as EntityRow[]);
  return rows.map(rowToEntity);
}

function readEntity(
  context: EngineContext,
  entityId: string,
  projectReference: string,
): Result<EntityDocument, EngineError> {
  try {
    const project = context.projectRow(projectReference);
    return ok(requiredEntity(context, project.project_id, entityId));
  } catch (error) {
    return {
      ok: false,
      error: {
        code: "NOT_FOUND",
        message: error instanceof Error ? error.message : String(error),
      },
    };
  }
}

async function writeEntity(
  context: EngineContext,
  entity: EntityDocument,
  projectReference: string,
): Promise<Result<Revision, EngineError>> {
  return resultOf(async () => {
    const project = context.projectRow(projectReference);
    requiredEntity(context, project.project_id, entity.id);
    const mutation = await context.store.semantic(
      {
        projectId: project.project_id,
        operation: "write_entity",
        details: { entityId: entity.id, type: entity.type },
        writeSet: [`entity:${entity.id}`],
      },
      ["entities"],
      (_operationId, now) => {
        context.store.db
          .prepare(
            `UPDATE entities
             SET type=?, name=?, description=?, prompt=?, data_json=?,
                 updated_at=?
             WHERE entity_id=? AND project_id=? AND deleted_at IS NULL`,
          )
          .run(
            entity.type,
            entity.name,
            entity.description ?? null,
            entity.prompt ?? null,
            canonicalJson(entity.data),
            now,
            entity.id,
            project.project_id,
          );
      },
    );
    return ok(revisionFor(context, mutation.revision), mutation.revision);
  });
}

async function deleteEntity(
  context: EngineContext,
  entityId: string,
  projectReference: string,
): Promise<Result<{ deletedAt: number }, EngineError>> {
  return resultOf(async () => {
    const project = context.projectRow(projectReference);
    requiredEntity(context, project.project_id, entityId);
    const mutation = await context.store.semantic(
      {
        projectId: project.project_id,
        operation: "delete_entity",
        details: { entityId },
        writeSet: [`entity:${entityId}`],
      },
      ["entities"],
      (_operationId, now) => {
        context.store.db
          .prepare(
            `UPDATE entities SET deleted_at=?, updated_at=?
             WHERE entity_id=? AND project_id=?`,
          )
          .run(now, now, entityId, project.project_id);
        return now;
      },
    );
    return ok({ deletedAt: mutation.value }, mutation.revision);
  });
}

async function createNotebook(
  context: EngineContext,
  name: string,
  projectReference: string,
): Promise<Result<NotebookDocument, EngineError>> {
  return resultOf(async () => {
    const project = context.projectRow(projectReference);
    const notebookId = uuidv7();
    const mutation = await context.store.semantic(
      {
        projectId: project.project_id,
        operation: "create_notebook",
        details: { notebookId, name },
        writeSet: [`notebook:${notebookId}`],
      },
      ["notebooks"],
      (_operationId, now) => {
        context.store.db
          .prepare(
            `INSERT INTO notebooks(
              notebook_id, project_id, name, version, properties_json,
              created_at, updated_at, deleted_at
            ) VALUES (?, ?, ?, 2, '{}', ?, ?, NULL)`,
          )
          .run(notebookId, project.project_id, name.trim(), now, now);
      },
    );
    return ok(
      requiredNotebook(context, project.project_id, notebookId),
      mutation.revision,
    );
  });
}

function listNotebooks(
  context: EngineContext,
  projectReference: string,
): NotebookDocument[] {
  const project = context.projectRow(projectReference);
  const rows = context.store.db
    .prepare(
      `${NOTEBOOK_SELECT}
       WHERE project_id=? AND deleted_at IS NULL
       ORDER BY created_at, notebook_id`,
    )
    .all(project.project_id) as unknown as NotebookRow[];
  return rows.map((row) =>
    notebookFromRows(context, project.project_id, row),
  );
}

function readNotebook(
  context: EngineContext,
  notebookId: string,
  projectReference: string,
): Result<NotebookDocument, EngineError> {
  try {
    const project = context.projectRow(projectReference);
    return ok(
      requiredNotebook(context, project.project_id, notebookId),
    );
  } catch (error) {
    return {
      ok: false,
      error: {
        code: "NOT_FOUND",
        message: error instanceof Error ? error.message : String(error),
      },
    };
  }
}

async function writeNotebook(
  context: EngineContext,
  notebook: NotebookDocument,
  projectReference: string,
): Promise<Result<Revision, EngineError>> {
  return resultOf(async () => {
    const project = context.projectRow(projectReference);
    requiredNotebook(context, project.project_id, notebook.id);
    const mutation = await context.store.semantic(
      {
        projectId: project.project_id,
        operation: "write_notebook",
        details: { notebookId: notebook.id },
        writeSet: [`notebook:${notebook.id}`],
      },
      ["notebooks", "notebook_cells", "notebook_edges"],
      (_operationId, now) => {
        context.store.db
          .prepare(
            `UPDATE notebooks
             SET name=?, version=?, properties_json=?, updated_at=?
             WHERE notebook_id=? AND project_id=? AND deleted_at IS NULL`,
          )
          .run(
            notebook.name,
            notebook.version,
            canonicalJson(notebook.properties ?? {}),
            now,
            notebook.id,
            project.project_id,
          );
        replaceNotebookChildren(context, notebook);
      },
    );
    return ok(revisionFor(context, mutation.revision), mutation.revision);
  });
}

async function deleteNotebook(
  context: EngineContext,
  notebookId: string,
  projectReference: string,
): Promise<Result<{ deletedAt: number }, EngineError>> {
  return resultOf(async () => {
    const project = context.projectRow(projectReference);
    requiredNotebook(context, project.project_id, notebookId);
    const mutation = await context.store.semantic(
      {
        projectId: project.project_id,
        operation: "delete_notebook",
        details: { notebookId },
        writeSet: [`notebook:${notebookId}`],
      },
      ["notebooks"],
      (_operationId, now) => {
        context.store.db
          .prepare(
            `UPDATE notebooks SET deleted_at=?, updated_at=?
             WHERE notebook_id=? AND project_id=?`,
          )
          .run(now, now, notebookId, project.project_id);
        return now;
      },
    );
    return ok({ deletedAt: mutation.value }, mutation.revision);
  });
}

async function recordNotebookRun(
  context: EngineContext,
  run: NotebookRun,
  projectReference: string,
): Promise<Result<Revision, EngineError>> {
  return resultOf(async () => {
    const project = context.projectRow(projectReference);
    requiredNotebook(context, project.project_id, run.notebookId);
    if (
      run.status !== "completed" &&
      run.status !== "failed" &&
      run.status !== "aborted"
    ) {
      throw new Error(
        "Only terminal notebook runs may be recorded semantically",
      );
    }
    const mutation = await context.store.semantic(
      {
        projectId: project.project_id,
        operation: "record_notebook_run",
        details: { notebookId: run.notebookId, runId: run.id },
        writeSet: [`notebook-run:${run.id}`],
      },
      ["notebook_runs"],
      () => {
        context.store.db
          .prepare(
            `INSERT INTO notebook_runs(
              run_id, notebook_id, project_id, status, started_at,
              completed_at, cell_order_json, outputs_json, error
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(run_id) DO UPDATE SET
              status=excluded.status,
              completed_at=excluded.completed_at,
              cell_order_json=excluded.cell_order_json,
              outputs_json=excluded.outputs_json,
              error=excluded.error`,
          )
          .run(
            run.id,
            run.notebookId,
            project.project_id,
            run.status,
            Date.parse(run.startedAt),
            run.completedAt ? Date.parse(run.completedAt) : null,
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
  projectId: string,
  entityId: string,
): EntityDocument {
  const row = context.store.db
    .prepare(
      `${ENTITY_SELECT}
       WHERE entity_id=? AND project_id=? AND deleted_at IS NULL`,
    )
    .get(entityId, projectId) as unknown as EntityRow | undefined;
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
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

function requiredNotebook(
  context: EngineContext,
  projectId: string,
  notebookId: string,
): NotebookDocument {
  const row = context.store.db
    .prepare(
      `${NOTEBOOK_SELECT}
       WHERE notebook_id=? AND project_id=? AND deleted_at IS NULL`,
    )
    .get(notebookId, projectId) as unknown as NotebookRow | undefined;
  if (!row) throw new Error(`Notebook not found: ${notebookId}`);
  return notebookFromRows(context, projectId, row);
}

function notebookFromRows(
  context: EngineContext,
  _projectId: string,
  row: NotebookRow,
): NotebookDocument {
  const cells = context.store.db
    .prepare(
      `SELECT cell_id, type, title, position_x, position_y, entity_id,
              prompt, model, inputs_json, output_artifact_id, ordinal
       FROM notebook_cells
       WHERE notebook_id=?
       ORDER BY ordinal, cell_id`,
    )
    .all(row.notebook_id) as unknown as NotebookCellRow[];
  const edges = context.store.db
    .prepare(
      `SELECT edge_id, source_cell_id, target_cell_id, target_input, ordinal
       FROM notebook_edges
       WHERE notebook_id=?
       ORDER BY ordinal, edge_id`,
    )
    .all(row.notebook_id) as unknown as NotebookEdgeRow[];
  return {
    id: row.notebook_id,
    name: row.name,
    version: 2,
    properties: parseJson<Record<string, unknown>>(
      row.properties_json,
      {},
    ),
    cells: cells.map(rowToCell),
    edges: edges.map(rowToEdge),
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

function replaceNotebookChildren(
  context: EngineContext,
  notebook: NotebookDocument,
): void {
  context.store.db
    .prepare("DELETE FROM notebook_cells WHERE notebook_id=?")
    .run(notebook.id);
  context.store.db
    .prepare("DELETE FROM notebook_edges WHERE notebook_id=?")
    .run(notebook.id);
  const insertCell = context.store.db.prepare(
    `INSERT INTO notebook_cells(
      notebook_id, cell_id, type, title, position_x, position_y,
      entity_id, prompt, model, inputs_json, output_artifact_id, ordinal
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  notebook.cells.forEach((cell, ordinal) => {
    insertCell.run(
      notebook.id,
      cell.id,
      cell.type,
      cell.title,
      cell.position.x,
      cell.position.y,
      cell.entityId ?? null,
      cell.prompt ?? null,
      cell.model ?? null,
      canonicalJson(cell.inputs ?? {}),
      cell.outputAssetId ?? null,
      ordinal,
    );
  });
  const insertEdge = context.store.db.prepare(
    `INSERT INTO notebook_edges(
      notebook_id, edge_id, source_cell_id, target_cell_id,
      target_input, ordinal
    ) VALUES (?, ?, ?, ?, ?, ?)`,
  );
  notebook.edges.forEach((edge, ordinal) => {
    insertEdge.run(
      notebook.id,
      edge.id,
      edge.source,
      edge.target,
      edge.targetInput,
      ordinal,
    );
  });
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
      ? { outputAssetId: row.output_artifact_id }
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

const ENTITY_SELECT = `
  SELECT entity_id, project_id, type, name, description, prompt,
         data_json, created_at, updated_at, deleted_at
  FROM entities
`;

const NOTEBOOK_SELECT = `
  SELECT notebook_id, project_id, name, version, properties_json, created_at,
         updated_at, deleted_at
  FROM notebooks
`;
