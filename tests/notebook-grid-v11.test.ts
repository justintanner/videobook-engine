import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";

import { DatabaseSync } from "@dolthub/doltlite";
import { v7 as uuidv7 } from "uuid";
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
  const root = await mkdtemp(path.join(tmpdir(), "videobook-grid-v11-"));
  roots.push(root);
  const engine = createEngine({
    rootDir: root,
    initialBookSlug: "grid-v11",
  });
  await engine.ready;
  return { root, engine };
}

describe("centered notebook grid schema v11", () => {
  it("exports signed cell slots and the thirteen explicit cell types", () => {
    expect(NOTEBOOK_CELL_TYPES).toEqual([
      "audio",
      "image",
      "video",
      "extract_audio",
      "split_video",
      "prompt",
      "character",
      "analyze",
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
    expect(SCHEMA_VERSION).toBe(11);
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
        prompt: type === "analyze" ? "Analyze scenes" : undefined,
        provider: type === "analyze" ? "kie" : undefined,
        model: type === "analyze" ? "gemini-3.5-flash" : undefined,
        operation: type === "analyze" ? "analyze_source" : undefined,
        tool: type === "analyze" ? "kie_gemini_analysis" : undefined,
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
    expect(reloaded.cells.find((cell) => cell.type === "audio")).toMatchObject({
      title: "audio cell",
      slot: { row: 0, column: 0 },
    });
    expect(reloaded.cells.find((cell) => cell.type === "analyze")?.slot).toEqual({
      row: 49,
      column: -77,
    });
    expect(reloaded.cells.find((cell) => cell.type === "analyze")).toMatchObject({
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
         FROM cells WHERE notebook_id=? AND type='analyze'`,
      )
      .get(notebook.id) as Record<string, unknown>;
    expect(Object.keys(raw)).toHaveLength(14);
    expect(raw.grid_row).toBeGreaterThan(0);
    expect(raw.grid_column).toBe(-77);
    expect(raw.provider).toBe("kie");
    database.close();
  });

  it("enforces the explicit cell types in the semantic table", async () => {
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
        ) VALUES (?, 'removed-split', 'split', 'Removed', 0, 0, '{}')`,
      ).run(notebook.id)
    ).toThrow();
    database.close();
  });

  it("resets schema-v10 notebook graphs while preserving shells and media", async () => {
    const { root, engine } = await setup();
    const notebook = value(await engine.notebooks.create("Legacy workflow"));
    const artifact = value(await engine.artifacts.create({
      kind: "video",
      slug: "vid-original",
    }));
    const video = engine.notebooks.createCell({
      type: "video",
      title: "Original",
      slot: { row: 0, column: 0 },
      outputArtifactId: artifact.artifactId,
    });
    const analyze = engine.notebooks.createCell({
      type: "analyze",
      title: "Analysis",
      slot: { row: 1, column: 0 },
    });
    value(await engine.notebooks.write({
      ...notebook,
      properties: {
        generationPlan: { cells: [analyze.id] },
        execution: { [analyze.id]: { status: "running" } },
      },
      cells: [video, analyze],
      edges: [{
        id: uuidv7(),
        source: video.id,
        target: analyze.id,
        targetInput: "source",
      }],
    }));
    engine.close();
    const database = new DatabaseSync(
      path.join(root, "data", "videobook.db"),
    );
    database.prepare(
      `INSERT INTO runs(
        run_id, notebook_id, status, started_at, completed_at,
        cell_order_json, outputs_json
      ) VALUES (?, ?, 'completed', 1, 2, '[]', '{}')`,
    ).run(uuidv7(), notebook.id);
    database.prepare(
      `INSERT INTO runtime_jobs(
        operation_id, type, state, payload_json, enqueued_at
      ) VALUES (?, 'run_notebook', 'queued', ?, 1)`,
    ).run(uuidv7(), JSON.stringify({ notebookId: notebook.id }));
    database
      .prepare("UPDATE engine_schema SET version=10 WHERE singleton=1")
      .run();
    database.close();

    const reopened = createEngine({ rootDir: root });
    await reopened.ready;
    const migrated = value(reopened.notebooks.read(notebook.id));
    expect(migrated).toMatchObject({
      id: notebook.id,
      name: "Legacy workflow",
      properties: {},
      cells: [],
      edges: [],
    });
    expect(value(reopened.artifacts.get(artifact.artifactId))).toMatchObject({
      artifactId: artifact.artifactId,
      slug: "vid-original",
    });
    reopened.close();

    const persisted = new DatabaseSync(
      path.join(root, "data", "videobook.db"),
      { readOnly: true },
    );
    expect(
      (persisted.prepare(
        "SELECT version FROM engine_schema WHERE singleton=1",
      ).get() as { version: number }).version,
    ).toBe(11);
    for (const table of [
      "cells",
      "edges",
      "runs",
      "cell_references",
      "pinned_search_results",
    ]) {
      expect(
        (persisted.prepare(`SELECT COUNT(*) AS count FROM ${table}`)
          .get() as { count: number }).count,
      ).toBe(0);
    }
    expect(
      (persisted.prepare(
        "SELECT state FROM runtime_jobs WHERE type='run_notebook'",
      ).get() as { state: string }).state,
    ).toBe("aborted");
    persisted.close();
  });

  it("rejects duplicate, negative-row, and fractional slots without horizontal edges", async () => {
    const { engine } = await setup();
    const notebook = value(await engine.notebooks.create("Validation"));
    const first = engine.notebooks.createCell({
      type: "prompt",
      title: "First",
      slot: { row: 0, column: 0 },
    });
    const duplicate = engine.notebooks.createCell({
      type: "image",
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
      title: "First",
      slot: { row: 0, column: 0 },
    });
    const second = engine.notebooks.createCell({
      type: "image",
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

  it("rejects pre-v10 engine roots", async () => {
    const { root, engine } = await setup();
    engine.close();
    const database = new DatabaseSync(path.join(root, "data", "videobook.db"));
    database
      .prepare("UPDATE engine_schema SET version=9 WHERE singleton=1")
      .run();
    database.close();

    expect(() => createEngine({ rootDir: root })).toThrow(
      "Database schema 9 is not supported by engine schema 11",
    );
  });
});
