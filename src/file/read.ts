import * as fs from "node:fs/promises";
import * as path from "node:path";

import { type FsError, type Result, ok, err } from "../types.js";
import {
  isSafeFilename,
  isSafePath,
  isWithinDir,
  invalidInput,
} from "../validation.js";

export async function readFile(
  projectDir: string,
  assetId: string,
  filename: string,
): Promise<Result<Buffer, FsError>> {
  if (!isSafePath(assetId)) return invalidInput(`Invalid asset ID: ${assetId}`);
  if (!isSafeFilename(filename))
    return invalidInput(`Invalid filename: ${filename}`);
  const filePath = path.join(projectDir, assetId, filename);
  if (!isWithinDir(projectDir, filePath))
    return invalidInput("Path escapes project directory");

  try {
    const data = await fs.readFile(filePath);
    return ok(data);
  } catch (error: unknown) {
    const e = error as NodeJS.ErrnoException;
    if (e.code === "ENOENT") {
      return err({
        code: "NOT_FOUND",
        message: `File not found: ${assetId}/${filename}`,
      });
    }
    return err({ code: "IO_ERROR", message: e.message });
  }
}
