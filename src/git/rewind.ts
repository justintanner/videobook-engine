import * as path from "node:path";

import { gitExec } from "./exec.js";
import { isGitRepo } from "./init.js";
import { withGitLock } from "./mutex.js";
import { recoverAssetsTable } from "../asset/recover.js";
import { closeMetadataDb } from "../db/metadata-client.js";

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
      // The full-tree checkout replaces .clipfirst/metadata.sqlite — drop
      // the cached SQLite handle so subsequent operations bind to the new
      // inode rather than failing with SQLITE_READONLY_DBMOVED.
      try {
        closeMetadataDb(projectDir);
      } catch {
        // Best-effort eviction; the next open will re-acquire the handle.
      }
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
