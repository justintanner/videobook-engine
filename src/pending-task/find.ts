import { type FsError, type Result, ok, err } from "../types.js";
import { getStateDb } from "../db/client.js";
import {
  type PendingTask,
  type PendingTaskRow,
  type GenerationError,
  type GenerationErrorRow,
  rowToPendingTask,
  rowToGenerationError,
} from "./types.js";

const PENDING_COLS =
  "asset_id, task_id, task_type, asset_dir, created_at, meta, completing, owner_id";

const ERROR_COLS = "asset_id, message, fail_code, prompt, failed_at";

export function findAllPendingTasks(
  projectDir: string,
): Result<PendingTask[], FsError> {
  const db = getStateDb(projectDir);
  try {
    const rows = db
      .prepare(`SELECT ${PENDING_COLS} FROM pending_tasks ORDER BY created_at`)
      .all() as PendingTaskRow[];
    return ok(rows.map(rowToPendingTask));
  } catch (error: unknown) {
    const e = error as { message?: string };
    return err({
      code: "IO_ERROR",
      message: e.message ?? "Failed to list pending tasks",
    });
  }
}

export function findPendingTaskByExternalId(
  projectDir: string,
  taskId: string,
): Result<PendingTask | null, FsError> {
  const db = getStateDb(projectDir);
  try {
    const row = db
      .prepare(
        `SELECT ${PENDING_COLS} FROM pending_tasks WHERE task_id = ? LIMIT 1`,
      )
      .get(taskId) as PendingTaskRow | undefined;
    return ok(row ? rowToPendingTask(row) : null);
  } catch (error: unknown) {
    const e = error as { message?: string };
    return err({
      code: "IO_ERROR",
      message: e.message ?? "Failed to look up pending task by external id",
    });
  }
}

export function findAllGenerationErrors(
  projectDir: string,
): Result<GenerationError[], FsError> {
  const db = getStateDb(projectDir);
  try {
    const rows = db
      .prepare(`SELECT ${ERROR_COLS} FROM generation_errors ORDER BY failed_at`)
      .all() as GenerationErrorRow[];
    return ok(rows.map(rowToGenerationError));
  } catch (error: unknown) {
    const e = error as { message?: string };
    return err({
      code: "IO_ERROR",
      message: e.message ?? "Failed to list generation errors",
    });
  }
}
