import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";

import { createFs, type ClipfirstFs } from "../src/index.js";
import { closeAllStateDbs, getStateDb } from "../src/db/client.js";

describe("recovery sweep + version guard", () => {
  let projectsDir: string;
  let cfs: ClipfirstFs;
  let projectDir: string;

  beforeEach(async () => {
    projectsDir = await fs.mkdtemp(path.join(os.tmpdir(), "cfs-recover-"));
    cfs = createFs({ projectsDir });
    expect((await cfs.createProject("p")).ok).toBe(true);
    projectDir = path.join(projectsDir, "p");
  });

  afterEach(async () => {
    closeAllStateDbs();
    await fs.rm(projectsDir, { recursive: true, force: true });
  });

  it("aborts orphan recovery_journal rows on startup", async () => {
    const db = getStateDb(projectDir);
    db.prepare(
      `INSERT INTO recovery_journal
       (operation_id, intent, target, scope, status, started_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run("op-orphan-1", "test", null, "project", "pending", 1, 1);
    db.prepare(
      `INSERT INTO recovery_journal
       (operation_id, intent, target, scope, status, started_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run("op-orphan-2", "test", null, "project", "sqlite_done", 1, 1);
    // A complete row should be left alone
    db.prepare(
      `INSERT INTO recovery_journal
       (operation_id, intent, target, scope, status, started_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run("op-done", "test", null, "project", "complete", 1, 1);

    const aborted = await cfs.recoverIncompleteOperations("p");
    expect(aborted).toBe(2);

    const remaining = db
      .prepare(`SELECT operation_id, status FROM recovery_journal ORDER BY operation_id`)
      .all() as Array<{ operation_id: string; status: string }>;
    expect(remaining).toEqual([
      { operation_id: "op-done", status: "complete" },
      { operation_id: "op-orphan-1", status: "aborted" },
      { operation_id: "op-orphan-2", status: "aborted" },
    ]);
  });

  it("schema version check passes for fresh project", async () => {
    const result = await cfs.checkSchemaVersion("p");
    expect(result.ok).toBe(true);
    expect(result.recordedStateVersion).toBe(result.buildStateVersion);
  });

  it("schema version check refuses when state.sqlite is from a newer build", async () => {
    const db = getStateDb(projectDir);
    // Pretend the project was migrated by a future build
    db.prepare(
      `INSERT INTO schema_migrations (version, name, applied_at)
       VALUES (?, ?, ?)`,
    ).run(999, "future_migration", Date.now());

    const result = await cfs.checkSchemaVersion("p");
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("state.sqlite at version 999");
  });
});
