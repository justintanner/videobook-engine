import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { createSandbox, type Sandbox } from "./helpers/sandbox.js";

const execFileAsync = promisify(execFile);

async function gitConfig(repoDir: string, key: string): Promise<string> {
  const { stdout } = await execFileAsync(
    "git",
    ["config", "--local", "--get", key],
    { cwd: repoDir },
  );
  return stdout.trim();
}

async function gitLfsAvailable(): Promise<boolean> {
  try {
    await execFileAsync("git", ["lfs", "version"]);
    return true;
  } catch {
    return false;
  }
}

describe("project operations", () => {
  let sandbox: Sandbox;

  beforeEach(async () => {
    sandbox = await createSandbox();
  });

  afterEach(async () => {
    await sandbox.cleanup();
  });

  it("creates a project with auto-generated slug", async () => {
    const result = await sandbox.fs.createProject();
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.slug).toMatch(/^[a-z]+-[a-z]+-\d+$/);
    expect(result.value.is_default).toBe(true);

    // Git repo initialized
    const gitDir = path.join(result.value.path, ".git");
    await expect(fs.access(gitDir)).resolves.toBeUndefined();
  });

  it("creates a project with custom slug", async () => {
    const result = await sandbox.fs.createProject("my-project");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.slug).toBe("my-project");
  });

  it("disables git auto-gc on the project repo (vc-147)", async () => {
    const result = await sandbox.fs.createProject("gc-test");
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // Rapid engine commits otherwise spawn detached `git gc --auto` that can
    // corrupt the repo on a near-full disk; init must turn it off.
    expect(await gitConfig(result.value.path, "gc.auto")).toBe("0");
    expect(await gitConfig(result.value.path, "gc.autoDetach")).toBe("false");
  });

  it("only writes LFS filter patterns when git-lfs is installed (vc-cqh)", async () => {
    const result = await sandbox.fs.createProject("lfs-test");
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    let gitattributes = "";
    try {
      gitattributes = await fs.readFile(
        path.join(result.value.path, ".gitattributes"),
        "utf-8",
      );
    } catch {
      gitattributes = "";
    }

    if (await gitLfsAvailable()) {
      expect(gitattributes).toContain("filter=lfs");
    } else {
      // Without git-lfs the filters never run, so the patterns must not be
      // written — otherwise .gitattributes implies LFS while media commits raw.
      expect(gitattributes).not.toContain("filter=lfs");
    }
  });

  it("lists projects sorted newest-first by default", async () => {
    await sandbox.fs.createProject("project-a");
    // Git timestamps have second-level resolution — need >1s gap
    await new Promise((r) => setTimeout(r, 1100));
    await sandbox.fs.createProject("project-b");

    const projects = await sandbox.fs.listProjects();
    expect(projects.length).toBe(2);
    expect(projects[0]!.slug).toBe("project-b"); // most recent first
    expect(projects[1]!.slug).toBe("project-a");
  });

  it("lists projects sorted oldest-first with sort option", async () => {
    await sandbox.fs.createProject("project-a");
    await new Promise((r) => setTimeout(r, 1100));
    await sandbox.fs.createProject("project-b");

    const projects = await sandbox.fs.listProjects({ sort: "oldest" });
    expect(projects.length).toBe(2);
    expect(projects[0]!.slug).toBe("project-a");
    expect(projects[1]!.slug).toBe("project-b");
  });

  it("gets project by slug", async () => {
    await sandbox.fs.createProject("test-proj");
    const result = await sandbox.fs.getProject("test-proj");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.metadata.slug).toBe("test-proj");
  });

  it("switches default project", async () => {
    await sandbox.fs.createProject("project-a");
    await sandbox.fs.createProject("project-b");

    const result = await sandbox.fs.switchProject("project-b");
    expect(result.ok).toBe(true);

    const defaultFile = path.join(sandbox.projectsDir, ".default-project");
    const defaultSlug = (await fs.readFile(defaultFile, "utf-8")).trim();
    expect(defaultSlug).toBe("project-b");
  });

  it("returns error when switching to nonexistent project", async () => {
    const result = await sandbox.fs.switchProject("nonexistent");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("NOT_FOUND");
  });

  it("deletes a project and moves the default to a remaining project", async () => {
    await sandbox.fs.createProject("project-a");
    await sandbox.fs.createProject("project-b");
    await sandbox.fs.switchProject("project-a");

    const result = await sandbox.fs.deleteProject("project-a");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.slug).toBe("project-a");
    expect(result.value.default_project_slug).toBe("project-b");

    const projects = await sandbox.fs.listProjects();
    expect(projects.map((p) => p.slug)).toEqual(["project-b"]);

    const defaultFile = path.join(sandbox.projectsDir, ".default-project");
    const defaultSlug = (await fs.readFile(defaultFile, "utf-8")).trim();
    expect(defaultSlug).toBe("project-b");
  });

  it("removes the default file when deleting the only project", async () => {
    await sandbox.fs.createProject("lonely");

    const result = await sandbox.fs.deleteProject("lonely");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.default_project_slug).toBeNull();
    await expect(fs.access(path.join(sandbox.projectsDir, ".default-project"))).rejects.toThrow();
  });
});
