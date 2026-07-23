import * as fs from "node:fs/promises";
import * as path from "node:path";

export async function gitMv(
  projectDir: string,
  oldPath: string,
  newPath: string,
  gitPath?: string,
): Promise<boolean> {
  void gitPath;
  try {
    await fs.rename(path.join(projectDir, oldPath), path.join(projectDir, newPath));
    return true;
  } catch {
    return false;
  }
}
