import { gitExec, gitExecSafe } from "./exec.js";

const STASH_MESSAGE = "clipfirst-engine: auto-stash";

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

  // Stash all dirty state (tracked + untracked)
  await gitExec(["stash", "push", "--include-untracked", "-m", STASH_MESSAGE], {
    cwd: projectDir,
    gitPath,
  });

  try {
    return await fn();
  } finally {
    // Restore user's changes
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
  }
}
