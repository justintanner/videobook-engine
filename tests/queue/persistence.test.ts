import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";

import { createFs, type ClipfirstFs } from "../../src/index.js";
import { closeAllStateDbs, getStateDb } from "../../src/db/client.js";

describe("queue persistence across restart", () => {
  let projectsDir: string;
  let cfs: ClipfirstFs;

  beforeEach(async () => {
    projectsDir = await fs.mkdtemp(path.join(os.tmpdir(), "cfs-restart-"));
    cfs = createFs({ projectsDir });
    const created = await cfs.createProject("p");
    expect(created.ok).toBe(true);
  });

  afterEach(async () => {
    closeAllStateDbs();
    await fs.rm(projectsDir, { recursive: true, force: true });
  });

  it("queued jobs survive a process restart simulation", async () => {
    const a = await cfs.queue.enqueue("p", {
      type: "later",
      payload: { x: 1 },
    });
    const b = await cfs.queue.enqueue("p", {
      type: "later",
      payload: { x: 2 },
    });
    expect(a?.inserted).toBe(true);
    expect(b?.inserted).toBe(true);

    // Simulate restart: close state DB, drop in-memory cache.
    closeAllStateDbs();

    // New "process" sees the same DB on disk.
    const cfs2 = createFs({ projectsDir });
    const jobs = await cfs2.queue.list("p", { states: ["queued"] });
    expect(jobs.length).toBe(2);
    expect(jobs.map((j) => (j.payload as { x: number }).x).sort()).toEqual([1, 2]);
  });

  it("running jobs from a dead pid are reaped to queued on startup", async () => {
    const dir = (await cfs.resolveProjectDir("p"))!;
    const db = getStateDb(dir);
    db.prepare(
      `INSERT INTO pending_jobs
       (operation_id, type, asset_id, state, payload, max_attempts, enqueued_at, started_at, pid, attempts, lease_expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      "op-1",
      "ghost",
      null,
      "running",
      "{}",
      3,
      Date.now() - 60_000,
      Date.now() - 60_000,
      999999, // dead pid
      1,
      Date.now() - 30_000,
    );

    const result = await cfs.queue.reapOnStartup("p");
    expect(result.requeued).toBe(1);
    expect(result.failed).toBe(0);

    const queued = await cfs.queue.list("p", { states: ["queued"] });
    expect(queued.length).toBe(1);
  });

  it("running jobs that exhausted attempts become 'failed' on reap", async () => {
    const dir = (await cfs.resolveProjectDir("p"))!;
    const db = getStateDb(dir);
    db.prepare(
      `INSERT INTO pending_jobs
       (operation_id, type, asset_id, state, payload, max_attempts, enqueued_at, started_at, pid, attempts, lease_expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      "op-2",
      "ghost",
      null,
      "running",
      "{}",
      1,
      Date.now() - 60_000,
      Date.now() - 60_000,
      999999,
      1,
      Date.now() - 30_000,
    );
    const result = await cfs.queue.reapOnStartup("p");
    expect(result.failed).toBe(1);
    const failed = await cfs.queue.list("p", { states: ["failed"] });
    expect(failed.length).toBe(1);
  });

  it("reap leaves a live worker alone", async () => {
    const dir = (await cfs.resolveProjectDir("p"))!;
    const db = getStateDb(dir);
    db.prepare(
      `INSERT INTO pending_jobs
       (operation_id, type, asset_id, state, payload, max_attempts, enqueued_at, started_at, pid, attempts, lease_expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      "op-3",
      "ghost",
      null,
      "running",
      "{}",
      3,
      Date.now() - 60_000,
      Date.now() - 60_000,
      process.pid, // alive
      1,
      Date.now() - 30_000,
    );
    const result = await cfs.queue.reapOnStartup("p");
    expect(result.requeued).toBe(0);
    expect(result.failed).toBe(0);
    const running = await cfs.queue.list("p", { states: ["running"] });
    expect(running.length).toBe(1);
  });
});
