import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";

import { DatabaseSync } from "@dolthub/doltlite";
import { afterEach, describe, expect, it } from "vitest";

import { SCHEMA_VERSION } from "../src/catalog-metadata.js";
import { createEngine } from "../src/index.js";
import {
  applyV23NotebookGridMigration,
  parseV23GridAddress,
  rewriteV23Mentions,
} from "../src/migrate-grid-v23.js";
import { notebookGridTag } from "../src/notebook-grid.js";

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

describe("schema 23 notebook grid address migration", () => {
  it("parses v23 column-letter addresses onto the same slots", () => {
    expect(parseV23GridAddress("@a1")).toEqual({ row: 0, column: 0 });
    expect(parseV23GridAddress("B1")).toEqual({ row: 0, column: 1 });
    expect(parseV23GridAddress("@a2")).toEqual({ row: 1, column: 0 });
    expect(parseV23GridAddress("h64")).toEqual({ row: 63, column: 7 });
    expect(parseV23GridAddress("@i1")).toBeUndefined();
    expect(parseV23GridAddress("@a65")).toBeUndefined();
    expect(notebookGridTag({ row: 0, column: 1 })).toBe("@a2");
    expect(notebookGridTag({ row: 1, column: 0 })).toBe("@b1");
    expect(notebookGridTag({ row: 63, column: 7 })).toBe("@bl8");
  });

  it("re-encodes every mention as a lettered row and numbered column", () => {
    expect(rewriteV23Mentions("use @b1 with @A2 and @h64")).toBe(
      "use @a2 with @b1 and @bl8",
    );
    expect(rewriteV23Mentions("@a1 stays; @a27 becomes a two-letter row")).toBe(
      "@a1 stays; @aa1 becomes a two-letter row",
    );
    expect(rewriteV23Mentions("@b1-set @i1 @a65 @img-foo untouched")).toBe(
      "@b1-set @i1 @a65 @img-foo untouched",
    );
    expect(rewriteV23Mentions('{"prompt":"blend @c3 into @d12"}')).toBe(
      '{"prompt":"blend @c3 into @l4"}',
    );
  });

  it("rewrites cell, generation and message text in place without moving cells", () => {
    const db = new DatabaseSync(":memory:");
    db.exec(`
      CREATE TABLE notebooks (notebook_id TEXT PRIMARY KEY);
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
        grid_row INTEGER NOT NULL CHECK (grid_row BETWEEN 0 AND 63),
        grid_column INTEGER NOT NULL CHECK (grid_column BETWEEN 0 AND 7),
        prompt TEXT,
        inputs_json TEXT NOT NULL DEFAULT '{}',
        PRIMARY KEY(notebook_id, cell_id)
      );
      CREATE TABLE generations (
        notebook_id TEXT NOT NULL,
        generation_id TEXT NOT NULL,
        prompt TEXT,
        resolved_prompt TEXT,
        PRIMARY KEY(notebook_id, generation_id)
      );
      CREATE TABLE messages (
        message_id TEXT PRIMARY KEY,
        body_json TEXT NOT NULL
      );
    `);
    db.prepare("INSERT INTO notebooks(notebook_id) VALUES ('nb')").run();
    db.prepare(
      "INSERT INTO engine_schema(singleton, version, created_at) VALUES (1, 23, 1)",
    ).run();
    const insert = db.prepare(
      `INSERT INTO cells(
         notebook_id, cell_id, type, label, grid_row, grid_column, prompt, inputs_json
       ) VALUES ('nb', ?, 'image', ?, ?, ?, ?, ?)`,
    );
    insert.run("origin", "origin", 0, 0, "start", "{}");
    insert.run("right", "see @a1", 0, 1, "use @a1", '{"media":"@b1"}');
    insert.run("below", null, 1, 0, "from @b1 and @a2", "{}");
    db.prepare(
      `INSERT INTO generations(notebook_id, generation_id, prompt, resolved_prompt)
       VALUES ('nb', 'gen', 'render @b1', 'render @b1 as @h64')`,
    ).run();
    db.prepare(
      `INSERT INTO messages(message_id, body_json)
       VALUES ('m1', '{"text":"done with @a2"}')`,
    ).run();
    db.prepare(
      `INSERT INTO messages(message_id, body_json)
       VALUES ('m2', '{"text":"nothing to change"}')`,
    ).run();

    const result = applyV23NotebookGridMigration(db);
    expect(result.rewritten).toBe(4);
    expect(
      db.prepare("SELECT version FROM engine_schema").get(),
    ).toEqual({ version: SCHEMA_VERSION });
    const rows = db
      .prepare(
        `SELECT cell_id, label, grid_row, grid_column, prompt, inputs_json
         FROM cells ORDER BY cell_id`,
      )
      .all();
    expect(rows).toEqual([
      {
        cell_id: "below",
        label: null,
        grid_row: 1,
        grid_column: 0,
        prompt: "from @a2 and @b1",
        inputs_json: "{}",
      },
      {
        cell_id: "origin",
        label: "origin",
        grid_row: 0,
        grid_column: 0,
        prompt: "start",
        inputs_json: "{}",
      },
      {
        cell_id: "right",
        label: "see @a1",
        grid_row: 0,
        grid_column: 1,
        prompt: "use @a1",
        inputs_json: '{"media":"@a2"}',
      },
    ]);
    expect(
      db.prepare("SELECT prompt, resolved_prompt FROM generations").get(),
    ).toEqual({ prompt: "render @a2", resolved_prompt: "render @a2 as @bl8" });
    expect(
      db.prepare("SELECT body_json FROM messages ORDER BY message_id").all(),
    ).toEqual([
      { body_json: '{"text":"done with @b1"}' },
      { body_json: '{"text":"nothing to change"}' },
    ]);
    db.close();
  });

  it("upgrades a schema-23 catalog when the engine reopens it", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "videobook-grid-v23-"));
    roots.push(root);
    const engine = createEngine({
      rootDir: root,
      initialBookName: "grid-v23",
    });
    await engine.ready;
    const notebook = value(await engine.notebooks.create("Grid"));
    const origin = engine.notebooks.createCell({
      type: "prompt",
      slot: { row: 0, column: 0 },
      prompt: "origin",
    });
    const right = engine.notebooks.createCell({
      type: "image",
      slot: { row: 0, column: 1 },
      prompt: "see @a1",
    });
    const below = engine.notebooks.createCell({
      type: "image",
      slot: { row: 1, column: 0 },
      prompt: "under origin",
    });
    const edge = engine.notebooks.createEdge({
      source: origin.id,
      target: right.id,
      targetInput: "media",
    });
    value(
      await engine.notebooks.write({
        ...notebook,
        cells: [origin, right, below],
        edges: [edge],
      }),
    );
    engine.close();

    // Downgrade the fixture: schema 23 spelled these slots @b1 and @a2.
    const db = new DatabaseSync(path.join(root, "data", "videobook.db"));
    db.prepare("UPDATE cells SET prompt='blend @b1 into @a2' WHERE cell_id=?")
      .run(origin.id);
    db.prepare("UPDATE engine_schema SET version=23 WHERE singleton=1").run();
    db.prepare("SELECT dolt_add('cells') AS result").get();
    db.prepare("SELECT dolt_add('engine_schema') AS result").get();
    db.prepare(
      "SELECT dolt_commit('-m', 'downgrade fixture to schema 23', '--author', 'Videobook <videobook@localhost>') AS hash",
    ).get();
    db.close();

    const upgraded = createEngine({ rootDir: root });
    await upgraded.ready;
    const document = upgraded.notebooks.read(notebook.id);
    if (!document.ok) throw new Error(document.error.message);
    const byId = new Map(document.value.cells.map((cell) => [cell.id, cell]));
    expect(byId.get(origin.id)?.prompt).toBe("blend @a2 into @b1");
    expect(byId.get(right.id)?.prompt).toBe("see @a1");
    expect(byId.get(right.id)?.slot).toEqual({ row: 0, column: 1 });
    expect(byId.get(below.id)?.slot).toEqual({ row: 1, column: 0 });
    expect(document.value.edges).toEqual([edge]);
    const reopened = new DatabaseSync(path.join(root, "data", "videobook.db"));
    expect(
      reopened.prepare("SELECT version FROM engine_schema").get(),
    ).toEqual({ version: SCHEMA_VERSION });
    reopened.close();
    upgraded.close();
  });
});
