import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import Database from "better-sqlite3";

import { closeAllStateDbs } from "../../src/db/client.js";
import { getMetadataDb } from "../../src/db/metadata-client.js";
import * as m0001 from "../../src/db/migrations/metadata_0001_init.js";
import * as m0002 from "../../src/db/migrations/metadata_0002_audio_waveforms.js";
import * as m0003 from "../../src/db/migrations/metadata_0003_timeline_audio.js";
import * as m0004 from "../../src/db/migrations/metadata_0004_prompt_history.js";
import * as m0005 from "../../src/db/migrations/metadata_0005_drop_unused.js";

const LEGACY_MIGRATIONS = [m0001, m0002, m0003, m0004, m0005];

describe("metadata migrations", () => {
  let projectRoot: string | undefined;

  afterEach(async () => {
    closeAllStateDbs();
    if (projectRoot) {
      await fs.rm(projectRoot, { recursive: true, force: true });
      projectRoot = undefined;
    }
  });

  it("upgrades version 5 by removing typed character tables", async () => {
    projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "vce-meta-v5-"));
    const metadataDir = path.join(projectRoot, ".videocity");
    await fs.mkdir(metadataDir, { recursive: true });

    const legacyDb = new Database(path.join(metadataDir, "metadata.sqlite"));
    for (const migration of LEGACY_MIGRATIONS) {
      migration.up(legacyDb);
      legacyDb
        .prepare(
          `INSERT INTO schema_migrations
             (version, name, checksum, applied_at)
           VALUES (?, ?, '', ?)`,
        )
        .run(migration.version, migration.name, Date.now());
    }

    legacyDb
      .prepare(
        `INSERT INTO characters (asset_id, name, raw_json)
         VALUES ('char-alex', 'Alex', '{"name":"Alex"}')`,
      )
      .run();
    legacyDb
      .prepare(
        `INSERT INTO character_pins
           (character_id, slot, position, asset_id)
         VALUES ('char-alex', 'wardrobe', 0, 'img-jacket')`,
      )
      .run();
    legacyDb
      .prepare(
        `INSERT INTO asset_metadata
           (asset_id, meta_key, value, updated_at)
         VALUES ('char-alex', 'character', '{"name":"Alex"}', ?)`,
      )
      .run(Date.now());
    legacyDb.close();

    const upgradedDb = getMetadataDb(projectRoot);
    const version = upgradedDb
      .prepare("SELECT MAX(version) AS version FROM schema_migrations")
      .get() as { version: number };
    expect(version.version).toBe(6);

    const removedTables = upgradedDb
      .prepare(
        `SELECT name FROM sqlite_master
         WHERE type = 'table' AND name IN ('characters', 'character_pins')`,
      )
      .all();
    expect(removedTables).toEqual([]);

    const genericMetadata = upgradedDb
      .prepare(
        `SELECT value FROM asset_metadata
         WHERE asset_id = 'char-alex' AND meta_key = 'character'`,
      )
      .get() as { value: string };
    expect(JSON.parse(genericMetadata.value)).toEqual({ name: "Alex" });
  });
});
