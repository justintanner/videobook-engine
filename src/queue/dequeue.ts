import type { Database as DatabaseType } from "better-sqlite3";

import { rowToJob } from "./row.js";
import { type Job, type JobRow } from "./types.js";

const DEFAULT_LEASE_MS = 60_000;

/**
 * Atomically claim the next queued job. Returns null when the queue is empty.
 * Uses a single UPDATE…WHERE id=(SELECT…LIMIT 1) so two concurrent claimers
 * cannot both win the same row.
 */
export function dequeue(
  db: DatabaseType,
  pid: number = process.pid,
  leaseMs: number = DEFAULT_LEASE_MS,
): Job | null {
  if (!db.open) return null;
  const now = Date.now();
  const row = db
    .prepare(
      `UPDATE pending_jobs
       SET    state            = 'running',
              pid              = ?,
              started_at       = ?,
              lease_expires_at = ?,
              attempts         = attempts + 1
       WHERE  id = (
         SELECT id FROM pending_jobs
         WHERE  state = 'queued'
         ORDER  BY enqueued_at, id
         LIMIT  1
       )
       RETURNING *`,
    )
    .get(pid, now, now + leaseMs) as JobRow | undefined;
  return row ? rowToJob(row) : null;
}

export function heartbeat(
  db: DatabaseType,
  id: number,
  leaseMs: number = DEFAULT_LEASE_MS,
): boolean {
  if (!db.open) return false;
  const result = db
    .prepare(
      `UPDATE pending_jobs
       SET    lease_expires_at = ?
       WHERE  id = ? AND state IN ('running','completing')`,
    )
    .run(Date.now() + leaseMs, id);
  return result.changes > 0;
}

export const DEFAULT_LEASE_DURATION_MS = DEFAULT_LEASE_MS;
