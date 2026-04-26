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
import {
  type CharacterRecord,
  exportCharacterPins,
  exportCharacters,
  readCharacter,
  writeCharacter,
} from "../db/character.js";
import { getMetadataDb } from "../db/metadata-client.js";

const KEY_PATTERN = /^[a-z0-9][a-z0-9.-]*$/;
const KEY_MAX_LENGTH = 100;

const CHARACTER_KEY = "character";

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

function isCharacterRecord(value: unknown): value is CharacterRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function writeCharacterToSqlite(
  projectDir: string,
  charAssetId: string,
  record: CharacterRecord,
  sidecarPath: string,
  json: string,
  gitPath?: string,
): Promise<void> {
  await withGitLock(projectDir, async () => {
    const result = await runOperation(projectDir, {
      intent: "write_character",
      scope: "asset",
      target: charAssetId,
      subject: `update character ${charAssetId}`,
      work: (ctx) => {
        writeCharacter(ctx.metadataDb, charAssetId, record);
        // Mirror through asset_metadata so generic readers see a consistent
        // value even before they switch to the typed accessor.
        upsertAssetMetadata(ctx.metadataDb, charAssetId, CHARACTER_KEY, record);
        ctx.appendEvent({
          subjectType: "character",
          subjectId: charAssetId,
          kind: "metadata_changed",
          detail: { keys: Object.keys(record).length },
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
        { path: "characters.json", rebuild: (db) => exportCharacters(db) },
        {
          path: "character_pins.json",
          rebuild: (db) => exportCharacterPins(db),
        },
      ],
    });
    await fs.writeFile(sidecarPath, json);
    const hash = await commitAndFinalizeOperation(projectDir, result, {
      operation: "write",
      assetId: charAssetId,
      details: { file: metadataFilename(CHARACTER_KEY) },
      gitPath,
      paths: [path.join(charAssetId, metadataFilename(CHARACTER_KEY))],
    });
    if (!hash) throw new Error("Failed to commit character metadata");
  });
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
    const hash = await commitAndFinalizeOperation(projectDir, result, {
      operation: "write",
      assetId,
      details: { file: metadataFilename(key) },
      gitPath,
      paths: [path.join(assetId, metadataFilename(key))],
    });
    if (!hash) throw new Error(`Failed to commit metadata key: ${key}`);
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
    if (key === CHARACTER_KEY && isCharacterRecord(data)) {
      await writeCharacterToSqlite(
        projectDir,
        assetId,
        data,
        filePath,
        json,
        gitPath,
      );
    } else {
      await writeAssetMetadataToSqlite(
        projectDir,
        assetId,
        key,
        data,
        filePath,
        json,
        gitPath,
      );
    }
  } catch (error: unknown) {
    return err({
      code: "IO_ERROR",
      message: error instanceof Error ? error.message : String(error),
    });
  }

  return ok(filePath);
}

async function metadataDbExists(projectDir: string): Promise<boolean> {
  try {
    const stat = await fs.stat(
      path.join(projectDir, ".clipfirst", "metadata.sqlite"),
    );
    return stat.isFile();
  } catch {
    return false;
  }
}

export async function readMetadata<T>(
  projectDir: string,
  assetId: string,
  key: string,
): Promise<Result<T, FsError>> {
  const keyErr = validateKey(key);
  if (keyErr) return keyErr;

  // Character is the only key with SQL-native typed storage; for everything
  // else the sidecar is still the source-of-truth signal (its presence ==
  // metadata exists; its deletion == metadata deleted). asset_metadata is
  // a passive mirror used only for the audit trail and the canonical export.
  if (key === CHARACTER_KEY && (await metadataDbExists(projectDir))) {
    try {
      const db = getMetadataDb(projectDir);
      const character = readCharacter(db, assetId);
      if (character) return ok(character as unknown as T);
    } catch {
      // fall through to sidecar
    }
  }

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
