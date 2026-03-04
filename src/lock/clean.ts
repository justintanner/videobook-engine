import * as fs from "node:fs/promises";
import * as path from "node:path";

import { LOCK_FILE } from "../constants.js";
import type { LockData } from "../types.js";
import { parseLockContent, isExpired } from "./data.js";

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function isStale(data: LockData, now: number): boolean {
  if (isExpired(data, now)) return true;
  if (typeof data.pid === "number" && !isProcessAlive(data.pid)) return true;
  return false;
}

export async function cleanStaleLock(assetDir: string): Promise<boolean> {
  const lockPath = path.join(assetDir, LOCK_FILE);
  try {
    const content = await fs.readFile(lockPath, "utf-8");
    const data = parseLockContent(content);
    if (!data) return false;

    if (isStale(data, Date.now() / 1000)) {
      await fs.unlink(lockPath);
      return true;
    }
    return false;
  } catch {
    return false;
  }
}
