import * as path from "node:path";

import { catalogForProjectDir } from "../storage/context.js";

export async function getHistoricalSlugs(
  projectDir: string,
  gitPath?: string,
): Promise<Set<string>> {
  void gitPath;
  return (
    catalogForProjectDir(projectDir)?.historicalSlugs(
      path.basename(projectDir),
    ) ?? new Set()
  );
}
