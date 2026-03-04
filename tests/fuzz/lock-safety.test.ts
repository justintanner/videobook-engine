import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as path from "node:path";

import { createSandbox, type Sandbox } from "../helpers/sandbox.js";

describe("lock safety fuzz tests", () => {
  let sandbox: Sandbox;
  let projectSlug: string;

  beforeEach(async () => {
    sandbox = await createSandbox();
    const result = await sandbox.fs.createProject("lock-safety");
    if (!result.ok) throw new Error("Failed to create project");
    projectSlug = result.value.slug;
  }, 15_000);

  afterEach(async () => {
    await sandbox.cleanup();
  });

  it("renameAsset rejects rename when a lock is held", async () => {
    const asset = await sandbox.fs.createAsset(
      "vid",
      "square-test",
      projectSlug,
    );
    if (!asset.ok) throw new Error("Failed to create asset");
    const assetId = asset.value.assetId;
    const assetDir = path.join(sandbox.outputDir, projectSlug, assetId);

    const lockResult = await sandbox.fs.acquireLock(assetDir, {
      durationMs: 60_000,
    });
    expect(lockResult.ok).toBe(true);

    const renameResult = await sandbox.fs.renameAsset(
      assetId,
      "new-name",
      projectSlug,
    );
    expect(renameResult.ok).toBe(false);
    if (!renameResult.ok) {
      expect(renameResult.error.code).toBe("LOCKED");
    }

    await sandbox.fs.releaseLock(assetDir);
  }, 30_000);

  it("deleteAsset rejects deletion when lock is held", async () => {
    const asset = await sandbox.fs.createAsset(
      "vid",
      "delete-locked",
      projectSlug,
    );
    if (!asset.ok) throw new Error("Failed to create asset");
    const assetId = asset.value.assetId;
    const assetDir = path.join(sandbox.outputDir, projectSlug, assetId);

    const lockResult = await sandbox.fs.acquireLock(assetDir, {
      durationMs: 60_000,
    });
    expect(lockResult.ok).toBe(true);

    const deleteResult = await sandbox.fs.deleteAsset(assetId, projectSlug);
    expect(deleteResult.ok).toBe(false);
    if (!deleteResult.ok) {
      expect(deleteResult.error.code).toBe("LOCKED");
    }

    await sandbox.fs.releaseLock(assetDir);
  }, 30_000);

  it("deleteAsset succeeds after lock released", async () => {
    const asset = await sandbox.fs.createAsset(
      "vid",
      "delete-release",
      projectSlug,
    );
    if (!asset.ok) throw new Error("Failed to create asset");
    const assetId = asset.value.assetId;
    const assetDir = path.join(sandbox.outputDir, projectSlug, assetId);

    const lockResult = await sandbox.fs.acquireLock(assetDir, {
      durationMs: 60_000,
    });
    expect(lockResult.ok).toBe(true);

    // Should fail while locked
    const failResult = await sandbox.fs.deleteAsset(assetId, projectSlug);
    expect(failResult.ok).toBe(false);
    if (!failResult.ok) {
      expect(failResult.error.code).toBe("LOCKED");
    }

    // Release the lock
    const releaseResult = await sandbox.fs.releaseLock(assetDir);
    expect(releaseResult.ok).toBe(true);

    // Should succeed after release
    const deleteResult = await sandbox.fs.deleteAsset(assetId, projectSlug);
    expect(deleteResult.ok).toBe(true);
    if (deleteResult.ok) {
      expect(deleteResult.value.deleted_at).toBeTruthy();
    }
  }, 30_000);

  it("lock contention with 20 parallel acquires — exactly 1 wins", async () => {
    const asset = await sandbox.fs.createAsset(
      "vid",
      "contention",
      projectSlug,
    );
    if (!asset.ok) throw new Error("Failed to create asset");
    const assetDir = path.join(
      sandbox.outputDir,
      projectSlug,
      asset.value.assetId,
    );

    const attempts = Array.from({ length: 20 }, () =>
      sandbox.fs.acquireLock(assetDir, { durationMs: 60_000 }),
    );

    const results = await Promise.all(attempts);
    const wins = results.filter((r) => r.ok);
    const losses = results.filter((r) => !r.ok);

    expect(wins.length).toBe(1);
    expect(losses.length).toBe(19);

    for (const loss of losses) {
      if (!loss.ok) {
        expect(loss.error.code).toBe("LOCKED");
      }
    }

    await sandbox.fs.releaseLock(assetDir);
  }, 30_000);

  it("document lock ownership gap (no PID check on release)", async () => {
    const asset = await sandbox.fs.createAsset(
      "vid",
      "ownership-gap",
      projectSlug,
    );
    if (!asset.ok) throw new Error("Failed to create asset");
    const assetDir = path.join(
      sandbox.outputDir,
      projectSlug,
      asset.value.assetId,
    );

    const lockResult = await sandbox.fs.acquireLock(assetDir, {
      durationMs: 60_000,
    });
    expect(lockResult.ok).toBe(true);
    if (lockResult.ok) {
      expect(lockResult.value.pid).toBe(process.pid);
    }

    expect(await sandbox.fs.isLocked(assetDir)).toBe(true);

    const releaseResult = await sandbox.fs.releaseLock(assetDir);
    expect(releaseResult.ok).toBe(true);
    if (releaseResult.ok) {
      expect(releaseResult.value).toBe(true);
    }

    expect(await sandbox.fs.isLocked(assetDir)).toBe(false);

    // Can re-acquire after release
    const reacquire = await sandbox.fs.acquireLock(assetDir, {
      durationMs: 60_000,
    });
    expect(reacquire.ok).toBe(true);

    await sandbox.fs.releaseLock(assetDir);
  }, 30_000);
});
