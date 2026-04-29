import type { Database } from "better-sqlite3";

export const version = 2;
export const name = "pending_tasks";

export function up(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS pending_tasks (
      asset_id    TEXT PRIMARY KEY,
      task_id     TEXT NOT NULL,
      task_type   TEXT NOT NULL,
      asset_dir   TEXT NOT NULL,
      created_at  REAL NOT NULL,
      meta        TEXT NOT NULL,
      completing  INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS pending_tasks_task_id ON pending_tasks (task_id);

    CREATE TABLE IF NOT EXISTS generation_errors (
      asset_id    TEXT PRIMARY KEY,
      message     TEXT NOT NULL,
      fail_code   TEXT,
      prompt      TEXT,
      failed_at   REAL NOT NULL
    );
  `);
}
