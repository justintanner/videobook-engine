import * as fs from "node:fs/promises";
import * as path from "node:path";

import { type FsError, type Result, ok, err } from "../types.js";

const PROJECT_LOCK_KEY = "__PROJECT__";

const SLUG_PATTERN = /^[a-zA-Z0-9._-]+$/;

function isValidSlug(slug: string): boolean {
  if (!slug || slug === "." || slug === "..") return false;
  return SLUG_PATTERN.test(slug);
}

interface ResolvedLock {
  projectDir: string;
  assetKey: string;
}

/**
 * Resolve assetDir into (projectDir, assetKey) where assetKey is either
 * the first path segment within the project, or PROJECT_LOCK_KEY for a lock
 * taken on the project root itself.
 */
export async function resolveLockKey(
  projectsDir: string,
  assetDir: string,
): Promise<Result<ResolvedLock, FsError>> {
  let realRoot: string;
  let realAbs: string;
  try {
    realRoot = await fs.realpath(projectsDir);
    realAbs = await fs.realpath(assetDir);
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
      message: `assetDir ${assetDir} is not inside projectsDir ${projectsDir}`,
    });
  }
  const segments = rel.split(path.sep);
  const slug = segments[0]!;
  if (!isValidSlug(slug)) {
    return err({ code: "INVALID_INPUT", message: `Invalid slug: ${slug}` });
  }
  const projectDir = path.join(realRoot, slug);
  const assetKey = segments.length === 1 ? PROJECT_LOCK_KEY : segments[1]!;
  return ok({ projectDir, assetKey });
}
