import * as path from "node:path";

import { type FsError, type Result, ok, err } from "../types.js";
import { getStateDb } from "../db/client.js";
import {
  type FailureInfo,
  type GenerationError,
  type GenerationErrorRow,
  rowToGenerationError,
} from "./types.js";
import { recoverAssetRow } from "../asset/recover.js";

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

export async function clearGenerationError(
  projectDir: string,
  assetId: string,
): Promise<Result<boolean, FsError>> {
  const db = getStateDb(projectDir);
  let cleared = 0;
  try {
    const result = db
      .prepare("DELETE FROM generation_errors WHERE asset_id = ?")
      .run(assetId);
    cleared = result.changes;
  } catch (error: unknown) {
    const e = error as { message?: string };
    return err({
      code: "IO_ERROR",
      message: e.message ?? "Failed to clear generation error",
    });
  }
  if (cleared > 0) {
    // Re-derive the assets row from disk + remaining tables. Cleared error
    // on a media-less asset reverts to 'pending', not 'ready'.
    await recoverAssetRow(projectDir, path.dirname(projectDir), assetId);
  }
  return ok(cleared > 0);
}
