import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";

import { DatabaseSync } from "@dolthub/doltlite";
import { afterEach, describe, expect, it } from "vitest";

import { SCHEMA_VERSION } from "../src/catalog-metadata.js";
import { createEngine } from "../src/index.js";
import {
  applyV22NotebookGridMigration,
  parseV22GridAddress,
  relocateV22Slots,
  rewriteV22Mentions,
} from "../src/migrate-grid-v22.js";
import { notebookGridAddress, notebookGridTag } from "../src/notebook-grid.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) =>
      rm(root, { recursive: true, force: true, maxRetries: 3 }),
    ),
  );
});

function value<T>(
  result: { ok: true; value: T } | { ok: false; error: { message: string } },
): T {
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

describe("schema 22 notebook grid migration", () => {
  it("parses v22 letter-row addresses and re-encodes them on the 8-wide grid", () => {
    expect(parseV22GridAddress("@a2")).toEqual({ row: 0, column: 1 });
    expect(parseV22GridAddress("b1")).toEqual({ row: 1, column: 0 });
    expect(parseV22GridAddress("@z13")).toEqual({ row: 25, column: 12 });
    expect(notebookGridTag({ row: 0, column: 1 })).toBe("@a2");
    expect(notebookGridTag({ row: 1, column: 0 })).toBe("@b1");
  });

  it("keeps in-bounds slots and reflows columns 8-12 onto free 8-wide squares", () => {
    const map = relocateV22Slots([
      { row: 0, column: 0 },
      { row: 0, column: 7 },
      { row: 0, column: 8 },
      { row: 0, column: 12 },
      { row: 2, column: 9 },
    ]);
    expect(map.get("0:0")).toEqual({ row: 0, column: 0 });
    expect(map.get("0:7")).toEqual({ row: 0, column: 7 });
    expect(map.get("0:8")).toEqual({ row: 0, column: 1 });
    expect(map.get("0:12")).toEqual({ row: 0, column: 2 });
    expect(map.get("2:9")).toEqual({ row: 2, column: 0 });
  });

  it("rewrites relocated mentions and leaves in-bounds addresses in place", () => {
    const map = relocateV22Slots([
      { row: 0, column: 0 },
      { row: 0, column: 1 },
      { row: 0, column: 8 },
    ]);
    expect(rewriteV22Mentions("use @a2 and @b1 plus @a9", map))
      .toBe("use @a2 and @b1 plus @a3");
    expect(rewriteV22Mentions("empty @a4 stays at {0,3}", map))
      .toBe("empty @a4 stays at {0,3}");
    expect(rewriteV22Mentions("beyond @a13 and @z13", map))
      .toBe("beyond @a13 and @z13");
  });

  it("rebuilds cells, relocates overflow, and rewrites prompts", () => {
    const db = new DatabaseSync(":memory:");
    db.exec(`
      CREATE TABLE notebooks (notebook_id TEXT PRIMARY KEY);
      CREATE TABLE entities (entity_id TEXT PRIMARY KEY);
      CREATE TABLE artifacts (artifact_id TEXT PRIMARY KEY);
      CREATE TABLE engine_schema (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        version INTEGER NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE cells (
        notebook_id TEXT NOT NULL REFERENCES notebooks(notebook_id),
        cell_id TEXT NOT NULL,
        type TEXT NOT NULL,
        label TEXT,
        grid_row INTEGER NOT NULL CHECK (grid_row BETWEEN 0 AND 25),
        grid_column INTEGER NOT NULL CHECK (grid_column BETWEEN 0 AND 12),
        output_entity_id TEXT,
        prompt TEXT,
        provider TEXT,
        model TEXT,
        operation TEXT,
        tool TEXT,
        inputs_json TEXT NOT NULL DEFAULT '{}',
        output_artifact_id TEXT,
        PRIMARY KEY(notebook_id, cell_id)
      );
    `);
    db.prepare("INSERT INTO notebooks(notebook_id) VALUES ('nb')").run();
    db.prepare(
      "INSERT INTO engine_schema(singleton, version, created_at) VALUES (1, 22, 1)",
    ).run();
    const insert = db.prepare(
      `INSERT INTO cells(
         notebook_id, cell_id, type, label, grid_row, grid_column, prompt, inputs_json
       ) VALUES ('nb', ?, 'image', ?, ?, ?, ?, '{}')`,
    );
    insert.run("origin", "origin", 0, 0, "start");
    insert.run("right", "right", 0, 1, "use @a1");
    insert.run("overflow", "overflow", 0, 12, "from @a13 and empty @a4");
    const result = applyV22NotebookGridMigration(db);
    expect(result.relocated).toBe(1);
    expect(result.rewritten).toBe(1);
    expect(
      db.prepare("SELECT version FROM engine_schema").get(),
    ).toEqual({ version: SCHEMA_VERSION });
    const rows = db
      .prepare(
        "SELECT cell_id, grid_row, grid_column, prompt FROM cells ORDER BY cell_id",
      )
      .all() as Array<{
        cell_id: string;
        grid_row: number;
        grid_column: number;
        prompt: string;
      }>;
    expect(rows).toEqual([
      { cell_id: "origin", grid_row: 0, grid_column: 0, prompt: "start" },
      { cell_id: "overflow", grid_row: 0, grid_column: 2, prompt: "from @a3 and empty @a4" },
      { cell_id: "right", grid_row: 0, grid_column: 1, prompt: "use @a1" },
    ]);
    const sql = (
      db.prepare("SELECT sql FROM sqlite_master WHERE name='cells'").get() as {
        sql: string;
      }
    ).sql;
    expect(sql).toContain("BETWEEN 0 AND 63");
    expect(sql).toContain("BETWEEN 0 AND 7");
    db.close();
  });

  it("upgrades a schema-22 catalog when the engine reopens it", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "videobook-grid-v22-"));
    roots.push(root);
    const engine = createEngine({
      rootDir: root,
      initialBookName: "grid-v22",
    });
    await engine.ready;
    const notebook = value(await engine.notebooks.create("Grid"));
    const origin = engine.notebooks.createCell({
      type: "prompt",
      slot: { row: 0, column: 0 },
      prompt: "origin",
    });
    const neighbor = engine.notebooks.createCell({
      type: "image",
      slot: { row: 0, column: 1 },
      prompt: "see @a2",
    });
    const edge = engine.notebooks.createEdge({
      source: origin.id,
      target: neighbor.id,
      targetInput: "media",
    });
    value(
      await engine.notebooks.write({
        ...notebook,
        cells: [origin, neighbor],
        edges: [edge],
      }),
    );
    engine.close();

    const db = new DatabaseSync(path.join(root, "data", "videobook.db"));
    db.exec("PRAGMA foreign_keys=OFF");
    db.exec("DROP TABLE cells");
    db.exec(`
      CREATE TABLE cells (
        notebook_id TEXT NOT NULL,
        cell_id TEXT NOT NULL,
        type TEXT NOT NULL,
        label TEXT,
        grid_row INTEGER NOT NULL CHECK (grid_row BETWEEN 0 AND 25),
        grid_column INTEGER NOT NULL CHECK (grid_column BETWEEN 0 AND 12),
        output_entity_id TEXT,
        prompt TEXT,
        provider TEXT,
        model TEXT,
        operation TEXT,
        tool TEXT,
        inputs_json TEXT NOT NULL DEFAULT '{}',
        output_artifact_id TEXT,
        PRIMARY KEY(notebook_id, cell_id)
      )
    `);
    const insert = db.prepare(
      `INSERT INTO cells(
         notebook_id, cell_id, type, grid_row, grid_column, prompt, inputs_json
       ) VALUES (?, ?, 'image', ?, ?, ?, '{}')`,
    );
    insert.run(notebook.id, origin.id, 0, 0, "origin");
    insert.run(notebook.id, neighbor.id, 0, 1, "see @a2");
    insert.run(notebook.id, "overflow", 0, 12, "edge @a13");
    db.exec(`
      CREATE INDEX IF NOT EXISTS cells_grid
        ON cells(notebook_id, grid_row, grid_column, cell_id)
    `);
    db.exec("PRAGMA foreign_keys=ON");
    db.prepare("UPDATE engine_schema SET version=22 WHERE singleton=1").run();
    db.prepare("SELECT dolt_add('cells') AS result").get();
    db.prepare("SELECT dolt_add('engine_schema') AS result").get();
    db.prepare(
      "SELECT dolt_commit('-m', 'downgrade fixture to schema 22', '--author', 'Videobook <videobook@localhost>') AS hash",
    ).get();
    db.close();

    const upgraded = createEngine({ rootDir: root });
    await upgraded.ready;
    const document = upgraded.notebooks.read(notebook.id);
    if (!document.ok) throw new Error(document.error.message);
    const byId = new Map(document.value.cells.map((cell) => [cell.id, cell]));
    expect(byId.get(neighbor.id)?.prompt).toBe("see @a2");
    expect(byId.get(neighbor.id)?.slot).toEqual({ row: 0, column: 1 });
    expect(byId.get("overflow")?.slot).toEqual({ row: 0, column: 2 });
    expect(byId.get("overflow")?.prompt).toBe("edge @a3");
    expect(document.value.edges).toEqual([edge]);
    expect(notebookGridAddress({ row: 0, column: 1 })).toBe("a2");
    upgraded.close();
  });
});
