import * as fs from "node:fs/promises";
import * as path from "node:path";

import type { AssetEntry, AssetType } from "../types.js";
import { isValidAssetId } from "../validation.js";
import { readCreatedAt } from "../timestamps.js";

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
  options?: { sort?: "newest" | "oldest" },
): Promise<AssetEntry[]> {
  try {
    await fs.access(projectDir);
  } catch {
    return [];
  }

  const entries = await fs.readdir(projectDir, { withFileTypes: true });
  const assets: AssetEntry[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const name = entry.name;

    if (!isValidAssetId(name)) continue;

    const assetDir = path.join(projectDir, name);

    try {
      const assetType = getAssetType(name);
      const created = await readCreatedAt(assetDir);
      const createdAt = new Date(created * 1000).toISOString();

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

  const sortDir = options?.sort === "oldest" ? 1 : -1;
  assets.sort((a, b) => {
    const ta = new Date(a.created_at).getTime();
    const tb = new Date(b.created_at).getTime();
    return (ta - tb) * sortDir;
  });
  return assets;
}
