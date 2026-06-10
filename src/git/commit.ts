import * as fs from "node:fs/promises";
import * as path from "node:path";

import { gitExecSafe } from "./exec.js";
import { isGitRepo } from "./init.js";

const MAX_ATTEMPTS = 3;
const BASE_DELAY_MS = 100;

function isIndexLockError(stderr: string): boolean {
  return stderr.includes("index.lock") || stderr.includes("Unable to create");
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export type CommitResult =
  | { status: "committed"; hash: string }
  /** Nothing to commit — the operation produced no on-disk diff. */
  | { status: "clean" }
  | { status: "failed"; message: string };

export async function commitOperation(
  projectDir: string,
  operation: string,
  assetId?: string,
  details?: Record<string, unknown>,
  gitPath?: string,
  allowEmpty?: boolean,
  paths?: string[],
): Promise<CommitResult> {
  if (!(await isGitRepo(projectDir))) {
    return { status: "failed", message: "Not a git repository" };
  }

  let lastError = "";

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    let addResult;

    if (paths && paths.length > 0) {
      // Stage only the specific paths provided (relative to projectDir)
      addResult = await gitExecSafe(["add", "--", ...paths], {
        cwd: projectDir,
        gitPath,
      });
    } else {
      // Fall back to staging the whole asset directory
      const assetDirName = assetId?.split("/")[0];
      const scopedDir = assetDirName
        ? path.join(projectDir, assetDirName)
        : null;

      if (scopedDir) {
        try {
          await fs.access(scopedDir);
          addResult = await gitExecSafe(["add", "--", assetDirName!], {
            cwd: projectDir,
            gitPath,
          });
        } catch {
          // For delete operations, the directory is gone — use -u scoped to asset dir
          // to stage only deletions of tracked files, preventing bystander staging
          if (operation === "delete") {
            addResult = await gitExecSafe(["add", "-u", "--", assetDirName!], {
              cwd: projectDir,
              gitPath,
            });
          } else {
            addResult = await gitExecSafe(["add", "--", assetDirName!], {
              cwd: projectDir,
              gitPath,
            });
          }
        }
      } else {
        addResult = await gitExecSafe(["add", "-A"], {
          cwd: projectDir,
          gitPath,
        });
      }
    }

    if (addResult.exitCode !== 0) {
      if (isIndexLockError(addResult.stderr) && attempt < MAX_ATTEMPTS - 1) {
        lastError = addResult.stderr;
        await delay(BASE_DELAY_MS * Math.pow(2, attempt));
        continue;
      }
      // When allowEmpty, add failures are non-fatal (e.g. pathspec matched nothing)
      if (!allowEmpty) {
        return { status: "failed", message: addResult.stderr };
      }
    }

    // Check for changes (skip when allowEmpty)
    if (!allowEmpty) {
      const statusResult = await gitExecSafe(["status", "--porcelain"], {
        cwd: projectDir,
        gitPath,
      });
      if (statusResult.exitCode !== 0) {
        return { status: "failed", message: statusResult.stderr };
      }
      if (!statusResult.stdout.trim()) {
        return { status: "clean" };
      }
    }

    // Build commit message
    const subject = assetId
      ? `[${assetId}] ${operation}`
      : `${operation}: project`;
    const bodyLines: string[] = [];
    if (details) {
      for (const [key, value] of Object.entries(details)) {
        if (value !== undefined && value !== null) {
          // Newlines in a value could inject extra body lines (e.g. a forged
          // `op-id:`); collapse control characters to spaces.
          const safe = String(value).replace(/[\x00-\x1f\x7f]+/g, " ");
          bodyLines.push(`${key}: ${safe}`);
        }
      }
    }
    const message =
      bodyLines.length > 0 ? `${subject}\n\n${bodyLines.join("\n")}` : subject;

    const commitArgs = ["commit", "-m", message];
    if (allowEmpty) commitArgs.push("--allow-empty");
    if (paths && paths.length > 0) commitArgs.push("--", ...paths);
    const commitResult = await gitExecSafe(commitArgs, {
      cwd: projectDir,
      gitPath,
    });
    if (commitResult.exitCode !== 0) {
      if (isIndexLockError(commitResult.stderr) && attempt < MAX_ATTEMPTS - 1) {
        lastError = commitResult.stderr;
        await delay(BASE_DELAY_MS * Math.pow(2, attempt));
        continue;
      }
      return { status: "failed", message: commitResult.stderr };
    }

    // Get commit hash
    const hashResult = await gitExecSafe(["rev-parse", "HEAD"], {
      cwd: projectDir,
      gitPath,
    });
    if (hashResult.exitCode !== 0) {
      return { status: "failed", message: "Failed to resolve commit hash" };
    }
    return { status: "committed", hash: hashResult.stdout.trim() };
  }

  return {
    status: "failed",
    message: `Git commit failed after retries: ${lastError}`,
  };
}
