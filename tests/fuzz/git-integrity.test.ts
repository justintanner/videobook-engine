import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fc from "fast-check";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { createSandbox, type Sandbox } from "../helpers/sandbox.js";
import { commitMessageInjectionArb } from "../helpers/arbitraries.js";
import { rewindToCommit } from "../../src/git/rewind.js";

const execFileAsync = promisify(execFile);

describe("git-integrity fuzz tests", () => {
  let sandbox: Sandbox;
  let projectSlug: string;

  beforeEach(async () => {
    sandbox = await createSandbox();
    const result = await sandbox.fs.createProject("git-integ");
    if (!result.ok) throw new Error("Failed to create project");
    projectSlug = result.value.slug;
  });

  afterEach(async () => {
    await sandbox.cleanup();
  });

  it("writeFile produces a git commit", async () => {
    // Create an asset
    const assetResult = await sandbox.fs.createAsset(
      "vid",
      "meta-test",
      projectSlug,
    );
    if (!assetResult.ok) throw new Error("Failed to create asset");
    const assetId = assetResult.value.assetId;

    // Write a file
    const writeResult = await sandbox.fs.writeFile(
      assetId,
      "test.txt",
      Buffer.from("hello"),
      projectSlug,
    );
    expect(writeResult.ok).toBe(true);

    // Verify a commit with 'write' in the message exists
    const history = await sandbox.fs.getHistory(projectSlug);
    const writeCommit = history.find((c) => c.message.includes("write"));
    expect(writeCommit).toBeDefined();
    expect(writeCommit!.hash).toBeTruthy();
  });

  it("commit messages with pipe chars do not corrupt history", async () => {
    const assetResult = await sandbox.fs.createAsset(
      "vid",
      "pipe-test",
      projectSlug,
    );
    if (!assetResult.ok) throw new Error("Failed to create asset");
    const assetId = assetResult.value.assetId;

    // Write a file with pipe in the filename
    const writeResult = await sandbox.fs.writeFile(
      assetId,
      "data|pipe.txt",
      "content",
      projectSlug,
    );
    // The write might fail due to filename validation; if so, write a normal file
    // and commit with a pipe-containing operation name instead
    if (!writeResult.ok) {
      const projectDir = path.join(sandbox.outputDir, projectSlug);
      const assetDir = path.join(projectDir, assetId);
      await fs.writeFile(path.join(assetDir, "data.txt"), "content");
      await sandbox.fs.commitOperation(
        "write|pipe|test",
        assetId,
        undefined,
        projectSlug,
      );
    }

    const history = await sandbox.fs.getHistory(projectSlug);
    expect(history.length).toBeGreaterThanOrEqual(1);

    for (const commit of history) {
      expect(commit.hash).toBeTruthy();
      expect(commit.hash.length).toBeGreaterThan(0);
      expect(commit.message).toBeTruthy();
      expect(commit.message.length).toBeGreaterThan(0);
      expect(commit.date).toBeTruthy();
      expect(commit.date.length).toBeGreaterThan(0);
    }
  });

  it("special chars in commit messages (property test)", async () => {
    await fc.assert(
      fc.asyncProperty(commitMessageInjectionArb, async (fuzzedMsg) => {
        // Create a fresh sandbox for each property iteration
        const propSandbox = await createSandbox();
        try {
          const projResult = await propSandbox.fs.createProject();
          if (!projResult.ok) return; // skip if project creation fails
          const slug = projResult.value.slug;

          const assetResult = await propSandbox.fs.createAsset(
            "vid",
            "fuzz",
            slug,
          );
          if (!assetResult.ok) return; // skip if asset creation fails
          const assetId = assetResult.value.assetId;

          // Write a file so there are changes to commit
          const projectDir = path.join(propSandbox.outputDir, slug);
          const assetDir = path.join(projectDir, assetId);
          await fs.writeFile(path.join(assetDir, "fuzz.txt"), "data");

          // Commit with the fuzzed message as the operation
          await propSandbox.fs.commitOperation(
            fuzzedMsg,
            assetId,
            undefined,
            slug,
          );

          // Verify history parses correctly
          const history = await propSandbox.fs.getHistory(slug);
          for (const commit of history) {
            expect(commit.hash.length).toBeGreaterThan(0);
            expect(commit.date.length).toBeGreaterThan(0);
          }
        } finally {
          await propSandbox.cleanup();
        }
      }),
      { numRuns: 9 },
    );
  });

  it("commitOperation with no changes returns null", async () => {
    // Project already has an initial commit from createProject; no new changes
    const result = await sandbox.fs.commitOperation(
      "noop",
      undefined,
      undefined,
      projectSlug,
    );
    expect(result).toBeNull();
  });

  it("commitOperation does not stage bystander files", async () => {
    // Create two assets
    const asset1Result = await sandbox.fs.createAsset(
      "vid",
      "bystander-one",
      projectSlug,
    );
    if (!asset1Result.ok) throw new Error("Failed to create asset 1");
    const asset1Id = asset1Result.value.assetId;

    const asset2Result = await sandbox.fs.createAsset(
      "vid",
      "bystander-two",
      projectSlug,
    );
    if (!asset2Result.ok) throw new Error("Failed to create asset 2");
    const asset2Id = asset2Result.value.assetId;

    const projectDir = path.join(sandbox.outputDir, projectSlug);

    // Write a file to asset-1 but DON'T commit
    const asset1Dir = path.join(projectDir, asset1Id);
    await fs.writeFile(
      path.join(asset1Dir, "uncommitted.txt"),
      "should stay unstaged",
    );

    // Write a file to asset-2 and commit via commitOperation scoped to asset-2
    const asset2Dir = path.join(projectDir, asset2Id);
    await fs.writeFile(
      path.join(asset2Dir, "committed.txt"),
      "should be committed",
    );
    const hash = await sandbox.fs.commitOperation(
      "write",
      asset2Id,
      undefined,
      projectSlug,
    );
    expect(hash).toBeTruthy();

    // Check git status — asset-1's file should still be untracked/unstaged
    const { stdout } = await execFileAsync("git", ["status", "--porcelain"], {
      cwd: projectDir,
    });
    const lines = stdout
      .trim()
      .split("\n")
      .filter((l) => l.length > 0);

    // The asset-1 file should appear in status (untracked or modified)
    const asset1InStatus = lines.some((l) => l.includes(asset1Id));
    expect(asset1InStatus).toBe(true);

    // The asset-2 file should NOT appear in status (already committed)
    const asset2InStatus = lines.some(
      (l) => l.includes(asset2Id) && l.includes("committed.txt"),
    );
    expect(asset2InStatus).toBe(false);
  });

  it("rewindToCommit with invalid hash returns Result error", async () => {
    const projectDir = path.join(sandbox.outputDir, projectSlug);
    const result = await rewindToCommit(
      projectDir,
      "deadbeef1234567890abcdef1234567890abcdef",
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("GIT_ERROR");
      expect(result.error.message.length).toBeGreaterThan(0);
    }
  });
});
