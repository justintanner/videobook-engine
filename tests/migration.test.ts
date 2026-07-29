import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";

import { DatabaseSync } from "@dolthub/doltlite";
import { v7 as uuidv7 } from "uuid";
import { afterEach, describe, expect, it } from "vitest";

import {
  createEngine,
  dryRunV4Migration,
  migrateV4,
} from "../src/index.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) =>
      rm(root, { recursive: true, force: true, maxRetries: 3 })
    ),
  );
});

async function fixture(options: {
  image?: boolean;
  missingObject?: boolean;
} = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "videobook-v4-source-"));
  roots.push(root);
  const dataDir = path.join(root, "data");
  await mkdir(dataDir, { recursive: true });
  const databasePath = path.join(dataDir, "videobook.db");
  const database = new DatabaseSync(databasePath);
  database.exec(V4_FIXTURE_SCHEMA);
  const bookId = uuidv7();
  const notebookId = uuidv7();
  const cellId = uuidv7();
  database
    .prepare("INSERT INTO engine_schema VALUES (1, 4, 1)")
    .run();
  database
    .prepare("INSERT INTO book VALUES (?, 'migration-fixture', 1)")
    .run(bookId);
  database
    .prepare("INSERT INTO notebooks VALUES (?, 'Main', '{}', 1)")
    .run(notebookId);
  database
    .prepare(
      `INSERT INTO cells VALUES (
        ?, ?, 'prompt', 'Opening', 40, 40,
        NULL, 'A lighthouse', NULL, '{}', NULL
      )`,
    )
    .run(notebookId, cellId);
  database
    .prepare("INSERT INTO timeline VALUES (?, 'square')")
    .run(bookId);
  let artifactId: string | undefined;
  let objectHash: string | undefined;
  if (options.image) {
    artifactId = uuidv7();
    const bytes = Buffer.from("migration image");
    objectHash = createHash("sha256").update(bytes).digest("hex");
    database
      .prepare("INSERT INTO artifacts VALUES (?, 'img-lighthouse', 'image', 1)")
      .run(artifactId);
    database
      .prepare("INSERT INTO objects VALUES (?, ?, 1)")
      .run(objectHash, bytes.byteLength);
    database
      .prepare("INSERT INTO artifact_files VALUES (?, 'original.jpg', ?, 1, 1)")
      .run(artifactId, objectHash);
    database
      .prepare("INSERT INTO timeline_slots VALUES (?, ?, 0, NULL, NULL, NULL)")
      .run(uuidv7(), artifactId);
    if (!options.missingObject) {
      const objectDir = path.join(dataDir, "objects", "sha256", objectHash.slice(0, 2));
      await mkdir(objectDir, { recursive: true });
      await writeFile(path.join(objectDir, objectHash), bytes);
    }
  }
  database.prepare("SELECT dolt_add('.') AS result").get();
  database.prepare("SELECT dolt_commit('-m', 'Schema v4 fixture') AS hash").get();
  database.close();
  return { root, databasePath, bookId, notebookId, cellId, artifactId, objectHash };
}

function value<T>(
  result:
    | { ok: true; value: T }
    | { ok: false; error: { message: string } },
): T {
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

describe("schema-v4 copy-forward migration", () => {
  it("dry-runs and migrates current state without changing the source", async () => {
    const source = await fixture({ image: true });
    const destination = await mkdtemp(path.join(tmpdir(), "videobook-v5-parent-"));
    roots.push(destination);
    const destinationRoot = path.join(destination, source.bookId);
    const dryRun = value(dryRunV4Migration(source.root));
    expect(dryRun).toMatchObject({
      sourceSchemaVersion: 4,
      destinationSchemaVersion: 16,
      sourceBookId: source.bookId,
      artifactCount: 1,
      notebookCount: 1,
      timelineSlotCount: 1,
      objectCount: 1,
      estimatedReindexArtifacts: 1,
    });
    expect(dryRun.migrationKey).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(dryRun.issues).toEqual([
      expect.objectContaining({ code: "REINDEX_REQUIRED", severity: "warning" }),
    ]);
    const migrated = value(await migrateV4({
      sourceRoot: source.root,
      destinationRoot,
      dryRun: false,
      expectedSourceBookId: source.bookId,
      expectedSourceHead: dryRun.sourceHeadRevision,
    }));
    if (!("destinationBookId" in migrated)) throw new Error("Expected migration result");
    expect(migrated).toMatchObject({
      destinationBookId: source.bookId,
      copiedObjectCount: 1,
      reusedObjectCount: 0,
    });
    const engine = createEngine({ rootDir: destinationRoot });
    await engine.ready;
    expect(engine.book.get().bookId).toBe(source.bookId);
    expect(engine.notebooks.list()[0]?.id).toBe(source.notebookId);
    expect(value(engine.notebooks.read(source.notebookId))).toMatchObject({
      id: source.notebookId,
      cells: [],
      edges: [],
      properties: {},
    });
    const sequence = engine.sequences.getPrimary();
    expect(sequence).toMatchObject({ width: 1080, height: 1080 });
    expect(sequence.clips).toEqual([
      expect.objectContaining({
        source: expect.objectContaining({ artifactId: source.artifactId }),
      }),
    ]);
    expect(engine.artifacts.get(migrated.reportArtifactId).ok).toBe(true);
    expect(engine.history.resolveRevision(migrated.importActionId)).not.toBeNull();
    engine.close();
    const sourceAfter = value(dryRunV4Migration(source.root));
    expect(sourceAfter.sourceHeadRevision).toBe(dryRun.sourceHeadRevision);
    expect(sourceAfter.sourceSchemaVersion).toBe(4);
    expect(sourceAfter.sourceBookId).toBe(source.bookId);
  });

  it("blocks migration when a referenced object is missing", async () => {
    const source = await fixture({ image: true, missingObject: true });
    const dryRun = value(dryRunV4Migration(source.root));
    expect(dryRun.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "MISSING_OBJECT", severity: "error" }),
    ]));
    const destination = await mkdtemp(path.join(tmpdir(), "videobook-v5-parent-"));
    roots.push(destination);
    const result = await migrateV4({
      sourceRoot: source.root,
      destinationRoot: path.join(destination, source.bookId),
      dryRun: false,
    });
    expect(result).toMatchObject({
      ok: false,
      error: { code: "OBJECT_UNAVAILABLE" },
    });
  });
});

const V4_FIXTURE_SCHEMA = `
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
  CREATE TABLE objects (
    object_hash TEXT PRIMARY KEY,
    size_bytes INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE artifact_files (
    artifact_id TEXT NOT NULL,
    path TEXT NOT NULL,
    object_hash TEXT NOT NULL,
    mtime_ms INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY(artifact_id, path)
  );
  CREATE TABLE book_metadata (key TEXT PRIMARY KEY, value_json TEXT NOT NULL);
  CREATE TABLE artifact_metadata (
    artifact_id TEXT NOT NULL,
    key TEXT NOT NULL,
    value_json TEXT NOT NULL,
    PRIMARY KEY(artifact_id, key)
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
    properties_json TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE cells (
    notebook_id TEXT NOT NULL,
    cell_id TEXT NOT NULL,
    type TEXT NOT NULL,
    title TEXT NOT NULL,
    position_x REAL NOT NULL,
    position_y REAL NOT NULL,
    entity_id TEXT,
    prompt TEXT,
    model TEXT,
    inputs_json TEXT NOT NULL,
    output_artifact_id TEXT,
    PRIMARY KEY(notebook_id, cell_id)
  );
  CREATE TABLE edges (
    notebook_id TEXT NOT NULL,
    edge_id TEXT NOT NULL,
    source_cell_id TEXT NOT NULL,
    target_cell_id TEXT NOT NULL,
    target_input TEXT NOT NULL,
    PRIMARY KEY(notebook_id, edge_id)
  );
  CREATE TABLE runs (
    run_id TEXT PRIMARY KEY,
    notebook_id TEXT NOT NULL,
    status TEXT NOT NULL,
    started_at INTEGER NOT NULL,
    completed_at INTEGER NOT NULL,
    cell_order_json TEXT NOT NULL,
    outputs_json TEXT NOT NULL,
    error TEXT
  );
  CREATE TABLE timeline (book_id TEXT PRIMARY KEY, render TEXT NOT NULL);
  CREATE TABLE timeline_slots (
    slot_id TEXT PRIMARY KEY,
    artifact_id TEXT NOT NULL,
    ordinal INTEGER NOT NULL,
    volume REAL,
    audio_fade_in REAL,
    audio_fade_out REAL
  );
  CREATE TABLE timeline_audio (
    audio_id TEXT PRIMARY KEY,
    artifact_id TEXT NOT NULL,
    ordinal INTEGER NOT NULL,
    start_frame INTEGER NOT NULL,
    duration_frames INTEGER NOT NULL,
    volume REAL,
    fade_in REAL,
    fade_out REAL
  );
  CREATE TABLE audio_waveforms (
    artifact_id TEXT PRIMARY KEY,
    peaks_json TEXT NOT NULL
  );
  CREATE TABLE prompt_entries (
    prompt_id TEXT PRIMARY KEY,
    surface TEXT NOT NULL,
    prompt TEXT NOT NULL,
    context_json TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE messages (
    message_id TEXT PRIMARY KEY,
    role TEXT NOT NULL,
    body_json TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE job_runs (
    id INTEGER PRIMARY KEY,
    operation_id TEXT NOT NULL,
    type TEXT NOT NULL,
    artifact_id TEXT,
    payload_json TEXT NOT NULL,
    result_json TEXT,
    error_json TEXT,
    started_at INTEGER,
    finished_at INTEGER NOT NULL
  );
`;
