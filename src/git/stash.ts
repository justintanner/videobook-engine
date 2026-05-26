import { gitExec, gitExecSafe } from "./exec.js";
import { closeMetadataDb } from "../db/metadata-client.js";

const STASH_MESSAGE = "vc-engine: auto-stash";

/**
 * Close the cached metadata.sqlite handle so the NEXT getMetadataDb call
 * re-opens against whatever inode currently sits on disk. Stash push+pop
 * (and any other git operation that rewrites the worktree copy) can swap
 * the file's inode underneath us; re-using the stale cached handle then
 * fails with SQLITE_READONLY_DBMOVED — surfaced as "attempt to write a
 * readonly database". Closing here invalidates the cache safely.
 */
function evictMetadataDbCache(projectDir: string): void {
  try {
    closeMetadataDb(projectDir);
  } catch {
    // Best-effort eviction; the next getMetadataDb call will re-open anyway.
  }
}

export async function withCleanWorktree<T>(
  projectDir: string,
  fn: () => Promise<T>,
  gitPath?: string,
): Promise<T> {
  const status = await gitExecSafe(["status", "--porcelain"], {
    cwd: projectDir,
    gitPath,
  });

  // Fast path: tree is clean, no stash needed
  if (!status.stdout.trim()) {
    return fn();
  }

  // Stash all dirty state (tracked + untracked). This replaces tracked files
  // (including metadata.sqlite if it was dirty) with their HEAD versions —
  // a NEW inode. Drop the cached SQLite handle so the next open binds to it.
  await gitExec(["stash", "push", "--include-untracked", "-m", STASH_MESSAGE], {
    cwd: projectDir,
    gitPath,
  });
  evictMetadataDbCache(projectDir);

  try {
    return await fn();
  } finally {
    // Restore user's changes; stash pop swaps the inode again.
    const popResult = await gitExecSafe(["stash", "pop"], {
      cwd: projectDir,
      gitPath,
    });

    if (popResult.exitCode !== 0) {
      // Conflict — clear conflict markers but leave stash on stack for manual recovery
      await gitExecSafe(["checkout", "--", "."], {
        cwd: projectDir,
        gitPath,
      });
    }
    evictMetadataDbCache(projectDir);
  }
}
