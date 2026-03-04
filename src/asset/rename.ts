import * as path from "node:path";

import type { FsError } from "../types.js";
import type { Result } from "../result.js";
import { ok, err } from "../result.js";
import { gitMv } from "../git/mv.js";
import { commitOperation } from "../git/commit.js";
import { withGitLock } from "../git/mutex.js";
import { getHistoricalSlugs } from "../git/slugs.js";
import { slugifyName } from "./slug.js";
import { isSafePath, invalidInput, VALID_PREFIXES } from "../validation.js";
import { acquireAllLocks, releaseAllLocks } from "../lock/acquire-all.js";

const MAX_SLUG_ATTEMPTS = 1000;

export async function renameAsset(
  projectDir: string,
  assetId: string,
  newName: string,
  gitPath?: string,
): Promise<Result<{ old_asset_id: string; new_asset_id: string }, FsError>> {
  // Strip @ prefix if present
  const cleanId = assetId.replace(/^@/, "");

  if (!isSafePath(cleanId)) return invalidInput(`Invalid asset ID: ${cleanId}`);

  if (cleanId === "final") {
    return err({
      code: "INVALID_INPUT",
      message: `Cannot rename singleton asset: ${cleanId}`,
    });
  }

  if (!VALID_PREFIXES.some((p) => cleanId.startsWith(p))) {
    return err({
      code: "INVALID_INPUT",
      message: `Invalid asset ID format: ${cleanId}`,
    });
  }

  const assetDir = path.join(projectDir, cleanId);

  // Atomically acquire all locks — prevents TOCTOU between check and rename
  const lockResult = await acquireAllLocks(assetDir);
  if (!lockResult.ok) {
    return err(lockResult.error);
  }

  // Extract prefix and build base slug
  const prefix = cleanId.split("-")[0]!;
  const baseSlug = slugifyName(newName, prefix);
  const historicalSlugs = await getHistoricalSlugs(projectDir, gitPath);

  // Try git mv in a loop — git mv fails if destination exists, so increment suffix and retry
  let newSlug: string | null = null;
  let candidate = baseSlug;
  let counter = 2;

  const result = await withGitLock(projectDir, async () => {
    for (let i = 0; i < MAX_SLUG_ATTEMPTS; i++) {
      // Skip historical slugs
      if (historicalSlugs.has(candidate)) {
        candidate = `${baseSlug}-${counter}`;
        counter++;
        continue;
      }

      // Try git mv directly — fails if destination exists
      if (await gitMv(projectDir, cleanId, candidate, gitPath)) {
        newSlug = candidate;
        break;
      }

      // Destination existed on disk, try next suffix
      candidate = `${baseSlug}-${counter}`;
      counter++;
    }

    if (!newSlug) {
      return err({
        code: "IO_ERROR" as const,
        message: `Could not find unique slug after ${MAX_SLUG_ATTEMPTS} attempts for: ${baseSlug}`,
      });
    }

    // Commit
    const commitHash = await commitOperation(
      projectDir,
      "rename",
      newSlug,
      { from: cleanId },
      gitPath,
    );

    if (commitHash === null) {
      // Rollback
      await gitMv(projectDir, newSlug, cleanId, gitPath);
      return err({
        code: "GIT_ERROR" as const,
        message: "Git commit failed, rename rolled back",
      });
    }

    return ok({ old_asset_id: cleanId, new_asset_id: newSlug });
  });

  // Release locks at the appropriate directory
  if (result.ok) {
    await releaseAllLocks(path.join(projectDir, result.value.new_asset_id));
  } else {
    await releaseAllLocks(assetDir);
  }

  return result;
}
