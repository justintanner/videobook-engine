import * as fs from "node:fs/promises";
import * as path from "node:path";

import { type FsError, type Result, ok, err } from "../types.js";
import { commitOperation } from "../git/commit.js";
import { withGitLock } from "../git/mutex.js";
import {
  isSafeFilename,
  isSafePath,
  isWithinDir,
  invalidInput,
} from "../validation.js";

export async function renameFile(
  projectDir: string,
  assetId: string,
  oldFilename: string,
  newFilename: string,
  gitPath?: string,
): Promise<Result<{ oldPath: string; newPath: string }, FsError>> {
  if (!isSafePath(assetId)) return invalidInput(`Invalid asset ID: ${assetId}`);
  if (!isSafeFilename(oldFilename))
    return invalidInput(`Invalid filename: ${oldFilename}`);
  if (!isSafeFilename(newFilename))
    return invalidInput(`Invalid filename: ${newFilename}`);

  const assetDir = path.join(projectDir, assetId);

  try {
    await fs.access(assetDir);
  } catch {
    return err({ code: "NOT_FOUND", message: `Asset not found: ${assetId}` });
  }

  const oldPath = path.join(assetDir, oldFilename);
  const newPath = path.join(assetDir, newFilename);
  if (!isWithinDir(projectDir, oldPath))
    return invalidInput("Path escapes project directory");
  if (!isWithinDir(projectDir, newPath))
    return invalidInput("Path escapes project directory");

  try {
    await fs.access(oldPath);
  } catch {
    return err({
      code: "NOT_FOUND",
      message: `File not found: ${assetId}/${oldFilename}`,
    });
  }

  try {
    await fs.access(newPath);
    return err({
      code: "ALREADY_EXISTS",
      message: `File already exists: ${assetId}/${newFilename}`,
    });
  } catch {
    // Expected — destination should not exist
  }

  const commit = await withGitLock(projectDir, async () => {
    await fs.rename(oldPath, newPath);
    return commitOperation(
      projectDir,
      "rename-file",
      assetId,
      { from: oldFilename, to: newFilename },
      gitPath,
      false,
      [path.join(assetId, oldFilename), path.join(assetId, newFilename)],
    );
  });
  if (commit.status === "failed") {
    return err({
      code: "GIT_ERROR",
      message: `Failed to commit file rename: ${commit.message}`,
    });
  }

  return ok({ oldPath, newPath });
}
