import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";

import { createSandbox, type Sandbox } from "./helpers/sandbox.js";

describe("listAssetSubdir", () => {
  let sandbox: Sandbox;
  let projectSlug: string;
  let assetId: string;
  let assetDir: string;

  beforeEach(async () => {
    sandbox = await createSandbox();
    const project = await sandbox.fs.createProject("subdir-test");
    if (!project.ok) throw new Error("create project failed");
    projectSlug = project.value.slug;

    const asset = await sandbox.fs.createAsset("vid", "subdir asset", projectSlug);
    if (!asset.ok) throw new Error("create asset failed");
    assetId = asset.value.assetId;
    assetDir = path.join(sandbox.projectsDir, projectSlug, assetId);
  });

  afterEach(async () => {
    await sandbox.cleanup();
  });

  it("returns sorted file list for an existing subdir", async () => {
    const framesDir = path.join(assetDir, "original_frames");
    await fs.mkdir(framesDir, { recursive: true });
    await fs.writeFile(path.join(framesDir, "2.00.jpg"), "b");
    await fs.writeFile(path.join(framesDir, "0.50.jpg"), "a");
    await fs.writeFile(path.join(framesDir, "1.25.jpg"), "c");

    const result = await sandbox.fs.listAssetSubdir(assetId, "original_frames", projectSlug);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual(["0.50.jpg", "1.25.jpg", "2.00.jpg"]);
  });

  it("returns NOT_FOUND when the subdir does not exist", async () => {
    const result = await sandbox.fs.listAssetSubdir(assetId, "missing_dir", projectSlug);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("NOT_FOUND");
  });

  it("rejects subdir names with disallowed characters", async () => {
    const r1 = await sandbox.fs.listAssetSubdir(assetId, "../escape", projectSlug);
    expect(r1.ok).toBe(false);
    if (!r1.ok) expect(r1.error.code).toBe("INVALID_INPUT");

    const r2 = await sandbox.fs.listAssetSubdir(assetId, "with-dash", projectSlug);
    expect(r2.ok).toBe(false);
    if (!r2.ok) expect(r2.error.code).toBe("INVALID_INPUT");

    const r3 = await sandbox.fs.listAssetSubdir(assetId, "", projectSlug);
    expect(r3.ok).toBe(false);
    if (!r3.ok) expect(r3.error.code).toBe("INVALID_INPUT");
  });

  it("rejects an invalid asset id", async () => {
    const result = await sandbox.fs.listAssetSubdir("not-a-prefix", "original_frames", projectSlug);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("INVALID_INPUT");
  });

  it("excludes dotfiles from the listing", async () => {
    const framesDir = path.join(assetDir, "original_frames");
    await fs.mkdir(framesDir, { recursive: true });
    await fs.writeFile(path.join(framesDir, "0.00.jpg"), "v");
    await fs.writeFile(path.join(framesDir, ".hidden"), "h");

    const result = await sandbox.fs.listAssetSubdir(assetId, "original_frames", projectSlug);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual(["0.00.jpg"]);
  });
});
