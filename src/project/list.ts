import * as fs from "node:fs/promises";
import * as path from "node:path";

import type { ProjectMetadata } from "../types.js";
import { DEFAULT_PROJECT_FILE } from "../constants.js";
import { isProjectSlug } from "./slug.js";
import { readCreatedAt } from "../timestamps.js";

export async function listProjects(
  projectsDir: string,
  gitPath?: string,
  options?: { sort?: "newest" | "oldest" },
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
      const created = await readCreatedAt(dir);
      return {
        slug: name,
        created,
        path: dir,
        is_default: name === defaultSlug,
      };
    }),
  );

  const sortDir = options?.sort === "oldest" ? 1 : -1;
  projects.sort((a, b) => (a.created - b.created) * sortDir);
  return projects;
}
