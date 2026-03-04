import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import type { FsError } from '../types.js';
import type { Result } from '../result.js';
import { ok, err } from '../result.js';
import { commitOperation } from '../git/commit.js';

const VALID_PREFIXES = ['img-', 'vid-', 'aud-', 'script-'];

export async function deleteAsset(
  projectDir: string,
  assetId: string,
  gitPath?: string,
): Promise<Result<{ deleted_at: string }, FsError>> {
  if (assetId === 'plan') {
    return err({ code: 'INVALID_INPUT', message: 'Cannot delete singleton asset: plan' });
  }

  const assetDir = path.join(projectDir, assetId);

  try {
    await fs.access(assetDir);
  } catch {
    return err({ code: 'NOT_FOUND', message: `Asset not found: ${assetId}` });
  }

  const hasValidPrefix =
    VALID_PREFIXES.some((p) => assetId.startsWith(p)) || assetId === 'final';
  if (!hasValidPrefix) {
    return err({ code: 'INVALID_INPUT', message: `Invalid asset ID format: ${assetId}` });
  }

  await fs.rm(assetDir, { recursive: true, force: true });
  const deletedAt = new Date().toISOString();

  await commitOperation(projectDir, 'delete', assetId, undefined, gitPath);

  return ok({ deleted_at: deletedAt });
}
