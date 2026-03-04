import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import type { AssetStatus, AssetType } from '../types.js';
import {
  LOCK_DOWNLOADING,
  LOCK_GENERATING,
  LOCK_TRANSCRIBING,
  LOCK_RENDERING_LANDSCAPE,
  LOCK_RENDERING_PORTRAIT,
  LOCK_RENDERING_SQUARE,
  LOCK_TIMELINE,
  LOCK_TRIMMING,
  ERROR_TRANSCRIBE,
  ERROR_GENERATING,
  ERROR_TIMELINE,
  ERROR_LANDSCAPE,
  ERROR_PORTRAIT,
  ERROR_SQUARE,
  EL_JSON,
  SRT_ORIGINAL_EL,
  THUMBNAIL,
  WHITELISTED_AT_FILE,
  LOCK_MAP,
  ERROR_MAP,
  ASPECT_TO_ORIENTATION,
  ORIENTATION_EXPORT_MAP,
} from '../constants.js';

async function fileExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

function isTranscribed(assetDir: string): Promise<boolean> {
  return Promise.any([
    fs.access(path.join(assetDir, EL_JSON)).then(() => true),
    fs.access(path.join(assetDir, SRT_ORIGINAL_EL)).then(() => true),
  ]).catch(() => false);
}

async function hasExport(assetDir: string, orientation: string): Promise<boolean> {
  const exportFile = ORIENTATION_EXPORT_MAP[orientation];
  if (!exportFile) return false;
  return fileExists(path.join(assetDir, exportFile));
}

async function needsRender(assetDir: string, orientation: string): Promise<boolean> {
  // Don't start render if transcription/trim in progress
  if (await fileExists(path.join(assetDir, LOCK_TRANSCRIBING))) return false;
  if (await fileExists(path.join(assetDir, LOCK_TRIMMING))) return false;

  if (!(await isTranscribed(assetDir))) return false;
  if (await hasExport(assetDir, orientation)) return false;

  const lockName = LOCK_MAP[orientation];
  if (lockName && await fileExists(path.join(assetDir, lockName))) return false;

  return true;
}

export async function deriveAssetStatus(
  assetDir: string,
  assetType: AssetType,
  hasOriginal: boolean,
  enabledOrientations: string[],
): Promise<AssetStatus> {
  if (assetType === 'final') {
    if (await fileExists(path.join(assetDir, LOCK_TIMELINE))) return 'rendering';
    if (await fileExists(path.join(assetDir, ERROR_TIMELINE))) return 'error';
    return 'ready';
  }

  if (assetType === 'video') {
    return deriveVideoStatus(assetDir, hasOriginal, enabledOrientations);
  }

  if (assetType === 'image') {
    if (await fileExists(path.join(assetDir, LOCK_DOWNLOADING))) return 'downloading';
    if (await fileExists(path.join(assetDir, LOCK_GENERATING))) return 'generating';
    if (await fileExists(path.join(assetDir, ERROR_GENERATING))) return 'error';
    if (hasOriginal) return 'ready';
    return 'corrupt';
  }

  if (assetType === 'audio') {
    if (await fileExists(path.join(assetDir, LOCK_GENERATING))) return 'generating';
    if (await fileExists(path.join(assetDir, ERROR_GENERATING))) return 'error';
    if (hasOriginal) return 'ready';
    return 'corrupt';
  }

  // script
  if (await fileExists(path.join(assetDir, LOCK_GENERATING))) return 'generating';
  if (await fileExists(path.join(assetDir, ERROR_GENERATING))) return 'error';
  if (hasOriginal) return 'ready';
  return 'corrupt';
}

async function deriveVideoStatus(
  assetDir: string,
  hasOriginal: boolean,
  enabledOrientations: string[],
): Promise<AssetStatus> {
  if (await fileExists(path.join(assetDir, LOCK_DOWNLOADING))) return 'downloading';
  if (await fileExists(path.join(assetDir, LOCK_GENERATING))) return 'generating';
  if (await fileExists(path.join(assetDir, LOCK_TRANSCRIBING))) return 'transcribing';

  // Check rendering locks
  const renderingOrientations: string[] = [];
  if (await fileExists(path.join(assetDir, LOCK_RENDERING_LANDSCAPE)))
    renderingOrientations.push('landscape');
  if (await fileExists(path.join(assetDir, LOCK_RENDERING_PORTRAIT)))
    renderingOrientations.push('portrait');
  if (await fileExists(path.join(assetDir, LOCK_RENDERING_SQUARE)))
    renderingOrientations.push('square');

  if (renderingOrientations.length > 1) return 'rendering';
  if (renderingOrientations.length === 1)
    return `rendering-${renderingOrientations[0]}` as AssetStatus;

  // Error files
  if (await fileExists(path.join(assetDir, ERROR_TRANSCRIBE))) return 'error';
  if (await fileExists(path.join(assetDir, ERROR_GENERATING))) return 'error';

  if (!hasOriginal) return 'corrupt';

  // Check enabled orientations for render state
  const errorOrientations: string[] = [];
  const queuedOrientations: string[] = [];

  for (const orient of enabledOrientations) {
    const errorFile = ERROR_MAP[orient];
    if (errorFile && await fileExists(path.join(assetDir, errorFile))) {
      errorOrientations.push(orient);
    } else if (await needsRender(assetDir, orient)) {
      queuedOrientations.push(orient);
    }
  }

  if (errorOrientations.length > 1) return 'render-error';
  if (errorOrientations.length === 1)
    return `render-error-${errorOrientations[0]}` as AssetStatus;

  if (queuedOrientations.length > 1) return 'render-queued';
  if (queuedOrientations.length === 1)
    return `render-queued-${queuedOrientations[0]}` as AssetStatus;

  // Ready: subtitles + thumbnail
  const hasSubtitles = await isTranscribed(assetDir);
  const hasThumbnail = await fileExists(path.join(assetDir, THUMBNAIL));
  if (hasSubtitles && hasThumbnail) return 'ready';

  if (await fileExists(path.join(assetDir, WHITELISTED_AT_FILE))) return 'whitelisted';

  return 'unreviewed';
}

export function getAssetType(name: string): AssetType {
  if (name.startsWith('vid-')) return 'video';
  if (name.startsWith('img-')) return 'image';
  if (name.startsWith('aud-')) return 'audio';
  if (name.startsWith('script-')) return 'script';
  if (name === 'final') return 'final';
  if (name === 'plan') return 'plan';
  throw new Error(`Unknown asset prefix: ${name}`);
}

export function getEnabledOrientations(orientations: string[]): string[] {
  return orientations.map((a) => ASPECT_TO_ORIENTATION[a] ?? a);
}
