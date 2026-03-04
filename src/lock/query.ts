import * as fs from "node:fs/promises";
import * as path from "node:path";

import type { LockData } from "../types.js";
import { LOCK_FILE } from "../constants.js";
import { parseLockContent, isExpired } from "./data.js";

export async function getLockData(assetDir: string): Promise<LockData | null> {
  try {
    const content = await fs.readFile(path.join(assetDir, LOCK_FILE), "utf-8");
    return parseLockContent(content);
  } catch {
    return null;
  }
}

export async function isLocked(assetDir: string): Promise<boolean> {
  const data = await getLockData(assetDir);
  if (!data) return false;
  return !isExpired(data);
}
