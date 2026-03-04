import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import type { FsError } from '../types.js';
import type { Result } from '../result.js';
import { ok, err } from '../result.js';

/**
 * Release a lock file. Note: this intentionally does NOT verify ownership
 * (e.g., matching PID). Any caller can release any lock. This is a design
 * tradeoff — simplicity over strict ownership — acceptable because locks
 * are process-scoped and the stale-lock cleaner handles orphans via PID checks.
 */
export async function releaseLock(
  assetDir: string,
  lockName: string,
): Promise<Result<boolean, FsError>> {
  const lockPath = path.join(assetDir, lockName);
  try {
    await fs.unlink(lockPath);
    return ok(true);
  } catch (error: unknown) {
    const e = error as NodeJS.ErrnoException;
    if (e.code === 'ENOENT') {
      return ok(false);
    }
    return err({ code: 'IO_ERROR', message: e.message });
  }
}
