import type { Database } from "better-sqlite3";
import { createHash } from "node:crypto";

import * as m0001 from "./migrations/0001_init.js";
import * as m0002 from "./migrations/0002_pending_tasks.js";

interface Migration {
  version: number;
  name: string;
  up: (db: Database) => void;
}

const STATE_MIGRATIONS: ReadonlyArray<Migration> = [m0001, m0002];

interface SchemaMigrationRow {
  version: number;
  name?: string;
  checksum?: string | null;
}

interface TableInfoRow {
  name: string;
}

function currentVersion(db: Database): number {
  const exists = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='schema_migrations'",
    )
    .get();
  if (!exists) return 0;
  const row = db
    .prepare("SELECT MAX(version) AS version FROM schema_migrations")
    .get() as SchemaMigrationRow | undefined;
  return row?.version ?? 0;
}

function checksumFor(migration: Migration): string {
  return createHash("sha256")
    .update(`${migration.version}:${migration.name}:${migration.up.toString()}`)
    .digest("hex");
}

function schemaMigrationsExists(db: Database): boolean {
  return Boolean(
    db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='schema_migrations'",
      )
      .get(),
  );
}

function ensureChecksumColumn(db: Database): void {
  if (!schemaMigrationsExists(db)) return;
  const columns = db
    .prepare("PRAGMA table_info(schema_migrations)")
    .all() as TableInfoRow[];
  if (columns.some((c) => c.name === "checksum")) return;
  db.prepare(
    "ALTER TABLE schema_migrations ADD COLUMN checksum TEXT NOT NULL DEFAULT ''",
  ).run();
}

function assertAppliedChecksums(db: Database): void {
  if (!schemaMigrationsExists(db)) return;
  const rows = db
    .prepare("SELECT version, name, checksum FROM schema_migrations")
    .all() as SchemaMigrationRow[];
  const byVersion = new Map(STATE_MIGRATIONS.map((m) => [m.version, m]));
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
        `state schema migration checksum mismatch for version ${row.version}`,
      );
    }
  }
}

export function migrateState(db: Database): void {
  ensureChecksumColumn(db);
  const at = currentVersion(db);
  for (const migration of STATE_MIGRATIONS) {
    if (migration.version <= at) continue;
    const tx = db.transaction(() => {
      migration.up(db);
      ensureChecksumColumn(db);
      db.prepare(
        "INSERT INTO schema_migrations (version, name, checksum, applied_at) VALUES (?, ?, ?, ?)",
      ).run(
        migration.version,
        migration.name,
        checksumFor(migration),
        Date.now(),
      );
    });
    tx();
  }
  ensureChecksumColumn(db);
  assertAppliedChecksums(db);
}

export function highestMigrationVersion(): number {
  let max = 0;
  for (const m of STATE_MIGRATIONS) if (m.version > max) max = m.version;
  return max;
}
