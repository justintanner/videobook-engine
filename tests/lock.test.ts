import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";

import { createFs } from "../src/index.js";

describe("lock operations", () => {
  let tmpDir: string;
  let assetDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "clipfirst-lock-"));
    assetDir = path.join(tmpDir, "vid-test");
    await fs.mkdir(assetDir, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  const cfs = createFs({ projectsDir: "/tmp/unused" });

  it("acquires a lock atomically", async () => {
    const result = await cfs.acquireLock(assetDir, { durationMs: 60_000 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.pid).toBe(process.pid);
    expect(result.value.created_at).toBeGreaterThan(0);
    expect(result.value.timeout_at).toBeGreaterThan(result.value.created_at);

    const content = await fs.readFile(path.join(assetDir, ".lock"), "utf-8");
    const data = JSON.parse(content);
    expect(data.pid).toBe(process.pid);
  });

  it("rejects acquiring held lock", async () => {
    await cfs.acquireLock(assetDir, { durationMs: 60_000 });
    const result = await cfs.acquireLock(assetDir, { durationMs: 60_000 });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("LOCKED");
  });

  it("releases a lock", async () => {
    await cfs.acquireLock(assetDir, { durationMs: 60_000 });
    const result = await cfs.releaseLock(assetDir);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toBe(true);

    // Can acquire again
    const reacquire = await cfs.acquireLock(assetDir, { durationMs: 60_000 });
    expect(reacquire.ok).toBe(true);
  });

  it("checks if locked", async () => {
    expect(await cfs.isLocked(assetDir)).toBe(false);
    await cfs.acquireLock(assetDir, { durationMs: 60_000 });
    expect(await cfs.isLocked(assetDir)).toBe(true);
  });

  it("reads lock data", async () => {
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
    await cfs.acquireLock(assetDir, {
      durationMs: 60_000,
      data: { task_id: "abc123", model: "veo3" },
    });
    const data = await cfs.getLockData(assetDir);
    expect(data!.task_id).toBe("abc123");
    expect(data!.model).toBe("veo3");
  });

  it("concurrency: only one process wins the lock", async () => {
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
    const lockData = {
      created_at: Date.now() / 1000,
      timeout_at: Date.now() / 1000 + 3600,
      pid: 999999,
    };
    await fs.writeFile(path.join(assetDir, ".lock"), JSON.stringify(lockData));

    const cleaned = await cfs.cleanStaleLock(assetDir);
    expect(cleaned).toBe(true);

    expect(await cfs.isLocked(assetDir)).toBe(false);
  });

  it("does not clean lock from live PID", async () => {
    await cfs.acquireLock(assetDir, { durationMs: 60_000 });
    const cleaned = await cfs.cleanStaleLock(assetDir);
    expect(cleaned).toBe(false);
    expect(await cfs.isLocked(assetDir)).toBe(true);
  });
});
