import * as fs from "node:fs/promises";
import * as path from "node:path";

import { type FsError, type Result, ok, err } from "../types.js";
import { gitMv } from "../git/mv.js";
import { commitOperation } from "../git/commit.js";
import { withGitLock } from "../git/mutex.js";
import { withCleanWorktree } from "../git/stash.js";
import { getHistoricalSlugs } from "../git/slugs.js";
import { slugifyName } from "./slug.js";
import { isValidAssetId, invalidInput } from "../validation.js";
import { isLocked } from "../lock/query.js";
import { getStateDb } from "../db/client.js";

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

  try {
    await fs.access(assetDir);
  } catch {
    return err({ code: "NOT_FOUND", message: `Asset not found: ${cleanId}` });
  }

  if (await isLocked(path.dirname(projectDir), assetDir)) {
    return err({ code: "LOCKED", message: `Asset is locked: ${cleanId}` });
  }

  // Status gate: only block while an owner actively holds the asset (status='working').
  // 'pending' is just queued/idle and is safe to rename; lock-based gate above
  // already covers held-mutex races.
  try {
    const db = getStateDb(projectDir);
    const row = db
      .prepare("SELECT status FROM assets WHERE asset_id = ?")
      .get(cleanId) as { status: string } | undefined;
    if (row && row.status === "working") {
      return err({
        code: "LOCKED",
        message: `Asset is in-flight (status=working); rename blocked: ${cleanId}`,
      });
    }
  } catch {
    // Tolerate missing state DB; recovery sweeps strays.
  }

  // Extract prefix and build base slug — skip slugification if already a valid slug with correct prefix
  const prefix = cleanId.split("-")[0]!;
  const expectedPrefix = `${prefix}-`;
  const baseSlug =
    isValidAssetId(newName) && newName.startsWith(expectedPrefix)
      ? newName
      : slugifyName(newName, prefix);
  const historicalSlugs = await getHistoricalSlugs(projectDir, gitPath);

  // Try git mv in a loop — git mv fails if destination exists, so increment suffix and retry
  let newSlug: string | null = null;
  let candidate = baseSlug;
  let counter = 2;

  const result = await withGitLock(projectDir, async () => {
    return withCleanWorktree(
      projectDir,
      async () => {
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
        const commit = await commitOperation(
          projectDir,
          "rename",
          newSlug,
          { from: cleanId },
          gitPath,
          true,
        );

        if (commit.status === "failed") {
          // Rollback
          await gitMv(projectDir, newSlug, cleanId, gitPath);
          return err({
            code: "GIT_ERROR" as const,
            message: "Git commit failed, rename rolled back",
          });
        }

        return ok({ old_asset_id: cleanId, new_asset_id: newSlug });
      },
      gitPath,
    );
  });

  // Move the assets-row PK to the new slug.
  if (result.ok) {
    try {
      const db = getStateDb(projectDir);
      const tx = db.transaction(() => {
        db.prepare("UPDATE assets SET asset_id = ? WHERE asset_id = ?").run(
          result.value.new_asset_id,
          result.value.old_asset_id,
        );
        db.prepare(
          "UPDATE pending_tasks SET asset_id = ? WHERE asset_id = ?",
        ).run(result.value.new_asset_id, result.value.old_asset_id);
        db.prepare(
          "UPDATE generation_errors SET asset_id = ? WHERE asset_id = ?",
        ).run(result.value.new_asset_id, result.value.old_asset_id);
      });
      tx();
    } catch {
      // Tolerate; recovery sweeps strays on next boot.
    }
  }

  return result;
}
