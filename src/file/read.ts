import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import type { FsError } from '../types.js';
import type { Result } from '../result.js';
import { ok, err } from '../result.js';

export async function readFile(
  projectDir: string,
  assetId: string,
  filename: string,
): Promise<Result<Buffer, FsError>> {
  const filePath = path.join(projectDir, assetId, filename);

  try {
    const data = await fs.readFile(filePath);
    return ok(data);
  } catch (error: unknown) {
    const e = error as NodeJS.ErrnoException;
    if (e.code === 'ENOENT') {
      return err({ code: 'NOT_FOUND', message: `File not found: ${assetId}/${filename}` });
    }
    return err({ code: 'IO_ERROR', message: e.message });
  }
}
