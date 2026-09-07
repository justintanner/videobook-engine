import type { DatabaseSync } from "@dolthub/doltlite";

import { SCHEMA_VERSION } from "./catalog-metadata.js";
import { TAG_SCHEMA_SQL } from "./schema.js";

// Schema 25 adds the asset-tag tables. The upgrade is structural only:
// existing books start with empty tag state, and importing whatever tags a
// consumer already keeps in its own sidecars is the consumer's job.
//
// The store runs this step in a SQL transaction with a durable commit
// outbox, including its empty-table write set. An interrupted upgrade can
// therefore roll back or finish its Dolt commit on the next open. The
// version stamp is deliberately conditional: a
// schema-22 or -23 catalog is only complete once its notebook-grid
// re-encoding has also run, and that step stamps the current version
// itself. Stamping here would let a crash between the two steps leave a
// catalog claiming schema 25 while its grid is still encoded the old way.
const ASSET_TAG_MIGRATION_SOURCE_VERSION = 24;

export const ASSET_TAG_TABLES = [
  "artifact_tags",
  "artifact_tag_dismissals",
  "artifact_tag_snapshots",
] as const;

interface SchemaRow {
  version: number;
}

interface AssetTagMigrationResult {
  /** Whether this step created tables that were missing. */
  created: boolean;
  /** Whether this step also stamped the current schema version. */
  stamped: boolean;
  version: number;
}

export function applyAssetTagMigration(
  db: DatabaseSync,
): AssetTagMigrationResult {
  const created = ASSET_TAG_TABLES.some((table) => !tableExists(db, table));
  db.exec(TAG_SCHEMA_SQL);
  const row = db
    .prepare("SELECT version FROM engine_schema WHERE singleton=1")
    .get() as unknown as SchemaRow | undefined;
  const version = row?.version ?? 0;
  if (version !== ASSET_TAG_MIGRATION_SOURCE_VERSION) {
    return { created, stamped: false, version };
  }
  db.prepare("UPDATE engine_schema SET version=? WHERE singleton=1")
    .run(SCHEMA_VERSION);
  return { created, stamped: true, version: SCHEMA_VERSION };
}

function tableExists(db: DatabaseSync, table: string): boolean {
  return (
    db
      .prepare(
        "SELECT 1 AS present FROM sqlite_master WHERE type='table' AND name=?",
      )
      .get(table) !== undefined
  );
}
