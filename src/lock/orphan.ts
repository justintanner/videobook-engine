import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { getLockData } from './query.js';

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export async function cleanStaleLocks(assetDir: string): Promise<string[]> {
  const cleaned: string[] = [];

  let entries: string[];
  try {
    entries = await fs.readdir(assetDir);
  } catch {
    return cleaned;
  }

  for (const entry of entries) {
    if (!entry.endsWith('.lock')) continue;

    const data = await getLockData(assetDir, entry);
    if (!data) continue;

    const pid = data.pid;
    if (typeof pid !== 'number') continue;

    if (!isProcessAlive(pid)) {
      try {
        await fs.unlink(path.join(assetDir, entry));
        cleaned.push(entry);
      } catch {
        // Already removed or permission issue
      }
    }
  }

  return cleaned;
}
