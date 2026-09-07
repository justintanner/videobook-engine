import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";

import { DatabaseSync } from "@dolthub/doltlite";
import { afterEach, describe, expect, it } from "vitest";

import { SCHEMA_VERSION } from "../src/catalog-metadata.js";
import { createEngine } from "../src/index.js";
import {
  ASSET_TAG_TABLES,
  applyAssetTagMigration,
} from "../src/migrate-tags-v24.js";

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

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "vb-tag-migration-"));
  roots.push(root);
  return root;
}

/**
 * Rewinds a current catalog into a pre-tag one: the tables disappear and
 * the recorded version drops to `version`, committed the way the engine
 * that wrote it would have left it.
 */
function downgrade(root: string, version: number): void {
  const db = new DatabaseSync(path.join(root, "data", "videobook.db"));
  for (const table of ASSET_TAG_TABLES) db.exec(`DROP TABLE ${table}`);
  db.prepare("UPDATE engine_schema SET version=? WHERE singleton=1").run(
    version,
  );
  for (const table of [...ASSET_TAG_TABLES, "engine_schema"]) {
    db.prepare("SELECT dolt_add(?) AS result").get(table);
  }
  db.prepare(
    "SELECT dolt_commit('-m', 'downgrade fixture', '--author', 'Videobook <videobook@localhost>') AS hash",
  ).get();
  db.close();
}

function tableNames(root: string): string[] {
  const db = new DatabaseSync(path.join(root, "data", "videobook.db"));
  const rows = db
    .prepare(
      `SELECT name FROM sqlite_master
       WHERE type='table' AND name LIKE 'artifact_tag%'
       ORDER BY name`,
    )
    .all() as Array<{ name: string }>;
  db.close();
  return rows.map((row) => row.name);
}

function recordedVersion(root: string): number {
  const db = new DatabaseSync(path.join(root, "data", "videobook.db"));
  const row = db
    .prepare("SELECT version FROM engine_schema WHERE singleton=1")
    .get() as { version: number };
  db.close();
  return row.version;
}

describe("schema 24 asset tag migration", () => {
  it("adds empty tag state to an existing book and keeps its data", async () => {
    const root = await tempRoot();
    const engine = createEngine({ rootDir: root, initialBookName: "before" });
    await engine.ready;
    const artifact = value(
      await engine.artifacts.create({ kind: "video", label: "clip" }),
    );
    const notebook = value(await engine.notebooks.create("Board"));
    engine.close();
    downgrade(root, 24);
    expect(tableNames(root)).toEqual([]);
    expect(recordedVersion(root)).toBe(24);

    const upgraded = createEngine({ rootDir: root });
    await upgraded.ready;
    expect(recordedVersion(root)).toBe(SCHEMA_VERSION);
    expect(tableNames(root)).toEqual([...ASSET_TAG_TABLES].sort());
    expect(upgraded.artifacts.list().map((row) => row.artifactId)).toEqual([
      artifact.artifactId,
    ]);
    expect(upgraded.notebooks.list().map((row) => row.id)).toEqual([
      notebook.id,
    ]);

    const state = value(upgraded.tags.read(artifact.artifactId));
    expect(state.effective).toEqual([]);
    expect(state.snapshot).toBeUndefined();
    const tagged = value(
      await upgraded.tags.add(artifact.artifactId, {
        facet: "editing",
        label: "Insert",
      }),
    );
    expect(tagged.effective.map((tag) => tag.key)).toEqual(["insert"]);
    upgraded.close();
  });

  it("records the upgrade as one commit and leaves a clean worktree", async () => {
    const root = await tempRoot();
    const engine = createEngine({ rootDir: root, initialBookName: "clean" });
    await engine.ready;
    engine.close();
    downgrade(root, 24);

    const upgraded = createEngine({ rootDir: root });
    await upgraded.ready;
    const head = upgraded.head;
    const db = new DatabaseSync(path.join(root, "data", "videobook.db"));
    const message = (
      db.doltLog({ limit: 1 })[0] as unknown as { message: string }
    ).message;
    expect(message).toContain("Add asset tag tables from schema 24");
    expect(
      db
        .doltStatus()
        .filter((entry) => entry.table_name.startsWith("artifact_tag")),
    ).toEqual([]);
    db.close();

    // Reopening an upgraded catalog is a no-op: no second migration commit.
    upgraded.close();
    const reopened = createEngine({ rootDir: root });
    await reopened.ready;
    expect(reopened.head).toBe(head);
    reopened.close();
  });

  it("upgrades a schema-23 catalog before its grid re-encoding stamps the version", async () => {
    const root = await tempRoot();
    const engine = createEngine({ rootDir: root, initialBookName: "grid" });
    await engine.ready;
    const notebook = value(await engine.notebooks.create("Grid"));
    const cell = engine.notebooks.createCell({
      type: "prompt",
      slot: { row: 0, column: 0 },
      prompt: "blend @b1 into @a2",
    });
    value(await engine.notebooks.insertCell(notebook.id, cell));
    engine.close();
    downgrade(root, 23);

    const upgraded = createEngine({ rootDir: root });
    await upgraded.ready;
    expect(recordedVersion(root)).toBe(SCHEMA_VERSION);
    expect(tableNames(root)).toEqual([...ASSET_TAG_TABLES].sort());
    const document = value(upgraded.notebooks.read(notebook.id));
    // The schema-23 spelling @b1/@a2 is re-encoded, exactly once.
    expect(document.cells[0]?.prompt).toBe("blend @a2 into @b1");
    upgraded.close();
  });

  it("is idempotent and only stamps the version from schema 24", async () => {
    const root = await tempRoot();
    const engine = createEngine({ rootDir: root, initialBookName: "twice" });
    await engine.ready;
    engine.close();

    const db = new DatabaseSync(path.join(root, "data", "videobook.db"));
    // Tables already exist at the current version: nothing to create or stamp.
    expect(applyAssetTagMigration(db)).toEqual({
      created: false,
      stamped: false,
      version: SCHEMA_VERSION,
    });
    db.prepare("UPDATE engine_schema SET version=23 WHERE singleton=1").run();
    expect(applyAssetTagMigration(db)).toEqual({
      created: false,
      stamped: false,
      version: 23,
    });
    db.prepare("UPDATE engine_schema SET version=24 WHERE singleton=1").run();
    expect(applyAssetTagMigration(db)).toEqual({
      created: false,
      stamped: true,
      version: SCHEMA_VERSION,
    });
    db.close();
  });
});
