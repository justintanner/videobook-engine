import * as fs from "node:fs/promises";
import * as path from "node:path";

import type { FsError } from "../types.js";
import type { Result } from "../result.js";
import { ok, err } from "../result.js";
import { LOCK_FILE } from "../constants.js";

export async function releaseLock(
  assetDir: string,
): Promise<Result<boolean, FsError>> {
  try {
    await fs.unlink(path.join(assetDir, LOCK_FILE));
    return ok(true);
  } catch (error: unknown) {
    const e = error as NodeJS.ErrnoException;
    if (e.code === "ENOENT") {
      return ok(false);
    }
    return err({ code: "IO_ERROR", message: e.message });
  }
}
