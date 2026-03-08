import * as fs from "node:fs/promises";
import * as path from "node:path";

import { type FsError, type Result, ok, err } from "../types.js";
import { invalidInput } from "../validation.js";
import { commitOperation } from "../git/commit.js";
import { withGitLock } from "../git/mutex.js";
import { withCleanWorktree } from "../git/stash.js";

const KEY_PATTERN = /^[a-z0-9][a-z0-9-]*$/;
const KEY_MAX_LENGTH = 100;

function validateKey(key: string): Result<never, FsError> | null {
  if (!key || key.length > KEY_MAX_LENGTH || !KEY_PATTERN.test(key)) {
    return invalidInput(
      `Invalid metadata key: ${key} (must match ${KEY_PATTERN.source}, max ${KEY_MAX_LENGTH} chars)`,
    );
  }
  return null;
}

function metadataFilename(key: string): string {
  return `.${key}.json`;
}

export async function writeProjectMeta(
  projectDir: string,
  key: string,
  data: unknown,
  gitPath?: string,
): Promise<Result<string, FsError>> {
  const keyErr = validateKey(key);
  if (keyErr) return keyErr;

  let json: string;
  try {
    json = JSON.stringify(data, null, 2);
  } catch (error: unknown) {
    return invalidInput(
      `Cannot serialize metadata: ${(error as Error).message}`,
    );
  }

  const filename = metadataFilename(key);
  const filePath = path.join(projectDir, filename);

  await withGitLock(projectDir, async () => {
    return withCleanWorktree(
      projectDir,
      async () => {
        await fs.writeFile(filePath, json);
        await commitOperation(
          projectDir,
          "write",
          filename,
          undefined,
          gitPath,
        );
      },
      gitPath,
    );
  });

  return ok(filePath);
}

export async function readProjectMeta<T>(
  projectDir: string,
  key: string,
): Promise<Result<T, FsError>> {
  const keyErr = validateKey(key);
  if (keyErr) return keyErr;

  const filePath = path.join(projectDir, metadataFilename(key));

  let data: Buffer;
  try {
    data = await fs.readFile(filePath);
  } catch (error: unknown) {
    const e = error as NodeJS.ErrnoException;
    if (e.code === "ENOENT") {
      return err({
        code: "NOT_FOUND",
        message: `Project metadata not found: ${key}`,
      });
    }
    return err({ code: "IO_ERROR", message: e.message });
  }

  try {
    const parsed = JSON.parse(data.toString()) as T;
    return ok(parsed);
  } catch {
    return err({
      code: "IO_ERROR",
      message: `Invalid JSON in project metadata: ${key}`,
    });
  }
}
