import {
  copyFile,
  mkdir,
  mkdtemp,
  readdir,
  rm,
  stat,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";

import { DatabaseSync } from "@dolthub/doltlite";
import { v7 as uuidv7 } from "uuid";
import { afterEach, describe, expect, it } from "vitest";

import { EngineContext } from "../src/context.js";
import { createEngine, type Engine } from "../src/engine.js";
import type { ContentStore } from "../src/engine-types.js";
import { createHistoryApi } from "../src/history.js";
import {
  RUNTIME_TABLES,
  SCHEMA_VERSION,
  SEMANTIC_TABLES,
} from "../src/schema.js";

const roots: string[] = [];
const MERGE_TABLES = [
  "engine_schema",
  "book",
  "artifacts",
  "entities",
  "notebooks",
  "cells",
  "prompt_entries",
] as const;
const MERGE_SCHEMA_SQL = `
  CREATE TABLE engine_schema (
    singleton INTEGER PRIMARY KEY,
    version INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE book (
    book_id TEXT PRIMARY KEY,
    slug TEXT NOT NULL UNIQUE,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE artifacts (
    artifact_id TEXT PRIMARY KEY,
    slug TEXT NOT NULL UNIQUE,
    kind TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE entities (
    entity_id TEXT PRIMARY KEY,
    type TEXT NOT NULL,
    name TEXT NOT NULL,
    description TEXT,
    prompt TEXT,
    data_json TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE notebooks (
    notebook_id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE cells (
    notebook_id TEXT NOT NULL,
    cell_id TEXT NOT NULL,
    type TEXT NOT NULL,
    slug TEXT NOT NULL,
    grid_row INTEGER NOT NULL,
    grid_column INTEGER NOT NULL,
    output_entity_id TEXT,
    prompt TEXT,
    model TEXT,
    inputs_json TEXT NOT NULL,
    output_artifact_id TEXT,
    PRIMARY KEY(notebook_id, cell_id)
  );
  CREATE TABLE prompt_entries (
    prompt_id TEXT PRIMARY KEY,
    surface TEXT NOT NULL,
    prompt TEXT NOT NULL,
    context_json TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
`;

afterEach(async () => {
  await Promise.all(roots.splice(0).map(removeRoot));
});

async function setup(initialBookSlug = "demo"): Promise<{
  engine: Engine;
  root: string;
  dataDir: string;
}> {
  const root = await mkdtemp(path.join(tmpdir(), "videobook-v2-"));
  roots.push(root);
  const dataDir = path.join(root, "data");
  return {
    engine: createEngine({
      dataDir,
      workspaceDir: path.join(root, "workspace"),
      initialBookSlug,
    }),
    root,
    dataDir,
  };
}

function value<T>(
  result:
    | { ok: true; value: T }
    | { ok: false; error: { message: string } },
): T {
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

function fileContentStore(root: string): ContentStore {
  return {
    async head(key) {
      try {
        const info = await stat(path.join(root, key));
        return { exists: true, size: info.size };
      } catch {
        return { exists: false };
      }
    },
    async uploadFile(key, sourcePath) {
      const destination = path.join(root, key);
      await mkdir(path.dirname(destination), { recursive: true });
      await copyFile(sourcePath, destination);
    },
    async downloadFile(key, destinationPath) {
      await mkdir(path.dirname(destinationPath), { recursive: true });
      await copyFile(path.join(root, key), destinationPath);
    },
    async delete(key) {
      await rm(path.join(root, key), { force: true });
    },
  };
}

async function removeRoot(root: string): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      await rm(root, { recursive: true, force: true, maxRetries: 1 });
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  throw lastError;
}

function commitTables(
  db: DatabaseSync,
  tables: string[],
  message: string,
): string {
  for (const table of tables) {
    db.prepare("SELECT dolt_add(?) AS result").get(table);
  }
  const row = db
    .prepare("SELECT dolt_commit('-m', ?) AS hash")
    .get(message) as { hash: string };
  return row.hash;
}

describe("single-book Dolt engine", () => {
  it("initializes exactly one book and reopens it without initialization input", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "videobook-book-"));
    roots.push(root);
    const dataDir = path.join(root, "data");
    const workspaceDir = path.join(root, "workspace");

    expect(() =>
      createEngine({ dataDir, workspaceDir }),
    ).toThrow("initialBookSlug is required");

    const engine = createEngine({
      dataDir,
      workspaceDir,
      initialBookSlug: "My First Book",
    });
    const first = engine.book.get();
    expect(first.slug).toBe("my-first-book");
    expect(first.bookId).toMatch(/^[0-9a-f-]{36}$/);
    value(await engine.book.rename("Renamed Book"));
    engine.close();

    const catalog = new DatabaseSync(path.join(dataDir, "videobook.db"));
    const bookColumns = (
      catalog.prepare("PRAGMA table_info(book)").all() as Array<{ name: string }>
    ).map((column) => column.name);
    expect(bookColumns).toEqual(["book_id", "slug", "created_at"]);
    catalog.close();

    const reopened = createEngine({ dataDir, workspaceDir });
    expect(reopened.book.get()).toEqual({
      bookId: first.bookId,
      slug: "renamed-book",
      createdAt: first.createdAt,
    });
    reopened.close();

    const suppliedAgain = createEngine({
      dataDir,
      workspaceDir,
      initialBookSlug: "ignored-on-reopen",
    });
    expect(suppliedAgain.book.get().slug).toBe("renamed-book");
    suppliedAgain.close();
  });

  it("creates the exact normalized v18 semantic and runtime schema", async () => {
    const { engine, dataDir } = await setup();
    expect(SCHEMA_VERSION).toBe(18);
    engine.close();

    const db = new DatabaseSync(path.join(dataDir, "videobook.db"));
    const tables = (
      db
        .prepare(
          `SELECT name FROM sqlite_master
           WHERE type='table'
             AND name NOT LIKE 'sqlite_%'
             AND name NOT LIKE 'dolt_%'
           ORDER BY name`,
        )
        .all() as Array<{ name: string }>
    ).map((row) => row.name);
    expect(tables).toEqual(
      [...SEMANTIC_TABLES, ...RUNTIME_TABLES].sort(),
    );
    expect(tables).toHaveLength(57);

    const columns = (table: string) =>
      (
        db.prepare(`PRAGMA table_info(${table})`).all() as Array<{
          name: string;
        }>
      ).map((column) => column.name);
    expect(columns("artifacts")).toEqual([
      "artifact_id",
      "slug",
      "kind",
      "created_at",
    ]);
    expect(columns("artifact_files")).toEqual([
      "artifact_id",
      "path",
      "object_hash",
      "created_at",
    ]);
    expect(columns("notebooks")).toEqual([
      "notebook_id",
      "name",
      "created_at",
    ]);
    expect(columns("notebook_fields")).toEqual([
      "notebook_id",
      "field",
      "value_json",
    ]);
    expect(columns("notebook_cell_executions")).toContain("cell_id");
    expect(columns("notebook_generation_plans")).toContain("plan_id");
    expect(columns("notebook_run_plans")).toContain("plan_id");
    expect(columns("notebook_transcript_edits")).toContain("action_id");
    expect(columns("notebook_transcript_attachments")).toContain(
      "attachment_id",
    );
    expect(columns("cells")).toEqual([
      "notebook_id",
      "cell_id",
      "type",
      "slug",
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
    expect(columns("artifact_streams")).toContain("time_base_numerator");
    expect(columns("sequence_tracks")).toContain("order_key");
    expect(columns("sequence_tracks")).not.toContain("ordinal");
    expect(columns("transcripts")).toContain("object_hash");
    expect(columns("transcripts")).toContain("payload_hash");
    expect(columns("transcript_segments")).not.toContain("text");
    expect(columns("transcript_words")).not.toContain("text");
    expect(columns("sequences")).toContain("frame_rate_numerator");
    expect(columns("sequence_clips")).toContain("source_duration_ticks");
    expect(columns("caption_cues")).toContain("transcript_revision");
    expect(columns("runtime_media_segments")).toContain("source_range_json");
    expect(columns("runtime_segment_embeddings")).toContain("embedding_space");
    expect(columns("runtime_index_coverage")).toContain("covered_ranges_json");
    expect(columns("prompt_entries")[0]).toBe("prompt_id");
    expect(
      (db
        .prepare("SELECT version FROM engine_schema WHERE singleton=1")
        .get() as { version: number }).version,
    ).toBe(18);
    expect(
      db
        .prepare(
          `SELECT 1 AS present FROM sqlite_master
           WHERE name IN (
             'notebook_cells','notebook_edges','notebook_runs',
             'timelines','timeline','timeline_slots','timeline_audio',
             'artifact_events','runtime_engine_leases',
             'operations','actions','action_events','action_parents',
             'action_artifacts','action_write_set','edit_batches'
           )`,
        )
        .get(),
    ).toBeUndefined();
    db.close();
  });

  it.each([3, 4, 13])("rejects v%s catalogs without an explicit migration", async (version) => {
    const root = await mkdtemp(path.join(tmpdir(), `videobook-v${version}-schema-`));
    roots.push(root);
    const dataDir = path.join(root, "data");
    await mkdir(dataDir, { recursive: true });
    const db = new DatabaseSync(path.join(dataDir, "videobook.db"));
    db.exec(
      `CREATE TABLE engine_schema (
        singleton INTEGER PRIMARY KEY,
        version INTEGER NOT NULL,
        created_at INTEGER NOT NULL
      );
      INSERT INTO engine_schema(singleton, version, created_at)
      VALUES (1, ${version}, 0);`,
    );
    db.close();

    expect(() =>
      createEngine({
        dataDir,
        workspaceDir: path.join(root, "workspace"),
      }),
    ).toThrow(`Database schema ${version} is not supported`);
  });

  it("keeps semantic history and runtime state in one database without projects", async () => {
    const { engine, dataDir } = await setup();
    const artifact = value(
      await engine.artifacts.create({ kind: "image", slug: "img-cat" }),
    );
    expect((await stat(artifact.path)).isDirectory()).toBe(true);
    const semanticHead = engine.head;
    expect(
      engine.jobs.artifactWork.begin(artifact.artifactId, {
        kind: "generate",
        ownerKind: "job",
        durationMs: 10_000,
      }),
    ).not.toBeNull();
    expect(engine.settings.set("application.watermark", { enabled: true }).ok).toBe(
      true,
    );
    expect(engine.head).toBe(semanticHead);
    engine.close();

    expect(
      (await readdir(dataDir)).filter((name) => name.endsWith(".db")),
    ).toEqual(["videobook.db"]);
    const db = new DatabaseSync(path.join(dataDir, "videobook.db"));
    const names = (
      db
        .prepare(
          `SELECT name FROM sqlite_master
           WHERE type='table' AND name IN ('book', 'projects', 'runtime_artifact_views')
           ORDER BY name`,
        )
        .all() as Array<{ name: string }>
    ).map((row) => row.name);
    expect(names).toEqual(["book", "runtime_artifact_views"]);
    expect(
      db.doltStatus().some(
        (row) => row.table_name === "runtime_artifact_views" && row.staged === 1,
      ),
    ).toBe(false);
    db.close();
  });

  it("treats sequences as the single timeline model", async () => {
    const { engine } = await setup();
    expect("timeline" in engine).toBe(false);
    expect(SEMANTIC_TABLES).not.toContain("timeline");
    expect(SEMANTIC_TABLES).not.toContain("timeline_slots");
    expect(SEMANTIC_TABLES).not.toContain("timeline_audio");
    const sequence = engine.sequences.getPrimary();
    expect(sequence.tracks.map((track) => track.kind)).toEqual([
      "audio",
      "audio",
      "audio",
      "audio",
      "caption",
      "video",
      "video",
    ]);
    engine.close();
  });

  it("rejects hard deletion of referenced records and cascades owned rows", async () => {
    const { engine, dataDir } = await setup();
    const artifact = value(
      await engine.artifacts.create({ kind: "image", slug: "img-owned" }),
    );
    const fileWrite = await engine.files.write(
      artifact.artifactId,
      "original.png",
      "pixel",
    );
    if (!fileWrite.ok || !fileWrite.revision) throw new Error("missing file revision");
    const entity = value(
      await engine.entities.create("character", "Referenced"),
    );
    const notebook = value(await engine.notebooks.create("Graph"));
    const cell = engine.notebooks.createCell({
      type: "image",
      slug: "img-image",
      slot: { row: 0, column: 0 },
      outputEntityId: entity.id,
      outputArtifactId: artifact.artifactId,
    });
    value(
      await engine.notebooks.write({
        ...notebook,
        cells: [cell],
        edges: [],
      }),
    );

    expect(await engine.entities.delete(entity.id)).toMatchObject({
      ok: false,
      error: { code: "IN_USE" },
    });
    expect(await engine.artifacts.delete(artifact.artifactId)).toMatchObject({
      ok: false,
      error: { code: "IN_USE" },
    });
    expect(value(await engine.notebooks.delete(notebook.id))).toEqual({
      notebookId: notebook.id,
    });
    expect(engine.notebooks.read(notebook.id)).toMatchObject({
      ok: false,
      error: { code: "NOT_FOUND" },
    });
    expect(value(await engine.entities.delete(entity.id))).toEqual({
      entityId: entity.id,
    });
    expect(value(await engine.artifacts.delete(artifact.artifactId))).toEqual({
      artifactId: artifact.artifactId,
      slug: artifact.slug,
    });
    expect(engine.history.artifact(artifact.artifactId)[0]?.operation).toBe(
      "delete_artifact",
    );
    value(
      await engine.history.restoreArtifact(
        artifact.artifactId,
        fileWrite.revision,
      ),
    );
    expect(
      value(await engine.files.read(artifact.artifactId, "original.png")).toString(),
    ).toBe("pixel");
    engine.close();

    const db = new DatabaseSync(path.join(dataDir, "videobook.db"));
    const objectCount = (
      db.prepare("SELECT COUNT(*) AS count FROM objects").get() as {
        count: number;
      }
    ).count;
    expect(objectCount).toBe(1);
    const manifestColumns = (
      db.prepare("PRAGMA table_info(artifact_files)").all() as Array<{
        name: string;
      }>
    ).map((column) => column.name);
    expect(manifestColumns).not.toContain("size_bytes");
    expect(manifestColumns).not.toContain("mime_type");
    db.close();
  });

  it("validates caller-supplied semantic IDs as UUIDv7", async () => {
    const { engine } = await setup();
    const notebook = value(await engine.notebooks.create("IDs"));
    const generatedCell = engine.notebooks.createCell({
      type: "prompt",
      slug: "prompt-generated",
      slot: { row: 1, column: 2 },
    });
    expect(generatedCell.id[14]).toBe("7");
    expect(
      value(await engine.prompts.record({ surface: "test", prompt: "hello" })).id[14],
    ).toBe("7");
    expect(
      value(await engine.messages.append({ role: "user", body: {} })).messageId[14],
    ).toBe("7");

    expect(
      await engine.notebooks.write({
        ...notebook,
        cells: [{ ...generatedCell, id: "cell-1" }],
        edges: [],
      }),
    ).toMatchObject({ ok: false, error: { code: "INVALID_INPUT" } });
    engine.close();
  });

  it("merges independent UUID rows and conflicts only on the same cell", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "videobook-merge-schema-"));
    roots.push(root);
    const mergeDatabasePath = path.join(root, "merge.db");
    const db = new DatabaseSync(mergeDatabasePath);
    db.exec(MERGE_SCHEMA_SQL);
    const bookId = uuidv7();
    const notebookId = uuidv7();
    const leftEntity = uuidv7();
    const rightEntity = uuidv7();
    const leftArtifact = uuidv7();
    const rightArtifact = uuidv7();
    db.prepare(
      "INSERT INTO engine_schema(singleton, version, created_at) VALUES (1, 5, 0)",
    ).run();
    db.prepare("INSERT INTO book(book_id, slug, created_at) VALUES (?, 'merge-book', 0)")
      .run(bookId);
    db.prepare(
      `INSERT INTO artifacts(artifact_id, slug, kind, created_at)
       VALUES (?, 'vid-left', 'video', 0), (?, 'vid-right', 'video', 0)`,
    ).run(leftArtifact, rightArtifact);
    db.prepare(
      `INSERT INTO entities(
        entity_id, type, name, data_json, created_at
      ) VALUES (?, 'scene', 'Left', '{}', 0),
               (?, 'scene', 'Right', '{}', 0)`,
    ).run(leftEntity, rightEntity);
    db.prepare(
      `INSERT INTO notebooks(
        notebook_id, name, created_at
      ) VALUES (
        ?, 'Merge graph',
        0
      )`,
    ).run(notebookId);
    commitTables(db, [...MERGE_TABLES], "initial merge fixture");

    const leftCell = uuidv7();
    const rightCell = uuidv7();
    const leftPrompt = uuidv7();
    const rightPrompt = uuidv7();

    db.doltBranch("fork-left");
    db.doltCheckout("fork-left");
    db.prepare("UPDATE entities SET name='Left fork' WHERE entity_id=?")
      .run(leftEntity);
    db.prepare(
      `INSERT INTO cells(
        notebook_id, cell_id, type, slug, grid_row, grid_column,
        output_entity_id, inputs_json
      ) VALUES (?, ?, 'scene', 'scene-left', 0, 0, ?, '{}')`,
    ).run(notebookId, leftCell, leftEntity);
    db.prepare(
      `INSERT INTO prompt_entries(
        prompt_id, surface, prompt, context_json, created_at
      ) VALUES (?, 'merge', 'left', '{}', 1)`,
    ).run(leftPrompt);
    commitTables(
      db,
      ["entities", "cells", "prompt_entries"],
      "left fork",
    );

    db.doltCheckout("main");
    db.doltReset("--hard");
    db.doltBranch("fork-right");
    db.doltCheckout("fork-right");
    db.prepare("UPDATE entities SET name='Right fork' WHERE entity_id=?")
      .run(rightEntity);
    // Both forks append at the same grid slot: positions are no longer
    // unique, so the merge must keep both rows and order them
    // deterministically by the row UUID tie-break.
    db.prepare(
      `INSERT INTO cells(
        notebook_id, cell_id, type, slug, grid_row, grid_column,
        output_entity_id, inputs_json
      ) VALUES (?, ?, 'scene', 'scene-right', 0, 0, ?, '{}')`,
    ).run(notebookId, rightCell, rightEntity);
    db.prepare(
      `INSERT INTO prompt_entries(
        prompt_id, surface, prompt, context_json, created_at
      ) VALUES (?, 'merge', 'right', '{}', 2)`,
    ).run(rightPrompt);
    commitTables(
      db,
      ["entities", "cells", "prompt_entries"],
      "right fork",
    );

    db.doltCheckout("main");
    db.doltReset("--hard");
    expect(db.doltMerge("fork-left").conflicts).toBe(0);
    expect(db.doltMerge("fork-right").conflicts).toBe(0);
    expect(
      (db.prepare("SELECT COUNT(*) AS count FROM cells").get() as {
        count: number;
      }).count,
    ).toBe(2);
    expect(
      (db
        .prepare("SELECT cell_id FROM cells ORDER BY grid_row, grid_column, cell_id")
        .all() as Array<{ cell_id: string }>).map((row) => row.cell_id),
    ).toEqual([leftCell, rightCell].sort());
    expect(
      (
        db
          .prepare("SELECT name FROM entities WHERE entity_id=?")
          .get(leftEntity) as { name: string }
      ).name,
    ).toBe("Left fork");
    expect(
      (
        db
          .prepare("SELECT name FROM entities WHERE entity_id=?")
          .get(rightEntity) as { name: string }
      ).name,
    ).toBe("Right fork");

    db.doltBranch("same-cell-left");
    db.doltCheckout("same-cell-left");
    db.prepare("UPDATE cells SET slug='scene-left-edit' WHERE cell_id=?")
      .run(leftCell);
    commitTables(db, ["cells"], "left edit");
    db.doltCheckout("main");
    db.doltReset("--hard");
    db.doltBranch("same-cell-right");
    db.doltCheckout("same-cell-right");
    db.doltReset("--hard");
    db.prepare("UPDATE cells SET slug='scene-right-edit' WHERE cell_id=?")
      .run(leftCell);
    commitTables(db, ["cells"], "right edit");
    db.doltCheckout("main");
    db.doltReset("--hard");
    expect(db.doltMerge("same-cell-left").conflicts).toBe(0);
    expect(() => db.doltMerge("same-cell-right")).toThrow("Merge conflict");
    db.close();
  });

  it("merges same-position rows from independent forks without losing rows", async () => {
    // Minimal fixture: doltlite's merge guard misfires on working roots with
    // many tables, so the order-key merge behavior gets its own small db.
    const root = await mkdtemp(path.join(tmpdir(), "videobook-merge-keys-"));
    roots.push(root);
    const db = new DatabaseSync(path.join(root, "merge-keys.db"));
    db.exec(`
      CREATE TABLE engine_schema (
        singleton INTEGER PRIMARY KEY,
        version INTEGER NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE cells (
        notebook_id TEXT NOT NULL,
        cell_id TEXT NOT NULL,
        type TEXT NOT NULL,
        slug TEXT NOT NULL,
        grid_row INTEGER NOT NULL,
        grid_column INTEGER NOT NULL,
        inputs_json TEXT NOT NULL,
        PRIMARY KEY(notebook_id, cell_id)
      );
      CREATE TABLE sequence_tracks (
        track_id TEXT PRIMARY KEY,
        sequence_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        order_key TEXT NOT NULL,
        name TEXT NOT NULL
      );
    `);
    const tables = [
      "engine_schema",
      "cells",
      "sequence_tracks",
    ];
    db.prepare(
      "INSERT INTO engine_schema(singleton, version, created_at) VALUES (1, 15, 0)",
    ).run();
    commitTables(db, tables, "initial");
    const notebookId = uuidv7();
    const leftCell = uuidv7();
    const rightCell = uuidv7();
    const leftTrack = uuidv7();
    const rightTrack = uuidv7();

    // Both forks append at the same grid slot and mint the same fractional
    // order keys. Positions and order keys are not unique, so the merge must
    // keep both rows and order them by the stable UUID tie-break.
    for (const [branch, cell, track] of [
      ["fork-left", leftCell, leftTrack],
      ["fork-right", rightCell, rightTrack],
    ] as const) {
      db.doltBranch(branch);
      db.doltCheckout(branch);
      db.prepare(
        `INSERT INTO cells(
          notebook_id, cell_id, type, slug, grid_row, grid_column, inputs_json
        ) VALUES (?, ?, 'scene', ?, 0, 0, '{}')`,
      ).run(notebookId, cell, `scene-${branch}`);
      db.prepare(
        `INSERT INTO sequence_tracks(
          track_id, sequence_id, kind, order_key, name
        ) VALUES (?, 'merge-sequence', 'video', 'a1', ?)`,
      ).run(track, `Track ${branch}`);
      commitTables(db, ["cells", "sequence_tracks"], branch);
      db.doltCheckout("main");
      db.doltReset("--hard");
    }

    expect(db.doltMerge("fork-left").conflicts).toBe(0);
    expect(db.doltMerge("fork-right").conflicts).toBe(0);
    expect(
      (db
        .prepare(
          `SELECT cell_id FROM cells
           ORDER BY grid_row, grid_column, cell_id`,
        )
        .all() as Array<{ cell_id: string }>).map((row) => row.cell_id),
    ).toEqual([leftCell, rightCell].sort());
    expect(
      (db
        .prepare(
          `SELECT track_id FROM sequence_tracks
           ORDER BY order_key, track_id`,
        )
        .all() as Array<{ track_id: string }>).map((row) => row.track_id),
    ).toEqual([leftTrack, rightTrack].sort());
    db.close();
  });

  it("projects queued work into an artifact runtime view", async () => {
    const { engine } = await setup();
    const artifact = value(
      await engine.artifacts.create({ kind: "image", slug: "img-queued" }),
    );
    const enqueued = engine.jobs.queue.enqueue({
      type: "generate_image",
      artifactId: artifact.artifactId,
      payload: {},
      artifactWorkKind: "generate",
    });
    expect(enqueued.inserted).toBe(true);
    expect(value(engine.jobs.artifactWork.read(artifact.artifactId))).toMatchObject({
      status: "pending",
      meta: { kind: "generate", queued: true },
      deadlineAt: null,
    });
    expect(value(await engine.status.get(artifact.artifactId))).toBe("generating");
    engine.close();
  });

  it("propagates durable cancellation into a running handler", async () => {
    const { engine } = await setup();
    let started: (() => void) | undefined;
    const running = new Promise<void>((resolve) => {
      started = resolve;
    });
    let observedReason: unknown;
    const runner = engine.jobs.queue.createRunner({
      concurrency: 1,
      pollIntervalMs: 10,
      resolveHandler: () => async (_job, signal) => {
        started?.();
        await new Promise<void>((resolve) => {
          if (signal?.aborted) {
            observedReason = signal.reason;
            resolve();
            return;
          }
          signal?.addEventListener("abort", () => {
            observedReason = signal.reason;
            resolve();
          }, { once: true });
        });
      },
    });
    runner.start();
    const enqueued = engine.jobs.queue.enqueue({
      type: "cancel-test",
      payload: {},
    });
    await running;
    expect(await engine.jobs.queue.abort(enqueued.job.id, "Cancelled in test")).toBe(true);
    await runner.waitFor(enqueued.job.id).catch(() => undefined);
    expect(observedReason).toMatchObject({
      name: "AbortError",
      message: "Cancelled in test",
    });
    expect(engine.jobs.queue.get(enqueued.job.id)?.state).toBe("aborted");
    await runner.stop();
    engine.close();
  });

  it("reuses a deleted slug with an isolated identity", async () => {
    const { engine } = await setup();
    const first = value(
      await engine.artifacts.create({ kind: "video", slug: "vid-cat" }),
    );
    value(await engine.files.write(first.artifactId, "original.mp4", "old bytes"));
    value(await engine.artifacts.delete(first.artifactId));
    expect(engine.artifacts.isSlugAvailable("vid-cat")).toBe(true);

    const second = value(
      await engine.artifacts.create({ kind: "video", slug: "vid-cat" }),
    );
    expect(second.artifactId).not.toBe(first.artifactId);
    expect(second.path).not.toBe(first.path);
    expect(value(await engine.files.manifest(second.artifactId)).files).toEqual([]);
    engine.close();
  });

  it("restores artifact content forward without changing its identity", async () => {
    const { engine } = await setup();
    const artifact = value(
      await engine.artifacts.create({ kind: "script", slug: "script-draft" }),
    );
    const first = await engine.files.write(
      artifact.artifactId,
      "original.md",
      "version one",
    );
    if (!first.ok || !first.revision) throw new Error("missing first revision");
    value(await engine.files.write(artifact.artifactId, "original.md", "version two"));

    value(await engine.history.restoreArtifact(artifact.artifactId, first.revision));
    expect(
      value(await engine.files.read(artifact.artifactId, "original.md")).toString(),
    ).toBe("version one");
    expect(value(engine.artifacts.get(artifact.artifactId)).artifactId).toBe(
      artifact.artifactId,
    );
    engine.close();
  });

  it("reports the current owner when restoring a reused artifact slug", async () => {
    const { engine } = await setup();
    const original = value(
      await engine.artifacts.create({ kind: "video", slug: "vid-cat" }),
    );
    const written = await engine.files.write(
      original.artifactId,
      "original.mp4",
      "old cat",
    );
    if (!written.ok || !written.revision) throw new Error("missing write revision");
    value(await engine.artifacts.delete(original.artifactId));
    const current = value(
      await engine.artifacts.create({ kind: "video", slug: "vid-cat" }),
    );

    const conflict = await engine.history.restoreArtifact(
      original.artifactId,
      written.revision,
    );
    expect(conflict).toMatchObject({ ok: false, error: { code: "SLUG_CONFLICT" } });
    if (!conflict.ok) expect(conflict.error.ownerId).toBe(current.artifactId);

    value(
      await engine.history.restoreArtifact(
        original.artifactId,
        written.revision,
        "vid-cat-restored",
      ),
    );
    expect(value(engine.artifacts.get(original.artifactId)).slug).toBe(
      "vid-cat-restored",
    );
    engine.close();
  });

  it("restores all book-authored state forward", async () => {
    const { engine } = await setup();
    const artifact = value(
      await engine.artifacts.create({ kind: "script", slug: "script-main" }),
    );
    value(await engine.files.write(artifact.artifactId, "original.md", "target"));
    value(
      await engine.metadata.artifacts.write(
        artifact.artifactId,
        "caption",
        "target caption",
      ),
    );
    const entity = value(await engine.entities.create("character", "Target Character"));
    value(await engine.notebooks.create("Target Notebook"));
    const sequence = engine.sequences.getPrimary();
    const addedTrack = value(
      await engine.sequences.addTrack(sequence.sequenceId, { kind: "video" }),
    ).tracks.find((track) => track.kind === "video" && track.ordinal === 2);
    if (!addedTrack) throw new Error("missing added track");
    value(await engine.sequences.rename(sequence.sequenceId, "Target Cut"));
    value(await engine.prompts.record({ surface: "chat", prompt: "target prompt" }));
    value(await engine.messages.append({ role: "user", body: { text: "target message" } }));
    const target = engine.head;

    value(await engine.book.rename("later-book"));
    value(await engine.files.write(artifact.artifactId, "original.md", "later"));
    value(await engine.metadata.artifacts.write(artifact.artifactId, "caption", "later"));
    value(await engine.entities.delete(entity.id));
    value(await engine.artifacts.create({ kind: "image", slug: "img-later" }));
    value(await engine.sequences.removeTrack(addedTrack.trackId));
    value(await engine.sequences.rename(sequence.sequenceId, "Later Cut"));
    value(await engine.prompts.record({ surface: "chat", prompt: "later prompt" }));
    value(await engine.messages.append({ role: "assistant", body: { text: "later message" } }));

    value(await engine.history.restore(target));
    expect(engine.book.get().slug).toBe("demo");
    expect(
      value(await engine.files.read(artifact.artifactId, "original.md")).toString(),
    ).toBe("target");
    expect(
      value(await engine.metadata.artifacts.read<string>(artifact.artifactId, "caption")),
    ).toBe("target caption");
    expect(engine.entities.list()).toHaveLength(1);
    expect(engine.notebooks.list()).toHaveLength(1);
    expect(engine.artifacts.list()).toHaveLength(1);
    expect(value(engine.prompts.list()).map((entry) => entry.prompt)).toEqual([
      "target prompt",
    ]);
    expect(value(engine.messages.list<{ text: string }>()).map((message) => message.body.text)).toEqual([
      "target message",
    ]);
    const restored = engine.sequences.getPrimary();
    expect(restored.name).toBe("Target Cut");
    expect(
      restored.tracks
        .filter((track) => track.kind === "video")
        .map((track) => track.trackId),
    ).toContain(addedTrack.trackId);
    engine.close();
  });

  it("restore reloads every semantic table from the target revision", async () => {
    const { engine, dataDir } = await setup();
    const target = engine.head;

    // Dirty every table family the APIs can reach: sequences, tracks,
    // prompts, messages, metadata, entities, notebooks, and artifacts.
    value(await engine.artifacts.create({ kind: "image", slug: "img-extra" }));
    value(await engine.entities.create("scene", "Later Scene"));
    value(await engine.notebooks.create("Later Notebook"));
    value(await engine.metadata.book.write("theme", { mode: "dark" }));
    const sequence = engine.sequences.getPrimary();
    value(await engine.sequences.addTrack(sequence.sequenceId, { kind: "audio" }));
    value(await engine.prompts.record({ surface: "chat", prompt: "later" }));
    value(await engine.messages.append({ role: "user", body: {} }));

    value(await engine.history.restore(target));
    // Rows created after the target revision are gone again.
    expect(engine.artifacts.list()).toHaveLength(0);
    expect(
      engine.sequences.getPrimary().tracks.filter(
        (track) => track.kind === "audio",
      ),
    ).toHaveLength(4);
    engine.close();

    // The state after restore must equal the state at the target revision in
    // every semantic table, not just the tables the engine APIs read back.
    const db = new DatabaseSync(path.join(dataDir, "videobook.db"));
    const mismatched: string[] = [];
    for (const table of SEMANTIC_TABLES) {
      const current = db
        .prepare(`SELECT * FROM ${table}`)
        .all()
        .map((row) => JSON.stringify(row))
        .sort();
      const atTarget = db
        .prepare(`SELECT * FROM dolt_at_${table}(?)`)
        .all(target)
        .map((row) => JSON.stringify(row))
        .sort();
      if (JSON.stringify(current) !== JSON.stringify(atTarget)) {
        mismatched.push(table);
      }
    }
    db.close();
    expect(mismatched).toEqual([]);
  });

  it("derives history listings from structured commit messages", async () => {
    const { engine } = await setup();
    const artifact = value(
      await engine.artifacts.create({ kind: "image", slug: "img-action" }),
    );
    const written = await engine.files.write(
      artifact.artifactId,
      "original.png",
      "pixel",
    );
    if (!written.ok || !written.revision) throw new Error("missing revision");

    const revisions = engine.history.revisions();
    const latest = revisions[0]!;
    expect(latest.operation).toBe("write_file");
    expect(latest.hash).toBe(written.revision);
    expect(latest.artifactId).toBe(artifact.artifactId);
    expect(latest.artifactSlug).toBe(artifact.slug);
    expect(latest.author).toBe("Videobook");
    expect(latest.operationId).toMatch(/^[0-9a-f-]{36}$/);
    expect(latest.details).toMatchObject({
      path: "original.png",
      writeSet: [
        `artifact:${artifact.artifactId}`,
        `file:${artifact.artifactId}:original.png`,
      ],
    });
    expect(revisions[1]?.operation).toBe("create_artifact");

    const artifactRevisions = engine.history.artifact(artifact.artifactId);
    expect(artifactRevisions.map((revision) => revision.operation)).toEqual([
      "write_file",
      "create_artifact",
    ]);
    expect(
      engine.history.resolveRevision(written.revision.slice(0, 12))?.hash,
    ).toBe(written.revision);
    engine.close();
  });

  it("lists history without per-commit table diffs", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "videobook-action-history-"));
    roots.push(root);
    const context = new EngineContext({
      dataDir: path.join(root, "data"),
      workspaceDir: path.join(root, "workspace"),
      initialBookSlug: "action-history",
    });
    const history = createHistoryApi(context);
    // Seed three unrelated commits so naive revision scans would wander.
    const seed = async (operation: string): Promise<void> => {
      await context.store.semantic(
        { operation, tables: ["book_metadata"] },
        () => {
          context.store.db
            .prepare(
              `INSERT INTO book_metadata(key, value_json) VALUES (?, '{}')
               ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json`,
            )
            .run(operation);
        },
      );
    };
    await seed("seed-one");
    await seed("seed-two");
    await seed("seed-three");
    const originalDiff = context.store.diff.bind(context.store);
    let diffCalls = 0;
    context.store.diff = (from, to, table) => {
      diffCalls += 1;
      return originalDiff(from, to, table);
    };

    const revisions = history.revisions();
    expect(revisions.map((revision) => revision.operation)).toEqual([
      "seed-three",
      "seed-two",
      "seed-one",
    ]);
    expect(history.artifact(uuidv7())).toEqual([]);
    expect(diffCalls).toBe(0);
    context.store.close();
  });

  it("copies terminal jobs into job_runs audit rows", async () => {
    const { engine, dataDir } = await setup();
    const artifact = value(
      await engine.artifacts.create({ kind: "image", slug: "img-job" }),
    );
    const enqueued = engine.jobs.queue.enqueue({
      type: "generate",
      artifactId: artifact.artifactId,
      payload: { prompt: "cat" },
      artifactWorkKind: "generate",
    });
    const running = engine.jobs.queue.dequeue(process.pid, 30_000);
    expect(running?.id).toBe(enqueued.job.id);
    expect(
      await engine.jobs.queue.complete(
        enqueued.job.id,
        { result: { output: "ok" } },
        running?.fence,
      ),
    ).toBe(true);
    engine.close();

    const db = new DatabaseSync(path.join(dataDir, "videobook.db"));
    const audit = db
      .prepare("SELECT state, result_json FROM job_runs WHERE run_id=?")
      .get(enqueued.job.operationId) as { state: string; result_json: string };
    expect(audit.state).toBe("done");
    expect(JSON.parse(audit.result_json)).toEqual({ output: "ok" });
    db.close();
  });

  it("publishes CAS objects before backing up the catalog", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "videobook-backup-"));
    roots.push(root);
    const objectRoot = path.join(root, "remote-objects");
    const catalogRoot = path.join(root, "remote-catalog");
    const engine = createEngine({
      dataDir: path.join(root, "data"),
      workspaceDir: path.join(root, "workspace"),
      initialBookSlug: "backup",
      remoteObjects: fileContentStore(objectRoot),
      objectPrefix: "videobook",
      catalogBackup: { name: "backup", url: `file://${catalogRoot}` },
    });
    const artifact = value(
      await engine.artifacts.create({ kind: "image", slug: "img-cat" }),
    );
    value(await engine.files.write(artifact.artifactId, "original.png", "image bytes"));
    const manifest = value(await engine.files.manifest(artifact.artifactId));
    const objectHash = manifest.files[0]?.objectHash;
    if (!objectHash) throw new Error("Manifest did not contain an object");
    expect(value(await engine.storage.backup()).state).toBe("backed_up");
    await expect(
      stat(path.join(objectRoot, "videobook", objectHash.slice(0, 2), objectHash)),
    ).resolves.toBeDefined();
    engine.close();
  });

  it("bootstraps an existing catalog snapshot without a new initial slug", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "videobook-bootstrap-"));
    roots.push(root);
    const objectStore = fileContentStore(path.join(root, "remote-objects"));
    const sourceData = path.join(root, "source-data");
    const source = createEngine({
      dataDir: sourceData,
      workspaceDir: path.join(root, "source-workspace"),
      initialBookSlug: "source",
      remoteObjects: objectStore,
      objectPrefix: "videobook",
    });
    const artifact = value(
      await source.artifacts.create({ kind: "video", slug: "vid-cat" }),
    );
    value(await source.files.write(artifact.artifactId, "original.mp4", "remote bytes"));
    value(await source.storage.backup());
    source.close();

    const restoredData = path.join(root, "restored-data");
    await mkdir(restoredData, { recursive: true });
    await copyFile(
      path.join(sourceData, "videobook.db"),
      path.join(restoredData, "videobook.db"),
    );
    const restored = createEngine({
      dataDir: restoredData,
      workspaceDir: path.join(root, "restored-workspace"),
      remoteObjects: objectStore,
      objectPrefix: "videobook",
    });
    await restored.ready;
    expect(value(restored.artifacts.get("vid-cat")).artifactId).toBe(
      artifact.artifactId,
    );
    expect(
      value(await restored.files.read(artifact.artifactId, "original.mp4")).toString(),
    ).toBe("remote bytes");
    restored.close();
  });
});
