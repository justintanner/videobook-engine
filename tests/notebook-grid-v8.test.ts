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
  const root = await mkdtemp(path.join(tmpdir(), "videobook-grid-v8-"));
  roots.push(root);
  const engine = createEngine({
    rootDir: root,
    initialBookSlug: "grid-v8",
  });
  await engine.ready;
  return { root, engine };
}

describe("unbounded notebook grid schema v8", () => {
  it("exports cell slots and the label cell type", () => {
    expect(NOTEBOOK_CELL_TYPES).toHaveLength(18);
    expect(NOTEBOOK_CELL_TYPES).toContain("label");
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
    expect(SCHEMA_VERSION).toBe(8);
  });

  it("round-trips every cell type at arbitrary nonnegative slots", async () => {
    const { root, engine } = await setup();
    const notebook = value(await engine.notebooks.create("Workflow"));
    const cells = NOTEBOOK_CELL_TYPES.map((type, index) =>
      engine.notebooks.createCell({
        type,
        title: `${type} cell`,
        slot: {
          row: index === 0 ? 0 : index * 7,
          column: index === 0 ? 0 : index * 11,
        },
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
      cells,
      edges: [],
    }));
    const reloaded = value(engine.notebooks.read(notebook.id));
    expect("grid" in reloaded).toBe(false);
    expect(reloaded.cells.map((cell) => cell.type).sort()).toEqual(
      [...NOTEBOOK_CELL_TYPES].sort(),
    );
    expect(reloaded.cells.find((cell) => cell.type === "label")).toMatchObject({
      title: "label cell",
      slot: { row: 0, column: 0 },
    });
    expect(reloaded.cells.find((cell) => cell.type === "analysis")).toMatchObject({
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
    expect(raw.grid_row).toBeGreaterThan(0);
    expect(raw.grid_column).toBeGreaterThan(0);
    expect(raw.provider).toBe("kie");
    database.close();
  });

  it("rejects duplicate, negative, and fractional slots without a right edge", async () => {
    const { engine } = await setup();
    const notebook = value(await engine.notebooks.create("Validation"));
    const first = engine.notebooks.createCell({
      type: "label",
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

    const fractional = await engine.notebooks.write({
      ...notebook,
      cells: [{ ...first, slot: { row: 0.5, column: 0 } }],
      edges: [],
    });
    expect(fractional.ok).toBe(false);

    const negative = await engine.notebooks.write({
      ...notebook,
      cells: [{ ...first, slot: { row: 0, column: -1 } }],
      edges: [],
    });
    expect(negative.ok).toBe(false);

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

  it("rejects pre-v8 engine roots", async () => {
    const { root, engine } = await setup();
    engine.close();
    const database = new DatabaseSync(path.join(root, "data", "videobook.db"));
    database
      .prepare("UPDATE engine_schema SET version=7 WHERE singleton=1")
      .run();
    database.close();

    expect(() => createEngine({ rootDir: root })).toThrow(
      "Database schema 7 is not supported by engine schema 8",
    );
  });
});
