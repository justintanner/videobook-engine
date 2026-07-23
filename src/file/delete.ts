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

export async function deleteFile(
  projectDir: string,
  assetId: string,
  filename: string,
  gitPath?: string,
): Promise<Result<string, FsError>> {
  if (!isSafePath(assetId)) return invalidInput(`Invalid asset ID: ${assetId}`);
  if (!isSafeFilename(filename))
    return invalidInput(`Invalid filename: ${filename}`);

  const assetDir = path.join(projectDir, assetId);

  try {
    await fs.access(assetDir);
  } catch {
    return err({ code: "NOT_FOUND", message: `Asset not found: ${assetId}` });
  }

  const filePath = path.join(assetDir, filename);
  if (!isWithinDir(projectDir, filePath))
    return invalidInput("Path escapes project directory");

  try {
    await fs.access(filePath);
  } catch {
    return err({
      code: "NOT_FOUND",
      message: `File not found: ${assetId}/${filename}`,
    });
  }

  const commit = await withGitLock(projectDir, async () => {
    await fs.unlink(filePath);
    return commitOperation(
      projectDir,
      "delete-file",
      assetId,
      { file: filename },
      gitPath,
      false,
      [path.join(assetId, filename)],
    );
  });
  if (commit.status === "failed") {
    return err({
      code: "STORAGE_ERROR",
      message: `Failed to create file deletion revision: ${commit.message}`,
    });
  }

  return ok(filePath);
}
