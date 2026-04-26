import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";

import { createFs, type ClipfirstFs } from "../../src/index.js";
import { closeAllStateDbs } from "../../src/db/client.js";

describe("queue.reconcileFromSidecars", () => {
  let projectsDir: string;
  let cfs: ClipfirstFs;
  let projectDir: string;

  beforeEach(async () => {
    projectsDir = await fs.mkdtemp(path.join(os.tmpdir(), "cfs-reconcile-"));
    cfs = createFs({ projectsDir });
    const created = await cfs.createProject("p");
    expect(created.ok).toBe(true);
    projectDir = path.join(projectsDir, "p");
  });

  afterEach(async () => {
    closeAllStateDbs();
    await fs.rm(projectsDir, { recursive: true, force: true });
  });

  async function writeSidecar(
    assetSlug: string,
    sidecar: Record<string, unknown>,
  ): Promise<void> {
    const dir = path.join(projectDir, assetSlug);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(
      path.join(dir, ".kie-task.json"),
      JSON.stringify(sidecar),
    );
  }

  it("inserts queued state for sentinel-task sidecars", async () => {
    await writeSidecar("vid-a", {
      taskId: "queued",
      taskType: "generate_thing",
      assetId: "vid-a",
      assetDir: path.join(projectDir, "vid-a"),
      projectSlug: "p",
      meta: { url: "u1" },
    });
    const result = await cfs.queue.reconcileFromSidecars("p");
    expect(result.scanned).toBe(1);
    expect(result.insertedQueued).toBe(1);
    const queued = await cfs.queue.list("p", { states: ["queued"] });
    expect(queued.length).toBe(1);
    expect(queued[0].type).toBe("generate_thing");
  });

  it("inserts running state for sidecars with real external task ids", async () => {
    await writeSidecar("vid-b", {
      taskId: "real-task-xyz",
      taskType: "generate_thing",
      assetId: "vid-b",
      meta: {},
    });
    const result = await cfs.queue.reconcileFromSidecars("p");
    expect(result.insertedRunning).toBe(1);
    const running = await cfs.queue.list("p", { states: ["running"] });
    expect(running.length).toBe(1);
    expect(running[0].externalTaskId).toBe("real-task-xyz");
  });

  it("does not duplicate when SQLite already has the external task", async () => {
    await cfs.queue.enqueue("p", {
      type: "generate_thing",
      payload: { existing: true },
      externalTaskId: "real-456",
      assetId: "vid-c",
    });
    await writeSidecar("vid-c", {
      taskId: "real-456",
      taskType: "generate_thing",
      assetId: "vid-c",
      meta: {},
    });
    const result = await cfs.queue.reconcileFromSidecars("p");
    expect(result.matchedExisting).toBe(1);
    expect(result.insertedRunning).toBe(0);
  });

  it("does not duplicate a queued sentinel matching an existing dedupe_key", async () => {
    const enq = await cfs.queue.enqueue("p", {
      type: "generate_thing",
      assetId: "vid-d",
      payload: { taskId: "queued", assetId: "vid-d" },
    });
    expect(enq?.inserted).toBe(true);

    await writeSidecar("vid-d", {
      taskId: "queued",
      taskType: "generate_thing",
      assetId: "vid-d",
    });
    // Second reconcile pass with payload-shape that matches existing dedupe.
    const result = await cfs.queue.reconcileFromSidecars("p", {
      mapper: (s) => ({
        type: "generate_thing",
        payload: { taskId: "queued", assetId: s.assetId },
        externalTaskId: null,
        isQueuedSentinel: true,
      }),
    });
    expect(result.matchedExisting).toBe(1);
    expect(result.insertedQueued).toBe(0);
  });

  it("skips sidecars that the mapper rejects", async () => {
    await writeSidecar("vid-e", { foo: "bar" });
    const result = await cfs.queue.reconcileFromSidecars("p");
    expect(result.skipped).toBeGreaterThanOrEqual(1);
  });
});
