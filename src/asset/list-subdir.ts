import * as fs from "node:fs/promises";
import * as path from "node:path";

import { type FsError, type Result, ok, err } from "../types.js";
import {
  invalidInput,
  isValidAssetId,
  isWithinDir,
} from "../validation.js";

const SUBDIR_PATTERN = /^[a-zA-Z0-9_]+$/;

export async function listAssetSubdir(
  projectDir: string,
  assetId: string,
  subdirName: string,
): Promise<Result<string[], FsError>> {
  if (!isValidAssetId(assetId)) {
    return invalidInput(`Invalid asset ID: ${assetId}`);
  }
  if (!subdirName || !SUBDIR_PATTERN.test(subdirName)) {
    return invalidInput(`Invalid subdir name: ${subdirName}`);
  }

  const subdirPath = path.join(projectDir, assetId, subdirName);
  if (!isWithinDir(projectDir, subdirPath)) {
    return invalidInput("Path escapes project directory");
  }

  try {
    const entries = await fs.readdir(subdirPath);
    return ok(entries.filter((e) => !e.startsWith(".")).sort());
  } catch (error: unknown) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") {
      return err({
        code: "NOT_FOUND",
        message: `Subdir not found: ${assetId}/${subdirName}`,
      });
    }
    return err({
      code: "IO_ERROR",
      message: error instanceof Error ? error.message : String(error),
    });
  }
}
