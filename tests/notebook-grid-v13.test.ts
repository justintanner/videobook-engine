import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";

import { DatabaseSync } from "@dolthub/doltlite";
import { afterEach, describe, expect, it } from "vitest";

import {
  CELLS_TABLE_COLUMNS,
  firstEmptyNotebookGridSlot,
  firstEmptyNotebookGridSlots,
  nearestOriginNotebookGridSlot,
  nextHorizontalSlotFrom,
  nextVerticalSlotFrom,
  NOTEBOOK_CELL_TYPES,
  NOTEBOOK_GRID_CAPACITY,
  NOTEBOOK_GRID_COLUMN_COUNT,
  NOTEBOOK_GRID_FULL_ERROR,
  NOTEBOOK_GRID_ROW_COUNT,
  notebookGridAddress,
  notebookGridTag,
  parseNotebookGridAddress,
  SCHEMA_VERSION,
  createEngine,
} from "../src/index.js";
import type { NotebookCell } from "../src/index.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true, maxRetries: 3 })),
  );
});

function value<T>(
  result: { ok: true; value: T } | { ok: false; error: { message: string } },
): T {
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

async function setup() {
  const root = await mkdtemp(path.join(tmpdir(), "videobook-grid-v13-"));
  roots.push(root);
  const engine = createEngine({
    rootDir: root,
    initialBookName: "grid-v13",
  });
  await engine.ready;
  return { root, engine };
}

// Kept as a literal copy of CELLS_TABLE_SQL in src/schema.ts so a schema
// drift shows up as a test diff, not a silent divergence.
const CELLS_TABLE_DDL = `
  CREATE TABLE IF NOT EXISTS cells (
    notebook_id TEXT NOT NULL
      REFERENCES notebooks(notebook_id) ON DELETE CASCADE,
    cell_id TEXT NOT NULL,
    type TEXT NOT NULL CHECK (
      type IN (
        'audio','image','video','extract_audio','extract_frame','split_video',
        'prompt','character',
        'analyze','analysis','generate_video','generate_image','generate_audio',
        'concat','splice'
      )
    ),
    label TEXT,
    grid_row INTEGER NOT NULL CHECK (grid_row BETWEEN 0 AND 25),
    grid_column INTEGER NOT NULL CHECK (grid_column BETWEEN 0 AND 12),
    output_entity_id TEXT
      REFERENCES entities(entity_id) ON DELETE RESTRICT,
    prompt TEXT,
    provider TEXT,
    model TEXT,
    operation TEXT,
    tool TEXT,
    inputs_json TEXT NOT NULL DEFAULT '{}',
    output_artifact_id TEXT
      REFERENCES artifacts(artifact_id) ON DELETE RESTRICT,
    PRIMARY KEY(notebook_id, cell_id)
  );`;

describe("fixed notebook grid schema 21", () => {
  it("exports the bounded address contract and the fifteen explicit cell types", () => {
    expect(NOTEBOOK_CELL_TYPES).toEqual([
      "audio",
      "image",
      "video",
      "extract_audio",
      "extract_frame",
      "split_video",
      "prompt",
      "character",
      "analyze",
      "analysis",
      "generate_video",
      "generate_image",
      "generate_audio",
      "concat",
      "splice",
    ]);
    expect(CELLS_TABLE_COLUMNS).toEqual([
      "notebook_id",
      "cell_id",
      "type",
      "label",
      "grid_row",
      "grid_column",
      "output_entity_id",
      "prompt",
      "provider",
      "model",
      "operation",
      "tool",
      "inputs_json",
      "output_artifact_id",
    ]);
    expect(SCHEMA_VERSION).toBe(21);
    expect(NOTEBOOK_GRID_ROW_COUNT).toBe(26);
    expect(NOTEBOOK_GRID_COLUMN_COUNT).toBe(13);
    expect(NOTEBOOK_GRID_CAPACITY).toBe(338);
    expect(parseNotebookGridAddress("@A13")).toEqual({ row: 0, column: 12 });
    expect(parseNotebookGridAddress("z13")).toEqual({ row: 25, column: 12 });
    expect(parseNotebookGridAddress("@a14")).toBeUndefined();
    expect(parseNotebookGridAddress("@aa1")).toBeUndefined();
    expect(notebookGridAddress({ row: 25, column: 12 })).toBe("z13");
    expect(notebookGridTag({ row: 0, column: 0 })).toBe("@a1");
  });

  it("pins the label-only cells DDL and its live column projection", async () => {
    const { root, engine } = await setup();
    engine.close();
    const catalog = new DatabaseSync(path.join(root, "data", "videobook.db"), {
      readOnly: true,
    });
    const liveColumns = (
      catalog.prepare("PRAGMA table_info(cells)").all() as Array<{
        name: string;
        notnull: number;
      }>
    ).map(({ name, notnull }) => ({ name, notnull }));
    catalog.close();

    const scratchRoot = await mkdtemp(
      path.join(tmpdir(), "videobook-cells-ddl-"),
    );
    roots.push(scratchRoot);
    const scratch = new DatabaseSync(path.join(scratchRoot, "cells-ddl.db"));
    scratch.exec(`
      CREATE TABLE notebooks (notebook_id TEXT PRIMARY KEY);
      CREATE TABLE entities (entity_id TEXT PRIMARY KEY);
      CREATE TABLE artifacts (artifact_id TEXT PRIMARY KEY);
    `);
    scratch.exec(CELLS_TABLE_DDL);
    const pinnedColumns = (
      scratch.prepare("PRAGMA table_info(cells)").all() as Array<{
        name: string;
        notnull: number;
      }>
    ).map(({ name, notnull }) => ({ name, notnull }));
    scratch.close();

    expect(liveColumns).toEqual(pinnedColumns);
    expect(pinnedColumns.map((column) => column.name)).toEqual([
      ...CELLS_TABLE_COLUMNS,
    ]);
    expect(pinnedColumns.find((column) => column.name === "label")).toEqual({
      name: "label",
      notnull: 0,
    });
  });

  it("allocates empty slots in address order and reports a full grid", () => {
    expect(
      firstEmptyNotebookGridSlots(
        [
          { row: 0, column: 0 },
          { row: 0, column: 2 },
        ],
        3,
      ),
    ).toEqual([
      { row: 0, column: 1 },
      { row: 0, column: 3 },
      { row: 0, column: 4 },
    ]);
    const full = Array.from({ length: NOTEBOOK_GRID_CAPACITY }, (_, index) => ({
      row: Math.floor(index / NOTEBOOK_GRID_COLUMN_COUNT),
      column: index % NOTEBOOK_GRID_COLUMN_COUNT,
    }));
    expect(() => firstEmptyNotebookGridSlot(full)).toThrow(
      NOTEBOOK_GRID_FULL_ERROR,
    );
  });

  it("allocates vertical slots downward from an anchor with collision skip and spill", () => {
    expect(nextVerticalSlotFrom({ row: 0, column: 0 }, [])).toEqual({
      row: 0,
      column: 0,
    });
    expect(
      nextVerticalSlotFrom(
        { row: 1, column: 0 },
        [{ row: 1, column: 0 }, { row: 2, column: 0 }],
      ),
    ).toEqual({ row: 3, column: 0 });
    const columnFull = Array.from(
      { length: NOTEBOOK_GRID_ROW_COUNT - 2 },
      (_, index) => ({ row: index + 2, column: 1 }),
    );
    expect(
      nextVerticalSlotFrom({ row: 2, column: 1 }, columnFull),
    ).toEqual({ row: 2, column: 2 });
  });

  it("allocates horizontal slots rightward from an anchor with collision skip and spill", () => {
    expect(nextHorizontalSlotFrom({ row: 0, column: 0 }, [])).toEqual({
      row: 0,
      column: 0,
    });
    expect(
      nextHorizontalSlotFrom(
        { row: 0, column: 2 },
        [{ row: 0, column: 2 }, { row: 0, column: 3 }],
      ),
    ).toEqual({ row: 0, column: 4 });
    const rowFull = Array.from(
      { length: NOTEBOOK_GRID_COLUMN_COUNT - 4 },
      (_, index) => ({ row: 1, column: index + 4 }),
    );
    expect(
      nextHorizontalSlotFrom({ row: 1, column: 4 }, rowFull),
    ).toEqual({ row: 2, column: 4 });
  });

  it("picks the free slot nearest @a1 and reports a full board for directional helpers", () => {
    expect(
      nearestOriginNotebookGridSlot([
        { row: 0, column: 0 },
        { row: 0, column: 1 },
        { row: 1, column: 0 },
      ]),
    ).toEqual({ row: 0, column: 2 });
    const full = Array.from({ length: NOTEBOOK_GRID_CAPACITY }, (_, index) => ({
      row: Math.floor(index / NOTEBOOK_GRID_COLUMN_COUNT),
      column: index % NOTEBOOK_GRID_COLUMN_COUNT,
    }));
    expect(() => nearestOriginNotebookGridSlot(full)).toThrow(
      NOTEBOOK_GRID_FULL_ERROR,
    );
    expect(() => nextVerticalSlotFrom({ row: 0, column: 0 }, full)).toThrow(
      NOTEBOOK_GRID_FULL_ERROR,
    );
    expect(() => nextHorizontalSlotFrom({ row: 0, column: 0 }, full)).toThrow(
      NOTEBOOK_GRID_FULL_ERROR,
    );
  });

  it("round-trips every cell type in row-major grid slots", async () => {
    const { root, engine } = await setup();
    const notebook = value(await engine.notebooks.create("Workflow"));
    const cells = NOTEBOOK_CELL_TYPES.map((type, index) =>
      engine.notebooks.createCell({
        type,
        label: `${type} cell`,
        slot: {
          row: Math.floor(index / NOTEBOOK_GRID_COLUMN_COUNT),
          column: index % NOTEBOOK_GRID_COLUMN_COUNT,
        },
        prompt: type === "analyze" ? "Analyze scenes" : undefined,
        provider: type === "analyze" ? "kie" : undefined,
        model: type === "analyze" ? "gemini-3.5-flash" : undefined,
        operation: type === "analyze" ? "analyze_source" : undefined,
        tool: type === "analyze" ? "kie_gemini_analysis" : undefined,
        inputs: { ordinal: index },
      }),
    );
    value(
      await engine.notebooks.write({
        ...notebook,
        cells,
        edges: [],
      }),
    );
    const reloaded = value(engine.notebooks.read(notebook.id));
    expect("grid" in reloaded).toBe(false);
    expect(reloaded.cells.map((cell) => cell.type).sort()).toEqual(
      [...NOTEBOOK_CELL_TYPES].sort(),
    );
    expect(reloaded.cells.find((cell) => cell.type === "audio")).toMatchObject({
      label: "audio cell",
      slot: { row: 0, column: 0 },
    });
    expect(
      reloaded.cells.find((cell) => cell.type === "analyze")?.slot,
    ).toEqual({
      row: 0,
      column: 8,
    });
    expect(
      reloaded.cells.find((cell) => cell.type === "analyze"),
    ).toMatchObject({
      provider: "kie",
      model: "gemini-3.5-flash",
      operation: "analyze_source",
      tool: "kie_gemini_analysis",
      prompt: "Analyze scenes",
    });

    engine.close();
    const database = new DatabaseSync(path.join(root, "data", "videobook.db"), {
      readOnly: true,
    });
    const raw = database
      .prepare(
        `SELECT ${CELLS_TABLE_COLUMNS.join(", ")}
         FROM cells WHERE notebook_id=? AND type='analyze'`,
      )
      .get(notebook.id) as Record<string, unknown>;
    expect(Object.keys(raw)).toHaveLength(14);
    expect(raw.grid_row).toBe(0);
    expect(raw.grid_column).toBe(8);
    expect(raw.provider).toBe("kie");
    database.close();
  });

  it("enforces the explicit cell types in the semantic table", async () => {
    const { root, engine } = await setup();
    const notebook = value(await engine.notebooks.create("Constraint"));
    engine.close();
    const database = new DatabaseSync(path.join(root, "data", "videobook.db"));
    expect(() =>
      database
        .prepare(
          `INSERT INTO cells(
          notebook_id, cell_id, type, label, grid_row, grid_column, inputs_json
        ) VALUES (?, 'removed-split', 'split', 'split removed', 0, 0, '{}')`,
        )
        .run(notebook.id),
    ).toThrow();
    database.close();
  });

  it("allows only one edge per named target input", async () => {
    const { engine } = await setup();
    const notebook = value(await engine.notebooks.create("Inputs"));
    const first = engine.notebooks.createCell({
      type: "video",
      slot: { row: 0, column: 0 },
    });
    const second = engine.notebooks.createCell({
      type: "video",
      slot: { row: 0, column: 1 },
    });
    const target = engine.notebooks.createCell({
      type: "analyze",
      slot: { row: 1, column: 0 },
    });
    const duplicateInput = await engine.notebooks.write({
      ...notebook,
      cells: [first, second, target],
      edges: [
        engine.notebooks.createEdge({
          source: first.id,
          target: target.id,
          targetInput: "source",
        }),
        engine.notebooks.createEdge({
          source: second.id,
          target: target.id,
          targetInput: "source",
        }),
      ],
    });
    expect(duplicateInput).toMatchObject({
      ok: false,
      error: {
        message: `Duplicate target input: ${target.id} source`,
      },
    });
    engine.close();
  });

  it("round-trips notebook workflow state through normalized tables", async () => {
    const { root, engine } = await setup();
    const notebook = value(await engine.notebooks.create("Workflow state"));
    const cell = engine.notebooks.createCell({
      type: "analyze",
      slot: { row: 0, column: 0 },
    });
    value(
      await engine.notebooks.write({
        ...notebook,
        description: "Catalog-owned workflow",
        lifecycleState: "running",
        workflowVersion: 3,
        analysisRevision: "rev-analysis",
        fixture: { version: 1, owner: "integration" },
        execution: {
          [cell.id]: {
            fingerprint: "fingerprint-1",
            status: "completed",
            runId: "run-1",
            stale: true,
            fixtureBaseline: true,
          },
        },
        generationPlans: [
          {
            planId: "generation-plan-1",
            cellId: cell.id,
            status: "approved",
            plan: { provider: "kie" },
            createdAt: "2026-07-29T00:00:00.000Z",
            updatedAt: "2026-07-29T00:01:00.000Z",
          },
        ],
        notebookRunPlans: [
          {
            planId: "run-plan-1",
            status: "approved",
            plan: { order: [cell.id] },
            paidCellIds: [cell.id],
            cellDefinitionFingerprints: { [cell.id]: "fingerprint-1" },
            knownCostUsd: 1.25,
            unknownCostCount: 0,
            createdAt: "2026-07-29T00:00:00.000Z",
            updatedAt: "2026-07-29T00:01:00.000Z",
          },
        ],
        cells: [cell],
        edges: [],
      }),
    );

    const reloaded = value(engine.notebooks.read(notebook.id));
    expect(reloaded).toMatchObject({
      description: "Catalog-owned workflow",
      lifecycleState: "running",
      workflowVersion: 3,
      analysisRevision: "rev-analysis",
      fixture: { version: 1, owner: "integration" },
      execution: {
        [cell.id]: {
          fingerprint: "fingerprint-1",
          stale: true,
          fixtureBaseline: true,
        },
      },
      generationPlans: [{ planId: "generation-plan-1", cellId: cell.id }],
      notebookRunPlans: [{ planId: "run-plan-1", knownCostUsd: 1.25 }],
    });

    value(
      await engine.notebooks.write({
        ...reloaded,
        description: undefined,
        lifecycleState: undefined,
        workflowVersion: undefined,
        analysisRevision: undefined,
        fixture: undefined,
        execution: {},
        generationPlans: [],
        notebookRunPlans: [],
      }),
    );
    const cleared = value(engine.notebooks.read(notebook.id));
    expect(cleared).not.toHaveProperty("description");
    expect(cleared).not.toHaveProperty("analysisRevision");
    expect(cleared.execution).toEqual({});
    expect(cleared.generationPlans).toEqual([]);
    expect(cleared.notebookRunPlans).toEqual([]);
    engine.close();

    const database = new DatabaseSync(path.join(root, "data", "videobook.db"));
    for (const table of [
      "notebook_fields",
      "notebook_cell_executions",
      "notebook_generation_plans",
      "notebook_run_plans",
    ]) {
      expect(
        database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get(),
      ).toEqual({ count: 0 });
    }
    database.close();
  });

  it.each([11, 12, 18, 19, 20])(
    "rejects schema-v%s catalogs without migration",
    async (version) => {
      const { root, engine } = await setup();
      engine.close();
      const database = new DatabaseSync(
        path.join(root, "data", "videobook.db"),
      );
      database
        .prepare("UPDATE engine_schema SET version=? WHERE singleton=1")
        .run(version);
      database.close();

      expect(() => createEngine({ rootDir: root })).toThrow(
        `Database schema ${version} is not supported by engine schema 21`,
      );
    },
  );

  it("rejects duplicate, fractional, and out-of-bounds slots", async () => {
    const { engine } = await setup();
    const notebook = value(await engine.notebooks.create("Validation"));
    const first = engine.notebooks.createCell({
      type: "prompt",
      slot: { row: 0, column: 0 },
    });
    const duplicate = engine.notebooks.createCell({
      type: "image",
      slot: { row: 0, column: 0 },
    });
    const duplicated = await engine.notebooks.write({
      ...notebook,
      cells: [first, duplicate],
      edges: [],
    });
    expect(duplicated.ok).toBe(false);
    if (!duplicated.ok) {
      expect(duplicated.error.message).toContain("Duplicate cell slot");
    }

    const fractional = await engine.notebooks.write({
      ...notebook,
      cells: [{ ...first, slot: { row: 0.5, column: 0 } }],
      edges: [],
    });
    expect(fractional.ok).toBe(false);

    const negativeRow = await engine.notebooks.write({
      ...notebook,
      cells: [{ ...first, slot: { row: -1, column: 0 } }],
      edges: [],
    });
    expect(negativeRow.ok).toBe(false);

    const fractionalColumn = await engine.notebooks.write({
      ...notebook,
      cells: [{ ...first, slot: { row: 0, column: -1.5 } }],
      edges: [],
    });
    expect(fractionalColumn.ok).toBe(false);

    const left = await engine.notebooks.write({
      ...notebook,
      cells: [{ ...first, slot: { row: 0, column: -1 } }],
      edges: [],
    });
    expect(left.ok).toBe(false);

    const wide = await engine.notebooks.write({
      ...notebook,
      cells: [{ ...first, slot: { row: 0, column: 13 } }],
      edges: [],
    });
    expect(wide.ok).toBe(false);

    const low = await engine.notebooks.write({
      ...notebook,
      cells: [{ ...first, slot: { row: 26, column: 0 } }],
      edges: [],
    });
    expect(low.ok).toBe(false);

    const removedType = {
      ...first,
      type: "split",
      slot: { row: 0, column: 1 },
    } as unknown as NotebookCell;
    const removed = await engine.notebooks.write({
      ...notebook,
      cells: [removedType],
      edges: [],
    });
    expect(removed).toMatchObject({
      ok: false,
      error: { message: "Invalid cell type: split" },
    });
    engine.close();
  });

  it("persists occupied-slot swaps atomically", async () => {
    const { engine } = await setup();
    const notebook = value(await engine.notebooks.create("Swap"));
    const first = engine.notebooks.createCell({
      type: "prompt",
      slot: { row: 0, column: 0 },
    });
    const second = engine.notebooks.createCell({
      type: "image",
      slot: { row: 0, column: 1 },
    });
    value(
      await engine.notebooks.write({
        ...notebook,
        cells: [first, second],
        edges: [],
      }),
    );
    const current = value(engine.notebooks.read(notebook.id));
    value(
      await engine.notebooks.write({
        ...current,
        cells: current.cells.map((cell) => ({
          ...cell,
          slot:
            cell.id === first.id
              ? { row: 0, column: 1 }
              : { row: 0, column: 0 },
        })),
      }),
    );
    const swapped = value(engine.notebooks.read(notebook.id));
    expect(swapped.cells.find((cell) => cell.id === first.id)?.slot).toEqual({
      row: 0,
      column: 1,
    });
    expect(swapped.cells.find((cell) => cell.id === second.id)?.slot).toEqual({
      row: 0,
      column: 0,
    });
    engine.close();
  });

  it("persists downward moves beyond the temporary evacuation band atomically", async () => {
    const { engine } = await setup();
    const notebook = value(await engine.notebooks.create("Downward move"));
    const first = engine.notebooks.createCell({
      type: "prompt",
      slot: { row: 0, column: 0 },
    });
    const second = engine.notebooks.createCell({
      type: "image",
      slot: { row: 1, column: 0 },
    });
    value(
      await engine.notebooks.write({
        ...notebook,
        cells: [first, second],
        edges: [],
      }),
    );

    const moved = value(engine.notebooks.read(notebook.id));
    value(
      await engine.notebooks.write({
        ...moved,
        cells: moved.cells.map((cell) => ({
          ...cell,
          slot: {
            row: cell.id === first.id ? 3 : 4,
            column: 0,
          },
        })),
      }),
    );
    expect(value(engine.notebooks.read(notebook.id)).cells).toMatchObject([
      { id: first.id, slot: { row: 3, column: 0 } },
      { id: second.id, slot: { row: 4, column: 0 } },
    ]);

    const duplicate = await engine.notebooks.write({
      ...value(engine.notebooks.read(notebook.id)),
      cells: [
        { ...first, slot: { row: 5, column: 0 } },
        { ...second, slot: { row: 5, column: 0 } },
      ],
    });
    expect(duplicate).toMatchObject({
      ok: false,
      error: { message: "Duplicate cell slot: 5:0" },
    });
    expect(value(engine.notebooks.read(notebook.id)).cells).toMatchObject([
      { id: first.id, slot: { row: 3, column: 0 } },
      { id: second.id, slot: { row: 4, column: 0 } },
    ]);
    engine.close();
  });

  it("rejects unsupported engine schemas", async () => {
    const { root, engine } = await setup();
    engine.close();
    const database = new DatabaseSync(path.join(root, "data", "videobook.db"));
    database
      .prepare("UPDATE engine_schema SET version=10 WHERE singleton=1")
      .run();
    database.close();

    expect(() => createEngine({ rootDir: root })).toThrow(
      "Database schema 10 is not supported by engine schema 21",
    );
  });
});
