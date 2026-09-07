import { rmSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";

import { DatabaseSync } from "@dolthub/doltlite";
import { afterEach, describe, expect, it } from "vitest";

import { SCHEMA_VERSION } from "../src/catalog-metadata.js";
import {
  SEMANTIC_SCHEMA_SQL,
  SEMANTIC_TABLES,
  TAG_SCHEMA_SQL,
} from "../src/schema.js";
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

/**
 * Rewrites a catalog the way an engine that predates asset tags would have
 * left it: the tag tables are absent from every commit, not merely dropped
 * from the tip. The distinction is load-bearing. Dolt exposes
 * `dolt_diff_<table>` only for a table its history knows, so a
 * dropped-then-committed table still answers diff probes while a genuinely
 * old book does not — the state every real schema 24 book is in.
 */
function rewriteWithoutTagHistory(root: string, version: number): void {
  const catalog = path.join(root, "data", "videobook.db");
  const carried = SEMANTIC_TABLES.filter(
    (table) => !(ASSET_TAG_TABLES as readonly string[]).includes(table),
  );
  const source = new DatabaseSync(catalog);
  const rows = new Map<string, Array<Record<string, unknown>>>(
    carried.map((table) => [
      table,
      source.prepare(`SELECT * FROM ${table}`).all() as Array<
        Record<string, unknown>
      >,
    ]),
  );
  source.close();
  rmSync(catalog, { recursive: true, force: true });

  const rebuilt = new DatabaseSync(catalog);
  rebuilt.exec(SEMANTIC_SCHEMA_SQL.replace(TAG_SCHEMA_SQL, ""));
  rebuilt.exec(
    `CREATE TABLE IF NOT EXISTS dolt_ignore(
      pattern TEXT NOT NULL,
      ignored TINYINT NOT NULL,
      PRIMARY KEY(pattern)
    )`,
  );
  for (const pattern of ["runtime_%", "sqlite_sequence", "job_runs"]) {
    rebuilt
      .prepare("INSERT INTO dolt_ignore(pattern, ignored) VALUES (?, 1)")
      .run(pattern);
  }
  for (const table of carried) {
    for (const row of rows.get(table) ?? []) {
      const columns = Object.keys(row);
      rebuilt
        .prepare(
          `INSERT INTO ${table}(${columns.join(", ")})
           VALUES (${columns.map(() => "?").join(", ")})`,
        )
        .run(...columns.map((column) => row[column] as null));
    }
  }
  rebuilt.prepare("UPDATE engine_schema SET version=? WHERE singleton=1").run(
    version,
  );
  for (const table of [...carried, "dolt_ignore"]) {
    rebuilt.prepare("SELECT dolt_add(?) AS result").get(table);
  }
  rebuilt
    .prepare(
      "SELECT dolt_commit('-m', 'legacy catalog without tag tables', '--author', 'Videobook <videobook@localhost>') AS hash",
    )
    .get();
  rebuilt.close();
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

  it("upgrades a catalog whose history never carried the tag tables", async () => {
    const root = await tempRoot();
    const engine = createEngine({ rootDir: root, initialBookName: "legacy" });
    await engine.ready;
    const artifact = value(
      await engine.artifacts.create({ kind: "video", label: "clip" }),
    );
    engine.close();
    rewriteWithoutTagHistory(root, 24);
    expect(tableNames(root)).toEqual([]);
    expect(recordedVersion(root)).toBe(24);

    const upgraded = createEngine({ rootDir: root });
    await upgraded.ready;
    expect(recordedVersion(root)).toBe(SCHEMA_VERSION);
    expect(tableNames(root)).toEqual([...ASSET_TAG_TABLES].sort());
    expect(upgraded.artifacts.list().map((row) => row.artifactId)).toEqual([
      artifact.artifactId,
    ]);
    expect(value(upgraded.tags.read(artifact.artifactId)).effective).toEqual([]);
    const tagged = value(
      await upgraded.tags.add(artifact.artifactId, {
        facet: "editing",
        label: "Interview",
      }),
    );
    expect(tagged.effective.map((tag) => tag.key)).toEqual(["interview"]);

    const db = new DatabaseSync(path.join(root, "data", "videobook.db"));
    try {
      expect(
        db
          .doltStatus()
          .filter((entry) => entry.table_name.startsWith("artifact_tag")),
      ).toEqual([]);
      expect(
        db
          .doltLog()
          .filter((entry) => entry.message.startsWith("Add asset tag tables")),
      ).toHaveLength(1);
    } finally {
      db.close();
    }
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

  const boundaries = [
    "after-semantic-mutation", "before-sql-commit", "after-sql-commit",
    "after-table-stage", "after-dolt-commit",
  ] as const;
  const interruptions = [
    ...[22, 23, 24].flatMap((version) => boundaries.map((boundary) => ({ version, boundary, operation: 1 }))),
    ...[22, 23].flatMap((version) => boundaries.map((boundary) => ({ version, boundary, operation: 2 }))),
  ];
  it.each(interruptions)("recovers schema $version operation $operation interrupted at $boundary", async ({ version, boundary, operation }) => {
    const root = await tempRoot();
    const engine = createEngine({ rootDir: root, initialBookName: "interrupted" });
    await engine.ready;
    const artifact = value(await engine.artifacts.create({ kind: "video" }));
    const notebook = value(await engine.notebooks.create("Grid"));
    const source = engine.notebooks.createCell({
      type: "prompt", slot: { row: 0, column: 0 }, prompt: "blend @b1 into @a2",
    });
    const target = engine.notebooks.createCell({ type: "image", slot: { row: 0, column: 1 } });
    const edge = engine.notebooks.createEdge({ source: source.id, target: target.id, targetInput: "media" });
    value(await engine.notebooks.write({ ...notebook, cells: [source, target], edges: [edge] }));
    engine.close();
    downgrade(root, version);

    const operations = new Set<string>();
    expect(() => createEngine({
      rootDir: root,
      semanticCommitBoundary(current, operationId) {
        operations.add(operationId);
        if (operations.size === operation && current === boundary) throw new Error("migration interruption");
      },
    })).toThrow("migration interruption");

    const recovered = createEngine({ rootDir: root });
    let head: string;
    try {
      await recovered.ready;
      head = recovered.head;
      expect(value(recovered.tags.readAtRevision(artifact.artifactId, head)).effective).toEqual([]);
      expect(value(recovered.notebooks.read(notebook.id)).edges).toEqual([edge]);
      if (version === 23) {
        expect(value(recovered.notebooks.read(notebook.id)).cells[0]?.prompt).toBe("blend @a2 into @b1");
      }
      const probe = new DatabaseSync(path.join(root, "data", "videobook.db"));
      try {
        expect(probe.prepare("SELECT version FROM dolt_at_engine_schema('HEAD') WHERE singleton=1").get()).toMatchObject({ version: SCHEMA_VERSION });
        for (const table of ASSET_TAG_TABLES) {
          expect(probe.prepare(`SELECT COUNT(*) AS n FROM dolt_at_${table}('HEAD')`).get()).toEqual({ n: 0 });
        }
        expect(probe.prepare("SELECT COUNT(*) AS n FROM runtime_commit_outbox").get()).toEqual({ n: 0 });
        expect(probe.doltLog().filter((entry) => entry.message.startsWith("Add asset tag tables"))).toHaveLength(1);
      } finally {
        probe.close();
      }
    } finally {
      recovered.close();
    }
    const reopened = createEngine({ rootDir: root });
    try {
      await reopened.ready;
      expect(reopened.head).toBe(head);
    } finally {
      reopened.close();
    }
  });
});
