import * as fs from "node:fs/promises";
import * as path from "node:path";

import { type FsError, type Result, ok, err } from "../types.js";
import { isSafePath, isWithinDir, invalidInput } from "../validation.js";

export async function resolveAssetDir(
  projectDir: string,
  assetId: string,
): Promise<Result<string, FsError>> {
  if (!isSafePath(assetId)) return invalidInput(`Invalid asset ID: ${assetId}`);

  const assetDir = path.join(projectDir, assetId);
  if (!isWithinDir(projectDir, assetDir))
    return invalidInput("Path escapes project directory");

  try {
    await fs.access(assetDir);
  } catch {
    return err({ code: "NOT_FOUND", message: `Asset not found: ${assetId}` });
  }

  return ok(path.resolve(assetDir));
}
