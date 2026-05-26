import * as path from "node:path";
import * as fs from "node:fs/promises";

import { gitExec, gitExecSafe } from "./exec.js";
import { isGitRepo } from "./init.js";
import { commitOperation } from "./commit.js";
import { withGitLock } from "./mutex.js";
import { withCleanWorktree } from "./stash.js";
import { recoverAssetRow } from "../asset/recover.js";

async function assetExistsAtCommit(
  projectDir: string,
  assetId: string,
  commitHash: string,
  gitPath?: string,
): Promise<boolean> {
  const result = await gitExecSafe(["cat-file", "-e", `${commitHash}:${assetId}`], {
    cwd: projectDir,
    gitPath,
  });
  return result.exitCode === 0;
}

async function assetTreeMatchesCommit(
  projectDir: string,
  assetId: string,
  commitHash: string,
  gitPath?: string,
): Promise<boolean | null> {
  const result = await gitExecSafe(["diff", "--quiet", "HEAD", commitHash, "--", assetId], {
    cwd: projectDir,
    gitPath,
  });
  if (result.exitCode === 0) return true;
  if (result.exitCode === 1) return false;
  return null;
}

async function getHeadHash(projectDir: string, gitPath?: string): Promise<string | null> {
  const result = await gitExecSafe(["rev-parse", "HEAD"], {
    cwd: projectDir,
    gitPath,
  });
  return result.exitCode === 0 ? result.stdout.trim() : null;
}

export async function restoreAsset(
  projectDir: string,
  assetId: string,
  commitHash: string,
  gitPath?: string,
): Promise<string | null> {
  if (!(await isGitRepo(projectDir))) {
    return null;
  }

  const hash = await withGitLock(projectDir, async () => {
    return withCleanWorktree(
      projectDir,
      async () => {
        if (!(await assetExistsAtCommit(projectDir, assetId, commitHash, gitPath))) {
          return null;
        }

        const matches = await assetTreeMatchesCommit(projectDir, assetId, commitHash, gitPath);
        if (matches === true) {
          return getHeadHash(projectDir, gitPath);
        }
        if (matches === null) {
          return null;
        }

        await fs.rm(path.join(projectDir, assetId), { recursive: true, force: true });

        try {
          await gitExec(["checkout", commitHash, "--", assetId], {
            cwd: projectDir,
            gitPath,
          });
        } catch {
          return null;
        }

        return commitOperation(
          projectDir,
          "restore",
          assetId,
          { from_commit: commitHash.slice(0, 8) },
          gitPath,
        );
      },
      gitPath,
    );
  });

  if (hash !== null) {
    // Re-derive the assets row from disk + remaining tables.
    await recoverAssetRow(projectDir, path.dirname(projectDir), assetId);
  }
  return hash;
}
