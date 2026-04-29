import { type FsError, type Result, ok, err } from "../types.js";
import { getStateDb } from "../db/client.js";
import {
  type FailureInfo,
  type GenerationError,
  type GenerationErrorRow,
  rowToGenerationError,
} from "./types.js";

export function writeGenerationError(
  projectDir: string,
  assetId: string,
  info: FailureInfo,
): Result<GenerationError, FsError> {
  const db = getStateDb(projectDir);
  const failedAt = Date.now() / 1000;
  try {
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
  } catch (error: unknown) {
    const e = error as { message?: string };
    return err({
      code: "IO_ERROR",
      message: e.message ?? "Failed to write generation error",
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

export function readGenerationError(
  projectDir: string,
  assetId: string,
): Result<GenerationError | null, FsError> {
  const db = getStateDb(projectDir);
  try {
    const row = db
      .prepare(
        `SELECT asset_id, message, fail_code, prompt, failed_at
         FROM generation_errors WHERE asset_id = ?`,
      )
      .get(assetId) as GenerationErrorRow | undefined;
    return ok(row ? rowToGenerationError(row) : null);
  } catch (error: unknown) {
    const e = error as { message?: string };
    return err({
      code: "IO_ERROR",
      message: e.message ?? "Failed to read generation error",
    });
  }
}

export function clearGenerationError(
  projectDir: string,
  assetId: string,
): Result<boolean, FsError> {
  const db = getStateDb(projectDir);
  try {
    const result = db
      .prepare("DELETE FROM generation_errors WHERE asset_id = ?")
      .run(assetId);
    return ok(result.changes > 0);
  } catch (error: unknown) {
    const e = error as { message?: string };
    return err({
      code: "IO_ERROR",
      message: e.message ?? "Failed to clear generation error",
    });
  }
}
