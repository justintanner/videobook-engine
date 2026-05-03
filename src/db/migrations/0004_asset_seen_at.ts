import type { Database } from "better-sqlite3";

export const version = 4;
export const name = "asset_seen_at";

export function up(db: Database): void {
  db.exec(`
    ALTER TABLE assets ADD COLUMN seen_at REAL;
  `);
}
