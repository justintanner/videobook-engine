import type { Database } from "better-sqlite3";

export const version = 5;
export const name = "metadata_drop_unused";

export function up(db: Database): void {
  db.exec(`
    DROP INDEX IF EXISTS operations_committed;
    DROP TABLE IF EXISTS project_metadata;
    ALTER TABLE characters DROP COLUMN source_image_id;
    ALTER TABLE render_settings DROP COLUMN rendered_at;
  `);
}
