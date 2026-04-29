import { type FsError, type Result, ok, err } from "../types.js";
import { getStateDb } from "../db/client.js";
import type { FailureInfo, GenerationError } from "./types.js";

/**
 * Atomically record a generation failure: write the generation_errors row and
 * delete any pending_tasks row for the asset in one transaction. This replaces
 * the legacy two-step file dance (.generation-error.json then delete
 * .kie-task.json), which relied on write-order discipline to avoid orphaning
 * the asset.
 */
export function failPendingTask(
  projectDir: string,
  assetId: string,
  info: FailureInfo,
): Result<GenerationError, FsError> {
  const db = getStateDb(projectDir);
  const failedAt = Date.now() / 1000;
  try {
    const tx = db.transaction(() => {
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
    });
    tx();
  } catch (error: unknown) {
    const e = error as { message?: string };
    return err({
      code: "IO_ERROR",
      message: e.message ?? "Failed to record pending task failure",
    });
  }
  return ok({
    assetId,
    message: info.message,
    ...(info.failCode !== undefined ? { failCode: info.failCode } : {}),
    ...(info.prompt != null ? { prompt: info.prompt } : {}),
    failedAt,
  });
}
