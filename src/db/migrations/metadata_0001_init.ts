import type { Database } from "better-sqlite3";

export const version = 1;
export const name = "metadata_init";

/**
 * Initial metadata.sqlite schema.
 *
 * Tables created here are the source-of-truth for content metadata. The DB
 * file is committed to git alongside canonical JSON exports under
 * .videocity/export/ — see src/db/export.ts for the export pipeline.
 *
 * Phase 2 ships only the entities migrated in this phase (project, timeline,
 * timeline_slots, characters, character_pins, render_settings, asset_metadata
 * fallback, operations + asset_events for audit). Asset rows and media files
 * remain on disk during Phase 2; Phase 3 promotes them.
 */
export function up(db: Database): void {
  db.exec(`
	    CREATE TABLE IF NOT EXISTS schema_migrations (
	      version    INTEGER PRIMARY KEY,
	      name       TEXT NOT NULL,
	      checksum   TEXT NOT NULL DEFAULT '',
	      applied_at INTEGER NOT NULL
	    );

    CREATE TABLE IF NOT EXISTS project (
      id          INTEGER PRIMARY KEY CHECK (id = 1),
      slug        TEXT NOT NULL,
      created_at  INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS operations (
      operation_id          TEXT PRIMARY KEY,
      intent                TEXT NOT NULL,
      scope                 TEXT NOT NULL CHECK (scope IN ('project','asset','file','schema')),
      target                TEXT,
      subject               TEXT NOT NULL,
      started_at            INTEGER NOT NULL,
      sqlite_committed_at   INTEGER
    );
    CREATE INDEX IF NOT EXISTS operations_committed ON operations (sqlite_committed_at DESC);

    CREATE TABLE IF NOT EXISTS asset_events (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      operation_id  TEXT NOT NULL,
      subject_type  TEXT NOT NULL,
      subject_id    TEXT NOT NULL,
      kind          TEXT NOT NULL,
      detail        TEXT,
      occurred_at   INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS asset_events_subject
      ON asset_events (subject_type, subject_id, occurred_at DESC);
    CREATE INDEX IF NOT EXISTS asset_events_op
      ON asset_events (operation_id);
    CREATE INDEX IF NOT EXISTS asset_events_kind
      ON asset_events (kind, occurred_at DESC);

    CREATE TABLE IF NOT EXISTS asset_metadata (
      asset_id    TEXT NOT NULL,
      meta_key    TEXT NOT NULL,
      value       TEXT NOT NULL,
      updated_at  INTEGER NOT NULL,
      PRIMARY KEY (asset_id, meta_key)
    );

    CREATE TABLE IF NOT EXISTS project_metadata (
      meta_key    TEXT PRIMARY KEY,
      value       TEXT NOT NULL,
      updated_at  INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS timeline (
      id                   INTEGER PRIMARY KEY CHECK (id = 1),
      render               TEXT NOT NULL CHECK (render IN ('landscape','portrait','square')),
      current_orientation  TEXT CHECK (current_orientation IN ('landscape','portrait','square','original'))
    );

    CREATE TABLE IF NOT EXISTS timeline_slots (
      position        INTEGER PRIMARY KEY,
      asset_id        TEXT NOT NULL,
      volume          REAL,
      audio_fade_in   REAL,
      audio_fade_out  REAL
    );

    CREATE TABLE IF NOT EXISTS characters (
      asset_id        TEXT PRIMARY KEY,
      name TEXT, age TEXT, gender TEXT, ethnicity TEXT, height TEXT, build TEXT,
      face TEXT, hair TEXT, eyes TEXT, skin TEXT, distinguishing TEXT,
      wardrobe_style TEXT, vibe TEXT, backstory TEXT,
      source_image_id TEXT,
      raw_json        TEXT
    );

    CREATE TABLE IF NOT EXISTS character_pins (
      character_id  TEXT NOT NULL,
      slot          TEXT NOT NULL CHECK (slot IN ('wardrobe','poses','outfits')),
      position      INTEGER NOT NULL,
      asset_id      TEXT NOT NULL,
      PRIMARY KEY (character_id, slot, position)
    );
    CREATE INDEX IF NOT EXISTS character_pins_asset ON character_pins (asset_id);

    CREATE TABLE IF NOT EXISTS render_settings (
      asset_id          TEXT NOT NULL,
      orientation       TEXT NOT NULL CHECK (orientation IN ('landscape','portrait','square')),
      raw_json          TEXT,
      rendered_at       INTEGER,
      PRIMARY KEY (asset_id, orientation)
    );
  `);
}
