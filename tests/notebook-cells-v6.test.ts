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

async function createV5Fixture(): Promise<{
  root: string;
  notebookId: string;
  cellId: string;
  prompt: string;
  model: string;
}> {
  const root = await mkdtemp(path.join(tmpdir(), "videobook-v5-cells-"));
  roots.push(root);
  const prompt = "Legacy moon garden prompt";
  const model = "generate_kie_gpt_image_2_text_to_image";
  const engine = createEngine({
    rootDir: root,
    initialBookSlug: "v5-cells",
  });
  await engine.ready;
  const notebook = value(await engine.notebooks.create("Main"));
  const cell = engine.notebooks.createCell({
    type: "image",
    title: "Moon garden",
    position: { x: 40, y: 80 },
    prompt,
    model,
    provider: "kie",
    operation: "text_to_image",
    tool: model,
    inputs: {
      provider: "kie",
      operation: "text_to_image",
      seed: 42,
    },
  });
  value(await engine.notebooks.write({
    ...notebook,
    cells: [cell],
    edges: [],
  }));
  engine.close();

  const database = new DatabaseSync(path.join(root, "data", "videobook.db"));
  database.exec("PRAGMA foreign_keys=OFF");
  database.exec(`
    CREATE TABLE cells_v5 (
      notebook_id TEXT NOT NULL
        REFERENCES notebooks(notebook_id) ON DELETE CASCADE,
      cell_id TEXT NOT NULL,
      type TEXT NOT NULL,
      title TEXT NOT NULL,
      position_x REAL NOT NULL,
      position_y REAL NOT NULL,
      entity_id TEXT,
      prompt TEXT,
      model TEXT,
      inputs_json TEXT NOT NULL DEFAULT '{}',
      output_artifact_id TEXT,
      PRIMARY KEY(notebook_id, cell_id)
    );
  `);
  database.exec(`
    INSERT INTO cells_v5(
      notebook_id, cell_id, type, title, position_x, position_y,
      entity_id, prompt, model, inputs_json, output_artifact_id
    )
    SELECT notebook_id, cell_id, type, title, position_x, position_y,
           entity_id, prompt, model, inputs_json, output_artifact_id
    FROM cells
  `);
  database.exec("DROP TABLE cells");
  database.exec("ALTER TABLE cells_v5 RENAME TO cells");
  database
    .prepare("UPDATE engine_schema SET version=5 WHERE singleton=1")
    .run();
  database.prepare("SELECT dolt_add('.') AS result").get();
  database
    .prepare("SELECT dolt_commit('-m', 'Downgrade cells to schema v5 fixture') AS hash")
    .get();
  database.close();
  return {
    root,
    notebookId: notebook.id,
    cellId: cell.id,
    prompt,
    model,
  };
}

describe("notebook cells schema v6", () => {
  it("exports 17 cell types and 14 physical columns", () => {
    expect(NOTEBOOK_CELL_TYPES).toHaveLength(17);
    expect(CELLS_TABLE_COLUMNS).toEqual([
      "notebook_id",
      "cell_id",
      "type",
      "title",
      "position_x",
      "position_y",
      "entity_id",
      "prompt",
      "provider",
      "model",
      "operation",
      "tool",
      "inputs_json",
      "output_artifact_id",
    ]);
    expect(SCHEMA_VERSION).toBe(6);
  });

  it("migrates a real v5 fixture without data loss and lifts legacy fields", async () => {
    const fixture = await createV5Fixture();
    const engine = createEngine({ rootDir: fixture.root });
    await engine.ready;
    const notebook = value(engine.notebooks.read(fixture.notebookId));
    expect(notebook.cells).toHaveLength(1);
    const cell = notebook.cells[0]!;
    expect(cell).toMatchObject({
      id: fixture.cellId,
      type: "image",
      title: "Moon garden",
      prompt: fixture.prompt,
      model: fixture.model,
      provider: "kie",
      operation: "text_to_image",
      tool: fixture.model,
      inputs: {
        provider: "kie",
        operation: "text_to_image",
        seed: 42,
      },
    });
    engine.close();
    const database = new DatabaseSync(
      path.join(fixture.root, "data", "videobook.db"),
      { readOnly: true },
    );
    const columns = database
      .prepare("PRAGMA table_info(cells)")
      .all() as unknown as Array<{ name: string }>;
    expect(columns.map((column) => column.name)).toEqual([...CELLS_TABLE_COLUMNS]);
    const schema = database
      .prepare("SELECT version FROM engine_schema WHERE singleton=1")
      .get() as unknown as { version: number };
    expect(schema.version).toBe(6);
    database.close();
  });

  it("round-trips all 17 cell types and rejects invalid types", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "videobook-v6-types-"));
    roots.push(root);
    const engine = createEngine({
      rootDir: root,
      initialBookSlug: "type-roundtrip",
    });
    await engine.ready;
    const notebook = value(await engine.notebooks.create("Workflow"));
    const cells = NOTEBOOK_CELL_TYPES.map((type, index) =>
      engine.notebooks.createCell({
        type,
        title: `${type} cell`,
        position: { x: index * 10, y: index * 20 },
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
    expect(reloaded.cells.map((cell) => cell.type).sort()).toEqual(
      [...NOTEBOOK_CELL_TYPES].sort(),
    );
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
    expect(raw.provider).toBe("kie");
    expect(raw.operation).toBe("analyze_source");
    expect(raw.tool).toBe("kie_gemini_analysis");
    database.close();

    const engine2 = createEngine({ rootDir: root });
    await engine2.ready;
    const current = value(engine2.notebooks.read(notebook.id));
    const rejected = await engine2.notebooks.write({
      ...current,
      cells: [
        engine2.notebooks.createCell({
          type: "not-a-type" as (typeof NOTEBOOK_CELL_TYPES)[number],
          title: "bad",
          position: { x: 0, y: 0 },
        }),
      ],
    });
    expect(rejected.ok).toBe(false);
    if (!rejected.ok) {
      expect(rejected.error.message).toContain("Invalid cell type");
    }
    engine2.close();
  });
});

