import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import type { AssetManifest, AssetManifestFile, FsError } from '../types.js';
import type { Result } from '../result.js';
import { ok, err } from '../result.js';
import {
  ORIGINAL_FRAMES_DIR,
  LANDSCAPE_FRAMES_DIR,
  PORTRAIT_FRAMES_DIR,
  SQUARE_FRAMES_DIR,
} from '../constants.js';
import { isSafePath, isValidAssetId, invalidInput } from '../validation.js';

export async function getManifest(
  projectDir: string,
  assetId: string,
): Promise<Result<AssetManifest, FsError>> {
  if (!isSafePath(assetId)) return invalidInput(`Invalid asset ID: ${assetId}`);
  if (!isValidAssetId(assetId)) return invalidInput(`Invalid asset ID format: ${assetId}`);
  const assetDir = path.join(projectDir, assetId);

  try {
    await fs.access(assetDir);
  } catch {
    return err({ code: 'NOT_FOUND', message: `Asset not found: ${assetId}` });
  }

  const entries = await fs.readdir(assetDir, { withFileTypes: true });
  const files: AssetManifestFile[] = [];

  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isFile()) continue;
    const stat = await fs.stat(path.join(assetDir, entry.name));
    const ext = path.extname(entry.name);
    files.push({
      name: entry.name,
      size_bytes: stat.size,
      extension: ext ? ext.slice(1) : null,
    });
  }

  // Collect frame directories
  const frames: Record<string, string[]> = {};
  for (const frameDirName of [ORIGINAL_FRAMES_DIR, LANDSCAPE_FRAMES_DIR, PORTRAIT_FRAMES_DIR, SQUARE_FRAMES_DIR]) {
    const frameDir = path.join(assetDir, frameDirName);
    try {
      const frameStat = await fs.stat(frameDir);
      if (frameStat.isDirectory()) {
        const frameEntries = await fs.readdir(frameDir);
        frames[frameDirName] = frameEntries
          .filter((f) => !f.startsWith('.'))
          .sort();
      }
    } catch {
      // Directory doesn't exist
    }
  }

  const manifest: AssetManifest = {
    asset_id: assetId,
    path: path.resolve(assetDir),
    file_count: files.length,
    files,
  };

  if (Object.keys(frames).length > 0) {
    manifest.frames = frames;
  }

  return ok(manifest);
}
