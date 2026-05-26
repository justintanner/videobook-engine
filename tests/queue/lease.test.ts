import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";

import { createFs, type VideocityFs } from "../../src/index.js";
import { closeAllStateDbs, getStateDb } from "../../src/db/client.js";
import { dequeue, heartbeat } from "../../src/queue/dequeue.js";
import { reapStaleLeases } from "../../src/queue/reaper.js";

describe("queue lease + heartbeat + reaper", () => {
  let projectsDir: string;
  let cfs: VideocityFs;

  beforeEach(async () => {
    projectsDir = await fs.mkdtemp(path.join(os.tmpdir(), "cfs-lease-"));
    cfs = createFs({ projectsDir });
    const created = await cfs.createProject("p");
    expect(created.ok).toBe(true);
  });

  afterEach(async () => {
    closeAllStateDbs();
    await fs.rm(projectsDir, { recursive: true, force: true });
  });

  it("heartbeat extends the lease", async () => {
    const dir = (await cfs.resolveProjectDir("p"))!;
    const db = getStateDb(dir);
    await cfs.queue.enqueue("p", { type: "x", payload: {}, dedupeKey: null });
    const job = dequeue(db, process.pid, 1_000);
    expect(job).not.toBeNull();
    const before = db
      .prepare(`SELECT lease_expires_at FROM pending_jobs WHERE id = ?`)
      .get(job!.id) as { lease_expires_at: number };
    await new Promise((r) => setTimeout(r, 5));
    expect(heartbeat(db, job!.id, 5_000)).toBe(true);
    const after = db
      .prepare(`SELECT lease_expires_at FROM pending_jobs WHERE id = ?`)
      .get(job!.id) as { lease_expires_at: number };
    expect(after.lease_expires_at).toBeGreaterThan(before.lease_expires_at);
  });

  it("reaper requeues a job whose lease expired and pid is dead", async () => {
    const dir = (await cfs.resolveProjectDir("p"))!;
    const db = getStateDb(dir);
    db.prepare(
      `INSERT INTO pending_jobs
       (operation_id, type, asset_id, state, payload, max_attempts, enqueued_at, started_at, pid, attempts, lease_expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      "op-stale",
      "noop",
      null,
      "running",
      "{}",
      3,
      Date.now() - 10_000,
      Date.now() - 10_000,
      999999,
      1,
      Date.now() - 5_000,
    );
    const result = reapStaleLeases(db);
    expect(result.requeued).toBe(1);
    const queued = await cfs.queue.list("p", { states: ["queued"] });
    expect(queued.length).toBe(1);
  });

  it("reaper does NOT touch a fresh lease (alive pid, lease in future)", async () => {
    const dir = (await cfs.resolveProjectDir("p"))!;
    const db = getStateDb(dir);
    db.prepare(
      `INSERT INTO pending_jobs
       (operation_id, type, asset_id, state, payload, max_attempts, enqueued_at, started_at, pid, attempts, lease_expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      "op-fresh",
      "noop",
      null,
      "running",
      "{}",
      3,
      Date.now() - 1000,
      Date.now() - 500,
      process.pid,
      1,
      Date.now() + 60_000,
    );
    const result = reapStaleLeases(db);
    expect(result.inspected).toBe(0);
  });
});
