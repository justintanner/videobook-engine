import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import type { FsError } from '../types.js';
import type { Result } from '../result.js';
import { ok, err } from '../result.js';
import { commitOperation } from '../git/commit.js';
import { isSafePath, isWithinDir, invalidInput, VALID_PREFIXES } from '../validation.js';
import { isLocked } from '../lock/query.js';
import {
  LOCK_TRANSCRIBING,
  LOCK_GENERATING,
  LOCK_RENDERING_LANDSCAPE,
  LOCK_RENDERING_PORTRAIT,
  LOCK_RENDERING_SQUARE,
  LOCK_DOWNLOADING,
} from '../constants.js';

export async function deleteAsset(
  projectDir: string,
  assetId: string,
  gitPath?: string,
): Promise<Result<{ deleted_at: string }, FsError>> {
  if (assetId === 'plan') {
    return err({ code: 'INVALID_INPUT', message: 'Cannot delete singleton asset: plan' });
  }

  if (!isSafePath(assetId)) return invalidInput(`Invalid asset ID: ${assetId}`);

  const hasValidPrefix =
    VALID_PREFIXES.some((p) => assetId.startsWith(p)) || assetId === 'final';
  if (!hasValidPrefix) {
    return err({ code: 'INVALID_INPUT', message: `Invalid asset ID format: ${assetId}` });
  }

  const assetDir = path.join(projectDir, assetId);
  if (!isWithinDir(projectDir, assetDir)) return invalidInput('Path escapes project directory');

  try {
    await fs.access(assetDir);
  } catch {
    return err({ code: 'NOT_FOUND', message: `Asset not found: ${assetId}` });
  }

  // Check locks
  const lockChecks: Array<[string, string]> = [
    [LOCK_TRANSCRIBING, 'transcription in progress'],
    [LOCK_GENERATING, 'generation in progress'],
    [LOCK_RENDERING_LANDSCAPE, 'landscape rendering in progress'],
    [LOCK_RENDERING_PORTRAIT, 'portrait rendering in progress'],
    [LOCK_RENDERING_SQUARE, 'square rendering in progress'],
    [LOCK_DOWNLOADING, 'download in progress'],
  ];

  for (const [lock, msg] of lockChecks) {
    if (await isLocked(assetDir, lock)) {
      return err({ code: 'LOCKED', message: `Cannot delete: ${msg}` });
    }
  }

  await fs.rm(assetDir, { recursive: true, force: true });
  const deletedAt = new Date().toISOString();

  await commitOperation(projectDir, 'delete', assetId, undefined, gitPath);

  return ok({ deleted_at: deletedAt });
}
