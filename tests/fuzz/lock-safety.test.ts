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

    const lockResult = await sandbox.fs.acquireLock(
      assetDir,
      ".rendering-square.lock",
    );
    expect(lockResult.ok).toBe(true);

    const renameResult = await sandbox.fs.renameAsset(
      assetId,
      "new-name",
      projectSlug,
    );
    expect(renameResult.ok).toBe(false);
    if (!renameResult.ok) {
      expect(renameResult.error.code).toBe("LOCKED");
      expect(renameResult.error.message).toContain("lock held");
    }

    await sandbox.fs.releaseLock(assetDir, ".rendering-square.lock");
  }, 30_000);

  it("renameAsset rejects when any lock is held", async () => {
    const lockNames = [
      ".transcribing.lock",
      ".generating.lock",
      ".rendering-landscape.lock",
      ".rendering-portrait.lock",
      ".rendering-square.lock",
      ".downloading.lock",
    ];

    for (const lockName of lockNames) {
      const asset = await sandbox.fs.createAsset(
        "vid",
        `lock-test-${lockName}`,
        projectSlug,
      );
      if (!asset.ok) throw new Error(`Failed to create asset for ${lockName}`);
      const assetId = asset.value.assetId;
      const assetDir = path.join(sandbox.outputDir, projectSlug, assetId);

      const lockResult = await sandbox.fs.acquireLock(assetDir, lockName);
      expect(lockResult.ok).toBe(true);

      const renameResult = await sandbox.fs.renameAsset(
        assetId,
        "renamed",
        projectSlug,
      );
      expect(renameResult.ok).toBe(false);
      if (!renameResult.ok) {
        expect(renameResult.error.code).toBe("LOCKED");
        expect(renameResult.error.message).toContain("lock held");
      }

      await sandbox.fs.releaseLock(assetDir, lockName);
    }
  }, 30_000);

  it("deleteAsset rejects deletion when any lock is held", async () => {
    const asset = await sandbox.fs.createAsset(
      "vid",
      "delete-locked",
      projectSlug,
    );
    if (!asset.ok) throw new Error("Failed to create asset");
    const assetId = asset.value.assetId;
    const assetDir = path.join(sandbox.outputDir, projectSlug, assetId);

    const lockResult = await sandbox.fs.acquireLock(
      assetDir,
      ".rendering-landscape.lock",
    );
    expect(lockResult.ok).toBe(true);

    const deleteResult = await sandbox.fs.deleteAsset(assetId, projectSlug);
    expect(deleteResult.ok).toBe(false);
    if (!deleteResult.ok) {
      expect(deleteResult.error.code).toBe("LOCKED");
      expect(deleteResult.error.message).toContain("lock held");
    }

    await sandbox.fs.releaseLock(assetDir, ".rendering-landscape.lock");
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

    const lockResult = await sandbox.fs.acquireLock(
      assetDir,
      ".generating.lock",
    );
    expect(lockResult.ok).toBe(true);

    // Should fail while locked
    const failResult = await sandbox.fs.deleteAsset(assetId, projectSlug);
    expect(failResult.ok).toBe(false);
    if (!failResult.ok) {
      expect(failResult.error.code).toBe("LOCKED");
    }

    // Release the lock
    const releaseResult = await sandbox.fs.releaseLock(
      assetDir,
      ".generating.lock",
    );
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
      sandbox.fs.acquireLock(assetDir, ".generating.lock"),
    );

    const results = await Promise.all(attempts);
    const wins = results.filter((r) => r.ok);
    const losses = results.filter((r) => !r.ok);

    expect(wins.length).toBe(1);
    expect(losses.length).toBe(19);

    for (const loss of losses) {
      if (!loss.ok) {
        expect(loss.error.code).toBe("LOCK_HELD");
      }
    }

    await sandbox.fs.releaseLock(assetDir, ".generating.lock");
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

    // Acquire the lock — it records process.pid
    const lockResult = await sandbox.fs.acquireLock(
      assetDir,
      ".transcribing.lock",
    );
    expect(lockResult.ok).toBe(true);
    if (lockResult.ok) {
      expect(lockResult.value.pid).toBe(process.pid);
    }

    // Verify the lock is held
    expect(await sandbox.fs.isLocked(assetDir, ".transcribing.lock")).toBe(
      true,
    );

    // Release from the same process but without any ownership validation —
    // this documents that releaseLock does NOT check if the caller matches the
    // PID that acquired the lock. Any caller can release any lock.
    const releaseResult = await sandbox.fs.releaseLock(
      assetDir,
      ".transcribing.lock",
    );
    expect(releaseResult.ok).toBe(true);
    if (releaseResult.ok) {
      expect(releaseResult.value).toBe(true);
    }

    // Lock is now released
    expect(await sandbox.fs.isLocked(assetDir, ".transcribing.lock")).toBe(
      false,
    );

    // Can re-acquire after foreign release
    const reacquire = await sandbox.fs.acquireLock(
      assetDir,
      ".transcribing.lock",
    );
    expect(reacquire.ok).toBe(true);

    await sandbox.fs.releaseLock(assetDir, ".transcribing.lock");
  }, 30_000);
});
