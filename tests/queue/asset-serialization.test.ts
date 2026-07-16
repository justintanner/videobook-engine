import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fsP from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { createFs, type Job, type QueueRunner } from "../../src/index.js";

describe("asset-scoped queue serialization", () => {
  let projectsDir: string;

  beforeEach(async () => {
    projectsDir = await fsP.mkdtemp(path.join(os.tmpdir(), "vc-asset-queue-"));
  });

  afterEach(async () => {
    await fsP.rm(projectsDir, { recursive: true, force: true });
  });

  it("keeps same-asset waiters queued across concurrent runners", async () => {
    const fs = createFs({ projectsDir });
    const project = await fs.createProject("p");
    expect(project.ok).toBe(true);
    const asset = await fs.createAsset("vid", "serial", "p");
    expect(asset.ok).toBe(true);
    if (!asset.ok) return;

    let active = 0;
    let maxActive = 0;
    let releaseFirst: () => void = () => undefined;
    let notifyFirstStarted: () => void = () => undefined;
    const firstRelease = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const firstStarted = new Promise<void>((resolve) => {
      notifyFirstStarted = resolve;
    });
    const started: number[] = [];

    const handler = async (job: Job): Promise<{ index: number }> => {
      const index = Number(job.payload.index);
      active += 1;
      maxActive = Math.max(maxActive, active);
      started.push(index);
      if (index === 0) {
        notifyFirstStarted();
        await firstRelease;
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
      active -= 1;
      return { index };
    };

    const makeRunner = async (): Promise<QueueRunner> => {
      const runner = await fs.queue.createRunner("p", {
        concurrency: 2,
        pollIntervalMs: 10,
        resolveHandler: (type) => type === "serial" ? handler : null,
      });
      runner.start();
      return runner;
    };

    const runners = await Promise.all([makeRunner(), makeRunner()]);
    try {
      const jobs = [];
      for (const index of [0, 1, 2]) {
        jobs.push(await fs.queue.enqueue("p", {
          type: "serial",
          assetId: asset.value.assetId,
          payload: { index },
          dedupeKey: `serial-${index}`,
        }));
      }

      await firstStarted;
      await new Promise((resolve) => setTimeout(resolve, 50));

      const inFlight = await Promise.all(
        jobs.map(({ job }) => fs.queue.getJob("p", job.id)),
      );
      expect(inFlight.map((job) => job?.state)).toEqual(["running", "queued", "queued"]);
      expect(started).toEqual([0]);

      releaseFirst();
      await Promise.all(jobs.map(({ job }) => runners[0].waitFor(job.id, 5_000)));

      expect([...started].sort((a, b) => a - b)).toEqual([0, 1, 2]);
      expect(maxActive).toBe(1);
    } finally {
      releaseFirst();
      await Promise.all(runners.map((runner) => runner.stop()));
      fs.close();
    }
  });
});
