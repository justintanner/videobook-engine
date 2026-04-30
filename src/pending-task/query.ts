import { getStateDb } from "../db/client.js";

/**
 * Atomic per-row owner lookup, used by sync.ts polls and by the completion job
 * at startup. Returns null if the (asset_id, task_id) row no longer exists or
 * the row's owner_id is NULL.
 *
 * This is the only allowed lookup of an owner outside of recovery — and it is
 * not "current owner by asset", it is "owner of the specific row identified by task_id".
 */
export function getPendingTaskOwner(
  projectDir: string,
  assetId: string,
  taskId: string,
): string | null {
  const db = getStateDb(projectDir);
  const row = db
    .prepare(
      "SELECT owner_id FROM pending_tasks WHERE asset_id = ? AND task_id = ?",
    )
    .get(assetId, taskId) as { owner_id: string | null } | undefined;
  return row?.owner_id ?? null;
}
