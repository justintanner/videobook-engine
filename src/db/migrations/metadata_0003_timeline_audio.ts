import type { Database } from "better-sqlite3";

export const version = 3;
export const name = "metadata_timeline_audio";

/**
 * Adds overlay audio clips to the timeline. Each clip references an `aud-*`
 * asset and is positioned at a frame offset, independent of the slot row.
 * The composition fps (30) is fixed; start_frame and duration_frames are in
 * those units.
 */
export function up(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS timeline_audio (
      id              TEXT PRIMARY KEY,
      asset_id        TEXT NOT NULL,
      start_frame     INTEGER NOT NULL,
      duration_frames INTEGER NOT NULL,
      volume          REAL,
      fade_in         REAL,
      fade_out        REAL,
      ordinal         INTEGER NOT NULL
    );
  `);
}
