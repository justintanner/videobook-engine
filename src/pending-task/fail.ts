import { type FsError, type Result, ok, err } from "../types.js";
import { getStateDb } from "../db/client.js";
import type { FailureInfo, GenerationError } from "./types.js";

/**
 * CAS by (asset_id, task_id). In one txn:
 *   1. Read pending_tasks row; if missing or task_id != expectedTaskId → return null.
 *   2. UPSERT generation_errors, DELETE pending_tasks, AND CAS-fail the assets
 *      row using the row's owner_id.
 * Returns the GenerationError on success or null when the (asset_id, task_id) didn't match.
 */
export function failPendingTask(
  projectDir: string,
  assetId: string,
  expectedTaskId: string | undefined,
  info: FailureInfo,
): Result<GenerationError | null, FsError> {
  const db = getStateDb(projectDir);
  const failedAt = Date.now() / 1000;
  try {
    const tx = db.transaction((): GenerationError | null => {
      const row = db
        .prepare(
          "SELECT task_id, owner_id FROM pending_tasks WHERE asset_id = ?",
        )
        .get(assetId) as
        | { task_id: string; owner_id: string | null }
        | undefined;
      // Strict CAS path: refuse if the row's task_id doesn't match expectations.
      if (expectedTaskId !== undefined) {
        if (!row || row.task_id !== expectedTaskId) return null;
      }
      // Legacy path: row may or may not exist. We always write generation_errors
      // (even with no pending_tasks row, since callers may use this to record
      // arbitrary asset failures — e.g., a queue handler crash with no provider task).

      db.prepare(
        `INSERT INTO generation_errors (asset_id, message, fail_code, prompt, failed_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(asset_id) DO UPDATE SET
           message   = excluded.message,
           fail_code = excluded.fail_code,
           prompt    = excluded.prompt,
           failed_at = excluded.failed_at`,
      ).run(
        assetId,
        info.message,
        info.failCode ?? null,
        info.prompt ?? null,
        failedAt,
      );

      db.prepare("DELETE FROM pending_tasks WHERE asset_id = ?").run(assetId);

      const errorMeta = JSON.stringify({
        message: info.message,
        code: info.failCode ?? null,
      });
      if (row?.owner_id) {
        db.prepare(
          `UPDATE assets
              SET status='error',
                  meta=json_set(COALESCE(meta,'{}'), '$.error', json(?)),
                  owner_id=NULL,
                  owner_kind=NULL,
                  pid=NULL,
                  deadline_at=NULL,
                  updated_at=?
            WHERE asset_id=? AND owner_id=?`,
        ).run(errorMeta, failedAt, assetId, row.owner_id);
      } else {
        // Legacy / no-row path: flip any working/pending row to error.
        // If no assets row exists either, this is a no-op (the row will be
        // created on next createAsset/queue-enqueue path).
        db.prepare(
          `UPDATE assets
              SET status='error',
                  meta=json_set(COALESCE(meta,'{}'), '$.error', json(?)),
                  owner_id=NULL,
                  owner_kind=NULL,
                  pid=NULL,
                  deadline_at=NULL,
                  updated_at=?
            WHERE asset_id=? AND status IN ('working','pending')`,
        ).run(errorMeta, failedAt, assetId);
      }

      return {
        assetId,
        message: info.message,
        ...(info.failCode !== undefined ? { failCode: info.failCode } : {}),
        ...(info.prompt != null ? { prompt: info.prompt } : {}),
        failedAt,
      };
    });
    return ok(tx());
  } catch (error: unknown) {
    const e = error as { message?: string };
    return err({
      code: "IO_ERROR",
      message: e.message ?? "Failed to record pending task failure",
    });
  }
}

export function forceFailPendingTask(
  projectDir: string,
  assetId: string,
  info: FailureInfo,
): Result<GenerationError | null, FsError> {
  const db = getStateDb(projectDir);
  const failedAt = Date.now() / 1000;
  try {
    const tx = db.transaction((): GenerationError | null => {
      const errorMeta = JSON.stringify({
        message: info.message,
        code: info.failCode ?? null,
      });

      const update = db
        .prepare(
          `UPDATE assets
              SET status='error',
                  meta=json_set(COALESCE(meta,'{}'), '$.error', json(?)),
                  owner_id=NULL,
                  owner_kind=NULL,
                  pid=NULL,
                  deadline_at=NULL,
                  updated_at=?
            WHERE asset_id=?
              AND status='pending'
              AND owner_id IS NULL`,
        )
        .run(errorMeta, failedAt, assetId);

      if (update.changes === 0) return null;

      db.prepare(
        `INSERT INTO generation_errors (asset_id, message, fail_code, prompt, failed_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(asset_id) DO UPDATE SET
           message   = excluded.message,
           fail_code = excluded.fail_code,
           prompt    = excluded.prompt,
           failed_at = excluded.failed_at`,
      ).run(
        assetId,
        info.message,
        info.failCode ?? null,
        info.prompt ?? null,
        failedAt,
      );

      return {
        assetId,
        message: info.message,
        ...(info.failCode !== undefined ? { failCode: info.failCode } : {}),
        ...(info.prompt != null ? { prompt: info.prompt } : {}),
        failedAt,
      };
    });
    return ok(tx());
  } catch (error: unknown) {
    const e = error as { message?: string };
    return err({
      code: "IO_ERROR",
      message: e.message ?? "Failed to force-fail pending task",
    });
  }
}
