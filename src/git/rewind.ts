import * as path from "node:path";

import { gitExec } from "./exec.js";
import { isGitRepo } from "./init.js";
import { withGitLock } from "./mutex.js";
import { recoverAssetsTable } from "../asset/recover.js";

export async function rewindProject(
  projectDir: string,
  commitHash: string,
  gitPath?: string,
): Promise<string | null> {
  if (!(await isGitRepo(projectDir))) {
    return null;
  }

  const hash = await withGitLock(projectDir, async () => {
    try {
      await gitExec(["checkout", commitHash], { cwd: projectDir, gitPath });
      return commitHash;
    } catch {
      return null;
    }
  });

  if (hash !== null) {
    // Rebuild every assets row from disk + tables after the full-tree checkout.
    await recoverAssetsTable(projectDir, path.dirname(projectDir));
  }
  return hash;
}
