import type { Database as DatabaseType } from "better-sqlite3";

import { fail } from "./complete.js";
import { type JobRow } from "./types.js";

interface LeasedRow {
  id: number;
  pid: number | null;
  attempts: number;
  max_attempts: number;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: unknown) {
    const e = error as NodeJS.ErrnoException;
    if (e.code === "EPERM") return true;
    return false;
  }
}

interface ReapResult {
  requeued: number;
  failed: number;
  inspected: number;
}

/**
 * Find leased jobs whose lease has expired and whose worker pid is no longer
 * alive. Re-queue them if they have retry budget left, else mark as failed.
 *
 * Live workers whose lease expired (rare — heartbeat misfire) are left for
 * one more cycle and surfaced for manual review.
 */
export function reapStaleLeases(db: DatabaseType): ReapResult {
  if (!db.open) return { requeued: 0, failed: 0, inspected: 0 };
  const now = Date.now();
  const candidates = db
    .prepare(
      `SELECT id, pid, attempts, max_attempts
       FROM   pending_jobs
       WHERE  state IN ('running','completing')
         AND  lease_expires_at IS NOT NULL
         AND  lease_expires_at < ?`,
    )
    .all(now) as LeasedRow[];

  let requeued = 0;
  let failed = 0;
  for (const row of candidates) {
    if (row.pid != null && isProcessAlive(row.pid)) continue;
    const exhausted = row.attempts >= row.max_attempts;
    if (exhausted) {
      fail(db, row.id, {
        error: { message: "lease expired and worker pid is dead", code: "lease_expired" },
        allowRetry: false,
      });
      failed += 1;
    } else {
      db.prepare(
        `UPDATE pending_jobs
         SET    state            = 'queued',
                pid              = NULL,
                lease_expires_at = NULL
         WHERE  id = ?`,
      ).run(row.id);
      requeued += 1;
    }
  }
  return { requeued, failed, inspected: candidates.length };
}

/**
 * One-shot startup sweep: jobs left in 'running' or 'completing' from a prior
 * process generation whose pid is dead become eligible for re-queue or fail.
 * This is called once on server startup before the worker loop begins.
 */
export function reapOnStartup(db: DatabaseType): ReapResult {
  if (!db.open) return { requeued: 0, failed: 0, inspected: 0 };
  const candidates = db
    .prepare(
      `SELECT id, pid, attempts, max_attempts
       FROM   pending_jobs
       WHERE  state IN ('running','completing')`,
    )
    .all() as LeasedRow[];
  // Force re-evaluation by clearing the lease so the standard reaper logic applies.
  for (const row of candidates) {
    if (row.pid != null && isProcessAlive(row.pid)) continue;
    db.prepare(
      `UPDATE pending_jobs
       SET    lease_expires_at = 0
       WHERE  id = ?`,
    ).run(row.id);
  }
  return reapStaleLeases(db);
}

export function listLeasedRows(db: DatabaseType): JobRow[] {
  return db
    .prepare(
      `SELECT * FROM pending_jobs
       WHERE  state IN ('running','completing')
       ORDER  BY started_at`,
    )
    .all() as JobRow[];
}
