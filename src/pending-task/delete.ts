import { type FsError, type Result, ok, err } from "../types.js";
import { getStateDb } from "../db/client.js";

/**
 * CAS by (asset_id, task_id). In one txn:
 *   1. Read pending_tasks row; if missing or task_id != expectedTaskId → return false.
 *   2. DELETE pending_tasks AND CAS-complete assets row using the row's owner_id.
 * Returns true iff the matching row was deleted (and the assets row was completed
 * if the owner still matched at write time).
 */
export function deletePendingTask(
  projectDir: string,
  assetId: string,
  expectedTaskId?: string,
): Result<boolean, FsError> {
  const db = getStateDb(projectDir);
  const now = Date.now() / 1000;
  try {
    const tx = db.transaction((): boolean => {
      const row = db
        .prepare(
          "SELECT task_id, owner_id FROM pending_tasks WHERE asset_id = ?",
        )
        .get(assetId) as
        | { task_id: string; owner_id: string | null }
        | undefined;
      if (!row) return false;
      if (expectedTaskId !== undefined && row.task_id !== expectedTaskId) {
        return false;
      }

      db.prepare("DELETE FROM pending_tasks WHERE asset_id = ?").run(assetId);

      if (row.owner_id !== null) {
        db.prepare(
          `UPDATE assets
              SET status='ready', meta='{}', owner_id=NULL, owner_kind=NULL,
                  pid=NULL, deadline_at=NULL, updated_at=?
            WHERE asset_id=? AND owner_id=?`,
        ).run(now, assetId, row.owner_id);
      } else {
        // Legacy path: no per-task owner. Best-effort: mark assets ready
        // if the row exists at status='working' and is provider-owned.
        db.prepare(
          `UPDATE assets
              SET status='ready', meta='{}', owner_id=NULL, owner_kind=NULL,
                  pid=NULL, deadline_at=NULL, updated_at=?
            WHERE asset_id=? AND status='working'`,
        ).run(now, assetId);
      }
      return true;
    });
    return ok(tx());
  } catch (error: unknown) {
    const e = error as { message?: string };
    return err({
      code: "IO_ERROR",
      message: e.message ?? "Failed to delete pending task",
    });
  }
}
