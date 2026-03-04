import * as path from "node:path";

import { type FsError, type Result, ok, err } from "../types.js";
import { gitMv } from "../git/mv.js";
import { commitOperation } from "../git/commit.js";
import { withGitLock } from "../git/mutex.js";
import { getHistoricalSlugs } from "../git/slugs.js";
import { slugifyName } from "./slug.js";
import { isValidAssetId, invalidInput, VALID_PREFIXES } from "../validation.js";
import { isLocked } from "../lock/query.js";

const MAX_SLUG_ATTEMPTS = 1000;

export async function renameAsset(
  projectDir: string,
  assetId: string,
  newName: string,
  gitPath?: string,
): Promise<Result<{ old_asset_id: string; new_asset_id: string }, FsError>> {
  // Strip @ prefix if present
  const cleanId = assetId.replace(/^@/, "");

  if (cleanId === "final") {
    return invalidInput(`Cannot rename singleton asset: ${cleanId}`);
  }

  if (!isValidAssetId(cleanId))
    return invalidInput(`Invalid asset ID: ${cleanId}`);

  const assetDir = path.join(projectDir, cleanId);

  if (await isLocked(assetDir)) {
    return err({ code: "LOCKED", message: `Asset is locked: ${cleanId}` });
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

    // Commit (allowEmpty for assets with no tracked files yet)
    const commitHash = await commitOperation(
      projectDir,
      "rename",
      newSlug,
      { from: cleanId },
      gitPath,
      true,
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

  return result;
}
