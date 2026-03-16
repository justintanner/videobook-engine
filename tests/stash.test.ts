import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { createSandbox, type Sandbox } from "./helpers/sandbox.js";

const exec = promisify(execFile);

function git(cwd: string, ...args: string[]) {
  return exec("git", args, { cwd });
}

/** Returns the list of files touched by a specific commit. */
async function commitFiles(cwd: string, hash: string): Promise<string[]> {
  const { stdout } = await git(
    cwd,
    "diff-tree",
    "--no-commit-id",
    "--name-only",
    "-r",
    hash,
  );
  return stdout
    .trim()
    .split("\n")
    .filter((l) => l.length > 0);
}

describe("stash isolation", () => {
  let sandbox: Sandbox;
  let projectSlug: string;
  let projectDir: string;

  beforeEach(async () => {
    sandbox = await createSandbox();
    const result = await sandbox.fs.createProject("stash-test");
    if (!result.ok) throw new Error("Failed to create project");
    projectSlug = result.value.slug;
    projectDir = path.join(sandbox.projectsDir, projectSlug);
  });

  afterEach(async () => {
    await sandbox.cleanup();
  });

  it("writeFile ignores bystander files in same asset dir", async () => {
    const asset = await sandbox.fs.createAsset("vid", "alpha", projectSlug);
    if (!asset.ok) throw new Error("Failed to create asset");
    const assetId = asset.value.assetId;

    // Write an initial file through the library so the asset has content
    await sandbox.fs.writeFile(assetId, "first.txt", "initial", projectSlug);

    // Create a bystander file directly on disk (simulating user modification)
    const bystanderPath = path.join(projectDir, assetId, "bystander.txt");
    await fs.writeFile(bystanderPath, "user data");

    // Write another file through the library
    const result = await sandbox.fs.writeFile(
      assetId,
      "second.txt",
      "lib data",
      projectSlug,
    );
    expect(result.ok).toBe(true);

    // The commit for second.txt should NOT include bystander.txt
    const { stdout } = await git(projectDir, "rev-parse", "HEAD");
    const files = await commitFiles(projectDir, stdout.trim());
    expect(files).toContain(`${assetId}/second.txt`);
    expect(files).not.toContain(`${assetId}/bystander.txt`);

    // Bystander should still exist on disk (restored from stash)
    const content = await fs.readFile(bystanderPath, "utf-8");
    expect(content).toBe("user data");
  });

  it("writeFile ignores changes in other asset dirs", async () => {
    const asset1 = await sandbox.fs.createAsset("vid", "one", projectSlug);
    const asset2 = await sandbox.fs.createAsset("img", "two", projectSlug);
    if (!asset1.ok || !asset2.ok) throw new Error("Failed to create assets");

    // Establish both assets in git with tracked files
    await sandbox.fs.writeFile(
      asset1.value.assetId,
      "init.txt",
      "init",
      projectSlug,
    );
    await sandbox.fs.writeFile(
      asset2.value.assetId,
      "init.txt",
      "init",
      projectSlug,
    );

    // Create a dirty file in asset2
    const dirtyPath = path.join(projectDir, asset2.value.assetId, "dirty.txt");
    await fs.writeFile(dirtyPath, "other asset data");

    // Write through the library to asset1
    const result = await sandbox.fs.writeFile(
      asset1.value.assetId,
      "main.txt",
      "library data",
      projectSlug,
    );
    expect(result.ok).toBe(true);

    const { stdout } = await git(projectDir, "rev-parse", "HEAD");
    const files = await commitFiles(projectDir, stdout.trim());
    expect(files).toContain(`${asset1.value.assetId}/main.txt`);
    expect(files).not.toContain(`${asset2.value.assetId}/dirty.txt`);

    // Dirty file still exists
    const content = await fs.readFile(dirtyPath, "utf-8");
    expect(content).toBe("other asset data");
  });

  it("manually staged files not included in commit", async () => {
    const asset = await sandbox.fs.createAsset("vid", "staged", projectSlug);
    if (!asset.ok) throw new Error("Failed to create asset");
    const assetId = asset.value.assetId;

    // Establish asset in git with a tracked file
    await sandbox.fs.writeFile(assetId, "init.txt", "init", projectSlug);

    // Create and stage an unrelated file
    const unrelatedPath = path.join(projectDir, "unrelated.txt");
    await fs.writeFile(unrelatedPath, "staged by user");
    await git(projectDir, "add", "unrelated.txt");

    // Write through the library
    const result = await sandbox.fs.writeFile(
      assetId,
      "lib.txt",
      "lib content",
      projectSlug,
    );
    expect(result.ok).toBe(true);

    const { stdout } = await git(projectDir, "rev-parse", "HEAD");
    const files = await commitFiles(projectDir, stdout.trim());
    expect(files).toContain(`${assetId}/lib.txt`);
    expect(files).not.toContain("unrelated.txt");

    // Staged file should still exist on disk
    const content = await fs.readFile(unrelatedPath, "utf-8");
    expect(content).toBe("staged by user");
  });

  it("deleteAsset preserves unrelated dirty state", async () => {
    const asset1 = await sandbox.fs.createAsset(
      "vid",
      "to-delete",
      projectSlug,
    );
    const asset2 = await sandbox.fs.createAsset("vid", "keeper", projectSlug);
    if (!asset1.ok || !asset2.ok) throw new Error("Failed to create assets");

    // Write a file to each asset
    await sandbox.fs.writeFile(
      asset1.value.assetId,
      "doomed.txt",
      "gone",
      projectSlug,
    );
    await sandbox.fs.writeFile(
      asset2.value.assetId,
      "safe.txt",
      "keep me",
      projectSlug,
    );

    // Create dirty state in asset2
    const dirtyPath = path.join(
      projectDir,
      asset2.value.assetId,
      "unsaved.txt",
    );
    await fs.writeFile(dirtyPath, "user wip");

    // Delete asset1 through the library
    const result = await sandbox.fs.deleteAsset(
      asset1.value.assetId,
      projectSlug,
    );
    expect(result.ok).toBe(true);

    // Dirty file in asset2 should survive
    const content = await fs.readFile(dirtyPath, "utf-8");
    expect(content).toBe("user wip");
  });

  it("writeProjectMeta does not sweep bystanders", async () => {
    // Create a bystander file in the project root
    const bystanderPath = path.join(projectDir, "bystander-root.txt");
    await fs.writeFile(bystanderPath, "root bystander");

    const result = await sandbox.fs.writeProjectMeta(
      "test-key",
      { value: 42 },
      projectSlug,
    );
    expect(result.ok).toBe(true);

    const { stdout } = await git(projectDir, "rev-parse", "HEAD");
    const files = await commitFiles(projectDir, stdout.trim());
    expect(files).toContain(".test-key.json");
    expect(files).not.toContain("bystander-root.txt");

    // Bystander survives
    const content = await fs.readFile(bystanderPath, "utf-8");
    expect(content).toBe("root bystander");
  });

  it("clean tree fast path — no stash entries created", async () => {
    const asset = await sandbox.fs.createAsset("vid", "clean", projectSlug);
    if (!asset.ok) throw new Error("Failed to create asset");

    // No dirty state — write through library
    await sandbox.fs.writeFile(
      asset.value.assetId,
      "clean.txt",
      "data",
      projectSlug,
    );

    // Stash list should be empty
    const { stdout } = await git(projectDir, "stash", "list");
    expect(stdout.trim()).toBe("");
  });

  it("writeFile overwrites dirty file without leaving stash", async () => {
    const asset = await sandbox.fs.createAsset("vid", "conflict", projectSlug);
    if (!asset.ok) throw new Error("Failed to create asset");
    const assetId = asset.value.assetId;

    // Write initial content through the library
    await sandbox.fs.writeFile(assetId, "target.txt", "version-1", projectSlug);

    // Modify the same file on disk (simulating user edit)
    const targetPath = path.join(projectDir, assetId, "target.txt");
    await fs.writeFile(targetPath, "user-modified");

    // Write to the SAME file through the library — overwrites user edit
    const result = await sandbox.fs.writeFile(
      assetId,
      "target.txt",
      "version-2",
      projectSlug,
    );
    expect(result.ok).toBe(true);

    // The commit should have succeeded
    const { stdout: headHash } = await git(projectDir, "rev-parse", "HEAD");
    const files = await commitFiles(projectDir, headHash.trim());
    expect(files).toContain(`${assetId}/target.txt`);

    // File on disk should have the library's content
    const content = await fs.readFile(targetPath, "utf-8");
    expect(content).toBe("version-2");

    // No stash entries should exist (path-based staging, no stash used)
    const { stdout: stashList } = await git(projectDir, "stash", "list");
    expect(stashList.trim()).toBe("");
  });
});
