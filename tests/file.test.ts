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
});
