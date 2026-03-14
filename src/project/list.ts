import * as fs from "node:fs/promises";
import * as path from "node:path";

import type { ProjectMetadata } from "../types.js";
import { DEFAULT_PROJECT_FILE } from "../constants.js";
import { isProjectSlug } from "./slug.js";
import { getProjectTimestamps } from "../git/timestamps.js";

export async function listProjects(
  projectsDir: string,
  gitPath?: string,
): Promise<ProjectMetadata[]> {
  try {
    await fs.access(projectsDir);
  } catch {
    return [];
  }

  let defaultSlug: string | null = null;
  try {
    defaultSlug = (
      await fs.readFile(path.join(projectsDir, DEFAULT_PROJECT_FILE), "utf-8")
    ).trim();
  } catch {
    // No default file
  }

  const entries = await fs.readdir(projectsDir, { withFileTypes: true });
  const candidates: { name: string; dir: string }[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory() || !isProjectSlug(entry.name)) continue;
    const dir = path.join(projectsDir, entry.name);
    try {
      await fs.access(path.join(dir, ".git"));
      candidates.push({ name: entry.name, dir });
    } catch {
      // Not a git-initialized project — skip
    }
  }

  const projects = await Promise.all(
    candidates.map(async ({ name, dir }): Promise<ProjectMetadata> => {
      const timestamps = await getProjectTimestamps(dir, gitPath);
      return {
        slug: name,
        created: timestamps?.created ?? Date.now() / 1000,
        path: dir,
        is_default: name === defaultSlug,
        last_activity: timestamps?.lastActivity,
      };
    }),
  );

  projects.sort((a, b) => a.slug.localeCompare(b.slug));
  return projects;
}
