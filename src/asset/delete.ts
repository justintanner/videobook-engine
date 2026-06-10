import * as fs from "node:fs/promises";
import * as path from "node:path";

import { type FsError, type Result, ok, err } from "../types.js";
import { commitOperation } from "../git/commit.js";
import { gitExecSafe } from "../git/exec.js";
import { withGitLock } from "../git/mutex.js";
import { isValidAssetId, isWithinDir, invalidInput } from "../validation.js";
import { isLocked } from "../lock/query.js";
import { VIDEOCITY_DIR, getStateDb } from "../db/client.js";
import { getMetadataDb } from "../db/metadata-client.js";
import {
  audioWaveformExportPath,
  deleteAudioWaveformRow,
  readAudioWaveform,
  writeAudioWaveformRow,
} from "../db/audio-waveforms.js";

function projectsDirOf(projectDir: string): string {
  return path.dirname(projectDir);
}

interface AssetSqliteCleanup {
  /** Repo-relative paths to stage in the delete commit. */
  paths: string[];
  /** Undo the SQLite row delete + export unlink if the commit fails. */
  rollback: () => Promise<void>;
}

const NOOP_CLEANUP: AssetSqliteCleanup = {
  paths: [],
  rollback: async () => {},
};

/**
 * Remove SQLite metadata rows tied to this asset, plus their canonical export
 * files. Returns the repo-relative paths that should be staged in the delete
 * commit alongside the asset directory, and a rollback that restores the
 * captured row + export file should the commit fail.
 */
async function cleanupAssetSqliteState(
  projectDir: string,
  assetId: string,
): Promise<AssetSqliteCleanup> {
  const metadataPath = path.join(projectDir, VIDEOCITY_DIR, "metadata.sqlite");
  try {
    const stat = await fs.stat(metadataPath);
    if (!stat.isFile()) return NOOP_CLEANUP;
  } catch {
    return NOOP_CLEANUP;
  }
  const db = getMetadataDb(projectDir);
  const record = readAudioWaveform(db, assetId);
  if (!record) return NOOP_CLEANUP;

  const exportRel = path.join(
    VIDEOCITY_DIR,
    "export",
    audioWaveformExportPath(assetId),
  );
  const exportAbs = path.join(projectDir, exportRel);
  let exportBody: string | null = null;
  try {
    exportBody = await fs.readFile(exportAbs, "utf-8");
  } catch {
    // No export on disk — nothing to restore on rollback.
  }

  deleteAudioWaveformRow(db, assetId);
  try {
    await fs.unlink(exportAbs);
  } catch {
    // Already gone — fine.
  }

  return {
    paths: [path.join(VIDEOCITY_DIR, "metadata.sqlite"), exportRel],
    rollback: async () => {
      writeAudioWaveformRow(db, assetId, record.peaks, record.generated_at);
      if (exportBody !== null) {
        await fs.mkdir(path.dirname(exportAbs), { recursive: true });
        await fs.writeFile(exportAbs, exportBody);
      }
    },
  };
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

  // Delete + commit under mutex. Stage only this asset path plus metadata
  // cleanup exports, so unrelated dirty or untracked project files do not
  // need to be auto-stashed before deletion.
  const commit = await withGitLock(projectDir, async () => {
    const cleanup = await cleanupAssetSqliteState(projectDir, assetId);
    await fs.rm(assetDir, { recursive: true, force: true });
    const paths = [assetId, ...cleanup.paths];
    const result = await commitOperation(
      projectDir,
      "delete",
      assetId,
      undefined,
      gitPath,
      true,
      paths,
    );
    if (result.status === "failed") {
      // Commit failed — HEAD still has the asset, so restore the working tree
      // from it and undo the metadata cleanup. Untracked files in the asset
      // dir are not recoverable (they were never committed). Best-effort: if
      // the restore itself fails, the GIT_ERROR below still surfaces.
      await gitExecSafe(["checkout", "HEAD", "--", assetId], {
        cwd: projectDir,
        gitPath,
      });
      await cleanup.rollback();
    }
    return result;
  });

  const deletedAt = new Date().toISOString();

  if (commit.status === "failed") {
    return err({
      code: "GIT_ERROR",
      message: `Git commit failed for asset deletion (rolled back): ${assetId}: ${commit.message}`,
    });
  }

  // Drop state.sqlite rows for the asset (assets/pending_tasks/generation_errors).
  try {
    const db = getStateDb(projectDir);
    const tx = db.transaction(() => {
      db.prepare("DELETE FROM assets WHERE asset_id = ?").run(assetId);
      db.prepare("DELETE FROM pending_tasks WHERE asset_id = ?").run(assetId);
      db.prepare("DELETE FROM generation_errors WHERE asset_id = ?").run(
        assetId,
      );
    });
    tx();
  } catch {
    // Tolerate; recovery sweeps strays on next boot.
  }

  return ok({ deleted_at: deletedAt });
}
