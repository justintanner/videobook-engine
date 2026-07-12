import * as fs from "node:fs/promises";
import * as path from "node:path";

import { type FsError, type Result, ok, err } from "../types.js";
import {
  invalidInput,
  isSafeFilename,
  isSafePath,
  isWithinDir,
} from "../validation.js";
import { readFile } from "./read.js";
import {
  commitAndFinalizeOperation,
  runOperation,
} from "../db/run-operation.js";
import { withGitLock } from "../git/mutex.js";
import {
  upsertAssetMetadata,
  exportAssetMetadata,
} from "../db/asset-metadata.js";
import { exportAssetEvents } from "../db/asset-events.js";

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

async function writeAssetMetadataToSqlite(
  projectDir: string,
  assetId: string,
  key: string,
  data: unknown,
  sidecarPath: string,
  json: string,
  gitPath?: string,
): Promise<void> {
  await withGitLock(projectDir, async () => {
    const result = await runOperation(projectDir, {
      intent: "write_asset_metadata",
      scope: "asset",
      target: assetId,
      subject: `set ${assetId}.${key}`,
      work: (ctx) => {
        upsertAssetMetadata(ctx.metadataDb, assetId, key, data);
        ctx.appendEvent({
          subjectType: "asset",
          subjectId: assetId,
          kind: "metadata_changed",
          detail: { key },
        });
      },
      exports: [
        {
          path: "asset_events.json",
          rebuild: (db) => exportAssetEvents(db),
        },
        {
          path: "asset_metadata.json",
          rebuild: (db) => exportAssetMetadata(db),
        },
      ],
    });
    await fs.writeFile(sidecarPath, json);
    const commit = await commitAndFinalizeOperation(projectDir, result, {
      operation: "write",
      assetId,
      details: { file: metadataFilename(key) },
      gitPath,
      paths: [path.join(assetId, metadataFilename(key))],
    });
    if (commit.status === "failed") {
      throw new Error(
        `Failed to commit metadata key ${key}: ${commit.message}`,
      );
    }
  });
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

  const filename = metadataFilename(key);
  if (!isSafePath(assetId)) return invalidInput(`Invalid asset ID: ${assetId}`);
  if (!isSafeFilename(filename))
    return invalidInput(`Invalid filename: ${filename}`);

  const assetDir = path.join(projectDir, assetId);
  try {
    await fs.access(assetDir);
  } catch {
    return err({ code: "NOT_FOUND", message: `Asset not found: ${assetId}` });
  }
  const filePath = path.join(assetDir, filename);
  if (!isWithinDir(projectDir, filePath))
    return invalidInput("Path escapes project directory");

  try {
    await writeAssetMetadataToSqlite(
      projectDir,
      assetId,
      key,
      data,
      filePath,
      json,
      gitPath,
    );
  } catch (error: unknown) {
    return err({
      code: "IO_ERROR",
      message: error instanceof Error ? error.message : String(error),
    });
  }

  return ok(filePath);
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
