import * as fs from "node:fs/promises";
import * as path from "node:path";

import { type FsError, type Result, ok, err } from "../types.js";
import { DEFAULT_PROJECT_FILE } from "../constants.js";
import { closeStateDb } from "../db/client.js";
import { withGitLock } from "../git/mutex.js";
import { isLocked } from "../lock/query.js";
import { isValidAssetId } from "../validation.js";
import { listProjects } from "./list.js";
import { isProjectSlug } from "./slug.js";
import { getDefaultProject } from "./switch.js";

async function findLockedAsset(projectsDir: string, projectDir: string): Promise<string | null> {
  let entries: string[];
  try {
    entries = await fs.readdir(projectDir);
  } catch {
    return null;
  }
  for (const name of entries) {
    if (!isValidAssetId(name)) continue;
    const assetDir = path.join(projectDir, name);
    if (await isLocked(projectsDir, assetDir)) return name;
  }
  return null;
}

export async function deleteProject(
  projectsDir: string,
  slug: string,
  gitPath?: string,
): Promise<
  Result<{ slug: string; deleted_at: string; default_project_slug: string | null }, FsError>
> {
  if (!isProjectSlug(slug)) {
    return err({
      code: "INVALID_INPUT",
      message: `Invalid project slug: ${slug}`,
    });
  }

  const projectDir = path.join(projectsDir, slug);

  try {
    await fs.access(path.join(projectDir, ".git"));
  } catch {
    return err({ code: "NOT_FOUND", message: `Project not found: ${slug}` });
  }

  const lockedAsset = await findLockedAsset(projectsDir, projectDir);
  if (lockedAsset) {
    return err({ code: "LOCKED", message: `Asset is locked: ${lockedAsset}` });
  }

  const result: Result<{ deleted_at: string }, FsError> = await withGitLock(projectDir, async (): Promise<Result<{ deleted_at: string }, FsError>> => {
    try {
      await fs.access(path.join(projectDir, ".git"));
    } catch {
      return err({ code: "NOT_FOUND", message: `Project not found: ${slug}` });
    }

    const lockedNow = await findLockedAsset(projectsDir, projectDir);
    if (lockedNow) {
      return err({ code: "LOCKED", message: `Asset is locked: ${lockedNow}` });
    }

    closeStateDb(projectDir);
    await fs.rm(projectDir, { recursive: true, force: false });
    return ok({ deleted_at: new Date().toISOString() });
  });

  if (!result.ok) return result;

  const defaultFile = path.join(projectsDir, DEFAULT_PROJECT_FILE);
  const remaining = await listProjects(projectsDir, gitPath);
  let nextDefaultSlug: string | null = await getDefaultProject(projectsDir);
  const defaultStillExists = nextDefaultSlug
    ? remaining.some((project) => project.slug === nextDefaultSlug)
    : false;
  if (!defaultStillExists) {
    nextDefaultSlug = remaining[0]?.slug ?? null;
    if (nextDefaultSlug) {
      await fs.writeFile(defaultFile, nextDefaultSlug);
    } else {
      await fs.rm(defaultFile, { force: true });
    }
  }

  return ok({
    slug,
    deleted_at: result.value.deleted_at,
    default_project_slug: nextDefaultSlug,
  });
}
