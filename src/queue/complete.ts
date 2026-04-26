import type { Database as DatabaseType } from "better-sqlite3";

import { type CompleteOptions, type FailOptions } from "./types.js";

function ensureOpen(db: DatabaseType): boolean {
  return db.open;
}

export function complete(
  db: DatabaseType,
  id: number,
  opts: CompleteOptions = {},
): void {
  if (!ensureOpen(db)) return;
  const result = opts.result === undefined ? null : JSON.stringify(opts.result);
  db.prepare(
    `UPDATE pending_jobs
     SET    state            = 'done',
            finished_at      = ?,
            lease_expires_at = NULL,
            result           = ?,
            error            = NULL
     WHERE  id = ?`,
  ).run(Date.now(), result, id);
}

export function fail(db: DatabaseType, id: number, opts: FailOptions): void {
  if (!ensureOpen(db)) return;
  const allowRetry = opts.allowRetry !== false;
  const errorJson = JSON.stringify(opts.error);
  const row = db
    .prepare(`SELECT attempts, max_attempts FROM pending_jobs WHERE id = ?`)
    .get(id) as { attempts: number; max_attempts: number } | undefined;
  if (!row) return;

  const exhausted = row.attempts >= row.max_attempts;
  if (allowRetry && !exhausted) {
    db.prepare(
      `UPDATE pending_jobs
       SET    state            = 'queued',
              pid              = NULL,
              lease_expires_at = NULL,
              error            = ?
       WHERE  id = ?`,
    ).run(errorJson, id);
    return;
  }

  db.prepare(
    `UPDATE pending_jobs
     SET    state            = 'failed',
            finished_at      = ?,
            lease_expires_at = NULL,
            error            = ?
     WHERE  id = ?`,
  ).run(Date.now(), errorJson, id);
}

export function abort(db: DatabaseType, id: number, reason: string): void {
  if (!ensureOpen(db)) return;
  db.prepare(
    `UPDATE pending_jobs
     SET    state            = 'aborted',
            finished_at      = ?,
            lease_expires_at = NULL,
            error            = ?
     WHERE  id = ?`,
  ).run(Date.now(), JSON.stringify({ message: reason, code: "aborted" }), id);
}

export function markCompleting(db: DatabaseType, id: number): void {
  if (!ensureOpen(db)) return;
  db.prepare(
    `UPDATE pending_jobs
     SET    state = 'completing'
     WHERE  id = ?`,
  ).run(id);
}
