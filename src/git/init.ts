import * as fs from "node:fs/promises";
import * as path from "node:path";

import { CREATED_AT_FILE } from "../constants.js";
import { getStateDb, VIDEOCITY_DIR } from "../db/client.js";
import { ensureGitignorePatterns } from "../db/gitignore.js";
import { catalogForProjectDir } from "../storage/context.js";

const PROJECT_MARKER = ".videobook";
const LEGACY_SIDECAR_DIR = ".clipfirst";

export async function isGitRepo(projectDir: string): Promise<boolean> {
  return catalogForProjectDir(projectDir) !== null;
}

export async function runGitMaintenance(
  projectDir: string,
  gitPath?: string,
): Promise<void> {
  void projectDir;
  void gitPath;
}

export async function migrateLegacySidecar(
  projectDir: string,
  gitPath?: string,
): Promise<void> {
  void gitPath;
  const legacy = path.join(projectDir, LEGACY_SIDECAR_DIR);
  const current = path.join(projectDir, VIDEOCITY_DIR);
  try {
    await fs.access(legacy);
  } catch {
    return;
  }
  try {
    await fs.access(current);
    const entries = await fs.readdir(legacy);
    for (const entry of entries) {
      const source = path.join(legacy, entry);
      const destination = path.join(current, entry);
      try {
        await fs.access(destination);
      } catch {
        await fs.rename(source, destination);
      }
    }
    await fs.rm(legacy, { recursive: true, force: true });
  } catch {
    await fs.rename(legacy, current);
  }
}

export async function initProjectRepo(
  projectDir: string,
  gitPath?: string,
): Promise<boolean> {
  void gitPath;
  let initialized = false;
  try {
    await fs.access(path.join(projectDir, PROJECT_MARKER));
  } catch {
    initialized = true;
    await fs.writeFile(path.join(projectDir, PROJECT_MARKER), "videobook\n");
    await fs.writeFile(
      path.join(projectDir, CREATED_AT_FILE),
      String(Math.floor(Date.now() / 1000)),
    );
  }
  await migrateLegacySidecar(projectDir);
  getStateDb(projectDir);
  await ensureGitignorePatterns(projectDir);
  return initialized;
}
