import type { ProjectRevision } from "../types.js";
import { catalogForProjectDir } from "../storage/context.js";

export async function getHistory(
  projectDir: string,
  limit = 20,
  gitPath?: string,
): Promise<ProjectRevision[]> {
  void gitPath;
  const catalog = catalogForProjectDir(projectDir);
  return catalog?.history(projectDir.split("/").at(-1) ?? "", limit) ?? [];
}

export async function getAssetHistory(
  projectDir: string,
  assetId: string,
  limit = 20,
  gitPath?: string,
): Promise<ProjectRevision[]> {
  void gitPath;
  const catalog = catalogForProjectDir(projectDir);
  return (
    catalog?.history(
      projectDir.split("/").at(-1) ?? "",
      limit,
      assetId,
    ) ?? []
  );
}
