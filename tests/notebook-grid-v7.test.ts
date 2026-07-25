import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";

import { DatabaseSync } from "@dolthub/doltlite";
import { afterEach, describe, expect, it } from "vitest";

import {
  CELLS_TABLE_COLUMNS,
  NOTEBOOK_CELL_TYPES,
  SCHEMA_VERSION,
  createEngine,
  extendNotebookGrid,
} from "../src/index.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) =>
      rm(root, { recursive: true, force: true, maxRetries: 3 })
    ),
  );
});

function value<T>(
  result:
    | { ok: true; value: T }
    | { ok: false; error: { message: string } },
): T {
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

async function setup() {
  const root = await mkdtemp(path.join(tmpdir(), "videobook-grid-v7-"));
  roots.push(root);
  const engine = createEngine({
    rootDir: root,
    initialBookSlug: "grid-v7",
  });
  await engine.ready;
  return { root, engine };
}

describe("notebook grid schema v7", () => {
  it("exports logical slot columns and schema version 7", () => {
    expect(NOTEBOOK_CELL_TYPES).toHaveLength(17);
    expect(CELLS_TABLE_COLUMNS).toEqual([
      "notebook_id",
      "cell_id",
      "type",
      "title",
      "grid_row",
      "grid_column",
      "entity_id",
      "prompt",
      "provider",
      "model",
      "operation",
      "tool",
      "inputs_json",
      "output_artifact_id",
    ]);
    expect(SCHEMA_VERSION).toBe(7);
  });

  it("round-trips all cell types, named columns, and unique slots", async () => {
    const { root, engine } = await setup();
    const notebook = value(await engine.notebooks.create("Workflow"));
    const grid = {
      columns: [
        { id: "import", label: "Import + Analyze" },
        { id: "extract", label: "Split + Extract" },
        { id: "animate", label: "Prompt + Animate" },
        { id: "export", label: "Assemble + Export" },
      ],
    };
    const cells = NOTEBOOK_CELL_TYPES.map((type, index) =>
      engine.notebooks.createCell({
        type,
        title: `${type} cell`,
        slot: { row: Math.floor(index / 4), column: index % 4 },
        prompt: type === "analysis" ? "Analyze scenes" : undefined,
        provider: type === "analysis" ? "kie" : undefined,
        model: type === "analysis" ? "gemini-3.5-flash" : undefined,
        operation: type === "analysis" ? "analyze_source" : undefined,
        tool: type === "analysis" ? "kie_gemini_analysis" : undefined,
        inputs: { ordinal: index },
      })
    );
    value(await engine.notebooks.write({
      ...notebook,
      grid,
      cells,
      edges: [],
    }));
    const reloaded = value(engine.notebooks.read(notebook.id));
    expect(reloaded.grid).toEqual(grid);
    expect(reloaded.cells.map((cell) => cell.type).sort()).toEqual(
      [...NOTEBOOK_CELL_TYPES].sort(),
    );
    expect(reloaded.cells.find((cell) => cell.type === "analysis")).toMatchObject({
      slot: { row: 3, column: 1 },
      provider: "kie",
      model: "gemini-3.5-flash",
      operation: "analyze_source",
      tool: "kie_gemini_analysis",
      prompt: "Analyze scenes",
    });

    engine.close();
    const database = new DatabaseSync(
      path.join(root, "data", "videobook.db"),
      { readOnly: true },
    );
    const raw = database
      .prepare(
        `SELECT ${CELLS_TABLE_COLUMNS.join(", ")}
         FROM cells WHERE notebook_id=? AND type='analysis'`,
      )
      .get(notebook.id) as Record<string, unknown>;
    expect(Object.keys(raw)).toHaveLength(14);
    expect(raw.grid_row).toBe(3);
    expect(raw.grid_column).toBe(1);
    expect(raw.provider).toBe("kie");
    database.close();
  });

  it("rejects invalid grids, out-of-range slots, and duplicate occupancy", async () => {
    const { engine } = await setup();
    const notebook = value(await engine.notebooks.create("Validation"));
    const first = engine.notebooks.createCell({
      type: "prompt",
      title: "First",
      slot: { row: 0, column: 0 },
    });
    const duplicate = engine.notebooks.createCell({
      type: "video",
      title: "Duplicate",
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

    const outside = await engine.notebooks.write({
      ...notebook,
      cells: [{
        ...first,
        slot: { row: 0, column: notebook.grid.columns.length },
      }],
      edges: [],
    });
    expect(outside.ok).toBe(false);
    if (!outside.ok) {
      expect(outside.error.message).toContain("outside the notebook grid");
    }

    const fractional = await engine.notebooks.write({
      ...notebook,
      cells: [{ ...first, slot: { row: 0.5, column: 0 } }],
      edges: [],
    });
    expect(fractional.ok).toBe(false);
    engine.close();
  });

  it("persists occupied-slot swaps atomically", async () => {
    const { engine } = await setup();
    const notebook = value(await engine.notebooks.create("Swap"));
    const first = engine.notebooks.createCell({
      type: "prompt",
      title: "First",
      slot: { row: 0, column: 0 },
    });
    const second = engine.notebooks.createCell({
      type: "video",
      title: "Second",
      slot: { row: 0, column: 1 },
    });
    value(await engine.notebooks.write({
      ...notebook,
      cells: [first, second],
      edges: [],
    }));
    const current = value(engine.notebooks.read(notebook.id));
    value(await engine.notebooks.write({
      ...current,
      cells: current.cells.map((cell) => ({
        ...cell,
        slot: cell.id === first.id
          ? { row: 0, column: 1 }
          : { row: 0, column: 0 },
      })),
    }));
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

  it("extends named grids with deterministic unnamed columns", async () => {
    const { engine } = await setup();
    const notebook = value(await engine.notebooks.create("Expansion"));
    const original = {
      columns: [
        { id: "import", label: "Import + Analyze" },
        { id: "column-3", label: "Reserved name" },
      ],
    };
    const grid = extendNotebookGrid(original, 6);
    expect(original.columns).toHaveLength(2);
    expect(grid).toEqual({
      columns: [
        { id: "import", label: "Import + Analyze" },
        { id: "column-3", label: "Reserved name" },
        { id: "column-3-2" },
        { id: "column-4" },
        { id: "column-5" },
        { id: "column-6" },
      ],
    });
    const cell = engine.notebooks.createCell({
      type: "prompt",
      title: "Wide cell",
      slot: { row: 12, column: 5 },
    });
    value(await engine.notebooks.write({
      ...notebook,
      grid,
      cells: [cell],
      edges: [],
    }));
    expect(value(engine.notebooks.read(notebook.id))).toMatchObject({
      grid,
      cells: [{ slot: { row: 12, column: 5 } }],
    });
    engine.close();
  });

  it("rejects pre-v7 engine roots", async () => {
    const { root, engine } = await setup();
    engine.close();
    const database = new DatabaseSync(path.join(root, "data", "videobook.db"));
    database
      .prepare("UPDATE engine_schema SET version=6 WHERE singleton=1")
      .run();
    database.close();

    expect(() => createEngine({ rootDir: root })).toThrow(
      "Database schema 6 is not supported by engine schema 7",
    );
  });
});
