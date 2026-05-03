import type { Database as DatabaseType } from "better-sqlite3";

import { rowToJob } from "./row.js";
import { type Job, type JobRow } from "./types.js";

const DEFAULT_LEASE_MS = 60_000;

/**
 * Atomically claim the next queued job. Returns null when the queue is empty.
 * Uses a single UPDATE…WHERE id=(SELECT…LIMIT 1) so two concurrent claimers
 * cannot both win the same row. Asset-scoped jobs are skipped while the
 * corresponding assets row has an active owner; that lets completion handlers
 * enqueue follow-up work before they release the provider lease without the
 * child job racing into beginAssetWork.
 *
 * Exception: provider-handoff inheritor jobs (currently `complete_kie_task`)
 * are explicitly designed to take over a `owner_kind='provider'` lease via
 * `pendingTasks.getOwner`, so they must dequeue despite the active owner.
 * Without this exception the inheritor and the provider lease deadlock each
 * other: the lease blocks the dequeue, and only the dequeued job can release
 * the lease.
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
         SELECT pending_jobs.id
         FROM pending_jobs
         LEFT JOIN assets ON assets.asset_id = pending_jobs.asset_id
         WHERE pending_jobs.state = 'queued'
           AND (
             pending_jobs.asset_id IS NULL
             OR assets.owner_id IS NULL
             OR (
               pending_jobs.type = 'complete_kie_task'
               AND assets.owner_kind = 'provider'
             )
           )
         ORDER BY pending_jobs.enqueued_at, pending_jobs.id
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
