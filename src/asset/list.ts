import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as crypto from 'node:crypto';

import type { AssetEntry, AssetType, OriginalMetadata } from '../types.js';
import {
  VIDEO_FILENAME_EXTENSIONS,
  IMAGE_FILENAME_EXTENSIONS,
  AUDIO_FILENAME_EXTENSIONS,
  TIMELINE_LANDSCAPE,
  TIMELINE_PORTRAIT,
  PLAN_MD,
  INDEX_MD,
  DIALOG_MP3,
  ORIGINAL_METADATA_FILE,
  PROJECT_METADATA,
  CREATED_AT_FILE,
} from '../constants.js';
import { getAssetType, deriveAssetStatus, getEnabledOrientations } from './status.js';

async function fileExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function findOriginalFile(
  assetDir: string,
  assetType: AssetType,
): Promise<string | null> {
  if (assetType === 'final') {
    for (const f of [TIMELINE_LANDSCAPE, TIMELINE_PORTRAIT]) {
      const candidate = path.join(assetDir, f);
      if (await fileExists(candidate)) return candidate;
    }
    return null;
  }

  if (assetType === 'script') {
    const candidate = path.join(assetDir, INDEX_MD);
    return (await fileExists(candidate)) ? candidate : null;
  }

  const extensions =
    assetType === 'video' ? VIDEO_FILENAME_EXTENSIONS
    : assetType === 'image' ? IMAGE_FILENAME_EXTENSIONS
    : AUDIO_FILENAME_EXTENSIONS;

  for (const ext of extensions) {
    const candidate = path.join(assetDir, `original.${ext}`);
    if (await fileExists(candidate)) return candidate;
  }
  return null;
}

async function readOriginalMetadata(assetDir: string): Promise<OriginalMetadata> {
  try {
    const content = await fs.readFile(path.join(assetDir, ORIGINAL_METADATA_FILE), 'utf-8');
    return JSON.parse(content) as OriginalMetadata;
  } catch {
    return {};
  }
}

async function readCreatedAt(assetDir: string): Promise<number | null> {
  try {
    const content = await fs.readFile(path.join(assetDir, CREATED_AT_FILE), 'utf-8');
    const val = parseFloat(content.trim());
    return isNaN(val) ? null : val;
  } catch {
    return null;
  }
}

async function getProjectOrientations(projectDir: string): Promise<string[]> {
  try {
    const content = await fs.readFile(path.join(projectDir, PROJECT_METADATA), 'utf-8');
    const metadata = JSON.parse(content) as { orientations?: string[] };
    return metadata.orientations ?? ['16:9'];
  } catch {
    return ['16:9'];
  }
}

export async function listAssets(projectDir: string): Promise<AssetEntry[]> {
  try {
    await fs.access(projectDir);
  } catch {
    return [];
  }

  const orientations = await getProjectOrientations(projectDir);
  const enabledOrientations = getEnabledOrientations(orientations);
  const entries = await fs.readdir(projectDir, { withFileTypes: true });
  const assets: AssetEntry[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const name = entry.name;

    if (
      !name.startsWith('img-') &&
      !name.startsWith('vid-') &&
      !name.startsWith('aud-') &&
      !name.startsWith('script-') &&
      name !== 'final'
    ) {
      continue;
    }

    const assetDir = path.join(projectDir, name);
    const assetType = getAssetType(name);
    const originalFile = await findOriginalFile(assetDir, assetType);
    const hasOriginal = originalFile !== null;

    const status = await deriveAssetStatus(
      assetDir,
      assetType,
      hasOriginal,
      enabledOrientations,
    );

    // Timestamp
    const createdTs = await readCreatedAt(assetDir);
    let createdAt: string;
    if (createdTs !== null) {
      createdAt = new Date(createdTs * 1000).toISOString();
    } else {
      const stat = await fs.stat(assetDir);
      createdAt = new Date(stat.birthtimeMs).toISOString();
    }

    const asset: AssetEntry = {
      id: name,
      type: assetType,
      status,
      created_at: createdAt,
      file_path: originalFile,
    };

    // Type-specific fields
    if (assetType === 'video' || assetType === 'image') {
      const metadata = await readOriginalMetadata(assetDir);
      if (metadata.width) asset.width = metadata.width;
      if (metadata.height) asset.height = metadata.height;
      if (metadata.origin) asset.origin = metadata.origin;
      if (assetType === 'video') {
        if (metadata.duration) asset.duration = metadata.duration;
        if (metadata.source_url) asset.source_url = metadata.source_url as string;
        const hasSubtitles = await fileExists(path.join(assetDir, 'elevenlabs.json')) ||
          await fileExists(path.join(assetDir, 'original.el.srt'));
        asset.has_subtitles = hasSubtitles;
      }
    } else if (assetType === 'audio') {
      const metadata = await readOriginalMetadata(assetDir);
      if (metadata.duration) asset.duration = metadata.duration;
      if (metadata.origin) asset.origin = metadata.origin;
    } else if (assetType === 'script') {
      const dialogPath = path.join(assetDir, DIALOG_MP3);
      if (await fileExists(dialogPath)) {
        asset.dialog_audio = dialogPath;
        const buf = await fs.readFile(dialogPath);
        asset.dialog_audio_hash = `sha256:${crypto.createHash('sha256').update(buf).digest('hex')}`;
      } else {
        asset.dialog_audio = null;
        asset.dialog_audio_hash = null;
      }

      const indexFile = path.join(assetDir, INDEX_MD);
      if (await fileExists(indexFile)) {
        asset.prompt = await fs.readFile(indexFile, 'utf-8');
      }
    }

    assets.push(asset);
  }

  // Check for .plan.md at project root
  const planFile = path.join(projectDir, PLAN_MD);
  if (await fileExists(planFile)) {
    const stat = await fs.stat(planFile);
    assets.push({
      id: 'plan',
      type: 'plan',
      status: 'ready',
      created_at: new Date(stat.mtimeMs).toISOString(),
      file_path: planFile,
    });
  }

  assets.sort((a, b) => a.id.localeCompare(b.id));
  return assets;
}
