import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";

import {
  createFs,
  type ClipfirstFs,
  QUEUED_TASK_ID,
} from "../src/index.js";
import { closeAllStateDbs, getStateDb } from "../src/db/client.js";

describe("pending tasks (sqlite-backed)", () => {
  let projectsDir: string;
  let cfs: ClipfirstFs;

  beforeEach(async () => {
    projectsDir = await fs.mkdtemp(path.join(os.tmpdir(), "cfs-ptask-"));
    cfs = createFs({ projectsDir });
    const created = await cfs.createProject("p");
    expect(created.ok).toBe(true);
    const asset = await cfs.createAsset("vid", "demo", "p");
    expect(asset.ok).toBe(true);
  });

  afterEach(async () => {
    closeAllStateDbs();
    await fs.rm(projectsDir, { recursive: true, force: true });
  });

  function assetDir(): string {
    return path.join(projectsDir, "p", "vid-demo");
  }

  it("write/read/delete round-trip", async () => {
    const written = await cfs.pendingTasks.write("p", {
      assetId: "vid-demo",
      taskId: "queued",
      taskType: "fal_seedance2_t2v",
      assetDir: assetDir(),
      meta: { prompt: "a cat" },
    });
    expect(written.ok).toBe(true);
    if (!written.ok) return;
    expect(written.value.completing).toBe(false);
    expect(written.value.meta.prompt).toBe("a cat");

    const read = await cfs.pendingTasks.read("p", "vid-demo");
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.value?.taskId).toBe("queued");
    expect(read.value?.taskType).toBe("fal_seedance2_t2v");

    const del = await cfs.pendingTasks.delete("p", "vid-demo");
    expect(del.ok).toBe(true);
    if (!del.ok) return;
    expect(del.value).toBe(true);

    const after = await cfs.pendingTasks.read("p", "vid-demo");
    expect(after.ok).toBe(true);
    if (!after.ok) return;
    expect(after.value).toBeNull();
  });

  it("write upserts existing rows (real task id replaces sentinel)", async () => {
    await cfs.pendingTasks.write("p", {
      assetId: "vid-demo",
      taskId: QUEUED_TASK_ID,
      taskType: "fal_nano_banana",
      assetDir: assetDir(),
    });
    await cfs.pendingTasks.write("p", {
      assetId: "vid-demo",
      taskId: "fal-real-id-42",
      taskType: "fal_nano_banana",
      assetDir: assetDir(),
    });
    const read = await cfs.pendingTasks.read("p", "vid-demo");
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.value?.taskId).toBe("fal-real-id-42");
  });

  it("write clears any prior generation error for the same asset", async () => {
    await cfs.generationErrors.write("p", "vid-demo", { message: "prior fail" });
    const before = await cfs.generationErrors.read("p", "vid-demo");
    expect(before.ok && before.value?.message).toBe("prior fail");

    await cfs.pendingTasks.write("p", {
      assetId: "vid-demo",
      taskId: "queued",
      taskType: "fal_nano_banana",
      assetDir: assetDir(),
    });
    const after = await cfs.generationErrors.read("p", "vid-demo");
    expect(after.ok).toBe(true);
    if (!after.ok) return;
    expect(after.value).toBeNull();
  });

  it("markCompleting flips the dedup flag without losing other fields", async () => {
    await cfs.pendingTasks.write("p", {
      assetId: "vid-demo",
      taskId: "task-7",
      taskType: "fal_seedance2_t2v",
      assetDir: assetDir(),
      meta: { hint: "keep me" },
    });
    const m = await cfs.pendingTasks.markCompleting("p", "vid-demo");
    expect(m.ok && m.value).toBe(true);
    const read = await cfs.pendingTasks.read("p", "vid-demo");
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.value?.completing).toBe(true);
    expect(read.value?.meta.hint).toBe("keep me");

    const c = await cfs.pendingTasks.clearCompleting("p", "vid-demo");
    expect(c.ok && c.value).toBe(true);
    const reread = await cfs.pendingTasks.read("p", "vid-demo");
    expect(reread.ok && reread.value?.completing).toBe(false);
  });

  it("findByExternalId looks up by provider task id", async () => {
    await cfs.pendingTasks.write("p", {
      assetId: "vid-demo",
      taskId: "ext-99",
      taskType: "fal_nano_banana",
      assetDir: assetDir(),
    });
    const found = await cfs.pendingTasks.findByExternalId("p", "ext-99");
    expect(found.ok).toBe(true);
    if (!found.ok) return;
    expect(found.value?.assetId).toBe("vid-demo");

    const miss = await cfs.pendingTasks.findByExternalId("p", "nope");
    expect(miss.ok).toBe(true);
    if (!miss.ok) return;
    expect(miss.value).toBeNull();
  });

  it("findAll returns every pending task in the project", async () => {
    await cfs.createAsset("vid", "second", "p");
    await cfs.pendingTasks.write("p", {
      assetId: "vid-demo",
      taskId: "queued",
      taskType: "fal_nano_banana",
      assetDir: assetDir(),
    });
    await cfs.pendingTasks.write("p", {
      assetId: "vid-second",
      taskId: "queued",
      taskType: "fal_seedance2_t2v",
      assetDir: path.join(projectsDir, "p", "vid-second"),
    });
    const all = await cfs.pendingTasks.findAll("p");
    expect(all.ok).toBe(true);
    if (!all.ok) return;
    const ids = all.value.map((t) => t.assetId).sort();
    expect(ids).toEqual(["vid-demo", "vid-second"]);
  });

  it("fail() atomically deletes pending_task and writes generation_error", async () => {
    await cfs.pendingTasks.write("p", {
      assetId: "vid-demo",
      taskId: "queued",
      taskType: "fal_nano_banana",
      assetDir: assetDir(),
    });
    const failed = await cfs.pendingTasks.fail("p", "vid-demo", {
      message: "provider rejected prompt",
      failCode: "policy_violation",
      prompt: "naughty",
    });
    expect(failed.ok).toBe(true);
    if (!failed.ok) return;
    expect(failed.value.message).toBe("provider rejected prompt");

    const pending = await cfs.pendingTasks.read("p", "vid-demo");
    expect(pending.ok && pending.value).toBeNull();

    const stored = await cfs.generationErrors.read("p", "vid-demo");
    expect(stored.ok).toBe(true);
    if (!stored.ok) return;
    expect(stored.value?.failCode).toBe("policy_violation");
    expect(stored.value?.prompt).toBe("naughty");
  });

  it("generationErrors.clear removes the row", async () => {
    await cfs.generationErrors.write("p", "vid-demo", { message: "fail" });
    expect((await cfs.generationErrors.read("p", "vid-demo")).ok).toBe(true);
    const cleared = await cfs.generationErrors.clear("p", "vid-demo");
    expect(cleared.ok && cleared.value).toBe(true);
    const after = await cfs.generationErrors.read("p", "vid-demo");
    expect(after.ok).toBe(true);
    if (!after.ok) return;
    expect(after.value).toBeNull();
  });

  it("generationErrors.findAll lists every error in the project", async () => {
    await cfs.createAsset("vid", "second", "p");
    await cfs.generationErrors.write("p", "vid-demo", { message: "a" });
    await cfs.generationErrors.write("p", "vid-second", { message: "b" });
    const all = await cfs.generationErrors.findAll("p");
    expect(all.ok).toBe(true);
    if (!all.ok) return;
    expect(all.value.map((e) => e.assetId).sort()).toEqual([
      "vid-demo",
      "vid-second",
    ]);
  });

  it("rejects ops on a non-existent project with NOT_FOUND", async () => {
    const r = await cfs.pendingTasks.read("nonexistent", "vid-demo");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe("NOT_FOUND");
  });

  it("isolates state from other projects", async () => {
    await cfs.createProject("q");
    await cfs.createAsset("vid", "demo", "q");
    await cfs.pendingTasks.write("p", {
      assetId: "vid-demo",
      taskId: "p-task",
      taskType: "fal_nano_banana",
      assetDir: assetDir(),
    });
    const inQ = await cfs.pendingTasks.read("q", "vid-demo");
    expect(inQ.ok).toBe(true);
    if (!inQ.ok) return;
    expect(inQ.value).toBeNull();

    // Sanity: each project has its own state.sqlite
    const dbP = getStateDb(path.join(projectsDir, "p"));
    const dbQ = getStateDb(path.join(projectsDir, "q"));
    expect(dbP).not.toBe(dbQ);
  });
});
