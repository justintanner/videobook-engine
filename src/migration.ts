import { createHash } from "node:crypto";
import { createReadStream, existsSync, linkSync, mkdirSync, statSync } from "node:fs";
import { copyFile, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, rmdir, writeFile } from "node:fs/promises";
import * as path from "node:path";
import { setImmediate as yieldTurn } from "node:timers/promises";

import { DatabaseSync } from "@dolthub/doltlite";
import { v7 as uuidv7 } from "uuid";

import { ObjectStore } from "./cas.js";
import { createEngine } from "./engine.js";
import { initialOrderKeys } from "./order-keys.js";
import { legacyNotebookPlan } from "./migration-notebooks.js";
import { legacyReferenceIssues, legacyStateSummary } from "./migration-validation.js";
import { convertLegacyTimeline, legacyTimelinePlan } from "./migration-timeline.js";
import { openV4SourceSnapshot } from "./migration-source.js";
import { EngineFault } from "./store.js";
import type {
  EngineError,
  Result,
} from "./engine-types.js";
import {
  err,
  ok,
} from "./engine-types.js";
import type {
  MigrationIssue,
  V4MigrationDryRun,
  V4MigrationRequest,
  V4MigrationResult,
} from "./mvp-contracts.js";
import {
  MVP_CONTRACT_VERSION,
  MVP_LEGACY_SCHEMA_VERSION,
  MVP_SCHEMA_VERSION,
} from "./mvp-contracts.js";
import { SEMANTIC_TABLES } from "./schema.js";

interface SchemaRow {
  version: number;
}

interface BookRow {
  book_id: string;
  slug: string;
}

interface ObjectRow {
  object_hash: string;
  size_bytes: number;
}

type SqlValue = null | string | number | bigint | Uint8Array;
type SqlRow = Record<string, SqlValue>;

const COPY_TABLES = [
  "book",
  "artifacts",
  "objects",
  "artifact_files",
  "book_metadata",
  "artifact_metadata",
  "entities",
  "notebooks",
  "runs",
  "audio_waveforms",
  "prompt_entries",
  "messages",
] as const;

export function dryRunV4Migration(
  sourceRoot: string,
): Result<V4MigrationDryRun, EngineError> {
  let snapshot: ReturnType<typeof openV4SourceSnapshot> | undefined;
  try {
    const root = path.resolve(sourceRoot);
    const databasePath = path.join(root, "data", "videobook.db");
    if (!existsSync(databasePath)) {
      return err({
        code: "NOT_FOUND",
        message: `Schema-v4 catalog not found: ${databasePath}`,
      });
    }
    snapshot = openV4SourceSnapshot(root);
    const database = snapshot.database;
    const schema = database
      .prepare("SELECT version FROM engine_schema WHERE singleton=1")
      .get() as unknown as SchemaRow | undefined;
    if (schema?.version !== MVP_LEGACY_SCHEMA_VERSION) {
      return err({
        code: "SCHEMA_INCOMPATIBLE",
        message: `Expected schema ${MVP_LEGACY_SCHEMA_VERSION}; found ${schema?.version ?? "unknown"}`,
      });
    }
    const book = sourceBook(database);
    const sourceHeadRevision =
      database.doltLog({ limit: 1 })[0]?.commit_hash ?? "";
    const artifactCount = count(database, "artifacts");
    const notebookCount = count(database, "notebooks");
    const timelineSlotCount = count(database, "timeline_slots");
    const timelineAudioCount = count(database, "timeline_audio");
    const objectCount = count(database, "objects");
    const issues = migrationIssues(database, root, book.book_id);
    const currentState = legacyStateSummary(database);
    const migrationKey = migrationDigest({
      conversionVersion: 2,
      destinationSchemaVersion: MVP_SCHEMA_VERSION,
      sourceBookId: book.book_id,
      sourceHeadRevision,
      artifactCount,
      notebookCount,
      timelineSlotCount,
      timelineAudioCount,
      objectCount,
      currentState: currentState.digest,
    });
    return ok({
      contractVersion: MVP_CONTRACT_VERSION,
      sourceSchemaVersion: MVP_LEGACY_SCHEMA_VERSION,
      destinationSchemaVersion: MVP_SCHEMA_VERSION,
      sourceBookId: book.book_id,
      sourceHeadRevision,
      artifactCount,
      notebookCount,
      timelineSlotCount,
      timelineAudioCount,
      objectCount,
      estimatedReindexArtifacts: artifactCount,
      issues,
      migrationKey,
    });
  } catch (cause) {
    return err(migrationError(cause));
  } finally {
    snapshot?.close();
  }
}

export function readV4BookIdentity(
  sourceRoot: string,
): Result<{ bookId: string; slug: string }, EngineError> {
  let snapshot: ReturnType<typeof openV4SourceSnapshot> | undefined;
  try {
    snapshot = openV4SourceSnapshot(path.resolve(sourceRoot));
    const database = snapshot.database;
    const schema = database
      .prepare("SELECT version FROM engine_schema WHERE singleton=1")
      .get() as unknown as SchemaRow | undefined;
    if (schema?.version !== MVP_LEGACY_SCHEMA_VERSION) {
      return err({
        code: "SCHEMA_INCOMPATIBLE",
        message: `Expected schema ${MVP_LEGACY_SCHEMA_VERSION}; found ${schema?.version ?? "unknown"}`,
      });
    }
    const book = sourceBook(database);
    return ok({ bookId: book.book_id, slug: book.slug });
  } catch (cause) {
    return err(migrationError(cause));
  } finally {
    snapshot?.close();
  }
}

export async function migrateV4(
  request: V4MigrationRequest,
): Promise<Result<V4MigrationDryRun | V4MigrationResult, EngineError>> {
  if (request.signal?.aborted) return err({ code: "CANCELLED", message: "Schema-v4 migration cancelled" });
  const dryRun = dryRunV4Migration(request.sourceRoot);
  if (!dryRun.ok) return dryRun;
  if (
    request.expectedSourceBookId
    && request.expectedSourceBookId !== dryRun.value.sourceBookId
  ) {
    return err({
      code: "STALE_REVISION",
      message: "Schema-v4 source book identity changed after confirmation",
    });
  }
  if (
    request.expectedSourceHead
    && request.expectedSourceHead !== dryRun.value.sourceHeadRevision
  ) {
    return err({
      code: "STALE_REVISION",
      message: "Schema-v4 source head changed after confirmation",
    });
  }
  if (request.dryRun) return dryRun;
  if (request.expectedMigrationKey && request.expectedMigrationKey !== dryRun.value.migrationKey) {
    return err({ code: "STALE_REVISION", message: "Schema-v4 current state changed after confirmation" });
  }
  const blocking = dryRun.value.issues.filter((issue) => issue.severity === "error");
  if (blocking.length > 0) {
    return err({
      code: blocking.some((issue) => issue.code !== "MISSING_OBJECT" && issue.code !== "CORRUPT_OBJECT") ? "INVALID_INPUT" : "OBJECT_UNAVAILABLE",
      message: "Schema-v4 migration has blocking source issues",
      details: { issues: blocking },
    });
  }
  let sourceRoot = path.resolve(request.sourceRoot);
  let targetRoot = path.resolve(request.destinationRoot);
  if (sourceRoot === targetRoot || isInside(sourceRoot, targetRoot)) {
    return err({
      code: "INVALID_INPUT",
      message: "Migration destination must be separate from the schema-v4 root",
    });
  }
  let sourceDatabase: DatabaseSync | undefined;
  let sourceSnapshot: ReturnType<typeof openV4SourceSnapshot> | undefined;
  let destinationDatabase: DatabaseSync | undefined;
  let engine: ReturnType<typeof createEngine> | undefined;
  let destinationRoot: string | undefined;
  try {
    sourceRoot = await realpath(sourceRoot);
    if (existsSync(targetRoot) && (await lstat(targetRoot)).isSymbolicLink()) {
      return err({ code: "INVALID_INPUT", message: "Migration destination cannot be a symbolic link" });
    }
    targetRoot = await canonicalDestination(targetRoot);
    if (sourceRoot === targetRoot || isInside(sourceRoot, targetRoot)) {
      return err({ code: "INVALID_INPUT", message: "Migration destination must be separate from the schema-v4 root" });
    }
    const completed = await completedMigration(targetRoot, dryRun.value);
    if (completed) return completed;
    const destinationCheck = await emptyDestination(targetRoot);
    if (!destinationCheck.ok) return destinationCheck;
    await mkdir(path.dirname(targetRoot), { recursive: true });
    destinationRoot = await mkdtemp(`${targetRoot}.migrating-`);
    migrationProgress(request, "copy-state", 0, COPY_TABLES.length);
    sourceSnapshot = openV4SourceSnapshot(sourceRoot);
    sourceDatabase = sourceSnapshot.database;
    const book = sourceBook(sourceDatabase);
    const notebooks = legacyNotebookPlan(sourceDatabase);
    const timeline = legacyTimelinePlan(sourceDatabase);
    const legacyHistory = legacyStateSummary(sourceDatabase);
    engine = createEngine({
      rootDir: destinationRoot,
      initialBookName: book.slug,
    });
    await engine.ready;
    engine.close();
    engine = undefined;
    destinationDatabase = new DatabaseSync(
      path.join(destinationRoot, "data", "videobook.db"),
    );
    destinationDatabase.exec("PRAGMA foreign_keys=OFF");
    clearFreshDestination(destinationDatabase);
    for (const table of COPY_TABLES) {
      if (table === "notebooks") {
        copyLegacyNotebooks(sourceDatabase, destinationDatabase);
      } else if (table === "book") {
        copyLegacyBook(sourceDatabase, destinationDatabase);
      } else if (table === "artifacts") {
        copyLegacyArtifacts(sourceDatabase, destinationDatabase);
      } else {
        await copyTable(sourceDatabase, destinationDatabase, table, request.signal);
      }
      migrationProgress(request, "copy-state", COPY_TABLES.indexOf(table) + 1, COPY_TABLES.length);
      await yieldTurn();
    }
    destinationDatabase
      .prepare("UPDATE engine_schema SET version=? WHERE singleton=1")
      .run(MVP_SCHEMA_VERSION);
    initializePrimarySequence(
      destinationDatabase,
      book.book_id,
      sourceRender(sourceDatabase, book.book_id),
    );
    stageMigration(destinationDatabase);
    destinationDatabase.close();
    destinationDatabase = undefined;
    const objectCounts = await copyObjects(
      sourceDatabase,
      sourceRoot,
      destinationRoot,
      request,
    );
    sourceSnapshot.close();
    sourceSnapshot = undefined;
    sourceDatabase = undefined;
    engine = createEngine({ rootDir: destinationRoot });
    await engine.ready;
    for (const notebook of notebooks.documents) {
      const written = await engine.notebooks.write(notebook);
      if (!written.ok) throw new EngineFault(written.error);
      migrationProgress(request, "copy-notebooks", notebooks.documents.indexOf(notebook) + 1, notebooks.documents.length);
    }
    const convertedTimeline = await convertLegacyTimeline(engine, timeline,
      new ObjectStore(path.join(destinationRoot, "data", "objects", "sha256")), request);
    const reportArtifact = await engine.artifacts.create({
      kind: "script",
      label: "migration-report",
    });
    if (!reportArtifact.ok) {
      throw new EngineFault(reportArtifact.error);
    }
    const report = {
      ...dryRun.value,
      conversion: {
        timeline: convertedTimeline,
        similarity: "runtime-v4-discarded; v5-reindex-required",
        jobs: "legacy job history remains in source audit; v5 runtime job IDs start fresh",
        sourceRoot,
        notebooks: notebooks.decisions,
      },
      legacyHistory: { sourceHeadRevision: dryRun.value.sourceHeadRevision, ...legacyHistory },
    };
    const reportFile = await engine.files.write(
      reportArtifact.value.artifactId,
      "migration-report.json",
      JSON.stringify(report),
    );
    if (!reportFile.ok) {
      throw new EngineFault(reportFile.error);
    }
    // The import audit is an authored Dolt commit like every other record:
    // the audit payload lands in book_metadata and the commit hash becomes
    // the import's durable handle (importActionId).
    const audit = await engine.metadata.book.write(
      `migration.${dryRun.value.migrationKey.replaceAll(":", ".")}`,
      {
        operation: "import_schema_v4",
        migrationKey: dryRun.value.migrationKey,
        sourceBookId: dryRun.value.sourceBookId,
        sourceHeadRevision: dryRun.value.sourceHeadRevision,
        sourceSchemaVersion: MVP_LEGACY_SCHEMA_VERSION,
        destinationSchemaVersion: MVP_SCHEMA_VERSION,
        reportArtifactId: reportArtifact.value.artifactId,
      },
    );
    if (!audit.ok) {
      throw new EngineFault(audit.error);
    }
    if (!audit.revision) {
      throw new EngineFault({
        code: "STORAGE_ERROR",
        message: "Migration audit commit did not return a revision",
      });
    }
    const result: V4MigrationResult = {
      ...dryRun.value,
      destinationBookId: engine.book.get().bookId,
      destinationRevision: engine.head,
      importActionId: audit.revision,
      reportArtifactId: reportArtifact.value.artifactId,
      copiedObjectCount: objectCounts.copied,
      reusedObjectCount: objectCounts.reused,
      completedAt: Date.now(),
    };
    engine.close();
    engine = undefined;
    migrationProgress(request, "publish", 0, 1);
    const sourceAfter = dryRunV4Migration(sourceRoot);
    if (!sourceAfter.ok) throw new EngineFault(sourceAfter.error);
    if (sourceAfter.value.migrationKey !== dryRun.value.migrationKey) {
      throw new EngineFault({ code: "STALE_REVISION", message: "Schema-v4 source changed during migration" });
    }
    await writeFile(path.join(destinationRoot, "migration-v4.json"), JSON.stringify({ format: 1, result }));
    if (request.signal?.aborted) throw new EngineFault({ code: "CANCELLED", message: "Schema-v4 migration cancelled" });
    if (existsSync(targetRoot)) await rmdir(targetRoot);
    await rename(destinationRoot, targetRoot);
    destinationRoot = undefined;
    return ok(result);
  } catch (cause) {
    return err(migrationError(cause));
  } finally {
    sourceSnapshot?.close();
    destinationDatabase?.close();
    engine?.close();
    if (destinationRoot) await rm(destinationRoot, { recursive: true, force: true, maxRetries: 3 });
  }
}

async function canonicalDestination(input: string): Promise<string> {
  let ancestor = input;
  const suffix: string[] = [];
  for (;;) {
    try { return path.join(await realpath(ancestor), ...suffix.reverse()); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT" || path.dirname(ancestor) === ancestor) throw error;
      suffix.push(path.basename(ancestor));
      ancestor = path.dirname(ancestor);
    }
  }
}

async function completedMigration(root: string, source: V4MigrationDryRun): Promise<Result<V4MigrationResult, EngineError> | undefined> {
  if (!existsSync(root)) return undefined;
  if ((await lstat(root)).isSymbolicLink()) return err({ code: "INVALID_INPUT", message: "Migration destination cannot be a symbolic link" });
  let receipt: { format: number; result: V4MigrationResult };
  try { receipt = JSON.parse(await readFile(path.join(root, "migration-v4.json"), "utf8")); }
  catch { return undefined; }
  if (receipt.format !== 1 || receipt.result?.migrationKey !== source.migrationKey
    || receipt.result.destinationBookId !== source.sourceBookId) {
    return err({ code: "ALREADY_EXISTS", message: "Destination belongs to a different migration contract" });
  }
  const engine = createEngine({ rootDir: root });
  try {
    await engine.ready;
    const result = receipt.result;
    const audit = await engine.metadata.book.read<{ migrationKey: string; reportArtifactId: string }>(
      `migration.${source.migrationKey.replaceAll(":", ".")}`,
    );
    const report = await engine.files.read(result.reportArtifactId, "migration-report.json");
    if (engine.book.get().bookId !== source.sourceBookId || !audit.ok || audit.value.migrationKey !== source.migrationKey
      || audit.value.reportArtifactId !== result.reportArtifactId || !report.ok
      || JSON.parse(report.value.toString()).migrationKey !== source.migrationKey
      || !engine.history.resolveRevision(result.importActionId) || !engine.history.resolveRevision(result.destinationRevision)) {
      return err({ code: "STORAGE_ERROR", message: "Completed migration receipt does not match its catalog and report" });
    }
    return ok(result);
  } finally { engine.close(); }
}

function migrationProgress(request: V4MigrationRequest, phase: "copy-state" | "copy-objects" | "copy-notebooks" | "publish", completed: number, total: number): void {
  request.onProgress?.({ phase, completed, total });
  if (request.signal?.aborted) throw new EngineFault({ code: "CANCELLED", message: "Schema-v4 migration cancelled" });
}

function sourceBook(database: DatabaseSync): BookRow {
  const books = database
    .prepare("SELECT book_id, slug FROM book")
    .all() as unknown as BookRow[];
  if (books.length !== 1) {
    throw new Error(`Schema-v4 catalog must contain one book; found ${books.length}`);
  }
  return books[0]!;
}

function count(database: DatabaseSync, table: string): number {
  const row = database
    .prepare(`SELECT COUNT(*) AS total FROM ${table}`)
    .get() as unknown as { total: number };
  return row.total;
}

function migrationIssues(
  database: DatabaseSync,
  root: string,
  bookId: string,
): MigrationIssue[] {
  const issues: MigrationIssue[] = [];
  issues.push(...legacyReferenceIssues(database), ...legacyNotebookPlan(database).issues, ...legacyTimelinePlan(database).issues);
  const objects = database
    .prepare("SELECT object_hash, size_bytes FROM objects ORDER BY object_hash")
    .all() as unknown as ObjectRow[];
  for (const object of objects) {
    if (!/^[a-f0-9]{64}$/.test(object.object_hash)) {
      issues.push({ code: "INVALID_REFERENCE", severity: "error", resource: `object:${object.object_hash}`,
        message: "Invalid content-addressed object hash" });
      continue;
    }
    if (!existsSync(objectPath(root, object.object_hash))) {
      issues.push({
        code: "MISSING_OBJECT",
        severity: "error",
        resource: `object:${object.object_hash}`,
        message: "Content-addressed object is missing from the schema-v4 root",
      });
    } else {
      const info = statSync(objectPath(root, object.object_hash));
      if (!info.isFile() || info.size !== object.size_bytes) issues.push({ code: "CORRUPT_OBJECT", severity: "error",
        resource: `object:${object.object_hash}`, message: "Object file type or size does not match the schema-v4 catalog" });
    }
  }
  if (count(database, "artifacts") > 0) {
    issues.push({
      code: "REINDEX_REQUIRED",
      severity: "warning",
      resource: `book:${bookId}`,
      message: "Schema-v4 similarity rows are discarded and rebuilt under v5 manifests",
    });
  }
  return issues;
}

function migrationDigest(value: Record<string, string | number>): string {
  const entries = Object.entries(value).sort(([left], [right]) =>
    left.localeCompare(right)
  );
  return `sha256:${createHash("sha256")
    .update(JSON.stringify(entries))
    .digest("hex")}`;
}

async function emptyDestination(
  destinationRoot: string,
): Promise<Result<true, EngineError>> {
  if (!existsSync(destinationRoot)) return ok(true);
  const entries = await readdir(destinationRoot);
  return entries.length === 0
    ? ok(true)
    : err({
        code: "ALREADY_EXISTS",
        message: `Migration destination is not empty: ${destinationRoot}`,
      });
}

function clearFreshDestination(database: DatabaseSync): void {
  database.exec(`
    DELETE FROM sequence_tracks;
    DELETE FROM sequences;
    DELETE FROM book;
  `);
}

async function copyTable(
  source: DatabaseSync,
  destination: DatabaseSync,
  table: string,
  signal?: AbortSignal,
): Promise<void> {
  const sourceColumns = columns(source, table);
  const destinationColumns = new Set(columns(destination, table));
  const shared = sourceColumns.filter((column) => destinationColumns.has(column));
  if (shared.length === 0) return;
  const rows = source
    .prepare(`SELECT ${shared.join(", ")} FROM ${table}`)
    .all() as unknown as SqlRow[];
  if (rows.length === 0) return;
  const placeholders = shared.map(() => "?").join(", ");
  const insert = destination.prepare(
    `INSERT INTO ${table}(${shared.join(", ")}) VALUES (${placeholders})`,
  );
  for (const [ordinal, row] of rows.entries()) {
    insert.run(...shared.map((column) => row[column] ?? null));
    if (ordinal % 32 === 0) {
      await yieldTurn();
      if (signal?.aborted) throw new EngineFault({ code: "CANCELLED", message: "Schema-v4 migration cancelled" });
    }
  }
}

/**
 * Legacy schema-v4 catalogs name books and artifacts with slugs; the
 * current schema stores free-text name/label columns instead, so the old
 * slug is carried over as the display text.
 */
function copyLegacyBook(
  source: DatabaseSync,
  destination: DatabaseSync,
): void {
  const rows = source
    .prepare("SELECT book_id, slug, created_at FROM book")
    .all() as unknown as Array<{
      book_id: string;
      slug: string;
      created_at: number;
    }>;
  const insert = destination.prepare(
    "INSERT INTO book(book_id, name, created_at) VALUES (?, ?, ?)",
  );
  for (const row of rows) {
    insert.run(row.book_id, row.slug, row.created_at);
  }
}

function copyLegacyArtifacts(
  source: DatabaseSync,
  destination: DatabaseSync,
): void {
  const rows = source
    .prepare("SELECT artifact_id, slug, kind, created_at FROM artifacts")
    .all() as unknown as Array<{
      artifact_id: string;
      slug: string;
      kind: string;
      created_at: number;
    }>;
  const insert = destination.prepare(
    `INSERT INTO artifacts(artifact_id, label, kind, created_at)
     VALUES (?, ?, ?, ?)`,
  );
  for (const row of rows) {
    insert.run(row.artifact_id, row.slug, row.kind, row.created_at);
  }
}

function copyLegacyNotebooks(
  source: DatabaseSync,
  destination: DatabaseSync,
): void {
  const rows = source
    .prepare(
      `SELECT notebook_id, name, properties_json, created_at
       FROM notebooks ORDER BY notebook_id`,
    )
    .all() as unknown as Array<{
      notebook_id: string;
      name: string;
      properties_json: string;
      created_at: number;
    }>;
  const insert = destination.prepare(
    `INSERT INTO notebooks(
      notebook_id, name, created_at
    ) VALUES (?, ?, ?)`,
  );
  for (const row of rows) {
    insert.run(
      row.notebook_id,
      row.name,
      row.created_at,
    );
  }
}

function columns(database: DatabaseSync, table: string): string[] {
  return (
    database.prepare(`PRAGMA table_info(${table})`).all() as unknown as Array<{
      name: string;
    }>
  ).map((column) => column.name);
}

function sourceRender(database: DatabaseSync, bookId: string): string {
  const timeline = database
    .prepare("SELECT render FROM timeline WHERE book_id=?")
    .get(bookId) as unknown as { render: string } | undefined;
  return timeline?.render ?? "landscape";
}

function initializePrimarySequence(
  database: DatabaseSync,
  bookId: string,
  render: string,
): void {
  const [width, height] = render === "portrait"
    ? [1080, 1920]
    : render === "square"
      ? [1080, 1080]
      : [1920, 1080];
  const now = Date.now();
  const sequenceId = uuidv7();
  database.prepare(
    `INSERT INTO sequences(
      sequence_id, book_id, name, is_primary, width, height,
      pixel_aspect_numerator, pixel_aspect_denominator,
      frame_rate_numerator, frame_rate_denominator,
      audio_sample_rate_hz, audio_channel_layout,
      background_rgba_json, created_at
    ) VALUES (?, ?, 'Main', 1, ?, ?, 1, 1, 30, 1, 48000, 'stereo', ?, ?)`,
  ).run(sequenceId, bookId, width, height, "[0,0,0,1]", now);
  const insert = database.prepare(
    `INSERT INTO sequence_tracks(
      track_id, sequence_id, kind, order_key, name,
      enabled, locked, muted, solo, blend_mode
    ) VALUES (?, ?, ?, ?, ?, 1, 0, ?, ?, ?)`,
  );
  const videoKeys = initialOrderKeys(2);
  insert.run(uuidv7(), sequenceId, "video", videoKeys[0], "Video 1", null, null, "normal");
  insert.run(uuidv7(), sequenceId, "video", videoKeys[1], "Video 2", null, null, "normal");
  const audioKeys = initialOrderKeys(4);
  for (let ordinal = 0; ordinal < 4; ordinal += 1) {
    insert.run(
      uuidv7(),
      sequenceId,
      "audio",
      audioKeys[ordinal],
      `Audio ${ordinal + 1}`,
      0,
      0,
      null,
    );
  }
  insert.run(
    uuidv7(), sequenceId, "caption", initialOrderKeys(1)[0], "Captions", null, null, null,
  );
}

function stageMigration(database: DatabaseSync): void {
  for (const table of SEMANTIC_TABLES) {
    database.prepare("SELECT dolt_add(?) AS result").get(table);
  }
  const committed = database
    .prepare("SELECT dolt_commit('-m', ?) AS hash")
    .get("Import schema-v4 current state") as unknown as
    | { hash: string }
    | undefined;
  if (!committed?.hash) throw new Error("Migration commit did not return a hash");
}

async function copyObjects(
  source: DatabaseSync,
  sourceRoot: string,
  destinationRoot: string,
  request: V4MigrationRequest,
): Promise<{ copied: number; reused: number }> {
  const destinationObjects = path.join(
    destinationRoot,
    "data",
    "objects",
    "sha256",
  );
  const store = new ObjectStore(destinationObjects);
  const objects = source
    .prepare("SELECT object_hash FROM objects ORDER BY object_hash")
    .all() as unknown as ObjectRow[];
  let copied = 0;
  let reused = 0;
  migrationProgress(request, "copy-objects", 0, objects.length);
  for (const object of objects) {
    const sourcePath = objectPath(sourceRoot, object.object_hash);
    const destinationPath = store.pathFor(object.object_hash);
    if (existsSync(destinationPath)) {
      reused += 1;
      continue;
    }
    mkdirSync(path.dirname(destinationPath), { recursive: true });
    try {
      linkSync(sourcePath, destinationPath);
      copied += 1;
    } catch {
      const imported = await store.import(sourcePath);
      if (imported.hash !== object.object_hash) {
        throw new Error(`Object hash changed during migration: ${object.object_hash}`);
      }
      copied += 1;
    }
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(destinationPath, { signal: request.signal })) hash.update(chunk);
    if (hash.digest("hex") !== object.object_hash) {
      throw new EngineFault({ code: "OBJECT_UNAVAILABLE", message: `Object hash mismatch during migration: ${object.object_hash}` });
    }
    migrationProgress(request, "copy-objects", copied + reused, objects.length);
  }
  await copyWorkspaceMetadata(sourceRoot, destinationRoot);
  return { copied, reused };
}

async function copyWorkspaceMetadata(
  sourceRoot: string,
  destinationRoot: string,
): Promise<void> {
  const source = path.join(sourceRoot, "workspaces");
  if (!existsSync(source) || !statSync(source).isDirectory()) return;
  const destination = path.join(destinationRoot, "workspaces");
  await mkdir(destination, { recursive: true });
  const entries = await readdir(source, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    await copyFile(
      path.join(source, entry.name),
      path.join(destination, entry.name),
    );
  }
}

function objectPath(root: string, objectHash: string): string {
  return path.join(
    root,
    "data",
    "objects",
    "sha256",
    objectHash.slice(0, 2),
    objectHash,
  );
}

function isInside(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  return relative !== ""
    && relative !== ".."
    && !relative.startsWith(`..${path.sep}`);
}

function migrationError(cause: unknown): EngineError {
  if (cause instanceof Error && cause.name === "AbortError") return { code: "CANCELLED", message: "Schema-v4 migration cancelled" };
  if (
    typeof cause === "object"
    && cause !== null
    && "error" in cause
    && typeof cause.error === "object"
    && cause.error !== null
    && "code" in cause.error
    && "message" in cause.error
  ) {
    return cause.error as EngineError;
  }
  return {
    code: "IO_ERROR",
    message: cause instanceof Error ? cause.message : String(cause),
  };
}
