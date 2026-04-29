import { type FsError, type Result, ok, err } from "../types.js";
import { getStateDb } from "../db/client.js";

export function deletePendingTask(
  projectDir: string,
  assetId: string,
): Result<boolean, FsError> {
  const db = getStateDb(projectDir);
  try {
    const result = db
      .prepare("DELETE FROM pending_tasks WHERE asset_id = ?")
      .run(assetId);
    return ok(result.changes > 0);
  } catch (error: unknown) {
    const e = error as { message?: string };
    return err({
      code: "IO_ERROR",
      message: e.message ?? "Failed to delete pending task",
    });
  }
}
