import { type FsError, type Result, ok, err } from "../types.js";
import { getStateDb } from "../db/client.js";
import { resolveLockKey } from "./key.js";

export async function releaseLock(
  projectsDir: string,
  assetDir: string,
): Promise<Result<boolean, FsError>> {
  const resolved = await resolveLockKey(projectsDir, assetDir);
  if (!resolved.ok) return resolved;
  const { projectDir, assetKey } = resolved.value;

  try {
    const db = getStateDb(projectDir);
    const result = db
      .prepare("DELETE FROM locks WHERE asset_id = ?")
      .run(assetKey);
    return ok(result.changes > 0);
  } catch (error: unknown) {
    const e = error as { message?: string };
    return err({ code: "IO_ERROR", message: e.message ?? "release failed" });
  }
}
