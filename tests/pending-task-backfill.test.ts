import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";

import { createFs, type ClipfirstFs } from "../src/index.js";
import { closeAllStateDbs } from "../src/db/client.js";

describe("pending-task sidecar backfill", () => {
  let projectsDir: string;
  let cfs: ClipfirstFs;

  beforeEach(async () => {
    projectsDir = await fs.mkdtemp(path.join(os.tmpdir(), "cfs-pback-"));
    cfs = createFs({ projectsDir });
    await cfs.createProject("p");
    await cfs.createAsset("vid", "alpha", "p");
    await cfs.createAsset("vid", "bravo", "p");
  });

  afterEach(async () => {
    closeAllStateDbs();
    await fs.rm(projectsDir, { recursive: true, force: true });
  });

  function assetDir(slug: string): string {
    return path.join(projectsDir, "p", slug);
  }

  async function writeJson(filePath: string, value: unknown): Promise<void> {
    await fs.writeFile(filePath, JSON.stringify(value, null, 2));
  }

  it("migrates a legacy .kie-task.json into the pending_tasks table and removes the sidecar", async () => {
    await writeJson(path.join(assetDir("vid-alpha"), ".kie-task.json"), {
      taskId: "ext-1",
      taskType: "fal_nano_banana",
      assetId: "vid-alpha",
      assetDir: assetDir("vid-alpha"),
      projectSlug: "p",
      createdAt: new Date().toISOString(),
      meta: { prompt: "legacy" },
      completing: false,
    });
    const report = await cfs.backfillPendingTaskSidecars("p");
    expect(report.pendingTasksMigrated).toBe(1);
    expect(report.generationErrorsMigrated).toBe(0);

    const pending = await cfs.pendingTasks.read("p", "vid-alpha");
    expect(pending.ok).toBe(true);
    if (!pending.ok) return;
    expect(pending.value?.taskId).toBe("ext-1");
    expect(pending.value?.meta.prompt).toBe("legacy");

    const stillThere = await fs
      .access(path.join(assetDir("vid-alpha"), ".kie-task.json"))
      .then(() => true)
      .catch(() => false);
    expect(stillThere).toBe(false);
  });

  it("migrates a legacy .generation-error.json", async () => {
    await writeJson(path.join(assetDir("vid-bravo"), ".generation-error.json"), {
      message: "boom",
      failCode: "policy_violation",
      prompt: "naughty",
      failedAt: new Date().toISOString(),
    });
    const report = await cfs.backfillPendingTaskSidecars("p");
    expect(report.generationErrorsMigrated).toBe(1);

    const stored = await cfs.generationErrors.read("p", "vid-bravo");
    expect(stored.ok).toBe(true);
    if (!stored.ok) return;
    expect(stored.value?.message).toBe("boom");
    expect(stored.value?.failCode).toBe("policy_violation");
  });

  it("preserves the completing flag", async () => {
    await writeJson(path.join(assetDir("vid-alpha"), ".kie-task.json"), {
      taskId: "ext-2",
      taskType: "fal_seedance2_t2v",
      assetId: "vid-alpha",
      assetDir: assetDir("vid-alpha"),
      projectSlug: "p",
      createdAt: new Date().toISOString(),
      meta: {},
      completing: true,
    });
    await cfs.backfillPendingTaskSidecars("p");
    const pending = await cfs.pendingTasks.read("p", "vid-alpha");
    expect(pending.ok && pending.value?.completing).toBe(true);
  });

  it("is idempotent — re-running backfill is a no-op once tables hold the rows", async () => {
    await writeJson(path.join(assetDir("vid-alpha"), ".kie-task.json"), {
      taskId: "ext-3",
      taskType: "fal_nano_banana",
      assetId: "vid-alpha",
      assetDir: assetDir("vid-alpha"),
      projectSlug: "p",
      createdAt: new Date().toISOString(),
      meta: {},
    });
    const r1 = await cfs.backfillPendingTaskSidecars("p");
    expect(r1.pendingTasksMigrated).toBe(1);
    const r2 = await cfs.backfillPendingTaskSidecars("p");
    expect(r2.pendingTasksMigrated).toBe(0);
  });

  it("does not overwrite an existing pending_tasks row, but still cleans up the leftover sidecar", async () => {
    await cfs.pendingTasks.write("p", {
      assetId: "vid-alpha",
      taskId: "from-sqlite",
      taskType: "fal_nano_banana",
      assetDir: assetDir("vid-alpha"),
    });
    await writeJson(path.join(assetDir("vid-alpha"), ".kie-task.json"), {
      taskId: "from-sidecar",
      taskType: "fal_nano_banana",
      assetId: "vid-alpha",
      assetDir: assetDir("vid-alpha"),
      projectSlug: "p",
      createdAt: new Date().toISOString(),
      meta: {},
    });
    const report = await cfs.backfillPendingTaskSidecars("p");
    expect(report.pendingTasksMigrated).toBe(0);

    const pending = await cfs.pendingTasks.read("p", "vid-alpha");
    expect(pending.ok).toBe(true);
    if (!pending.ok) return;
    expect(pending.value?.taskId).toBe("from-sqlite");

    const sidecarGone = await fs
      .access(path.join(assetDir("vid-alpha"), ".kie-task.json"))
      .then(() => true)
      .catch(() => false);
    expect(sidecarGone).toBe(false);
  });

  it("skips a malformed sidecar instead of throwing", async () => {
    await fs.writeFile(
      path.join(assetDir("vid-alpha"), ".kie-task.json"),
      "{not json",
    );
    const report = await cfs.backfillPendingTaskSidecars("p");
    expect(report.pendingTasksMigrated).toBe(0);
  });
});
