import { createHash } from "node:crypto";
import { existsSync, linkSync, mkdirSync, statSync } from "node:fs";
import { copyFile, mkdir, readdir, rm } from "node:fs/promises";
import * as path from "node:path";

import { DatabaseSync } from "@dolthub/doltlite";
import { v7 as uuidv7 } from "uuid";

import { ObjectStore } from "./cas.js";
import { createEngine } from "./engine.js";
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
}

interface TimelineSlotRow {
  slot_id: string;
  artifact_id: string;
  ordinal: number;
  kind: string;
  source_path: string | null;
  object_hash: string | null;
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
  "timeline",
  "timeline_slots",
  "timeline_audio",
  "audio_waveforms",
  "prompt_entries",
  "messages",
  "job_runs",
] as const;

export function dryRunV4Migration(
  sourceRoot: string,
): Result<V4MigrationDryRun, EngineError> {
  let database: DatabaseSync | undefined;
  try {
    const root = path.resolve(sourceRoot);
    const databasePath = path.join(root, "data", "videobook.db");
    if (!existsSync(databasePath)) {
      return err({
        code: "NOT_FOUND",
        message: `Schema-v4 catalog not found: ${databasePath}`,
      });
    }
    database = new DatabaseSync(databasePath, { readOnly: true });
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
    const migrationKey = migrationDigest({
      sourceBookId: book.book_id,
      sourceHeadRevision,
      artifactCount,
      notebookCount,
      timelineSlotCount,
      timelineAudioCount,
      objectCount,
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
    database?.close();
  }
}

export function readV4BookIdentity(
  sourceRoot: string,
): Result<{ bookId: string; slug: string }, EngineError> {
  let database: DatabaseSync | undefined;
  try {
    database = new DatabaseSync(
      path.join(path.resolve(sourceRoot), "data", "videobook.db"),
      { readOnly: true },
    );
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
    database?.close();
  }
}

export async function migrateV4(
  request: V4MigrationRequest,
): Promise<Result<V4MigrationDryRun | V4MigrationResult, EngineError>> {
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
  const blocking = dryRun.value.issues.filter((issue) => issue.severity === "error");
  if (blocking.length > 0) {
    return err({
      code: "OBJECT_UNAVAILABLE",
      message: "Schema-v4 migration has blocking source issues",
      details: { issues: blocking },
    });
  }
  const sourceRoot = path.resolve(request.sourceRoot);
  const destinationRoot = path.resolve(request.destinationRoot);
  if (sourceRoot === destinationRoot || isInside(sourceRoot, destinationRoot)) {
    return err({
      code: "INVALID_INPUT",
      message: "Migration destination must be separate from the schema-v4 root",
    });
  }
  const destinationCheck = await emptyDestination(destinationRoot);
  if (!destinationCheck.ok) return destinationCheck;
  let sourceDatabase: DatabaseSync | undefined;
  let destinationDatabase: DatabaseSync | undefined;
  let destinationCreated = false;
  try {
    sourceDatabase = new DatabaseSync(
      path.join(sourceRoot, "data", "videobook.db"),
      { readOnly: true },
    );
    const book = sourceBook(sourceDatabase);
    const initial = createEngine({
      rootDir: destinationRoot,
      initialBookSlug: book.slug,
    });
    await initial.ready;
    initial.close();
    destinationCreated = true;
    destinationDatabase = new DatabaseSync(
      path.join(destinationRoot, "data", "videobook.db"),
    );
    destinationDatabase.exec("PRAGMA foreign_keys=OFF");
    clearFreshDestination(destinationDatabase);
    for (const table of COPY_TABLES) {
      if (table === "notebooks") {
        copyLegacyNotebooks(sourceDatabase, destinationDatabase);
      } else {
        copyTable(sourceDatabase, destinationDatabase, table);
      }
    }
    destinationDatabase
      .prepare("UPDATE engine_schema SET version=? WHERE singleton=1")
      .run(MVP_SCHEMA_VERSION);
    initializePrimarySequence(destinationDatabase, book.book_id);
    convertStillTimelineSlots(destinationDatabase);
    stageMigration(destinationDatabase);
    destinationDatabase.close();
    destinationDatabase = undefined;
    const objectCounts = await copyObjects(
      sourceDatabase,
      sourceRoot,
      destinationRoot,
    );
    sourceDatabase.close();
    sourceDatabase = undefined;
    const engine = createEngine({ rootDir: destinationRoot });
    await engine.ready;
    const reportArtifact = await engine.artifacts.create({
      kind: "script",
      slug: "migration-report",
    });
    if (!reportArtifact.ok) {
      engine.close();
      return reportArtifact;
    }
    const report = {
      ...dryRun.value,
      conversion: {
        timeline: "still-image-slots-converted; timed-media-requires-probe",
        similarity: "runtime-v4-discarded; v5-reindex-required",
        sourceRoot,
      },
    };
    const reportFile = await engine.files.write(
      reportArtifact.value.artifactId,
      "migration-report.json",
      JSON.stringify(report),
    );
    if (!reportFile.ok) {
      engine.close();
      return reportFile;
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
      engine.close();
      return audit;
    }
    if (!audit.revision) {
      engine.close();
      return err({
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
    return ok(result);
  } catch (cause) {
    sourceDatabase?.close();
    destinationDatabase?.close();
    if (destinationCreated) {
      await rm(destinationRoot, { recursive: true, force: true });
    }
    return err(migrationError(cause));
  }
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
  const objects = database
    .prepare("SELECT object_hash FROM objects ORDER BY object_hash")
    .all() as unknown as ObjectRow[];
  for (const object of objects) {
    if (!existsSync(objectPath(root, object.object_hash))) {
      issues.push({
        code: "MISSING_OBJECT",
        severity: "error",
        resource: `object:${object.object_hash}`,
        message: "Content-addressed object is missing from the schema-v4 root",
      });
    }
  }
  const timedSlots = database
    .prepare(
      `SELECT s.slot_id, a.artifact_id, a.kind
       FROM timeline_slots s
       JOIN artifacts a ON a.artifact_id=s.artifact_id
       WHERE a.kind <> 'image'
       ORDER BY s.ordinal, s.slot_id`,
    )
    .all() as unknown as Array<{
      slot_id: string;
      artifact_id: string;
      kind: string;
    }>;
  for (const slot of timedSlots) {
    issues.push({
      code: "PROBE_REQUIRED",
      severity: "warning",
      resource: `timeline-slot:${slot.slot_id}`,
      message: `${slot.kind} timeline source requires media probing before clip conversion`,
      details: { artifactId: slot.artifact_id },
    });
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
    DELETE FROM timeline;
    DELETE FROM book;
  `);
}

function copyTable(
  source: DatabaseSync,
  destination: DatabaseSync,
  table: string,
): void {
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
  for (const row of rows) {
    insert.run(...shared.map((column) => row[column] ?? null));
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
      notebook_id, name, properties_json, created_at
    ) VALUES (?, ?, ?, ?)`,
  );
  for (const row of rows) {
    insert.run(
      row.notebook_id,
      row.name,
      "{}",
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

function initializePrimarySequence(
  database: DatabaseSync,
  bookId: string,
): void {
  const timeline = database
    .prepare("SELECT render FROM timeline WHERE book_id=?")
    .get(bookId) as unknown as { render: string } | undefined;
  const render = timeline?.render ?? "landscape";
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
      track_id, sequence_id, kind, ordinal, name,
      enabled, locked, muted, solo, blend_mode
    ) VALUES (?, ?, ?, ?, ?, 1, 0, ?, ?, ?)`,
  );
  insert.run(uuidv7(), sequenceId, "video", 0, "Video 1", null, null, "normal");
  insert.run(uuidv7(), sequenceId, "video", 1, "Video 2", null, null, "normal");
  for (let ordinal = 0; ordinal < 4; ordinal += 1) {
    insert.run(
      uuidv7(),
      sequenceId,
      "audio",
      ordinal,
      `Audio ${ordinal + 1}`,
      0,
      0,
      null,
    );
  }
  insert.run(uuidv7(), sequenceId, "caption", 0, "Captions", null, null, null);
}

function convertStillTimelineSlots(database: DatabaseSync): void {
  const sequence = database
    .prepare("SELECT sequence_id FROM sequences WHERE is_primary=1")
    .get() as unknown as { sequence_id: string };
  const track = database
    .prepare(
      `SELECT track_id FROM sequence_tracks
       WHERE sequence_id=? AND kind='video' AND ordinal=0`,
    )
    .get(sequence.sequence_id) as unknown as { track_id: string };
  const rows = database
    .prepare(
      `SELECT s.slot_id, s.artifact_id, s.ordinal, a.kind,
              f.path AS source_path, f.object_hash
       FROM timeline_slots s
       JOIN artifacts a ON a.artifact_id=s.artifact_id
       LEFT JOIN artifact_files f ON f.artifact_id=a.artifact_id
       WHERE a.kind='image'
       ORDER BY s.ordinal, s.slot_id, f.path`,
    )
    .all() as unknown as TimelineSlotRow[];
  const seen = new Set<string>();
  const insertClip = database.prepare(
    `INSERT INTO sequence_clips(
      clip_id, track_id, source_kind, artifact_id, source_path,
      stream_id, object_hash, source_start_tick, source_duration_ticks,
      time_base_numerator, time_base_denominator, timeline_start_frame,
      duration_frames, speed_numerator, speed_denominator, reverse,
      audio_policy, gain_db, audio_muted, fade_in_frames, fade_out_frames,
      enabled
    ) VALUES (?, ?, 'still', ?, ?, NULL, ?, NULL, NULL, NULL, NULL,
      ?, 90, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, 1)`,
  );
  const insertTransform = database.prepare(
    `INSERT INTO clip_transforms(
      clip_id, fit, position_x, position_y, scale_x, scale_y,
      anchor_x, anchor_y, rotation_degrees, crop_top, crop_right,
      crop_bottom, crop_left, opacity, blend_mode
    ) VALUES (?, 'fit', 0, 0, 1, 1, 0.5, 0.5, 0, 0, 0, 0, 0, 1, 'normal')`,
  );
  let ordinal = 0;
  for (const row of rows) {
    if (seen.has(row.slot_id) || !row.source_path || !row.object_hash) continue;
    seen.add(row.slot_id);
    const clipId = uuidv7();
    insertClip.run(
      clipId,
      track.track_id,
      row.artifact_id,
      row.source_path,
      row.object_hash,
      ordinal * 90,
    );
    insertTransform.run(clipId);
    ordinal += 1;
  }
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
