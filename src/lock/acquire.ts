import * as fs from "node:fs/promises";
import * as path from "node:path";
import { constants } from "node:fs";

import type { LockData, FsError } from "../types.js";
import { type Result, ok, err } from "../types.js";
import { LOCK_FILE } from "../constants.js";
import {
  type LockOptions,
  buildLockData,
  parseLockContent,
  isExpired,
} from "./data.js";

async function tryCreateLock(
  lockPath: string,
  lockData: LockData,
): Promise<Result<LockData, FsError>> {
  let fd: fs.FileHandle | undefined;
  try {
    fd = await fs.open(
      lockPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
    );
    await fd.writeFile(JSON.stringify(lockData));
    return ok(lockData);
  } catch (error: unknown) {
    const e = error as NodeJS.ErrnoException;
    if (e.code === "EEXIST") {
      return err({ code: "LOCKED", message: "Lock already held" });
    }
    return err({ code: "IO_ERROR", message: e.message });
  } finally {
    if (fd) await fd.close().catch(() => {});
  }
}

export async function acquireLock(
  assetDir: string,
  options: LockOptions,
): Promise<Result<LockData, FsError>> {
  const lockPath = path.join(assetDir, LOCK_FILE);
  const now = Date.now() / 1000;
  const lockData = buildLockData(now, process.pid, options);

  const first = await tryCreateLock(lockPath, lockData);
  if (first.ok) return first;

  // On EEXIST: check if expired and take over
  if (first.error.code === "LOCKED") {
    try {
      const content = await fs.readFile(lockPath, "utf-8");
      const existing = parseLockContent(content);
      if (existing && isExpired(existing)) {
        await fs.unlink(lockPath).catch(() => {});
        return tryCreateLock(lockPath, lockData);
      }
    } catch {
      // File gone between check — retry once
      return tryCreateLock(lockPath, lockData);
    }
  }

  return first;
}
