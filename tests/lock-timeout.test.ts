import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";

import { createFs } from "../src/index.js";
import { closeAllStateDbs, getStateDb } from "../src/db/client.js";

describe("lock timeout behavior", () => {
  let projectsDir: string;
  let projectDir: string;
  let assetDir: string;

  beforeEach(async () => {
    projectsDir = await fs.mkdtemp(path.join(os.tmpdir(), "videocity-timeout-"));
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

  it("re-acquires expired lock (expired takeover)", async () => {
    const cfs = cfsFor();
    const first = await cfs.acquireLock(assetDir, { durationMs: 1 });
    expect(first.ok).toBe(true);

    await new Promise((resolve) => setTimeout(resolve, 10));

    const second = await cfs.acquireLock(assetDir, { durationMs: 60_000 });
    expect(second.ok).toBe(true);
    if (second.ok) {
      expect(second.value.timeout_at).toBeGreaterThan(second.value.created_at);
    }
  });

  it("isLocked returns false for expired lock", async () => {
    const cfs = cfsFor();
    const db = getStateDb(projectDir);
    db.prepare(
      `INSERT INTO locks (asset_id, pid, created_at, timeout_at)
       VALUES (?, ?, ?, ?)`,
    ).run("vid-test", process.pid, 1000, 1001);

    expect(await cfs.isLocked(assetDir)).toBe(false);
  });

  it("cleanStaleLock removes expired lock even with live PID", async () => {
    const cfs = cfsFor();
    const db = getStateDb(projectDir);
    db.prepare(
      `INSERT INTO locks (asset_id, pid, created_at, timeout_at)
       VALUES (?, ?, ?, ?)`,
    ).run("vid-test", process.pid, 1000, 1001);

    const cleaned = await cfs.cleanStaleLock(assetDir);
    expect(cleaned).toBe(true);

    const row = db
      .prepare("SELECT * FROM locks WHERE asset_id = ?")
      .get("vid-test");
    expect(row).toBeUndefined();
  });

  it("non-expired lock blocks acquisition", async () => {
    const cfs = cfsFor();
    const first = await cfs.acquireLock(assetDir, { durationMs: 60_000 });
    expect(first.ok).toBe(true);

    const second = await cfs.acquireLock(assetDir, { durationMs: 60_000 });
    expect(second.ok).toBe(false);
    if (!second.ok) {
      expect(second.error.code).toBe("LOCKED");
    }
  });

  it("getLockData includes timeout_at", async () => {
    const cfs = cfsFor();
    await cfs.acquireLock(assetDir, { durationMs: 30_000 });
    const data = await cfs.getLockData(assetDir);
    expect(data).toBeTruthy();
    expect(data!.timeout_at).toBeGreaterThan(data!.created_at);
    expect(data!.timeout_at - data!.created_at).toBeCloseTo(30, 0);
  });
});
