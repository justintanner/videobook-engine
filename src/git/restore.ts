import * as path from "node:path";

import { recoverAssetRow } from "../asset/recover.js";
import { catalogForProjectDir } from "../storage/context.js";

export async function restoreAsset(
  projectDir: string,
  assetId: string,
  commitHash: string,
  gitPath?: string,
): Promise<string | null> {
  void gitPath;
  const catalog = catalogForProjectDir(projectDir);
  if (!catalog) return null;
  const revision = await catalog.restoreAsset(
    path.basename(projectDir),
    assetId,
    commitHash,
  );
  if (!revision) return null;
  await recoverAssetRow(projectDir, path.dirname(projectDir), assetId);
  return revision.hash;
}
