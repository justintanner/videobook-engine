import * as fs from "node:fs/promises";
import * as path from "node:path";

import {
  type ProjectMetadata,
  type FsError,
  type Result,
  ok,
  err,
} from "../types.js";
import { readCreatedAt } from "../timestamps.js";
import { getDefaultProject } from "./switch.js";

// Resolve a slug (or the default project when omitted) to its canonical form.
// Returns null only when no slug is given and there is no default project.
async function normalizeSlug(
  projectsDir: string,
  slug?: string,
): Promise<string | null> {
  const projectSlug = slug ?? (await getDefaultProject(projectsDir));
  if (!projectSlug) return null;
  return projectSlug.includes("/") ? path.basename(projectSlug) : projectSlug;
}

async function projectDirExists(projectDir: string): Promise<boolean> {
  try {
    await fs.access(path.join(projectDir, ".videobook"));
    return true;
  } catch {
    return false;
  }
}

export async function getProject(
  projectsDir: string,
  slug?: string,
  gitPath?: string,
): Promise<Result<{ metadata: ProjectMetadata; path: string }, FsError>> {
  const normalizedSlug = await normalizeSlug(projectsDir, slug);
  if (!normalizedSlug) {
    return err({ code: "NOT_FOUND", message: "No default project set" });
  }

  const projectDir = path.join(projectsDir, normalizedSlug);
  if (!(await projectDirExists(projectDir))) {
    return err({
      code: "NOT_FOUND",
      message: `Project not found: ${normalizedSlug}`,
    });
  }

  const created = await readCreatedAt(projectDir);

  void gitPath;
  const lastActivity = Math.floor((await fs.stat(projectDir)).mtimeMs / 1000);

  const metadata: ProjectMetadata = {
    slug: normalizedSlug,
    created,
    path: projectDir,
    last_activity: lastActivity,
  };

  return ok({ metadata, path: projectDir });
}

// Resolve a slug to its project directory. This is the hot path invoked before
// every fs operation, so it deliberately avoids getProject's `git log`
// subprocess (used only for last_activity) — that field is discarded here and
// spawning a subprocess per fs call dominated list_assets latency.
export async function resolveProjectDir(
  projectsDir: string,
  slug?: string,
): Promise<string | null> {
  const normalizedSlug = await normalizeSlug(projectsDir, slug);
  if (!normalizedSlug) return null;
  const projectDir = path.join(projectsDir, normalizedSlug);
  return (await projectDirExists(projectDir)) ? projectDir : null;
}
