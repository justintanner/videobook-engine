import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";

import Database, { type Database as DatabaseType } from "better-sqlite3";

import { CLIPFIRST_DIR } from "./client.js";
import * as m0001 from "./migrations/metadata_0001_init.js";
import * as m0002 from "./migrations/metadata_0002_audio_waveforms.js";

export const METADATA_DB_FILENAME = "metadata.sqlite";

interface MetadataMigration {
  version: number;
  name: string;
  up: (db: DatabaseType) => void;
}

const METADATA_MIGRATIONS: ReadonlyArray<MetadataMigration> = [m0001, m0002];

const cache = new Map<string, DatabaseType>();

function clipfirstDir(projectDir: string): string {
  return path.join(projectDir, CLIPFIRST_DIR);
}

export function metadataDbPath(projectDir: string): string {
  return path.join(clipfirstDir(projectDir), METADATA_DB_FILENAME);
}

interface SchemaRow {
  version: number;
  name?: string;
  checksum?: string | null;
}

interface TableInfoRow {
  name: string;
}

function currentVersion(db: DatabaseType): number {
  const exists = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='schema_migrations'",
    )
    .get();
  if (!exists) return 0;
  const row = db
    .prepare("SELECT MAX(version) AS version FROM schema_migrations")
    .get() as SchemaRow | undefined;
  return row?.version ?? 0;
}

function checksumFor(migration: MetadataMigration): string {
  return createHash("sha256")
    .update(`${migration.version}:${migration.name}:${migration.up.toString()}`)
    .digest("hex");
}

function schemaMigrationsExists(db: DatabaseType): boolean {
  return Boolean(
    db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='schema_migrations'",
      )
      .get(),
  );
}

function ensureChecksumColumn(db: DatabaseType): void {
  if (!schemaMigrationsExists(db)) return;
  const columns = db
    .prepare("PRAGMA table_info(schema_migrations)")
    .all() as TableInfoRow[];
  if (columns.some((c) => c.name === "checksum")) return;
  db.prepare(
    "ALTER TABLE schema_migrations ADD COLUMN checksum TEXT NOT NULL DEFAULT ''",
  ).run();
}

function assertAppliedChecksums(db: DatabaseType): void {
  if (!schemaMigrationsExists(db)) return;
  const rows = db
    .prepare("SELECT version, name, checksum FROM schema_migrations")
    .all() as SchemaRow[];
  const byVersion = new Map(METADATA_MIGRATIONS.map((m) => [m.version, m]));
  const update = db.prepare(
    "UPDATE schema_migrations SET checksum = ? WHERE version = ?",
  );
  for (const row of rows) {
    const migration = byVersion.get(row.version);
    if (!migration) continue;
    const expected = checksumFor(migration);
    if (!row.checksum) {
      update.run(expected, row.version);
      continue;
    }
    if (row.checksum !== expected) {
      throw new Error(
        `metadata schema migration checksum mismatch for version ${row.version}`,
      );
    }
  }
}

function migrate(db: DatabaseType): void {
  ensureChecksumColumn(db);
  const at = currentVersion(db);
  for (const m of METADATA_MIGRATIONS) {
    if (m.version <= at) continue;
    const tx = db.transaction(() => {
      m.up(db);
      ensureChecksumColumn(db);
      db.prepare(
        "INSERT INTO schema_migrations (version, name, checksum, applied_at) VALUES (?, ?, ?, ?)",
      ).run(m.version, m.name, checksumFor(m), Date.now());
    });
    tx();
  }
  ensureChecksumColumn(db);
  assertAppliedChecksums(db);
}

/**
 * PRAGMAs for the committed metadata.sqlite file:
 *   journal_mode = DELETE     — keep one canonical file on disk; no -wal/-shm sidecars
 *   synchronous  = FULL       — correctness over speed for the file we commit
 *   secure_delete = OFF       — avoid zeroing freed pages (more deterministic bytes)
 *   auto_vacuum = NONE        — don't shuffle pages during normal operation
 */
function configurePragmas(db: DatabaseType): void {
  db.pragma("journal_mode = DELETE");
  db.pragma("synchronous = FULL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");
  db.pragma("secure_delete = OFF");
  db.pragma("auto_vacuum = NONE");
}

function ensureClipfirstDir(projectDir: string): void {
  fs.mkdirSync(clipfirstDir(projectDir), { recursive: true });
}

function open(projectDir: string): DatabaseType {
  ensureClipfirstDir(projectDir);
  const db = new Database(metadataDbPath(projectDir));
  configurePragmas(db);
  migrate(db);
  return db;
}

export function getMetadataDb(projectDir: string): DatabaseType {
  const key = path.resolve(projectDir);
  const cached = cache.get(key);
  if (cached && cached.open) return cached;
  const db = open(key);
  cache.set(key, db);
  return db;
}

export function closeMetadataDb(projectDir: string): void {
  const key = path.resolve(projectDir);
  const db = cache.get(key);
  if (db && db.open) db.close();
  cache.delete(key);
}

export function closeAllMetadataDbs(): void {
  for (const [, db] of cache) {
    if (db.open) db.close();
  }
  cache.clear();
}
