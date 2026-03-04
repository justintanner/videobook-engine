import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fc from "fast-check";
import * as fs from "node:fs/promises";
import * as path from "node:path";

import { createSandbox, type Sandbox } from "../helpers/sandbox.js";
import { validPrefixArb, safeAssetNameArb } from "../helpers/arbitraries.js";
import { slugifyName } from "../../src/asset/slug.js";
import { isSafePath } from "../../src/validation.js";

describe("edge-cases fuzz tests", () => {
  let sandbox: Sandbox;
  let projectSlug: string;

  beforeEach(async () => {
    sandbox = await createSandbox();
    const result = await sandbox.fs.createProject("edge-test");
    if (!result.ok) throw new Error("Failed to create project");
    projectSlug = result.value.slug;
  }, 15_000);

  afterEach(async () => {
    await sandbox.cleanup();
  });

  it("createAsset handles 100+ slug collisions without hanging", async () => {
    const ids = new Set<string>();

    for (let i = 0; i < 105; i++) {
      const result = await sandbox.fs.createAsset(
        "vid",
        "collision",
        projectSlug,
      );
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(ids.has(result.value.assetId)).toBe(false);
        ids.add(result.value.assetId);
      }
    }

    expect(ids.size).toBe(105);
  }, 30_000);

  it("getProject for bare directory without .project does NOT auto-create", async () => {
    const bareSlug = "bare-dir-no-project";
    const bareDir = path.join(sandbox.outputDir, bareSlug);
    await fs.mkdir(bareDir, { recursive: true });

    const result = await sandbox.fs.getProject(bareSlug);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("NOT_FOUND");
    }

    // Verify .project was NOT auto-created
    const metadataExists = await fs.access(path.join(bareDir, ".project")).then(
      () => true,
      () => false,
    );
    expect(metadataExists).toBe(false);
  }, 30_000);

  it("createAsset with empty name produces {prefix}-untitled", async () => {
    const result = await sandbox.fs.createAsset("vid", "", projectSlug);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.assetId).toMatch(/-untitled$/);
    }
  }, 30_000);

  it("createAsset with whitespace-only name produces {prefix}-untitled", async () => {
    const result = await sandbox.fs.createAsset("vid", "   ", projectSlug);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.assetId).toMatch(/-untitled$/);
    }
  }, 30_000);

  it("createAsset always produces safe assetId (property test, 30 runs)", async () => {
    await fc.assert(
      fc.asyncProperty(
        validPrefixArb,
        safeAssetNameArb,
        async (prefix, name) => {
          const result = await sandbox.fs.createAsset(
            prefix,
            name,
            projectSlug,
          );
          expect(result.ok).toBe(true);
          if (result.ok) {
            expect(isSafePath(result.value.assetId)).toBe(true);
          }
        },
      ),
      { numRuns: 30 },
    );
  }, 30_000);

  it("slugifyName never produces path-unsafe output (property test, 100 runs)", () => {
    fc.assert(
      fc.property(fc.string({ minLength: 0, maxLength: 200 }), (name) => {
        const slug = slugifyName(name, "vid");
        expect(slug).not.toContain("..");
        expect(slug).not.toContain("/");
        expect(slug).not.toContain("\\");
        expect(slug).not.toContain("\0");
      }),
      { numRuns: 100 },
    );
  });

  it("normal rename works (positive case for rollback context)", async () => {
    const asset = await sandbox.fs.createAsset(
      "vid",
      "original-name",
      projectSlug,
    );
    expect(asset.ok).toBe(true);
    if (!asset.ok) throw new Error("Failed to create asset");
    const oldId = asset.value.assetId;

    const renameResult = await sandbox.fs.renameAsset(
      oldId,
      "new-fancy-name",
      projectSlug,
    );
    expect(renameResult.ok).toBe(true);
    if (!renameResult.ok) throw new Error("Failed to rename asset");

    expect(renameResult.value.old_asset_id).toBe(oldId);
    const newId = renameResult.value.new_asset_id;
    expect(newId).not.toBe(oldId);

    // Verify old ID is gone
    const assets = await sandbox.fs.listAssets(projectSlug);
    const assetIds = assets.map((a) => a.id);
    expect(assetIds).not.toContain(oldId);
    expect(assetIds).toContain(newId);
  }, 30_000);
});
