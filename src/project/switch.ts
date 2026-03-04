import * as fs from "node:fs/promises";
import * as path from "node:path";

import { type FsError, type Result, ok, err } from "../types.js";
import { DEFAULT_PROJECT_FILE } from "../constants.js";
import { isProjectSlug } from "./slug.js";

export async function getDefaultProject(
  outputDir: string,
): Promise<string | null> {
  try {
    const content = await fs.readFile(
      path.join(outputDir, DEFAULT_PROJECT_FILE),
      "utf-8",
    );
    return content.trim() || null;
  } catch {
    return null;
  }
}

export async function switchProject(
  outputDir: string,
  slug: string,
): Promise<Result<string, FsError>> {
  if (!isProjectSlug(slug)) {
    return err({
      code: "INVALID_INPUT",
      message: `Invalid project slug: ${slug}`,
    });
  }
  const projectDir = path.join(outputDir, slug);
  try {
    await fs.access(projectDir);
  } catch {
    return err({ code: "NOT_FOUND", message: `Project not found: ${slug}` });
  }

  await fs.mkdir(outputDir, { recursive: true });
  await fs.writeFile(path.join(outputDir, DEFAULT_PROJECT_FILE), slug);
  return ok(slug);
}
