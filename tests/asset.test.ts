import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";

import { createSandbox, type Sandbox } from "./helpers/sandbox.js";

describe("asset operations", () => {
  let sandbox: Sandbox;
  let projectSlug: string;

  beforeEach(async () => {
    sandbox = await createSandbox();
    const result = await sandbox.fs.createProject("test-project");
    if (!result.ok) throw new Error("Failed to create project");
    projectSlug = result.value.slug;
  });

  afterEach(async () => {
    await sandbox.cleanup();
  });

  it("creates an asset with prefix and name", async () => {
    const result = await sandbox.fs.createAsset(
      "vid",
      "dancing cats",
      projectSlug,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.assetId).toMatch(/^vid-dancing-cats/);

    // Verify timestamp is available via listAssets
    const assets = await sandbox.fs.listAssets(projectSlug);
    const created = assets.find((a) => a.id === result.value.assetId);
    expect(created).toBeDefined();
    expect(new Date(created!.created_at).getTime()).toBeGreaterThan(0);
  });

  it("lists assets including video", async () => {
    const createResult = await sandbox.fs.createAsset(
      "vid",
      "test video",
      projectSlug,
    );
    if (!createResult.ok) throw new Error("Failed to create asset");

    await sandbox.fs.writeFile(
      createResult.value.assetId,
      "original.mp4",
      Buffer.from("fake-video-data"),
      projectSlug,
    );

    const assets = await sandbox.fs.listAssets(projectSlug);
    const vid = assets.find((a) => a.id === createResult.value.assetId);
    expect(vid).toBeDefined();
    expect(vid!.type).toBe("video");
  });

  it("deletes an asset", async () => {
    const createResult = await sandbox.fs.createAsset(
      "img",
      "sunset photo",
      projectSlug,
    );
    if (!createResult.ok) throw new Error("Failed to create asset");

    const deleteResult = await sandbox.fs.deleteAsset(
      createResult.value.assetId,
      projectSlug,
    );
    expect(deleteResult.ok).toBe(true);

    // Directory is gone
    await expect(fs.access(createResult.value.path)).rejects.toThrow();
  });

  it("deletes an asset while unrelated untracked files exist", async () => {
    const createResult = await sandbox.fs.createAsset(
      "img",
      "delete target",
      projectSlug,
    );
    if (!createResult.ok) throw new Error("Failed to create asset");

    const projectDir = path.join(sandbox.projectsDir, projectSlug);
    const bystanderDir = path.join(projectDir, "vid-bystander", "original_frames");
    await fs.mkdir(bystanderDir, { recursive: true });
    await fs.writeFile(path.join(bystanderDir, "0.00.jpg"), "untracked");

    const deleteResult = await sandbox.fs.deleteAsset(
      createResult.value.assetId,
      projectSlug,
    );
    expect(deleteResult.ok).toBe(true);

    await expect(fs.access(createResult.value.path)).rejects.toThrow();
    await expect(fs.access(path.join(bystanderDir, "0.00.jpg"))).resolves.toBeUndefined();
  });

  it("renames an asset with git mv", async () => {
    const createResult = await sandbox.fs.createAsset(
      "vid",
      "old name",
      projectSlug,
    );
    if (!createResult.ok) throw new Error("Failed to create asset");

    const renameResult = await sandbox.fs.renameAsset(
      createResult.value.assetId,
      "new name",
      projectSlug,
    );
    expect(renameResult.ok).toBe(true);
    if (!renameResult.ok) return;

    expect(renameResult.value.new_asset_id).toMatch(/^vid-new-name/);
    expect(renameResult.value.old_asset_id).toBe(createResult.value.assetId);
  });

  it("returns NOT_FOUND when renaming a nonexistent asset", async () => {
    const result = await sandbox.fs.renameAsset(
      "vid-does-not-exist",
      "new name",
      projectSlug,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("NOT_FOUND");
  });

  it("lists assets sorted newest-first by default", async () => {
    await sandbox.fs.createAsset("vid", "first video", projectSlug);
    await new Promise((r) => setTimeout(r, 1100));
    await sandbox.fs.createAsset("img", "second image", projectSlug);

    const assets = await sandbox.fs.listAssets(projectSlug);
    expect(assets.length).toBe(2);
    expect(assets[0]!.id).toMatch(/^img-second-image/);
    expect(assets[1]!.id).toMatch(/^vid-first-video/);
  });

  it("lists assets sorted oldest-first with sort option", async () => {
    await sandbox.fs.createAsset("vid", "first video", projectSlug);
    await new Promise((r) => setTimeout(r, 1100));
    await sandbox.fs.createAsset("img", "second image", projectSlug);

    const assets = await sandbox.fs.listAssets(projectSlug, { sort: "oldest" });
    expect(assets.length).toBe(2);
    expect(assets[0]!.id).toMatch(/^vid-first-video/);
    expect(assets[1]!.id).toMatch(/^img-second-image/);
  });

  it("gets asset manifest", async () => {
    const createResult = await sandbox.fs.createAsset(
      "vid",
      "manifest test",
      projectSlug,
    );
    if (!createResult.ok) throw new Error("Failed to create asset");

    // Write a file
    await sandbox.fs.writeFile(
      createResult.value.assetId,
      "original.mp4",
      Buffer.from("fake-data"),
      projectSlug,
    );

    const manifestResult = await sandbox.fs.getManifest(
      createResult.value.assetId,
      projectSlug,
    );
    expect(manifestResult.ok).toBe(true);
    if (!manifestResult.ok) return;

    expect(manifestResult.value.file_count).toBeGreaterThanOrEqual(1); // original.mp4
    const mp4 = manifestResult.value.files.find(
      (f) => f.name === "original.mp4",
    );
    expect(mp4).toBeDefined();
    expect(mp4!.extension).toBe("mp4");
  });
});
