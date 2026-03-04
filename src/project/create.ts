import * as fs from "node:fs/promises";
import * as path from "node:path";

import { type FsError, type Result, ok, err } from "../types.js";
import { DEFAULT_PROJECT_FILE } from "../constants.js";
import { initProjectRepo } from "../git/init.js";
import { generateProjectSlug, isProjectSlug } from "./slug.js";

export async function createProject(
  outputDir: string,
  slug?: string,
  gitPath?: string,
): Promise<
  Result<{ slug: string; path: string; is_default: boolean }, FsError>
> {
  if (slug !== undefined) {
    if (!isProjectSlug(slug)) {
      return err({
        code: "INVALID_INPUT",
        message: `Invalid project slug: ${slug}`,
      });
    }
  }

  // Ensure outputDir exists
  await fs.mkdir(outputDir, { recursive: true });

  // Atomic project directory creation
  let projectSlug: string;
  let projectDir: string;

  if (slug !== undefined) {
    // User-provided slug: non-recursive mkdir, EEXIST → ALREADY_EXISTS
    projectSlug = slug;
    projectDir = path.join(outputDir, projectSlug);
    try {
      await fs.mkdir(projectDir);
    } catch (error: unknown) {
      const e = error as NodeJS.ErrnoException;
      if (e.code === "EEXIST") {
        return err({
          code: "ALREADY_EXISTS",
          message: `Project already exists: ${projectSlug}`,
        });
      }
      throw error;
    }
  } else {
    // Auto-generated slug: retry with new slug on EEXIST
    const MAX_ATTEMPTS = 100;
    let created = false;
    projectSlug = "";
    projectDir = "";
    for (let i = 0; i < MAX_ATTEMPTS; i++) {
      projectSlug = await generateProjectSlug(outputDir);
      projectDir = path.join(outputDir, projectSlug);
      try {
        await fs.mkdir(projectDir);
        created = true;
        break;
      } catch (error: unknown) {
        const e = error as NodeJS.ErrnoException;
        if (e.code === "EEXIST") continue;
        throw error;
      }
    }
    if (!created) {
      return err({
        code: "IO_ERROR",
        message: "Could not generate unique project slug",
      });
    }
  }

  // Initialize git repo (first commit provides the created timestamp)
  await initProjectRepo(projectDir, gitPath);

  // Atomically set as default if no default exists — O_EXCL prevents TOCTOU
  const defaultFile = path.join(outputDir, DEFAULT_PROJECT_FILE);
  let isDefault = false;
  try {
    await fs.writeFile(defaultFile, projectSlug, { flag: "wx" });
    isDefault = true;
  } catch {
    // Default already exists — fine
  }

  return ok({ slug: projectSlug, path: projectDir, is_default: isDefault });
}
