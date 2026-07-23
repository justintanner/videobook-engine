import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";

import { createSandbox, type Sandbox } from "./helpers/sandbox.js";

describe("project metadata", () => {
  let sandbox: Sandbox;
  let projectSlug: string;

  beforeEach(async () => {
    sandbox = await createSandbox();
    const result = await sandbox.fs.createProject("meta-test");
    if (!result.ok) throw new Error("Failed to create project");
    projectSlug = result.value.slug;
  });

  afterEach(async () => {
    await sandbox.cleanup();
  });

  it("roundtrips write + read", async () => {
    const data = { foo: "bar", version: 2 };
    const writeResult = await sandbox.fs.writeProjectMeta(
      "scratch",
      data,
      projectSlug,
    );
    expect(writeResult.ok).toBe(true);

    const readResult = await sandbox.fs.readProjectMeta<typeof data>(
      "scratch",
      projectSlug,
    );
    expect(readResult.ok).toBe(true);
    if (readResult.ok) expect(readResult.value).toEqual(data);
  });

  it("returns NOT_FOUND for unset key", async () => {
    const result = await sandbox.fs.readProjectMeta("nonexistent", projectSlug);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("NOT_FOUND");
  });

  it("overwrite replaces previous value", async () => {
    await sandbox.fs.writeProjectMeta("config", { v: 1 }, projectSlug);
    await sandbox.fs.writeProjectMeta("config", { v: 2 }, projectSlug);

    const result = await sandbox.fs.readProjectMeta<{ v: number }>(
      "config",
      projectSlug,
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.v).toBe(2);
  });

  it("write produces a project revision with the metadata file", async () => {
    await sandbox.fs.writeProjectMeta("scratch", { a: 1 }, projectSlug);

    const revision = (await sandbox.fs.getProjectHistory(projectSlug, 1))[0];
    expect(revision?.operation).toBe("write");
    expect(revision?.files).toContain(".scratch.json");
  });

  it("returns INVALID_INPUT for uppercase key", async () => {
    const result = await sandbox.fs.writeProjectMeta(
      "UPPERCASE",
      {},
      projectSlug,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("INVALID_INPUT");
  });

  it("returns INVALID_INPUT for dash-leading key", async () => {
    const result = await sandbox.fs.writeProjectMeta(
      "-leading-dash",
      {},
      projectSlug,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("INVALID_INPUT");
  });

  it("returns IO_ERROR on corrupt JSON", async () => {
    const projectResult = await sandbox.fs.getProject(projectSlug);
    if (!projectResult.ok) throw new Error("Failed to get project");
    const projectDir = projectResult.value.path;

    // Write corrupt JSON directly to disk
    await fs.writeFile(
      path.join(projectDir, ".broken.json"),
      "not valid json {{{",
    );

    const result = await sandbox.fs.readProjectMeta("broken", projectSlug);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("IO_ERROR");
  });

  it("returns NOT_FOUND for nonexistent project", async () => {
    const result = await sandbox.fs.readProjectMeta(
      "timeline",
      "no-such-project",
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("NOT_FOUND");
  });
});
