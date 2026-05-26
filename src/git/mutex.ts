import * as path from "node:path";
import * as fs from "node:fs/promises";
import { lock as lockFile } from "proper-lockfile";

import { VIDEOCITY_DIR } from "../db/client.js";

const locks = new Map<string, Promise<void>>();

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

  await prev;
  const lockDir = path.join(key, VIDEOCITY_DIR);
  await fs.mkdir(lockDir, { recursive: true });
  const release = await lockFile(key, {
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
  try {
    return await fn();
  } finally {
    try {
      await release();
    } finally {
      resolve!();
      // Clean up if we're the tail of the chain
      if (locks.get(key) === next) {
        locks.delete(key);
      }
    }
  }
}
