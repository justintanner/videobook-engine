import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";

import { createFs } from "../src/index.js";
import { closeAllStateDbs, getStateDb } from "../src/db/client.js";

describe("lock operations (sqlite-backed)", () => {
  let projectsDir: string;
  let projectDir: string;
  let assetDir: string;

  beforeEach(async () => {
    projectsDir = await fs.mkdtemp(path.join(os.tmpdir(), "clipfirst-lock-"));
    projectDir = path.join(projectsDir, "proj");
    assetDir = path.join(projectDir, "vid-test");
    await fs.mkdir(assetDir, { recursive: true });
  });

  afterEach(async () => {
    closeAllStateDbs();
    await fs.rm(projectsDir, { recursive: true, force: true });
  });

  function cfsFor(): ReturnType<typeof createFs> {
    return createFs({ projectsDir });
  }

  it("acquires a lock atomically", async () => {
    const cfs = cfsFor();
    const result = await cfs.acquireLock(assetDir, { durationMs: 60_000 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.pid).toBe(process.pid);
    expect(result.value.created_at).toBeGreaterThan(0);
    expect(result.value.timeout_at).toBeGreaterThan(result.value.created_at);
  });

  it("rejects acquiring held lock", async () => {
    const cfs = cfsFor();
    await cfs.acquireLock(assetDir, { durationMs: 60_000 });
    const result = await cfs.acquireLock(assetDir, { durationMs: 60_000 });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("LOCKED");
  });

  it("releases a lock", async () => {
    const cfs = cfsFor();
    await cfs.acquireLock(assetDir, { durationMs: 60_000 });
    const result = await cfs.releaseLock(assetDir);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toBe(true);

    const reacquire = await cfs.acquireLock(assetDir, { durationMs: 60_000 });
    expect(reacquire.ok).toBe(true);
  });

  it("releaseLock returns false when no lock present", async () => {
    const cfs = cfsFor();
    const result = await cfs.releaseLock(assetDir);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toBe(false);
  });

  it("checks if locked", async () => {
    const cfs = cfsFor();
    expect(await cfs.isLocked(assetDir)).toBe(false);
    await cfs.acquireLock(assetDir, { durationMs: 60_000 });
    expect(await cfs.isLocked(assetDir)).toBe(true);
  });

  it("reads lock data", async () => {
    const cfs = cfsFor();
    await cfs.acquireLock(assetDir, {
      durationMs: 60_000,
      data: { url: "https://example.com" },
    });
    const data = await cfs.getLockData(assetDir);
    expect(data).toBeTruthy();
    expect(data!.url).toBe("https://example.com");
    expect(data!.pid).toBe(process.pid);
  });

  it("stores custom data in lock", async () => {
    const cfs = cfsFor();
    await cfs.acquireLock(assetDir, {
      durationMs: 60_000,
      data: { task_id: "abc123", model: "veo3" },
    });
    const data = await cfs.getLockData(assetDir);
    expect(data!.task_id).toBe("abc123");
    expect(data!.model).toBe("veo3");
  });

  it("concurrency: only one process wins the lock", async () => {
    const cfs = cfsFor();
    const results = await Promise.all([
      cfs.acquireLock(assetDir, { durationMs: 60_000 }),
      cfs.acquireLock(assetDir, { durationMs: 60_000 }),
      cfs.acquireLock(assetDir, { durationMs: 60_000 }),
    ]);

    const wins = results.filter((r) => r.ok);
    const losses = results.filter((r) => !r.ok);
    expect(wins.length).toBe(1);
    expect(losses.length).toBe(2);
  });

  it("cleans stale lock from dead PID", async () => {
    const cfs = cfsFor();
    // Insert a lock row with a non-existent PID via the state DB
    const db = getStateDb(projectDir);
    db.prepare(
      `INSERT INTO locks (asset_id, pid, created_at, timeout_at)
       VALUES (?, ?, ?, ?)`,
    ).run("vid-test", 999999, Date.now() / 1000, Date.now() / 1000 + 3600);

    expect(await cfs.isLocked(assetDir)).toBe(true);
    const cleaned = await cfs.cleanStaleLock(assetDir);
    expect(cleaned).toBe(true);
    expect(await cfs.isLocked(assetDir)).toBe(false);
  });

  it("does not clean lock from live PID", async () => {
    const cfs = cfsFor();
    await cfs.acquireLock(assetDir, { durationMs: 60_000 });
    const cleaned = await cfs.cleanStaleLock(assetDir);
    expect(cleaned).toBe(false);
    expect(await cfs.isLocked(assetDir)).toBe(true);
  });

  it("cleans expired lock automatically on next acquire", async () => {
    const cfs = cfsFor();
    const db = getStateDb(projectDir);
    db.prepare(
      `INSERT INTO locks (asset_id, pid, created_at, timeout_at)
       VALUES (?, ?, ?, ?)`,
    ).run("vid-test", process.pid, 1000, 2000);

    // Old expired lock — new acquire should take over
    const result = await cfs.acquireLock(assetDir, { durationMs: 60_000 });
    expect(result.ok).toBe(true);
  });
});
