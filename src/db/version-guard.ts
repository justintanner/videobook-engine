import * as fs from "node:fs/promises";
import * as path from "node:path";

import Database from "better-sqlite3";

import { VIDEOCITY_DIR } from "./client.js";

interface SchemaRow {
  version: number;
}

/**
 * Read the highest schema_migrations.version recorded in a SQLite file
 * without going through the migrate-on-open path. Returns 0 when the file
 * doesn't exist or has no schema_migrations table yet (fresh project).
 */
async function readSchemaVersion(dbPath: string): Promise<number> {
  try {
    await fs.access(dbPath);
  } catch {
    return 0;
  }
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    const exists = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='schema_migrations'",
      )
      .get();
    if (!exists) return 0;
    const row = db
      .prepare("SELECT MAX(version) AS version FROM schema_migrations")
      .get() as SchemaRow | undefined;
    return row?.version ?? 0;
  } finally {
    db.close();
  }
}

export interface VersionCheckResult {
  ok: boolean;
  recordedStateVersion: number;
  recordedMetadataVersion: number;
  buildStateVersion: number;
  buildMetadataVersion: number;
  /** Set when ok=false; identifies which DB exceeds the build's understanding. */
  reason?: string;
}

/**
 * Guard against opening a project with a SCHEMA NEWER than this build knows
 * about — typically a downgrade scenario where a developer rolled back the
 * videocity binary but the project's metadata.sqlite was migrated by a
 * newer build. A noisy refusal beats silent corruption.
 */
export async function checkProjectSchemaVersion(
  projectDir: string,
  buildStateVersion: number,
  buildMetadataVersion: number,
): Promise<VersionCheckResult> {
  const stateVer = await readSchemaVersion(
    path.join(projectDir, VIDEOCITY_DIR, "state.sqlite"),
  );
  const metaVer = await readSchemaVersion(
    path.join(projectDir, VIDEOCITY_DIR, "metadata.sqlite"),
  );
  if (stateVer > buildStateVersion) {
    return {
      ok: false,
      recordedStateVersion: stateVer,
      recordedMetadataVersion: metaVer,
      buildStateVersion,
      buildMetadataVersion,
      reason: `state.sqlite at version ${stateVer}, build supports ${buildStateVersion}`,
    };
  }
  if (metaVer > buildMetadataVersion) {
    return {
      ok: false,
      recordedStateVersion: stateVer,
      recordedMetadataVersion: metaVer,
      buildStateVersion,
      buildMetadataVersion,
      reason: `metadata.sqlite at version ${metaVer}, build supports ${buildMetadataVersion}`,
    };
  }
  return {
    ok: true,
    recordedStateVersion: stateVer,
    recordedMetadataVersion: metaVer,
    buildStateVersion,
    buildMetadataVersion,
  };
}
