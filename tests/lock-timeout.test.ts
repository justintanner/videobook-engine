import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";

import { createFs } from "../src/index.js";

describe("lock timeout behavior", () => {
  let tmpDir: string;
  let assetDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "clipfirst-timeout-"));
    assetDir = path.join(tmpDir, "vid-test");
    await fs.mkdir(assetDir, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  const cfs = createFs({ outputDir: "/tmp/unused" });

  it("re-acquires expired lock (expired takeover)", async () => {
    // Acquire with 1ms timeout — will be expired immediately
    const first = await cfs.acquireLock(assetDir, { durationMs: 1 });
    expect(first.ok).toBe(true);

    // Small delay to ensure expiry
    await new Promise((resolve) => setTimeout(resolve, 10));

    // Should succeed because the existing lock is expired
    const second = await cfs.acquireLock(assetDir, { durationMs: 60_000 });
    expect(second.ok).toBe(true);
    if (second.ok) {
      expect(second.value.timeout_at).toBeGreaterThan(second.value.created_at);
    }
  });

  it("isLocked returns false for expired lock on disk", async () => {
    // Write an already-expired lock
    const lockData = {
      created_at: 1000,
      timeout_at: 1001,
      pid: process.pid,
    };
    await fs.writeFile(path.join(assetDir, ".lock"), JSON.stringify(lockData));

    expect(await cfs.isLocked(assetDir)).toBe(false);
  });

  it("cleanStaleLock removes expired lock even with live PID", async () => {
    // Write a lock with our own PID but expired timeout
    const lockData = {
      created_at: 1000,
      timeout_at: 1001,
      pid: process.pid,
    };
    await fs.writeFile(path.join(assetDir, ".lock"), JSON.stringify(lockData));

    const cleaned = await cfs.cleanStaleLock(assetDir);
    expect(cleaned).toBe(true);

    // Lock file should be gone
    await expect(fs.access(path.join(assetDir, ".lock"))).rejects.toThrow();
  });

  it("non-expired lock blocks acquisition", async () => {
    const first = await cfs.acquireLock(assetDir, { durationMs: 60_000 });
    expect(first.ok).toBe(true);

    const second = await cfs.acquireLock(assetDir, { durationMs: 60_000 });
    expect(second.ok).toBe(false);
    if (!second.ok) {
      expect(second.error.code).toBe("LOCKED");
    }
  });

  it("getLockData includes timeout_at", async () => {
    await cfs.acquireLock(assetDir, { durationMs: 30_000 });
    const data = await cfs.getLockData(assetDir);
    expect(data).toBeTruthy();
    expect(data!.timeout_at).toBeGreaterThan(data!.created_at);
    expect(data!.timeout_at - data!.created_at).toBeCloseTo(30, 0);
  });
});
