import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";

import { createSandbox, type Sandbox } from "./helpers/sandbox.js";

describe("renameProject", () => {
  let sandbox: Sandbox;

  beforeEach(async () => {
    sandbox = await createSandbox();
  });

  afterEach(async () => {
    await sandbox.cleanup();
  });

  it("renames a project — old dir gone, new dir has .git", async () => {
    await sandbox.fs.createProject("old-proj");

    const result = await sandbox.fs.renameProject("old-proj", "new-proj");
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.oldSlug).toBe("old-proj");
    expect(result.value.newSlug).toBe("new-proj");

    // Old dir gone
    await expect(
      fs.access(path.join(sandbox.projectsDir, "old-proj")),
    ).rejects.toThrow();

    // New dir has .git
    await expect(
      fs.access(path.join(sandbox.projectsDir, "new-proj", ".git")),
    ).resolves.toBeUndefined();
  });

  it("updates .default-project when renamed project was default", async () => {
    await sandbox.fs.createProject("default-proj");
    await sandbox.fs.switchProject("default-proj");

    await sandbox.fs.renameProject("default-proj", "renamed-proj");

    const defaultFile = path.join(sandbox.projectsDir, ".default-project");
    const content = (await fs.readFile(defaultFile, "utf-8")).trim();
    expect(content).toBe("renamed-proj");
  });

  it("leaves .default-project unchanged when renaming non-default", async () => {
    await sandbox.fs.createProject("default-proj");
    await sandbox.fs.switchProject("default-proj");
    await sandbox.fs.createProject("other-proj");

    await sandbox.fs.renameProject("other-proj", "renamed-other");

    const defaultFile = path.join(sandbox.projectsDir, ".default-project");
    const content = (await fs.readFile(defaultFile, "utf-8")).trim();
    expect(content).toBe("default-proj");
  });

  it("rejects invalid slugs with INVALID_INPUT", async () => {
    await sandbox.fs.createProject("valid-proj");

    for (const bad of [".bad", "", "UPPER"]) {
      const result = await sandbox.fs.renameProject("valid-proj", bad);
      expect(result.ok).toBe(false);
      if (result.ok) continue;
      expect(result.error.code).toBe("INVALID_INPUT");
    }
  });

  it("rejects rename to existing slug with ALREADY_EXISTS", async () => {
    await sandbox.fs.createProject("proj-a");
    await sandbox.fs.createProject("proj-b");

    const result = await sandbox.fs.renameProject("proj-a", "proj-b");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("ALREADY_EXISTS");
  });

  it("returns NOT_FOUND for nonexistent source slug", async () => {
    const result = await sandbox.fs.renameProject("nonexistent", "new-name");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("NOT_FOUND");
  });

  it("blocks rename when any asset has an active lock", async () => {
    await sandbox.fs.createProject("locked-proj");
    const assetResult = await sandbox.fs.createAsset(
      "vid",
      "my-video",
      "locked-proj",
    );
    expect(assetResult.ok).toBe(true);
    if (!assetResult.ok) return;

    // Acquire a lock on the asset
    const assetDir = path.join(
      sandbox.projectsDir,
      "locked-proj",
      assetResult.value.assetId,
    );
    await sandbox.fs.acquireLock(assetDir, { durationMs: 60_000 });

    const result = await sandbox.fs.renameProject("locked-proj", "renamed");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("LOCKED");
    expect(result.error.message).toContain(assetResult.value.assetId);
  });

  it("assets are accessible after rename", async () => {
    await sandbox.fs.createProject("orig-proj");
    await sandbox.fs.createAsset("vid", "clip", "orig-proj");
    await sandbox.fs.writeFile("vid-clip", "notes.txt", "hello", "orig-proj");

    await sandbox.fs.renameProject("orig-proj", "moved-proj");

    const assets = await sandbox.fs.listAssets("moved-proj");
    expect(assets.length).toBe(1);
    expect(assets[0]!.id).toBe("vid-clip");

    const fileResult = await sandbox.fs.readFile(
      "vid-clip",
      "notes.txt",
      "moved-proj",
    );
    expect(fileResult.ok).toBe(true);
    if (!fileResult.ok) return;
    expect(fileResult.value.toString()).toBe("hello");
  });

  it("concurrent renames — exactly 1 wins, others get NOT_FOUND", async () => {
    await sandbox.fs.createProject("race-proj");

    const targets = [
      "target-a",
      "target-b",
      "target-c",
      "target-d",
      "target-e",
    ];
    const results = await Promise.all(
      targets.map((t) => sandbox.fs.renameProject("race-proj", t)),
    );

    const successes = results.filter((r) => r.ok);
    const failures = results.filter((r) => !r.ok);

    expect(successes.length).toBe(1);
    expect(failures.length).toBe(4);
    for (const f of failures) {
      if (f.ok) continue;
      // Could be NOT_FOUND (source gone) or ALREADY_EXISTS (target appeared)
      expect(["NOT_FOUND", "ALREADY_EXISTS"]).toContain(f.error.code);
    }
  });

  it("rename to self returns ALREADY_EXISTS", async () => {
    await sandbox.fs.createProject("self-proj");

    const result = await sandbox.fs.renameProject("self-proj", "self-proj");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("ALREADY_EXISTS");
  });

  it("expired lock does not block rename", async () => {
    await sandbox.fs.createProject("exp-proj");
    const assetResult = await sandbox.fs.createAsset(
      "vid",
      "my-vid",
      "exp-proj",
    );
    expect(assetResult.ok).toBe(true);
    if (!assetResult.ok) return;

    // Write an already-expired lock file directly
    const assetDir = path.join(
      sandbox.projectsDir,
      "exp-proj",
      assetResult.value.assetId,
    );
    const expiredLock = {
      created_at: Date.now() / 1000 - 120,
      timeout_at: Date.now() / 1000 - 60,
      pid: process.pid,
    };
    await fs.writeFile(
      path.join(assetDir, ".lock"),
      JSON.stringify(expiredLock),
    );

    const result = await sandbox.fs.renameProject("exp-proj", "moved-exp");
    expect(result.ok).toBe(true);
  });
});
