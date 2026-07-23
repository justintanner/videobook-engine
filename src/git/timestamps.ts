import * as path from "node:path";

import { catalogForProjectDir } from "../storage/context.js";

export async function getAssetCreationTimestamps(
  projectDir: string,
  gitPath?: string,
): Promise<Map<string, number>> {
  void gitPath;
  const catalog = catalogForProjectDir(projectDir);
  if (!catalog) return new Map();
  const timestamps = new Map<string, number>();
  const history = catalog
    .history(path.basename(projectDir), 10_000)
    .slice()
    .reverse();
  for (const revision of history) {
    if (
      revision.operation === "create" &&
      revision.assetId &&
      !timestamps.has(revision.assetId)
    ) {
      timestamps.set(revision.assetId, Date.parse(revision.date) / 1000);
    }
  }
  return timestamps;
}
