import * as fs from "node:fs/promises";
import * as path from "node:path";

import type { ProjectMetadata, FsError } from "../types.js";
import type { Result } from "../result.js";
import { ok, err } from "../result.js";
import { getProjectTimestamps } from "../git/timestamps.js";
import { getDefaultProject } from "./switch.js";

export async function getProject(
  outputDir: string,
  slug?: string,
  gitPath?: string,
): Promise<Result<{ metadata: ProjectMetadata; path: string }, FsError>> {
  const projectSlug = slug ?? (await getDefaultProject(outputDir));
  if (!projectSlug) {
    return err({ code: "NOT_FOUND", message: "No default project set" });
  }

  const normalizedSlug = projectSlug.includes("/")
    ? path.basename(projectSlug)
    : projectSlug;
  const projectDir = path.join(outputDir, normalizedSlug);

  // Check for .git dir instead of .project file
  try {
    await fs.access(path.join(projectDir, ".git"));
  } catch {
    return err({
      code: "NOT_FOUND",
      message: `Project not found: ${normalizedSlug}`,
    });
  }

  const timestamps = await getProjectTimestamps(projectDir, gitPath);
  const metadata: ProjectMetadata = {
    slug: normalizedSlug,
    created: timestamps?.created ?? Date.now() / 1000,
    path: projectDir,
    last_activity: timestamps?.lastActivity,
  };

  return ok({ metadata, path: projectDir });
}

export async function resolveProjectDir(
  outputDir: string,
  slug?: string,
  gitPath?: string,
): Promise<string | null> {
  const result = await getProject(outputDir, slug, gitPath);
  return result.ok ? result.value.path : null;
}
