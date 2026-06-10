import * as fs from "node:fs/promises";
import * as path from "node:path";

import { type FsError, type Result, ok, err } from "../types.js";
import { DEFAULT_PROJECT_FILE } from "../constants.js";
import { isProjectSlug } from "./slug.js";
import { getDefaultProject } from "./switch.js";
import {
  withGitLock,
  migrateGitLockKey,
  ProjectDirMissingError,
} from "../git/mutex.js";
import { isLocked } from "../lock/query.js";
import { closeStateDb } from "../db/client.js";
import { isValidAssetId } from "../validation.js";

async function findLockedAsset(
  projectsDir: string,
  projectDir: string,
): Promise<string | null> {
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

export async function renameProject(
  projectsDir: string,
  oldSlug: string,
  newSlug: string,
  gitPath?: string,
): Promise<
  Result<{ oldSlug: string; newSlug: string; path: string }, FsError>
> {
  // Validate slugs
  if (!isProjectSlug(oldSlug)) {
    return err({
      code: "INVALID_INPUT",
      message: `Invalid project slug: ${oldSlug}`,
    });
  }
  if (!isProjectSlug(newSlug)) {
    return err({
      code: "INVALID_INPUT",
      message: `Invalid project slug: ${newSlug}`,
    });
  }

  const oldDir = path.join(projectsDir, oldSlug);
  const newDir = path.join(projectsDir, newSlug);

  // Check source exists
  try {
    await fs.access(path.join(oldDir, ".git"));
  } catch {
    return err({ code: "NOT_FOUND", message: `Project not found: ${oldSlug}` });
  }

  // Check target not taken
  try {
    await fs.access(newDir);
    return err({
      code: "ALREADY_EXISTS",
      message: `Project already exists: ${newSlug}`,
    });
  } catch {
    // Good — target doesn't exist
  }

  // Check for active locks (early, before acquiring mutex)
  const lockedAsset = await findLockedAsset(projectsDir, oldDir);
  if (lockedAsset) {
    return err({ code: "LOCKED", message: `Asset is locked: ${lockedAsset}` });
  }

  // Critical section. A concurrent rename can win while we wait for the
  // lock, leaving oldDir gone — the mutex surfaces that as
  // ProjectDirMissingError, which is this operation's NOT_FOUND.
  try {
    return await withGitLock(oldDir, async () => {
      // TOCTOU re-check: source still exists?
      try {
        await fs.access(path.join(oldDir, ".git"));
      } catch {
        return err({
          code: "NOT_FOUND",
          message: `Project not found: ${oldSlug}`,
        });
      }

      // TOCTOU re-check: target still free?
      try {
        await fs.access(newDir);
        return err({
          code: "ALREADY_EXISTS",
          message: `Project already exists: ${newSlug}`,
        });
      } catch {
        // Still free
      }

      // TOCTOU re-check: locks
      const lockedNow = await findLockedAsset(projectsDir, oldDir);
      if (lockedNow) {
        return err({
          code: "LOCKED",
          message: `Asset is locked: ${lockedNow}`,
        });
      }

      // Close any open state.sqlite handle so the rename can succeed on
      // platforms where renaming a dir with open WAL files is rejected.
      closeStateDb(oldDir);

      // Atomic rename
      await fs.rename(oldDir, newDir);

      // Migrate in-process mutex key
      migrateGitLockKey(oldDir, newDir);

      // Update .default-project if needed
      const currentDefault = await getDefaultProject(projectsDir);
      if (currentDefault === oldSlug) {
        try {
          await fs.writeFile(
            path.join(projectsDir, DEFAULT_PROJECT_FILE),
            newSlug,
          );
        } catch {
          // Rollback rename
          await fs.rename(newDir, oldDir);
          migrateGitLockKey(newDir, oldDir);
          return err({
            code: "IO_ERROR",
            message: "Failed to update default project",
          });
        }
      }

      return ok({ oldSlug, newSlug, path: newDir });
    });
  } catch (error) {
    if (error instanceof ProjectDirMissingError) {
      return err({
        code: "NOT_FOUND",
        message: `Project not found: ${oldSlug}`,
      });
    }
    throw error;
  }
}
