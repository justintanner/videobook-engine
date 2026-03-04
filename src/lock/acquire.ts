import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { constants } from 'node:fs';

import type { LockData, FsError } from '../types.js';
import type { Result } from '../result.js';
import { ok, err } from '../result.js';

export async function acquireLock(
  assetDir: string,
  lockName: string,
  data?: Record<string, unknown>,
): Promise<Result<LockData, FsError>> {
  const lockPath = path.join(assetDir, lockName);

  const lockData: LockData = {
    created_at: Date.now() / 1000,
    pid: process.pid,
    ...data,
  };

  let fd: fs.FileHandle | undefined;
  try {
    // Atomic lock creation — O_CREAT | O_EXCL guarantees no TOCTOU race
    fd = await fs.open(
      lockPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
    );
    await fd.writeFile(JSON.stringify(lockData));
    await fd.close();
    fd = undefined;
    return ok(lockData);
  } catch (error: unknown) {
    if (fd) {
      await fd.close().catch(() => {});
    }
    const e = error as NodeJS.ErrnoException;
    if (e.code === 'EEXIST') {
      return err({ code: 'LOCK_HELD', message: `Lock already held: ${lockName}` });
    }
    return err({ code: 'IO_ERROR', message: e.message });
  }
}
