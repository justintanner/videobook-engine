import * as fs from "node:fs/promises";
import * as path from "node:path";

import type { AssetEntry, AssetType } from "../types.js";
import { CREATED_AT_FILE } from "../constants.js";

function getAssetType(name: string): AssetType {
  if (name.startsWith("vid-")) return "video";
  if (name.startsWith("img-")) return "image";
  if (name.startsWith("aud-")) return "audio";
  if (name.startsWith("script-")) return "script";
  if (name === "final") return "final";
  throw new Error(`Unknown asset prefix: ${name}`);
}

async function readCreatedAt(assetDir: string): Promise<number | null> {
  try {
    const content = await fs.readFile(
      path.join(assetDir, CREATED_AT_FILE),
      "utf-8",
    );
    const val = parseFloat(content.trim());
    return isNaN(val) ? null : val;
  } catch {
    return null;
  }
}

export async function listAssets(projectDir: string): Promise<AssetEntry[]> {
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

    if (
      !name.startsWith("img-") &&
      !name.startsWith("vid-") &&
      !name.startsWith("aud-") &&
      !name.startsWith("script-") &&
      name !== "final"
    ) {
      continue;
    }

    const assetDir = path.join(projectDir, name);

    try {
      const assetType = getAssetType(name);

      // Timestamp
      const createdTs = await readCreatedAt(assetDir);
      let createdAt: string;
      if (createdTs !== null) {
        createdAt = new Date(createdTs * 1000).toISOString();
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
      if (e.code === "ENOENT") continue; // Asset vanished — skip it
      throw error;
    }
  }

  assets.sort((a, b) => a.id.localeCompare(b.id));
  return assets;
}
