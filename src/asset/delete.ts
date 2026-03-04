import * as fs from "node:fs/promises";
import * as path from "node:path";

import { type FsError, type Result, ok, err } from "../types.js";
import { commitOperation } from "../git/commit.js";
import { withGitLock } from "../git/mutex.js";
import { isValidAssetId, isWithinDir, invalidInput } from "../validation.js";
import { isLocked } from "../lock/query.js";

export async function deleteAsset(
  projectDir: string,
  assetId: string,
  gitPath?: string,
): Promise<Result<{ deleted_at: string }, FsError>> {
  if (!isValidAssetId(assetId))
    return invalidInput(`Invalid asset ID: ${assetId}`);

  const assetDir = path.join(projectDir, assetId);
  if (!isWithinDir(projectDir, assetDir))
    return invalidInput("Path escapes project directory");

  try {
    await fs.access(assetDir);
  } catch {
    return err({ code: "NOT_FOUND", message: `Asset not found: ${assetId}` });
  }

  if (await isLocked(assetDir)) {
    return err({ code: "LOCKED", message: `Asset is locked: ${assetId}` });
  }

  // Delete + commit under mutex — lock files are deleted with the directory
  const commitHash = await withGitLock(projectDir, async () => {
    await fs.rm(assetDir, { recursive: true, force: true });
    return commitOperation(
      projectDir,
      "delete",
      assetId,
      undefined,
      gitPath,
      true,
    );
  });

  const deletedAt = new Date().toISOString();

  if (commitHash === null) {
    return err({
      code: "GIT_ERROR",
      message: `Git commit failed for asset deletion: ${assetId}`,
    });
  }

  return ok({ deleted_at: deletedAt });
}
