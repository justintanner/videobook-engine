import type { Database } from "better-sqlite3";

export const version = 1;
export const name = "init_state";

export function up(db: Database): void {
  db.exec(`
	    CREATE TABLE IF NOT EXISTS schema_migrations (
	      version    INTEGER PRIMARY KEY,
	      name       TEXT NOT NULL,
	      checksum   TEXT NOT NULL DEFAULT '',
	      applied_at INTEGER NOT NULL
	    );

    CREATE TABLE IF NOT EXISTS locks (
      asset_id    TEXT PRIMARY KEY,
      pid         INTEGER NOT NULL,
      state       TEXT,
      created_at  INTEGER NOT NULL,
      timeout_at  INTEGER NOT NULL,
      data        TEXT
    );

    CREATE TABLE IF NOT EXISTS pending_jobs (
      id                 INTEGER PRIMARY KEY AUTOINCREMENT,
      operation_id       TEXT NOT NULL,
      type               TEXT NOT NULL,
      asset_id           TEXT,
      external_task_id   TEXT,
      state              TEXT NOT NULL CHECK (state IN ('queued','running','completing','done','failed','aborted')),
      payload            TEXT NOT NULL,
      result             TEXT,
      dedupe_key         TEXT,
      enqueued_at        INTEGER NOT NULL,
      started_at         INTEGER,
      finished_at        INTEGER,
      pid                INTEGER,
      lease_expires_at   INTEGER,
      attempts           INTEGER NOT NULL DEFAULT 0,
      max_attempts       INTEGER NOT NULL DEFAULT 1,
      error              TEXT
    );
    CREATE INDEX IF NOT EXISTS pending_jobs_state ON pending_jobs (state, enqueued_at);
    CREATE INDEX IF NOT EXISTS pending_jobs_op    ON pending_jobs (operation_id);
    CREATE INDEX IF NOT EXISTS pending_jobs_lease ON pending_jobs (state, lease_expires_at);

    CREATE UNIQUE INDEX IF NOT EXISTS pending_jobs_dedupe
      ON pending_jobs (dedupe_key)
      WHERE dedupe_key IS NOT NULL
        AND (state = 'queued' OR state = 'running' OR state = 'completing');

    CREATE UNIQUE INDEX IF NOT EXISTS pending_jobs_external
      ON pending_jobs (type, external_task_id)
      WHERE external_task_id IS NOT NULL;

    CREATE TABLE IF NOT EXISTS recovery_journal (
      operation_id TEXT PRIMARY KEY,
      intent       TEXT NOT NULL,
      target       TEXT,
      scope        TEXT NOT NULL,
      status       TEXT NOT NULL CHECK (status IN ('pending','sqlite_done','git_done','complete','aborted')),
      git_hash     TEXT,
      started_at   INTEGER NOT NULL,
      updated_at   INTEGER NOT NULL,
      error        TEXT
    );
    CREATE INDEX IF NOT EXISTS recovery_journal_status ON recovery_journal (status, updated_at);

    CREATE TABLE IF NOT EXISTS process_locks (
      project_dir  TEXT PRIMARY KEY,
      pid          INTEGER NOT NULL,
      acquired_at  INTEGER NOT NULL,
      expires_at   INTEGER NOT NULL
    );
  `);
}
