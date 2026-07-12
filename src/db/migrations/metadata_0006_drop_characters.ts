import type { Database } from "better-sqlite3";

export const version = 6;
export const name = "metadata_drop_characters";

export function up(db: Database): void {
  db.exec(`
    DROP TABLE IF EXISTS character_pins;
    DROP TABLE IF EXISTS characters;
  `);
}
