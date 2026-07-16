import type { Database } from "better-sqlite3";

export const version = 5;
export const name = "asset_aliases";

export function up(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS asset_aliases (
      old_asset_id TEXT PRIMARY KEY,
      current_asset_id TEXT NOT NULL
    );
  `);
}
