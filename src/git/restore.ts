import * as path from "node:path";

import { gitExec } from "./exec.js";
import { isGitRepo } from "./init.js";
import { commitOperation } from "./commit.js";
import { withGitLock } from "./mutex.js";
import { withCleanWorktree } from "./stash.js";
import { recoverAssetRow } from "../asset/recover.js";

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
