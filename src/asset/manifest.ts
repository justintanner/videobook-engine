import * as fs from "node:fs/promises";
import * as path from "node:path";

import type { AssetManifest, AssetManifestFile, FsError } from "../types.js";
import type { Result } from "../result.js";
import { ok, err } from "../result.js";
import { isSafePath, isValidAssetId, invalidInput } from "../validation.js";

export async function getManifest(
  projectDir: string,
  assetId: string,
): Promise<Result<AssetManifest, FsError>> {
  if (!isSafePath(assetId)) return invalidInput(`Invalid asset ID: ${assetId}`);
  if (!isValidAssetId(assetId))
    return invalidInput(`Invalid asset ID format: ${assetId}`);
  const assetDir = path.join(projectDir, assetId);

  try {
    await fs.access(assetDir);
  } catch {
    return err({ code: "NOT_FOUND", message: `Asset not found: ${assetId}` });
  }

  const entries = await fs.readdir(assetDir, { withFileTypes: true });
  const files: AssetManifestFile[] = [];
  const directories: Record<string, string[]> = {};

  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.isFile()) {
      try {
        const stat = await fs.stat(path.join(assetDir, entry.name));
        const ext = path.extname(entry.name);
        files.push({
          name: entry.name,
          size_bytes: stat.size,
          extension: ext ? ext.slice(1) : null,
        });
      } catch {
        // File vanished between readdir and stat — skip it
      }
    } else if (entry.isDirectory()) {
      try {
        const dirEntries = await fs.readdir(path.join(assetDir, entry.name));
        directories[entry.name] = dirEntries
          .filter((f) => !f.startsWith("."))
          .sort();
      } catch {
        // Directory vanished — skip it
      }
    }
  }

  const manifest: AssetManifest = {
    asset_id: assetId,
    path: path.resolve(assetDir),
    file_count: files.length,
    files,
  };

  if (Object.keys(directories).length > 0) {
    manifest.directories = directories;
  }

  return ok(manifest);
}
