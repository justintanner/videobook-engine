import { type FsError, type Result, ok, err } from "../types.js";
import { getStateDb } from "../db/client.js";
import type { PendingTask } from "./types.js";

export interface WritePendingTaskInput {
  assetId: string;
  taskId: string;
  taskType: PendingTask["taskType"];
  assetDir: string;
  meta?: Record<string, unknown>;
  completing?: boolean;
}

export function writePendingTask(
  projectDir: string,
  input: WritePendingTaskInput,
): Result<PendingTask, FsError> {
  const db = getStateDb(projectDir);
  const now = Date.now() / 1000;
  const meta = input.meta ?? {};
  const completing = input.completing === true ? 1 : 0;
  try {
    const tx = db.transaction(() => {
      // Clear any prior generation error for this asset so the UI doesn't show
      // a stale failure once a new task is in flight.
      db.prepare("DELETE FROM generation_errors WHERE asset_id = ?").run(
        input.assetId,
      );
      db.prepare(
        `INSERT INTO pending_tasks
           (asset_id, task_id, task_type, asset_dir, created_at, meta, completing)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(asset_id) DO UPDATE SET
           task_id    = excluded.task_id,
           task_type  = excluded.task_type,
           asset_dir  = excluded.asset_dir,
           created_at = excluded.created_at,
           meta       = excluded.meta,
           completing = excluded.completing`,
      ).run(
        input.assetId,
        input.taskId,
        input.taskType,
        input.assetDir,
        now,
        JSON.stringify(meta),
        completing,
      );
    });
    tx();
  } catch (error: unknown) {
    const e = error as { message?: string };
    return err({
      code: "IO_ERROR",
      message: e.message ?? "Failed to write pending task",
    });
  }
  return ok({
    assetId: input.assetId,
    taskId: input.taskId,
    taskType: input.taskType,
    assetDir: input.assetDir,
    createdAt: now,
    meta,
    completing: completing === 1,
  });
}

export function markPendingTaskCompleting(
  projectDir: string,
  assetId: string,
): Result<boolean, FsError> {
  const db = getStateDb(projectDir);
  try {
    const result = db
      .prepare(
        "UPDATE pending_tasks SET completing = 1 WHERE asset_id = ?",
      )
      .run(assetId);
    return ok(result.changes > 0);
  } catch (error: unknown) {
    const e = error as { message?: string };
    return err({
      code: "IO_ERROR",
      message: e.message ?? "Failed to mark pending task completing",
    });
  }
}

export function clearPendingTaskCompleting(
  projectDir: string,
  assetId: string,
): Result<boolean, FsError> {
  const db = getStateDb(projectDir);
  try {
    const result = db
      .prepare(
        "UPDATE pending_tasks SET completing = 0 WHERE asset_id = ?",
      )
      .run(assetId);
    return ok(result.changes > 0);
  } catch (error: unknown) {
    const e = error as { message?: string };
    return err({
      code: "IO_ERROR",
      message: e.message ?? "Failed to clear completing flag",
    });
  }
}
