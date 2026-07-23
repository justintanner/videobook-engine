import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";

import { createSandbox, type Sandbox } from "./helpers/sandbox.js";
import { getStateDb } from "../src/db/client.js";
import { getMetadataDb } from "../src/db/metadata-client.js";
import { recoverOnStartup } from "../src/db/recover.js";
import {
  commitAndFinalizeOperation,
  runOperation,
} from "../src/db/run-operation.js";

interface JournalRow {
  operation_id: string;
  status: string;
  git_hash: string | null;
}

function newestJournalRow(dir: string): JournalRow {
  return getStateDb(dir)
    .prepare(
      `SELECT operation_id, status, git_hash FROM recovery_journal
       ORDER BY started_at DESC LIMIT 1`,
    )
    .get() as JournalRow;
}

function journalRow(dir: string, operationId: string): JournalRow {
  return getStateDb(dir)
    .prepare(
      `SELECT operation_id, status, git_hash FROM recovery_journal
       WHERE operation_id = ?`,
    )
    .get(operationId) as JournalRow;
}

async function failExportOperation(dir: string): Promise<JournalRow> {
  await expect(
    runOperation(dir, {
      intent: "write_project_meta",
      scope: "project",
      target: "timeline",
      subject: "export write failure",
      work: () => {},
      exports: [
        {
          path: "timeline.json",
          rebuild: () => {
            throw new Error("export boom");
          },
        },
      ],
    }),
  ).rejects.toThrow("export boom");
  return newestJournalRow(dir);
}

describe("journal survives export-write failure (vce-91h)", () => {
  let sandbox: Sandbox;
  let dir: string;

  beforeEach(async () => {
    sandbox = await createSandbox();
    await sandbox.fs.createProject("test-proj");
    dir = (await sandbox.fs.resolveProjectDir("test-proj"))!;
  });

  afterEach(async () => {
    await sandbox.cleanup();
  });

  it("leaves the journal at sqlite_done when an export write fails", async () => {
    const row = await failExportOperation(dir);
    // Pre-fix this row was marked "aborted", which recovery never replays —
    // orphaning a mutation that already committed to SQLite.
    expect(row.status).toBe("sqlite_done");

    const op = getMetadataDb(dir)
      .prepare("SELECT 1 FROM operations WHERE operation_id = ?")
      .get(row.operation_id);
    expect(op).toBeTruthy();
  });

  it("recoverOnStartup completes the orphaned operation", async () => {
    const row = await failExportOperation(dir);

    const recovery = await recoverOnStartup(dir);
    expect(recovery.completed).toBe(1);
    expect(recovery.aborted).toBe(0);
    expect(recovery.failed).toBe(0);

    const healed = journalRow(dir, row.operation_id);
    expect(healed.status).toBe("complete");
    expect(healed.git_hash).toBeTruthy();

    await expect(
      fs.access(path.join(dir, ".videocity", "export", "timeline.json")),
    ).resolves.toBeUndefined();

    const revision = (await sandbox.fs.getProjectHistory("test-proj", 1))[0];
    expect(revision?.details?.["op-id"]).toBe(row.operation_id);
  });

  it("still aborts when the work itself fails before COMMIT", async () => {
    await expect(
      runOperation(dir, {
        intent: "write_project_meta",
        scope: "project",
        subject: "work failure",
        work: () => {
          throw new Error("work boom");
        },
      }),
    ).rejects.toThrow("work boom");

    const row = newestJournalRow(dir);
    expect(row.status).toBe("aborted");

    const op = getMetadataDb(dir)
      .prepare("SELECT 1 FROM operations WHERE operation_id = ?")
      .get(row.operation_id);
    expect(op).toBeUndefined();
  });

  it("replays idempotently after a later successful operation", async () => {
    const orphan = await failExportOperation(dir);

    const result = await runOperation(dir, {
      intent: "write_project_meta",
      scope: "project",
      target: "timeline",
      subject: "successful retry",
      work: () => {},
      exports: [
        {
          path: "timeline.json",
          rebuild: () => JSON.stringify({ ok: true }),
        },
      ],
    });
    const commit = await commitAndFinalizeOperation(dir, result, {
      operation: "write",
    });
    expect(commit.status).not.toBe("failed");

    const recovery = await recoverOnStartup(dir);
    expect(recovery.aborted).toBe(0);
    expect(recovery.failed).toBe(0);

    const healed = journalRow(dir, orphan.operation_id);
    expect(healed.status).toBe("complete");
  });
});
