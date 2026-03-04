import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import type { FsError } from '../types.js';
import type { Result } from '../result.js';
import { ok, err } from '../result.js';
import { commitOperation } from '../git/commit.js';

export async function writeFile(
  projectDir: string,
  assetId: string,
  filename: string,
  data: Buffer | string,
  gitPath?: string,
): Promise<Result<string, FsError>> {
  const assetDir = path.join(projectDir, assetId);

  try {
    await fs.access(assetDir);
  } catch {
    return err({ code: 'NOT_FOUND', message: `Asset not found: ${assetId}` });
  }

  const filePath = path.join(assetDir, filename);
  await fs.writeFile(filePath, data);

  await commitOperation(projectDir, 'write', assetId, { file: filename }, gitPath);

  return ok(filePath);
}
