import { type FsError, type Result, ok, err } from "../types.js";
import { getStateDb } from "../db/client.js";
import {
  type PendingTask,
  type PendingTaskRow,
  rowToPendingTask,
} from "./types.js";

export function readPendingTask(
  projectDir: string,
  assetId: string,
): Result<PendingTask | null, FsError> {
  const db = getStateDb(projectDir);
  try {
    const row = db
      .prepare(
        `SELECT asset_id, task_id, task_type, asset_dir, created_at, meta, completing, owner_id
         FROM pending_tasks WHERE asset_id = ?`,
      )
      .get(assetId) as PendingTaskRow | undefined;
    return ok(row ? rowToPendingTask(row) : null);
  } catch (error: unknown) {
    const e = error as { message?: string };
    return err({
      code: "IO_ERROR",
      message: e.message ?? "Failed to read pending task",
    });
  }
}
