import * as path from "node:path";
import * as fs from "node:fs/promises";
import { lock as lockFile } from "proper-lockfile";

import { VIDEOCITY_DIR } from "../db/client.js";

const locks = new Map<string, Promise<void>>();

/** Thrown when the project dir vanished (rename/delete) while waiting for
 *  the lock. Callers that return Result should map this to NOT_FOUND. */
export class ProjectDirMissingError extends Error {
  constructor(dir: string) {
    super(`Project directory does not exist: ${dir}`);
    this.name = "ProjectDirMissingError";
  }
}

export function migrateGitLockKey(oldDir: string, newDir: string): void {
  const oldKey = path.resolve(oldDir);
  const newKey = path.resolve(newDir);
  const pending = locks.get(oldKey);
  if (pending) {
    locks.set(newKey, pending);
    locks.delete(oldKey);
  }
}

export async function withGitLock<T>(
  projectDir: string,
  fn: () => Promise<T>,
): Promise<T> {
  const key = path.resolve(projectDir);
  const prev = locks.get(key) ?? Promise.resolve();

  let resolve: () => void;
  const next = new Promise<void>((r) => {
    resolve = r;
  });
  locks.set(key, next);

  const releaseChain = (): void => {
    resolve!();
    // Clean up if we're the tail of the chain
    if (locks.get(key) === next) {
      locks.delete(key);
    }
  };

  await prev;
  // If acquisition fails (mkdir error, proper-lockfile retries exhausted),
  // the chain must still advance — otherwise every later withGitLock call
  // for this project awaits a promise that never settles.
  let release: () => Promise<void>;
  try {
    // The project may have been renamed or deleted while we were queued
    // (migrateGitLockKey moves the chain but not waiters already holding the
    // old path). Failing here beats recreating a stray {oldDir}/.videocity
    // and operating on a project that no longer exists at this path.
    try {
      await fs.stat(key);
    } catch {
      throw new ProjectDirMissingError(key);
    }
    const lockDir = path.join(key, VIDEOCITY_DIR);
    await fs.mkdir(lockDir, { recursive: true });
    release = await lockFile(key, {
      lockfilePath: path.join(lockDir, ".project.lock"),
      realpath: false,
      stale: 30_000,
      update: 10_000,
      retries: {
        retries: 60,
        factor: 1.2,
        minTimeout: 50,
        maxTimeout: 500,
      },
    });
  } catch (error) {
    releaseChain();
    throw error;
  }
  try {
    return await fn();
  } finally {
    try {
      await release();
    } finally {
      releaseChain();
    }
  }
}
