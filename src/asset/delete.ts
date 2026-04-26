import * as fs from "node:fs/promises";
import * as path from "node:path";

import { type FsError, type Result, ok, err } from "../types.js";
import { commitOperation } from "../git/commit.js";
import { withGitLock } from "../git/mutex.js";
import { withCleanWorktree } from "../git/stash.js";
import { isValidAssetId, isWithinDir, invalidInput } from "../validation.js";
import { isLocked } from "../lock/query.js";
import { CLIPFIRST_DIR } from "../db/client.js";
import { getMetadataDb } from "../db/metadata-client.js";
import {
  audioWaveformExportPath,
  deleteAudioWaveformRow,
} from "../db/audio-waveforms.js";

function projectsDirOf(projectDir: string): string {
  return path.dirname(projectDir);
}

/**
 * Remove SQLite metadata rows tied to this asset, plus their canonical export
 * files. Returns the list of repo-relative paths that should be staged in the
 * delete commit alongside the asset directory.
 */
async function cleanupAssetSqliteState(
  projectDir: string,
  assetId: string,
): Promise<string[]> {
  const metadataPath = path.join(
    projectDir,
    CLIPFIRST_DIR,
    "metadata.sqlite",
  );
  try {
    const stat = await fs.stat(metadataPath);
    if (!stat.isFile()) return [];
  } catch {
    return [];
  }
  const db = getMetadataDb(projectDir);
  const before = db
    .prepare("SELECT 1 FROM audio_waveforms WHERE asset_id = ?")
    .get(assetId);
  if (!before) return [];
  deleteAudioWaveformRow(db, assetId);
  const exportRel = path.join(CLIPFIRST_DIR, "export", audioWaveformExportPath(assetId));
  try {
    await fs.unlink(path.join(projectDir, exportRel));
  } catch {
    // Already gone — fine.
  }
  return [path.join(CLIPFIRST_DIR, "metadata.sqlite"), exportRel];
}

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

  if (await isLocked(projectsDirOf(projectDir), assetDir)) {
    return err({ code: "LOCKED", message: `Asset is locked: ${assetId}` });
  }

  // Delete + commit under mutex — lock files are deleted with the directory.
  // After withCleanWorktree, stash pop may resurrect untracked files from the
  // deleted directory, so we remove any leftover directory after the lock.
  const commitHash = await withGitLock(projectDir, async () => {
    const hash = await withCleanWorktree(
      projectDir,
      async () => {
        await fs.rm(assetDir, { recursive: true, force: true });
        const extraPaths = await cleanupAssetSqliteState(projectDir, assetId);
        const paths =
          extraPaths.length > 0 ? [assetId, ...extraPaths] : undefined;
        return commitOperation(
          projectDir,
          "delete",
          assetId,
          undefined,
          gitPath,
          true,
          paths,
        );
      },
      gitPath,
    );

    // Stash pop may restore untracked files that recreate the deleted directory
    try {
      await fs.rm(assetDir, { recursive: true, force: true });
    } catch {}

    return hash;
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
