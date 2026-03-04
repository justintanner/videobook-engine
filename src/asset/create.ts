import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import type { FsError } from '../types.js';
import type { Result } from '../result.js';
import { ok, err } from '../result.js';
import { CREATED_AT_FILE } from '../constants.js';
import { commitOperation } from '../git/commit.js';
import { slugifyName, uniqueSlug } from './slug.js';

export async function createAsset(
  projectDir: string,
  prefix: string,
  name: string,
  gitPath?: string,
): Promise<Result<{ assetId: string; path: string }, FsError>> {
  const baseSlug = slugifyName(name, prefix);
  const assetId = await uniqueSlug(projectDir, baseSlug);
  const assetDir = path.join(projectDir, assetId);

  try {
    await fs.mkdir(assetDir, { recursive: true });
  } catch (error: unknown) {
    const e = error as NodeJS.ErrnoException;
    return err({ code: 'IO_ERROR', message: e.message });
  }

  // Write .created_at
  await fs.writeFile(
    path.join(assetDir, CREATED_AT_FILE),
    String(Date.now() / 1000),
  );

  // Git commit
  await commitOperation(projectDir, 'create', assetId, undefined, gitPath);

  return ok({ assetId, path: assetDir });
}
