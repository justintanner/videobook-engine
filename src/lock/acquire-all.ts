import * as fs from "node:fs/promises";

import type { FsError } from "../types.js";
import type { Result } from "../result.js";
import { ok, err } from "../result.js";
import { acquireLock } from "./acquire.js";
import { releaseLock } from "./release.js";

async function scanLockFiles(assetDir: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(assetDir);
    return entries.filter((f) => f.endsWith(".lock"));
  } catch {
    return [];
  }
}

export async function acquireAllLocks(
  assetDir: string,
): Promise<Result<string[], FsError>> {
  const existingLocks = await scanLockFiles(assetDir);

  if (existingLocks.length > 0) {
    return err({
      code: "LOCKED",
      message: `Cannot proceed: lock held (${existingLocks[0]})`,
    });
  }

  return ok([]);
}

export async function releaseAllLocks(assetDir: string): Promise<void> {
  const locks = await scanLockFiles(assetDir);
  for (const lock of locks) {
    await releaseLock(assetDir, lock);
  }
}
