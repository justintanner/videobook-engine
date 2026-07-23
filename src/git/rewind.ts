import * as path from "node:path";

import { recoverAssetsTable } from "../asset/recover.js";
import { catalogForProjectDir } from "../storage/context.js";

export async function rewindProject(
  projectDir: string,
  commitHash: string,
  gitPath?: string,
): Promise<string | null> {
  void gitPath;
  const catalog = catalogForProjectDir(projectDir);
  if (!catalog) return null;
  const revision = await catalog.rewindProject(
    path.basename(projectDir),
    commitHash,
  );
  if (!revision) return null;
  await recoverAssetsTable(projectDir, path.dirname(projectDir));
  return revision.hash;
}
