import * as fs from "node:fs/promises";
import * as path from "node:path";

import { CREATED_AT_FILE } from "./constants.js";

export async function readCreatedAt(dir: string): Promise<number> {
  try {
    const content = await fs.readFile(path.join(dir, CREATED_AT_FILE), "utf-8");
    const ts = parseInt(content.trim(), 10);
    if (!isNaN(ts)) return ts;
  } catch {
    // Fall through to stat
  }

  try {
    const stat = await fs.stat(dir);
    return stat.birthtimeMs / 1000;
  } catch {
    // Last resort
  }

  return Date.now() / 1000;
}
