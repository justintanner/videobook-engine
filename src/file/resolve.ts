import * as fs from "node:fs/promises";
import * as path from "node:path";

import { type FsError, type Result, ok, err } from "../types.js";
import { isSafePath, isWithinDir, invalidInput } from "../validation.js";

import { getStateDb } from "../db/client.js";

export async function resolveAssetDir(
  projectDir: string,
  assetId: string,
): Promise<Result<string, FsError>> {
  if (!isSafePath(assetId)) return invalidInput(`Invalid asset ID: ${assetId}`);

  const assetDir = path.join(projectDir, assetId);
  if (!isWithinDir(projectDir, assetDir))
    return invalidInput("Path escapes project directory");

  try {
    await fs.access(assetDir);
  } catch {
    try {
      const db = getStateDb(projectDir);
      const row = db.prepare("SELECT current_asset_id FROM asset_aliases WHERE old_asset_id = ?").get(assetId) as { current_asset_id: string } | undefined;
      if (row && row.current_asset_id) {
        const newAssetDir = path.join(projectDir, row.current_asset_id);
        await fs.access(newAssetDir);
        return ok(path.resolve(newAssetDir));
      }
    } catch (e) {}
    return err({ code: "NOT_FOUND", message: `Asset not found: ${assetId}` });
  }

  return ok(path.resolve(assetDir));
}
