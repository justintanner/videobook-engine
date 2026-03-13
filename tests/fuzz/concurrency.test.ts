import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { createSandbox, type Sandbox } from "../helpers/sandbox.js";

describe("concurrency stress tests", () => {
  let sandbox: Sandbox;

  afterEach(async () => {
    await sandbox?.cleanup();
  });

  it("10 parallel createAsset with same name — all succeed with unique IDs", async () => {
    sandbox = await createSandbox();
    const project = await sandbox.fs.createProject();
    expect(project.ok).toBe(true);

    const results = await Promise.all(
      Array.from({ length: 10 }, () =>
        sandbox.fs.createAsset("vid", "parallel-test"),
      ),
    );

    const successes = results.filter((r) => r.ok);
    expect(successes.length).toBe(10);

    // All asset IDs should be unique
    const ids = successes.map((r) => (r.ok ? r.value.assetId : ""));
    const uniqueIds = new Set(ids);
    expect(uniqueIds.size).toBe(10);
  }, 30_000);

  it("5 parallel writeFile to same asset — no data corruption", async () => {
    sandbox = await createSandbox();
    const project = await sandbox.fs.createProject();
    expect(project.ok).toBe(true);

    const asset = await sandbox.fs.createAsset("vid", "write-target");
    expect(asset.ok).toBe(true);
    if (!asset.ok) return;

    const assetId = asset.value.assetId;

    // Write 5 different files in parallel
    const writes = await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        sandbox.fs.writeFile(assetId, `file-${i}.txt`, `content-${i}`),
      ),
    );

    // All writes should succeed
    const writeSuccesses = writes.filter((r) => r.ok);
    expect(writeSuccesses.length).toBe(5);

    // Verify each file has correct content
    for (let i = 0; i < 5; i++) {
      const read = await sandbox.fs.readFile(assetId, `file-${i}.txt`);
      expect(read.ok).toBe(true);
      if (read.ok) {
        expect(read.value.toString()).toBe(`content-${i}`);
      }
    }
  }, 30_000);

  it("20 concurrent acquireLock — exactly 1 wins", async () => {
    sandbox = await createSandbox();
    const project = await sandbox.fs.createProject();
    expect(project.ok).toBe(true);

    const asset = await sandbox.fs.createAsset("vid", "lock-race");
    expect(asset.ok).toBe(true);
    if (!asset.ok) return;

    const assetDir = asset.value.path;

    const results = await Promise.all(
      Array.from({ length: 20 }, () =>
        sandbox.fs.acquireLock(assetDir, { durationMs: 60_000 }),
      ),
    );

    const wins = results.filter((r) => r.ok);
    const losses = results.filter((r) => !r.ok);
    expect(wins.length).toBe(1);
    expect(losses.length).toBe(19);
    for (const loss of losses) {
      if (!loss.ok) {
        expect(loss.error.code).toBe("LOCKED");
      }
    }
  }, 30_000);

  it("5 parallel createProject — default-project file not corrupted", async () => {
    sandbox = await createSandbox();

    const results = await Promise.all(
      Array.from({ length: 5 }, () => sandbox.fs.createProject()),
    );

    const successes = results.filter((r) => r.ok);
    expect(successes.length).toBe(5);

    // All slugs should be unique
    const slugs = successes.map((r) => (r.ok ? r.value.slug : ""));
    const uniqueSlugs = new Set(slugs);
    expect(uniqueSlugs.size).toBe(5);

    // Default project file should contain a valid slug (one of the 5)
    const defaultContent = await fs.readFile(
      path.join(sandbox.projectsDir, ".default-project"),
      "utf-8",
    );
    const defaultSlug = defaultContent.trim();
    expect(defaultSlug.length).toBeGreaterThan(0);
    // It should be one of the created slugs
    expect(slugs).toContain(defaultSlug);
  }, 30_000);
});
