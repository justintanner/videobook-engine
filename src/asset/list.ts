import * as fs from "node:fs/promises";
import * as path from "node:path";

import type { AssetEntry, AssetType } from "../types.js";
import { isValidAssetId } from "../validation.js";
import { getAssetCreationTimestamps } from "../git/timestamps.js";

function getAssetType(name: string): AssetType {
  if (name.startsWith("vid-")) return "video";
  if (name.startsWith("img-")) return "image";
  if (name.startsWith("aud-")) return "audio";
  if (name.startsWith("script-")) return "script";
  if (name === "final") return "final";
  throw new Error(`Unknown asset prefix: ${name}`);
}

export async function listAssets(
  projectDir: string,
  gitPath?: string,
): Promise<AssetEntry[]> {
  try {
    await fs.access(projectDir);
  } catch {
    return [];
  }

  const entries = await fs.readdir(projectDir, { withFileTypes: true });
  const timestampMap = await getAssetCreationTimestamps(projectDir, gitPath);
  const assets: AssetEntry[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const name = entry.name;

    if (!isValidAssetId(name)) continue;

    const assetDir = path.join(projectDir, name);

    try {
      const assetType = getAssetType(name);

      // Timestamp from git commit, fallback to directory birthtime
      const gitTs = timestampMap.get(name);
      let createdAt: string;
      if (gitTs !== undefined) {
        createdAt = new Date(gitTs * 1000).toISOString();
      } else {
        const stat = await fs.stat(assetDir);
        createdAt = new Date(stat.birthtimeMs).toISOString();
      }

      assets.push({
        id: name,
        type: assetType,
        created_at: createdAt,
        path: assetDir,
      });
    } catch (error: unknown) {
      const e = error as NodeJS.ErrnoException;
      if (e.code === "ENOENT") continue;
      throw error;
    }
  }

  assets.sort((a, b) => a.id.localeCompare(b.id));
  return assets;
}
