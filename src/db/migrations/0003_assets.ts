import type { Database } from "better-sqlite3";

export const version = 3;
export const name = "assets";

export function up(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS assets (
      asset_id     TEXT PRIMARY KEY,
      status       TEXT NOT NULL CHECK (status IN ('pending','working','ready','error')),
      meta         TEXT NOT NULL DEFAULT '{}',
      owner_id     TEXT,
      owner_kind   TEXT,
      pid          INTEGER,
      deadline_at  REAL,
      updated_at   REAL NOT NULL
    );
    CREATE INDEX IF NOT EXISTS assets_reaper ON assets (status, deadline_at);

    ALTER TABLE pending_tasks ADD COLUMN owner_id TEXT;
  `);
}
