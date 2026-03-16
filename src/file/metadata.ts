import { type FsError, type Result, ok, err } from "../types.js";
import { invalidInput } from "../validation.js";
import { writeFile } from "./write.js";
import { readFile } from "./read.js";

const KEY_PATTERN = /^[a-z0-9][a-z0-9.-]*$/;
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

export async function writeMetadata(
  projectDir: string,
  assetId: string,
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

  return writeFile(projectDir, assetId, metadataFilename(key), json, gitPath);
}

export async function readMetadata<T>(
  projectDir: string,
  assetId: string,
  key: string,
): Promise<Result<T, FsError>> {
  const keyErr = validateKey(key);
  if (keyErr) return keyErr;

  const result = await readFile(projectDir, assetId, metadataFilename(key));
  if (!result.ok) return { ok: false, error: result.error };

  try {
    const parsed = JSON.parse(result.value.toString()) as T;
    return ok(parsed);
  } catch {
    return err({
      code: "IO_ERROR",
      message: `Invalid JSON in metadata key: ${key}`,
    });
  }
}
