import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";

import { createFs, type ClipfirstFs } from "../../src/index.js";
import { closeAllStateDbs } from "../../src/db/client.js";

describe("queue lifecycle", () => {
  let projectsDir: string;
  let cfs: ClipfirstFs;

  beforeEach(async () => {
    projectsDir = await fs.mkdtemp(path.join(os.tmpdir(), "cfs-queue-"));
    cfs = createFs({ projectsDir });
    const created = await cfs.createProject("p");
    expect(created.ok).toBe(true);
  });

  afterEach(async () => {
    closeAllStateDbs();
    await fs.rm(projectsDir, { recursive: true, force: true });
  });

  it("enqueues, runs, and completes a job via the runner", async () => {
    const dir = await cfs.resolveProjectDir("p");
    expect(dir).not.toBeNull();
    const runner = (await cfs.queue.createRunner("p", {
      concurrency: 1,
      pollIntervalMs: 25,
      resolveHandler: (type) =>
        type === "ping" ? async (job) => ({ echo: job.payload }) : null,
    }))!;
    runner.start();
    try {
      const result = await cfs.queue.enqueueAndWait<{ echo: { msg: string } }>(
        "p",
        { type: "ping", payload: { msg: "hi" } },
        5_000,
      );
      expect(result.echo.msg).toBe("hi");
    } finally {
      await runner.stop();
    }
  });

  it("retries up to maxAttempts on failure then marks as failed", async () => {
    let calls = 0;
    const runner = (await cfs.queue.createRunner("p", {
      concurrency: 1,
      pollIntervalMs: 25,
      resolveHandler: (type) =>
        type === "always-fail"
          ? async () => {
              calls++;
              throw new Error("boom");
            }
          : null,
    }))!;
    runner.start();
    try {
      const enq = await cfs.queue.enqueue("p", {
        type: "always-fail",
        payload: {},
        maxAttempts: 3,
      });
      expect(enq?.inserted).toBe(true);
      // Wait for terminal state
      const start = Date.now();
      while (Date.now() - start < 5_000) {
        const job = await cfs.queue.getJob("p", enq!.job.id);
        if (job?.state === "failed") {
          expect(calls).toBe(3);
          expect(job.attempts).toBe(3);
          return;
        }
        await new Promise((r) => setTimeout(r, 25));
      }
      throw new Error("retry did not converge to failed");
    } finally {
      await runner.stop();
    }
  });

  it("dedupes a queued sentinel via dedupeKey", async () => {
    const opts = { type: "submit", payload: { url: "u1" }, assetId: "vid-x" };
    const a = await cfs.queue.enqueue("p", opts);
    const b = await cfs.queue.enqueue("p", opts);
    expect(a?.inserted).toBe(true);
    expect(b?.inserted).toBe(false);
    expect(a?.job.id).toBe(b?.job.id);
  });

  it("dedupes a running external_task_id via partial unique index", async () => {
    const a = await cfs.queue.enqueue("p", {
      type: "poll",
      payload: { ref: 1 },
      externalTaskId: "task-123",
    });
    const b = await cfs.queue.enqueue("p", {
      type: "poll",
      payload: { ref: 2, different: true },
      externalTaskId: "task-123",
    });
    expect(a?.inserted).toBe(true);
    expect(b?.inserted).toBe(false);
    expect(a?.job.id).toBe(b?.job.id);
  });

  it("a different type with the same external_task_id is allowed", async () => {
    const a = await cfs.queue.enqueue("p", {
      type: "poll-type-a",
      payload: {},
      externalTaskId: "shared-123",
    });
    const b = await cfs.queue.enqueue("p", {
      type: "poll-type-b",
      payload: {},
      externalTaskId: "shared-123",
    });
    expect(a?.inserted).toBe(true);
    expect(b?.inserted).toBe(true);
  });
});
