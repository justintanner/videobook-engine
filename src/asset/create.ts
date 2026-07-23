import * as fs from "node:fs/promises";
import * as path from "node:path";

import { type FsError, type Result, ok, err } from "../types.js";
import { CREATED_AT_FILE } from "../constants.js";
import { commitOperation } from "../git/commit.js";
import { withGitLock } from "../git/mutex.js";
import { getHistoricalSlugs } from "../git/slugs.js";
import { slugifyName, uniqueSlug } from "./slug.js";
import { isValidAssetPrefix, invalidInput } from "../validation.js";
import { getStateDb } from "../db/client.js";

const PENDING_DEADLINE_MS = 5 * 60_000;

export async function createAsset(
  projectDir: string,
  prefix: string,
  name: string,
  gitPath?: string,
): Promise<Result<{ assetId: string; path: string }, FsError>> {
  if (!isValidAssetPrefix(prefix))
    return invalidInput(`Invalid asset prefix: ${prefix}`);
  const baseSlug = slugifyName(name, prefix);
  const historicalSlugs = await getHistoricalSlugs(projectDir, gitPath);
  let assetId: string;
  try {
    assetId = await uniqueSlug(projectDir, baseSlug, historicalSlugs);
  } catch (error: unknown) {
    const e = error as Error;
    return err({ code: "IO_ERROR", message: e.message });
  }
  const assetDir = path.join(projectDir, assetId);
  await fs.mkdir(assetDir, { recursive: true });
  await fs.writeFile(
    path.join(assetDir, CREATED_AT_FILE),
    String(Math.floor(Date.now() / 1000)),
  );

  // Co-write assets row at status='pending' BEFORE the git commit: the
  // directory is already visible to listAssets, and without a row a status
  // poll during the (mutex-serialized, potentially slow) commit reads the
  // asset as an orphan "error". The 5-minute deadline catches "created but
  // never used" rows; a real handler that takes ownership writes a fresh
  // deadline via beginAssetWork.
  try {
    const db = getStateDb(projectDir);
    const now = Date.now() / 1000;
    db.prepare(
      `INSERT INTO assets (asset_id, status, meta, owner_id, owner_kind, pid, deadline_at, updated_at)
       VALUES (?, 'pending', '{}', NULL, NULL, NULL, ?, ?)
       ON CONFLICT(asset_id) DO NOTHING`,
    ).run(assetId, now + PENDING_DEADLINE_MS / 1000, now);
  } catch {
    // Tolerate races; recovery sweeps strays.
  }

  // Commit under mutex (allow-empty since dir has no tracked files yet)
  const commit = await withGitLock(projectDir, async () => {
    return commitOperation(
      projectDir,
      "create",
      assetId,
      undefined,
      gitPath,
      true,
    );
  });
  if (commit.status === "failed") {
    try {
      getStateDb(projectDir)
        .prepare(`DELETE FROM assets WHERE asset_id = ? AND status = 'pending'`)
        .run(assetId);
    } catch {
      // best-effort; the pending deadline sweeps the stray row
    }
    return err({
      code: "STORAGE_ERROR",
      message: `Failed to create asset revision: ${commit.message}`,
    });
  }

  return ok({ assetId, path: assetDir });
}
