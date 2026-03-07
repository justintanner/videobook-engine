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

export async function copyFile(
  projectDir: string,
  assetId: string,
  filename: string,
  destAssetId: string,
  destFilename: string,
  gitPath?: string,
): Promise<Result<string, FsError>> {
  if (!isSafePath(assetId)) return invalidInput(`Invalid asset ID: ${assetId}`);
  if (!isSafeFilename(filename))
    return invalidInput(`Invalid filename: ${filename}`);
  if (!isSafePath(destAssetId))
    return invalidInput(`Invalid asset ID: ${destAssetId}`);
  if (!isSafeFilename(destFilename))
    return invalidInput(`Invalid filename: ${destFilename}`);

  const srcAssetDir = path.join(projectDir, assetId);
  const destAssetDir = path.join(projectDir, destAssetId);

  const srcPath = path.join(srcAssetDir, filename);
  const destPath = path.join(destAssetDir, destFilename);

  if (!isWithinDir(projectDir, srcPath))
    return invalidInput("Path escapes project directory");
  if (!isWithinDir(projectDir, destPath))
    return invalidInput("Path escapes project directory");

  try {
    await fs.access(srcAssetDir);
  } catch {
    return err({
      code: "NOT_FOUND",
      message: `Asset not found: ${assetId}`,
    });
  }

  try {
    await fs.access(srcPath);
  } catch {
    return err({
      code: "NOT_FOUND",
      message: `File not found: ${assetId}/${filename}`,
    });
  }

  try {
    await fs.access(destAssetDir);
  } catch {
    return err({
      code: "NOT_FOUND",
      message: `Asset not found: ${destAssetId}`,
    });
  }

  await withGitLock(projectDir, async () => {
    await fs.copyFile(srcPath, destPath);
    await commitOperation(
      projectDir,
      "copy-file",
      destAssetId,
      { from: `${assetId}/${filename}`, to: destFilename },
      gitPath,
    );
  });

  return ok(destPath);
}
