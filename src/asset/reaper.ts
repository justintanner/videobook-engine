import { getStateDb } from "../db/client.js";

interface ExpiredRow {
  asset_id: string;
  owner_id: string | null;
  deadline_at: number;
}

interface ReaperReport {
  reaped: number;
  pendingTasksDeleted: number;
  queuedJobsDeleted: number;
}

const REAPER_FAIL_MESSAGE = "timed out (lease expired)";
const REAPER_FAIL_CODE = "reaper_deadline_exceeded";

/**
 * One pass of the reaper. Snapshot all expired rows then per-row CAS-flip them
 * to error. CAS on (asset_id, owner_id, deadline_at) preserves any row whose
 * heartbeat extended the deadline or whose owner changed between snapshot and
 * update. For each row actually reaped, also delete the matching pending_tasks
 * row (CAS by snapshot owner_id) and any queued pending_jobs targeting the
 * asset (by asset_id column). Generation_errors rows are written for the
 * actually-reaped set only.
 */
export function runReaperPass(projectDir: string): ReaperReport {
  const db = getStateDb(projectDir);
  const now = Date.now() / 1000;

  const report: ReaperReport = {
    reaped: 0,
    pendingTasksDeleted: 0,
    queuedJobsDeleted: 0,
  };

  const tx = db.transaction(() => {
    const expired = db
      .prepare(
        `SELECT asset_id, owner_id, deadline_at
           FROM assets
          WHERE status IN ('working','pending')
            AND deadline_at IS NOT NULL
            AND deadline_at < ?`,
      )
      .all(now) as ExpiredRow[];

    if (expired.length === 0) return;

    const updateOne = db.prepare(
      `UPDATE assets
          SET status='error',
              meta=json_set(COALESCE(meta,'{}'),
                            '$.error',
                            json_object('message', ?, 'code', ?)),
              owner_id=NULL,
              owner_kind=NULL,
              pid=NULL,
              deadline_at=NULL,
              updated_at=?
        WHERE asset_id=?
          AND status IN ('working','pending')
          AND deadline_at = ?
          AND ((owner_id IS NULL AND ? IS NULL) OR owner_id = ?)`,
    );

    const deletePending = db.prepare(
      `DELETE FROM pending_tasks WHERE asset_id=? AND owner_id=?`,
    );
    const deleteQueued = db.prepare(
      `DELETE FROM pending_jobs WHERE state='queued' AND asset_id=?`,
    );
    const insertErr = db.prepare(
      `INSERT INTO generation_errors (asset_id, message, fail_code, prompt, failed_at)
       VALUES (?, ?, ?, NULL, ?)
       ON CONFLICT(asset_id) DO UPDATE SET
         message=excluded.message, fail_code=excluded.fail_code, failed_at=excluded.failed_at`,
    );

    for (const row of expired) {
      const result = updateOne.run(
        REAPER_FAIL_MESSAGE,
        REAPER_FAIL_CODE,
        now,
        row.asset_id,
        row.deadline_at,
        row.owner_id,
        row.owner_id,
      );
      if (result.changes === 0) continue;
      report.reaped++;

      if (row.owner_id !== null) {
        const dp = deletePending.run(row.asset_id, row.owner_id);
        report.pendingTasksDeleted += dp.changes;
      }
      const dq = deleteQueued.run(row.asset_id);
      report.queuedJobsDeleted += dq.changes;
      insertErr.run(row.asset_id, REAPER_FAIL_MESSAGE, REAPER_FAIL_CODE, now);
    }
  });

  tx();
  return report;
}

export interface ReaperHandle {
  stop: () => void;
}

export function startAssetReaper(
  projectDir: string,
  opts: { intervalMs: number },
): ReaperHandle {
  const handle = setInterval(() => {
    try {
      runReaperPass(projectDir);
    } catch (error: unknown) {
      const e = error as Error;
      // eslint-disable-next-line no-console
      console.error(`[reaper] pass failed: ${e.message}`);
    }
  }, opts.intervalMs);
  if (typeof handle.unref === "function") handle.unref();
  return {
    stop: () => clearInterval(handle),
  };
}
