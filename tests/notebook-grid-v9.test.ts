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
  type NotebookCell,
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
  const root = await mkdtemp(path.join(tmpdir(), "videobook-grid-v9-"));
  roots.push(root);
  const engine = createEngine({
    rootDir: root,
    initialBookSlug: "grid-v9",
  });
  await engine.ready;
  return { root, engine };
}

describe("centered notebook grid schema v9", () => {
  it("exports signed cell slots and the five primitive cell types", () => {
    expect(NOTEBOOK_CELL_TYPES).toEqual([
      "source",
      "note",
      "selects",
      "scene",
      "asset",
    ]);
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
    expect(SCHEMA_VERSION).toBe(9);
  });

  it("round-trips every cell type at arbitrary signed columns", async () => {
    const { root, engine } = await setup();
    const notebook = value(await engine.notebooks.create("Workflow"));
    const cells = NOTEBOOK_CELL_TYPES.map((type, index) =>
      engine.notebooks.createCell({
        type,
        title: `${type} cell`,
        slot: {
          row: index === 0 ? 0 : index * 7,
          column: index === 0 ? 0 : index % 2 === 0 ? index * 11 : index * -11,
        },
        prompt: type === "note" ? "Analyze scenes" : undefined,
        provider: type === "note" ? "kie" : undefined,
        model: type === "note" ? "gemini-3.5-flash" : undefined,
        operation: type === "note" ? "analyze_source" : undefined,
        tool: type === "note" ? "kie_gemini_analysis" : undefined,
        inputs: { ordinal: index },
      })
    );
    value(await engine.notebooks.write({
      ...notebook,
      cells,
      edges: [],
    }));
    const reloaded = value(engine.notebooks.read(notebook.id));
    expect("grid" in reloaded).toBe(false);
    expect(reloaded.cells.map((cell) => cell.type).sort()).toEqual(
      [...NOTEBOOK_CELL_TYPES].sort(),
    );
    expect(reloaded.cells.find((cell) => cell.type === "source")).toMatchObject({
      title: "source cell",
      slot: { row: 0, column: 0 },
    });
    expect(reloaded.cells.find((cell) => cell.type === "note")?.slot).toEqual({
      row: 7,
      column: -11,
    });
    expect(reloaded.cells.find((cell) => cell.type === "note")).toMatchObject({
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
         FROM cells WHERE notebook_id=? AND type='note'`,
      )
      .get(notebook.id) as Record<string, unknown>;
    expect(Object.keys(raw)).toHaveLength(14);
    expect(raw.grid_row).toBeGreaterThan(0);
    expect(raw.grid_column).toBeLessThan(0);
    expect(raw.provider).toBe("kie");
    database.close();
  });

  it("enforces primitive cell types in the semantic table", async () => {
    const { root, engine } = await setup();
    const notebook = value(await engine.notebooks.create("Constraint"));
    engine.close();
    const database = new DatabaseSync(
      path.join(root, "data", "videobook.db"),
    );
    expect(() =>
      database.prepare(
        `INSERT INTO cells(
          notebook_id, cell_id, type, title, grid_row, grid_column, inputs_json
        ) VALUES (?, 'legacy-video', 'video', 'Legacy', 0, 0, '{}')`,
      ).run(notebook.id)
    ).toThrow();
    database.close();
  });

  it("rejects duplicate, negative-row, and fractional slots without horizontal edges", async () => {
    const { engine } = await setup();
    const notebook = value(await engine.notebooks.create("Validation"));
    const first = engine.notebooks.createCell({
      type: "note",
      title: "First",
      slot: { row: 0, column: 0 },
    });
    const duplicate = engine.notebooks.createCell({
      type: "asset",
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
      cells: [{ ...first, slot: { row: 12_345, column: -67_890 } }],
      edges: [],
    });
    expect(left.ok).toBe(true);
    expect(value(engine.notebooks.read(notebook.id)).cells[0]?.slot).toEqual({
      row: 12_345,
      column: -67_890,
    });

    const wide = await engine.notebooks.write({
      ...notebook,
      cells: [{ ...first, slot: { row: 12_345, column: 67_890 } }],
      edges: [],
    });
    expect(wide.ok).toBe(true);
    expect(value(engine.notebooks.read(notebook.id)).cells[0]?.slot).toEqual({
      row: 12_345,
      column: 67_890,
    });

    const removedType = {
      ...first,
      type: "video",
      slot: { row: 0, column: 1 },
    } as unknown as NotebookCell;
    const removed = await engine.notebooks.write({
      ...notebook,
      cells: [removedType],
      edges: [],
    });
    expect(removed).toMatchObject({
      ok: false,
      error: { message: "Invalid cell type: video" },
    });
    engine.close();
  });

  it("persists occupied-slot swaps atomically", async () => {
    const { engine } = await setup();
    const notebook = value(await engine.notebooks.create("Swap"));
    const first = engine.notebooks.createCell({
      type: "note",
      title: "First",
      slot: { row: 0, column: 0 },
    });
    const second = engine.notebooks.createCell({
      type: "asset",
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

  it("rejects pre-v9 engine roots", async () => {
    const { root, engine } = await setup();
    engine.close();
    const database = new DatabaseSync(path.join(root, "data", "videobook.db"));
    database
      .prepare("UPDATE engine_schema SET version=8 WHERE singleton=1")
      .run();
    database.close();

    expect(() => createEngine({ rootDir: root })).toThrow(
      "Database schema 8 is not supported by engine schema 9",
    );
  });
});
