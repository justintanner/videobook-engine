import type { Database } from "better-sqlite3";
import { createHash } from "node:crypto";

import * as m0001 from "./migrations/0001_init.js";
import * as m0002 from "./migrations/0002_pending_tasks.js";
import * as m0003 from "./migrations/0003_assets.js";
import * as m0004 from "./migrations/0004_asset_seen_at.js";
import * as m0005 from "./migrations/0005_asset_aliases.js";

interface Migration {
  version: number;
  name: string;
  up: (db: Database) => void;
}

const STATE_MIGRATIONS: ReadonlyArray<Migration> = [m0001, m0002, m0003, m0004, m0005];

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
    if (!migration) {
      // An applied version this build doesn't know about means the binary was
      // rolled back past a migration (or a migration was reverted). Proceeding
      // risks silent corruption if that version is ever re-added.
      throw new Error(
        `state schema has applied migration version ${row.version} unknown to this build`,
      );
    }
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
