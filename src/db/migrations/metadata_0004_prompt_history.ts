import type { Database } from "better-sqlite3";

export const version = 4;
export const name = "metadata_prompt_history";

export function up(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS prompt_history (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      surface     TEXT NOT NULL,
      prompt      TEXT NOT NULL,
      params_json TEXT,
      created_at  INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS prompt_history_surface_ts
      ON prompt_history (surface, created_at DESC);
  `);
}
