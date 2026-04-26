import * as fs from "node:fs/promises";
import * as path from "node:path";

import { type FsError, type Result, ok, err } from "../types.js";

const SLUG_PATTERN = /^[a-zA-Z0-9._-]+$/;

function isValidSlug(slug: string): boolean {
  if (!slug || slug.length === 0 || slug === "." || slug === "..") return false;
  return SLUG_PATTERN.test(slug);
}

export interface ProjectResolution {
  projectDir: string;
  slug: string;
}

export async function resolveProjectFromAssetDir(
  absPath: string,
  projectsDir: string,
): Promise<Result<ProjectResolution, FsError>> {
  let realRoot: string;
  let realAbs: string;
  try {
    realRoot = await fs.realpath(projectsDir);
    realAbs = await fs.realpath(absPath);
  } catch (error: unknown) {
    return err({
      code: "INVALID_INPUT",
      message: error instanceof Error ? error.message : String(error),
    });
  }
  const rel = path.relative(realRoot, realAbs);
  if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) {
    return err({
      code: "INVALID_INPUT",
      message: `Path ${absPath} escapes projectsDir ${projectsDir}`,
    });
  }
  const slug = rel.split(path.sep)[0]!;
  if (!isValidSlug(slug)) {
    return err({ code: "INVALID_INPUT", message: `Invalid slug: ${slug}` });
  }
  return ok({ projectDir: path.join(realRoot, slug), slug });
}

const projectsDirRef: { current: string | null } = { current: null };

export function setProjectsDir(dir: string): void {
  projectsDirRef.current = path.resolve(dir);
}

export function getProjectsDir(): string | null {
  return projectsDirRef.current;
}
