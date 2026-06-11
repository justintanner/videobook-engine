import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";

import { createSandbox, type Sandbox } from "./helpers/sandbox.js";

describe("file operations", () => {
  let sandbox: Sandbox;
  let projectSlug: string;

  beforeEach(async () => {
    sandbox = await createSandbox();
    const result = await sandbox.fs.createProject("file-test");
    if (!result.ok) throw new Error("Failed to create project");
    projectSlug = result.value.slug;
  });

  afterEach(async () => {
    await sandbox.cleanup();
  });

  it("writes and reads a file", async () => {
    const createResult = await sandbox.fs.createAsset(
      "vid",
      "roundtrip",
      projectSlug,
    );
    if (!createResult.ok) throw new Error("Failed to create asset");
    const assetId = createResult.value.assetId;

    // Write
    const data = Buffer.from("hello world");
    const writeResult = await sandbox.fs.writeFile(
      assetId,
      "test.txt",
      data,
      projectSlug,
    );
    expect(writeResult.ok).toBe(true);

    // Read
    const readResult = await sandbox.fs.readFile(
      assetId,
      "test.txt",
      projectSlug,
    );
    expect(readResult.ok).toBe(true);
    if (!readResult.ok) return;
    expect(readResult.value.toString()).toBe("hello world");
  });

  it("returns NOT_FOUND for missing file", async () => {
    const createResult = await sandbox.fs.createAsset(
      "img",
      "missing",
      projectSlug,
    );
    if (!createResult.ok) throw new Error("Failed to create asset");

    const result = await sandbox.fs.readFile(
      createResult.value.assetId,
      "nonexistent.txt",
      projectSlug,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("NOT_FOUND");
  });

  describe("deleteFile", () => {
    it("deletes a file and readFile returns NOT_FOUND", async () => {
      const asset = await sandbox.fs.createAsset(
        "vid",
        "del-test",
        projectSlug,
      );
      if (!asset.ok) throw new Error("Failed to create asset");
      const assetId = asset.value.assetId;

      await sandbox.fs.writeFile(assetId, "doomed.txt", "bye", projectSlug);

      const result = await sandbox.fs.deleteFile(
        assetId,
        "doomed.txt",
        projectSlug,
      );
      expect(result.ok).toBe(true);

      const read = await sandbox.fs.readFile(
        assetId,
        "doomed.txt",
        projectSlug,
      );
      expect(read.ok).toBe(false);
      if (!read.ok) expect(read.error.code).toBe("NOT_FOUND");
    });

    it("returns NOT_FOUND for missing file", async () => {
      const asset = await sandbox.fs.createAsset(
        "vid",
        "del-miss",
        projectSlug,
      );
      if (!asset.ok) throw new Error("Failed to create asset");

      const result = await sandbox.fs.deleteFile(
        asset.value.assetId,
        "nope.txt",
        projectSlug,
      );
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe("NOT_FOUND");
    });

    it("returns NOT_FOUND for missing asset", async () => {
      const result = await sandbox.fs.deleteFile(
        "vid-nonexistent",
        "file.txt",
        projectSlug,
      );
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe("NOT_FOUND");
    });

    it("returns INVALID_INPUT for unsafe filename", async () => {
      const asset = await sandbox.fs.createAsset(
        "vid",
        "del-unsafe",
        projectSlug,
      );
      if (!asset.ok) throw new Error("Failed to create asset");

      const result = await sandbox.fs.deleteFile(
        asset.value.assetId,
        "../escape.txt",
        projectSlug,
      );
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe("INVALID_INPUT");
    });
  });

  describe("renameFile", () => {
    it("renames a file preserving content", async () => {
      const asset = await sandbox.fs.createAsset(
        "img",
        "ren-test",
        projectSlug,
      );
      if (!asset.ok) throw new Error("Failed to create asset");
      const assetId = asset.value.assetId;

      await sandbox.fs.writeFile(assetId, "old.txt", "content", projectSlug);

      const result = await sandbox.fs.renameFile(
        assetId,
        "old.txt",
        "new.txt",
        projectSlug,
      );
      expect(result.ok).toBe(true);

      const oldRead = await sandbox.fs.readFile(
        assetId,
        "old.txt",
        projectSlug,
      );
      expect(oldRead.ok).toBe(false);
      if (!oldRead.ok) expect(oldRead.error.code).toBe("NOT_FOUND");

      const newRead = await sandbox.fs.readFile(
        assetId,
        "new.txt",
        projectSlug,
      );
      expect(newRead.ok).toBe(true);
      if (newRead.ok) expect(newRead.value.toString()).toBe("content");
    });

    it("returns NOT_FOUND for missing source", async () => {
      const asset = await sandbox.fs.createAsset(
        "img",
        "ren-miss",
        projectSlug,
      );
      if (!asset.ok) throw new Error("Failed to create asset");

      const result = await sandbox.fs.renameFile(
        asset.value.assetId,
        "missing.txt",
        "new.txt",
        projectSlug,
      );
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe("NOT_FOUND");
    });

    it("returns ALREADY_EXISTS when dest exists", async () => {
      const asset = await sandbox.fs.createAsset("img", "ren-dup", projectSlug);
      if (!asset.ok) throw new Error("Failed to create asset");
      const assetId = asset.value.assetId;

      await sandbox.fs.writeFile(assetId, "a.txt", "aaa", projectSlug);
      await sandbox.fs.writeFile(assetId, "b.txt", "bbb", projectSlug);

      const result = await sandbox.fs.renameFile(
        assetId,
        "a.txt",
        "b.txt",
        projectSlug,
      );
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe("ALREADY_EXISTS");
    });

    it("returns INVALID_INPUT for unsafe names", async () => {
      const asset = await sandbox.fs.createAsset(
        "img",
        "ren-unsafe",
        projectSlug,
      );
      if (!asset.ok) throw new Error("Failed to create asset");

      const result = await sandbox.fs.renameFile(
        asset.value.assetId,
        "ok.txt",
        "sub/dir.txt",
        projectSlug,
      );
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe("INVALID_INPUT");
    });
  });

  describe("copyFile", () => {
    it("copies a file between two assets", async () => {
      const src = await sandbox.fs.createAsset("vid", "copy-src", projectSlug);
      const dest = await sandbox.fs.createAsset(
        "vid",
        "copy-dest",
        projectSlug,
      );
      if (!src.ok || !dest.ok) throw new Error("Failed to create assets");

      await sandbox.fs.writeFile(
        src.value.assetId,
        "data.bin",
        "payload",
        projectSlug,
      );

      const result = await sandbox.fs.copyFile(
        src.value.assetId,
        "data.bin",
        dest.value.assetId,
        "data-copy.bin",
        projectSlug,
      );
      expect(result.ok).toBe(true);

      // Both should be readable
      const srcRead = await sandbox.fs.readFile(
        src.value.assetId,
        "data.bin",
        projectSlug,
      );
      expect(srcRead.ok).toBe(true);

      const destRead = await sandbox.fs.readFile(
        dest.value.assetId,
        "data-copy.bin",
        projectSlug,
      );
      expect(destRead.ok).toBe(true);
      if (destRead.ok) expect(destRead.value.toString()).toBe("payload");
    });

    it("copies within the same asset", async () => {
      const asset = await sandbox.fs.createAsset(
        "aud",
        "copy-same",
        projectSlug,
      );
      if (!asset.ok) throw new Error("Failed to create asset");
      const assetId = asset.value.assetId;

      await sandbox.fs.writeFile(
        assetId,
        "orig.txt",
        "same-asset",
        projectSlug,
      );

      const result = await sandbox.fs.copyFile(
        assetId,
        "orig.txt",
        assetId,
        "clone.txt",
        projectSlug,
      );
      expect(result.ok).toBe(true);

      const read = await sandbox.fs.readFile(assetId, "clone.txt", projectSlug);
      expect(read.ok).toBe(true);
      if (read.ok) expect(read.value.toString()).toBe("same-asset");
    });

    it("returns ALREADY_EXISTS instead of overwriting the destination (vce-inf)", async () => {
      const src = await sandbox.fs.createAsset(
        "vid",
        "copy-over-src",
        projectSlug,
      );
      const dest = await sandbox.fs.createAsset(
        "vid",
        "copy-over-dst",
        projectSlug,
      );
      if (!src.ok || !dest.ok) throw new Error("Failed to create assets");

      await sandbox.fs.writeFile(
        src.value.assetId,
        "f.txt",
        "new",
        projectSlug,
      );
      await sandbox.fs.writeFile(
        dest.value.assetId,
        "f.txt",
        "old",
        projectSlug,
      );

      const result = await sandbox.fs.copyFile(
        src.value.assetId,
        "f.txt",
        dest.value.assetId,
        "f.txt",
        projectSlug,
      );
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe("ALREADY_EXISTS");

      // Destination content must be untouched
      const read = await sandbox.fs.readFile(
        dest.value.assetId,
        "f.txt",
        projectSlug,
      );
      expect(read.ok).toBe(true);
      if (read.ok) expect(read.value.toString()).toBe("old");
    });

    it("returns NOT_FOUND for missing source file", async () => {
      const src = await sandbox.fs.createAsset("vid", "cp-nosrc", projectSlug);
      const dest = await sandbox.fs.createAsset("vid", "cp-nodst", projectSlug);
      if (!src.ok || !dest.ok) throw new Error("Failed to create assets");

      const result = await sandbox.fs.copyFile(
        src.value.assetId,
        "missing.txt",
        dest.value.assetId,
        "out.txt",
        projectSlug,
      );
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe("NOT_FOUND");
    });

    it("returns NOT_FOUND for missing dest asset", async () => {
      const src = await sandbox.fs.createAsset("vid", "cp-ok", projectSlug);
      if (!src.ok) throw new Error("Failed to create asset");

      await sandbox.fs.writeFile(
        src.value.assetId,
        "f.txt",
        "data",
        projectSlug,
      );

      const result = await sandbox.fs.copyFile(
        src.value.assetId,
        "f.txt",
        "vid-nonexistent",
        "f.txt",
        projectSlug,
      );
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe("NOT_FOUND");
    });
  });

  describe("resolveAssetDir", () => {
    it("returns absolute path for existing asset", async () => {
      const asset = await sandbox.fs.createAsset(
        "vid",
        "resolve-test",
        projectSlug,
      );
      if (!asset.ok) throw new Error("Failed to create asset");

      const result = await sandbox.fs.resolveAssetDir(
        asset.value.assetId,
        projectSlug,
      );
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(path.isAbsolute(result.value)).toBe(true);
      expect(result.value).toContain(asset.value.assetId);
    });

    it("returns NOT_FOUND for missing asset", async () => {
      const result = await sandbox.fs.resolveAssetDir(
        "vid-nonexistent",
        projectSlug,
      );
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe("NOT_FOUND");
    });

    it("returns INVALID_INPUT for unsafe path", async () => {
      const result = await sandbox.fs.resolveAssetDir("../escape", projectSlug);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe("INVALID_INPUT");
    });
  });

  describe("writeMetadata / readMetadata", () => {
    it("roundtrips JSON data", async () => {
      const asset = await sandbox.fs.createAsset("vid", "meta-rt", projectSlug);
      if (!asset.ok) throw new Error("Failed to create asset");
      const assetId = asset.value.assetId;

      const data = { title: "Test", count: 42, tags: ["a", "b"] };
      const writeResult = await sandbox.fs.writeMetadata(
        assetId,
        "info",
        data,
        projectSlug,
      );
      expect(writeResult.ok).toBe(true);

      const readResult = await sandbox.fs.readMetadata<typeof data>(
        assetId,
        "info",
        projectSlug,
      );
      expect(readResult.ok).toBe(true);
      if (readResult.ok) expect(readResult.value).toEqual(data);
    });

    it("stores metadata as dotfile", async () => {
      const asset = await sandbox.fs.createAsset(
        "vid",
        "meta-dot",
        projectSlug,
      );
      if (!asset.ok) throw new Error("Failed to create asset");
      const assetId = asset.value.assetId;

      await sandbox.fs.writeMetadata(assetId, "config", { x: 1 }, projectSlug);

      // Verify .config.json exists on disk
      const resolveResult = await sandbox.fs.resolveAssetDir(
        assetId,
        projectSlug,
      );
      if (!resolveResult.ok) throw new Error("Failed to resolve asset dir");
      const filePath = path.join(resolveResult.value, ".config.json");
      const stat = await fs.stat(filePath);
      expect(stat.isFile()).toBe(true);
    });

    it("returns NOT_FOUND for missing metadata key", async () => {
      const asset = await sandbox.fs.createAsset(
        "vid",
        "meta-miss",
        projectSlug,
      );
      if (!asset.ok) throw new Error("Failed to create asset");

      const result = await sandbox.fs.readMetadata(
        asset.value.assetId,
        "nonexistent",
        projectSlug,
      );
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe("NOT_FOUND");
    });

    it("returns INVALID_INPUT for bad key", async () => {
      const asset = await sandbox.fs.createAsset(
        "vid",
        "meta-badkey",
        projectSlug,
      );
      if (!asset.ok) throw new Error("Failed to create asset");
      const assetId = asset.value.assetId;

      const result = await sandbox.fs.writeMetadata(
        assetId,
        "UPPERCASE",
        {},
        projectSlug,
      );
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe("INVALID_INPUT");

      const result2 = await sandbox.fs.writeMetadata(
        assetId,
        "-starts-with-dash",
        {},
        projectSlug,
      );
      expect(result2.ok).toBe(false);
      if (!result2.ok) expect(result2.error.code).toBe("INVALID_INPUT");
    });

    it("returns IO_ERROR for corrupt JSON on read", async () => {
      const asset = await sandbox.fs.createAsset(
        "vid",
        "meta-corrupt",
        projectSlug,
      );
      if (!asset.ok) throw new Error("Failed to create asset");
      const assetId = asset.value.assetId;

      // Write invalid JSON directly via writeFile
      await sandbox.fs.writeFile(
        assetId,
        ".broken.json",
        "not valid json {{{",
        projectSlug,
      );

      const result = await sandbox.fs.readMetadata(
        assetId,
        "broken",
        projectSlug,
      );
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe("IO_ERROR");
    });
  });
});
