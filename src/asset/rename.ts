import * as path from 'node:path';

import type { FsError } from '../types.js';
import type { Result } from '../result.js';
import { ok, err } from '../result.js';
import { isLocked } from '../lock/query.js';
import { gitMv } from '../git/mv.js';
import { commitOperation } from '../git/commit.js';
import {
  LOCK_TRANSCRIBING,
  LOCK_GENERATING,
  LOCK_RENDERING_LANDSCAPE,
  LOCK_RENDERING_PORTRAIT,
  LOCK_DOWNLOADING,
} from '../constants.js';
import { slugifyName, uniqueSlug } from './slug.js';

const VALID_PREFIXES = ['img-', 'vid-', 'aud-', 'script-'];

export async function renameAsset(
  projectDir: string,
  assetId: string,
  newName: string,
  gitPath?: string,
): Promise<Result<{ old_asset_id: string; new_asset_id: string }, FsError>> {
  // Strip @ prefix if present
  const cleanId = assetId.replace(/^@/, '');

  if (cleanId === 'plan' || cleanId === 'final') {
    return err({ code: 'INVALID_INPUT', message: `Cannot rename singleton asset: ${cleanId}` });
  }

  if (!VALID_PREFIXES.some((p) => cleanId.startsWith(p))) {
    return err({ code: 'INVALID_INPUT', message: `Invalid asset ID format: ${cleanId}` });
  }

  const assetDir = path.join(projectDir, cleanId);

  // Check locks
  const lockChecks: Array<[string, string]> = [
    [LOCK_TRANSCRIBING, 'transcription in progress'],
    [LOCK_GENERATING, 'generation in progress'],
    [LOCK_RENDERING_LANDSCAPE, 'landscape rendering in progress'],
    [LOCK_RENDERING_PORTRAIT, 'portrait rendering in progress'],
    [LOCK_DOWNLOADING, 'download in progress'],
  ];

  for (const [lock, msg] of lockChecks) {
    if (await isLocked(assetDir, lock)) {
      return err({ code: 'LOCKED', message: `Cannot rename: ${msg}` });
    }
  }

  // Extract prefix
  const prefix = cleanId.split('-')[0]!;
  const baseSlug = slugifyName(newName, prefix);
  const newSlug = await uniqueSlug(projectDir, baseSlug);

  // Git mv
  if (!(await gitMv(projectDir, cleanId, newSlug, gitPath))) {
    return err({ code: 'GIT_ERROR', message: `Git rename failed: ${cleanId} -> ${newSlug}` });
  }

  // Commit
  const commitHash = await commitOperation(
    projectDir, 'rename', newSlug, { from: cleanId }, gitPath,
  );

  // Rollback on commit failure
  if (commitHash === null) {
    await gitMv(projectDir, newSlug, cleanId, gitPath);
    return err({ code: 'GIT_ERROR', message: 'Git commit failed, rename rolled back' });
  }

  return ok({ old_asset_id: cleanId, new_asset_id: newSlug });
}
