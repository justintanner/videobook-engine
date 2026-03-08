import { describe, it, expect, beforeEach, afterEach } from "vitest";

import { createSandbox, type Sandbox } from "./helpers/sandbox.js";

describe("action log", () => {
  let sandbox: Sandbox;

  beforeEach(async () => {
    sandbox = await createSandbox();
  });

  afterEach(async () => {
    await sandbox.cleanup();
  });

  it("logs a text action and reads it back", async () => {
    await sandbox.fs.createProject("test-proj");

    const result = await sandbox.fs.logAction(
      "chat",
      "gen a video of a cow",
      "test-proj",
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.hash).toMatch(/^[a-f0-9]{40}$/);
    expect(result.value.action).toBe("chat");
    expect(result.value.payload).toBe("gen a video of a cow");
    expect(result.value.date).toBeTruthy();

    const log = await sandbox.fs.getActionLog(undefined, "test-proj");
    expect(log).toHaveLength(1);
    expect(log[0]!.hash).toBe(result.value.hash);
    expect(log[0]!.action).toBe("chat");
    expect(log[0]!.payload).toBe("gen a video of a cow");
  });

  it("logs a JSON action and round-trips payload as object", async () => {
    await sandbox.fs.createProject("test-proj");

    const payload = { details_of_gen: "cow video", model: "v3" };
    const result = await sandbox.fs.logAction("generate", payload, "test-proj");
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.payload).toEqual(payload);

    const log = await sandbox.fs.getActionLog(undefined, "test-proj");
    expect(log).toHaveLength(1);
    expect(log[0]!.payload).toEqual(payload);
  });

  it("queries with limit", async () => {
    await sandbox.fs.createProject("test-proj");

    await sandbox.fs.logAction("chat", "first message", "test-proj");
    await sandbox.fs.logAction("chat", "second message", "test-proj");
    await sandbox.fs.logAction("chat", "third message", "test-proj");

    const log = await sandbox.fs.getActionLog({ limit: 2 }, "test-proj");
    expect(log).toHaveLength(2);
    // Most recent first (git log default)
    expect(log[0]!.payload).toBe("third message");
    expect(log[1]!.payload).toBe("second message");
  });

  it("queries with since SHA", async () => {
    await sandbox.fs.createProject("test-proj");

    const first = await sandbox.fs.logAction(
      "chat",
      "first message",
      "test-proj",
    );
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    await sandbox.fs.logAction("chat", "second message", "test-proj");
    await sandbox.fs.logAction("chat", "third message", "test-proj");

    const log = await sandbox.fs.getActionLog(
      { since: first.value.hash },
      "test-proj",
    );
    expect(log).toHaveLength(2);
    expect(log[0]!.payload).toBe("third message");
    expect(log[1]!.payload).toBe("second message");
  });

  it("rejects invalid action names", async () => {
    await sandbox.fs.createProject("test-proj");

    const result = await sandbox.fs.logAction(
      "invalid action!",
      "hello",
      "test-proj",
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("INVALID_INPUT");
  });

  it("returns empty array for project with no actions", async () => {
    await sandbox.fs.createProject("test-proj");

    const log = await sandbox.fs.getActionLog(undefined, "test-proj");
    expect(log).toHaveLength(0);
  });

  it("does not include non-action commits in the log", async () => {
    await sandbox.fs.createProject("test-proj");

    // Create an asset (produces a regular commit)
    await sandbox.fs.createAsset("vid", "test-clip", "test-proj");

    // Log an action
    await sandbox.fs.logAction("chat", "hello world", "test-proj");

    const log = await sandbox.fs.getActionLog(undefined, "test-proj");
    expect(log).toHaveLength(1);
    expect(log[0]!.action).toBe("chat");
  });
});
