import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import type { LockData } from '../types.js';

export async function isLocked(
  assetDir: string,
  lockName: string,
): Promise<boolean> {
  try {
    await fs.access(path.join(assetDir, lockName));
    return true;
  } catch {
    return false;
  }
}

export async function getLockData(
  assetDir: string,
  lockName: string,
): Promise<LockData | null> {
  const lockPath = path.join(assetDir, lockName);
  try {
    const content = await fs.readFile(lockPath, 'utf-8');
    const trimmed = content.trim();
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
        return parsed as LockData;
      }
      if (typeof parsed === 'number') {
        return { created_at: parsed };
      }
      return null;
    } catch {
      // Plain timestamp format
      const ts = parseFloat(trimmed);
      if (!isNaN(ts)) {
        return { created_at: ts };
      }
      return null;
    }
  } catch {
    return null;
  }
}
