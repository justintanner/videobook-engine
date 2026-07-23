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
  if (name.startsWith("char-")) return "character";
  if (name.startsWith("prm-")) return "prompt";
  if (name.startsWith("scn-")) return "scene";
  if (name.startsWith("nb-")) return "notebook";
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
  const candidates = entries.filter(
    (e) => e.isDirectory() && isValidAssetId(e.name),
  );

  // Read all asset metadata in parallel — was a sequential readCreatedAt per
  // asset, which scales linearly with project size on every listAssets call.
  const results = await Promise.all(
    candidates.map(async (entry) => {
      const name = entry.name;
      const assetDir = path.join(projectDir, name);
      try {
        const assetType = getAssetType(name);
        const created = await readCreatedAt(assetDir);
        return {
          id: name,
          type: assetType,
          created_at: new Date(created * 1000).toISOString(),
          path: assetDir,
        } satisfies AssetEntry;
      } catch (error: unknown) {
        const e = error as NodeJS.ErrnoException;
        if (e.code === "ENOENT") return null;
        throw error;
      }
    }),
  );
  const assets: AssetEntry[] = results.filter(
    (a): a is AssetEntry => a !== null,
  );

  const sortDir = options?.sort === "oldest" ? 1 : -1;
  assets.sort((a, b) => {
    const ta = new Date(a.created_at).getTime();
    const tb = new Date(b.created_at).getTime();
    return (ta - tb) * sortDir;
  });
  return assets;
}
