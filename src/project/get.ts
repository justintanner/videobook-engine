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
import { gitExecSafe } from "../git/exec.js";
import { getDefaultProject } from "./switch.js";

export async function getProject(
  projectsDir: string,
  slug?: string,
  gitPath?: string,
): Promise<Result<{ metadata: ProjectMetadata; path: string }, FsError>> {
  const projectSlug = slug ?? (await getDefaultProject(projectsDir));
  if (!projectSlug) {
    return err({ code: "NOT_FOUND", message: "No default project set" });
  }

  const normalizedSlug = projectSlug.includes("/")
    ? path.basename(projectSlug)
    : projectSlug;
  const projectDir = path.join(projectsDir, normalizedSlug);

  // Check for .git dir instead of .project file
  try {
    await fs.access(path.join(projectDir, ".git"));
  } catch {
    return err({
      code: "NOT_FOUND",
      message: `Project not found: ${normalizedSlug}`,
    });
  }

  const created = await readCreatedAt(projectDir);

  // O(1) last_activity: just read the most recent commit timestamp
  let lastActivity: number | undefined;
  const logResult = await gitExecSafe(["log", "-1", "--format=%at"], {
    cwd: projectDir,
    gitPath,
  });
  if (logResult.exitCode === 0 && logResult.stdout.trim()) {
    const ts = parseInt(logResult.stdout.trim(), 10);
    if (!isNaN(ts)) lastActivity = ts;
  }

  const metadata: ProjectMetadata = {
    slug: normalizedSlug,
    created,
    path: projectDir,
    last_activity: lastActivity,
  };

  return ok({ metadata, path: projectDir });
}

export async function resolveProjectDir(
  projectsDir: string,
  slug?: string,
  gitPath?: string,
): Promise<string | null> {
  const result = await getProject(projectsDir, slug, gitPath);
  return result.ok ? result.value.path : null;
}
