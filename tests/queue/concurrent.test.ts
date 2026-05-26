import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";

import { createFs, type VideocityFs } from "../../src/index.js";
import { closeAllStateDbs, getStateDb } from "../../src/db/client.js";
import { dequeue } from "../../src/queue/dequeue.js";

describe("queue atomic claim under concurrency", () => {
  let projectsDir: string;
  let cfs: VideocityFs;

  beforeEach(async () => {
    projectsDir = await fs.mkdtemp(path.join(os.tmpdir(), "cfs-claim-"));
    cfs = createFs({ projectsDir });
    const created = await cfs.createProject("p");
    expect(created.ok).toBe(true);
  });

  afterEach(async () => {
    closeAllStateDbs();
    await fs.rm(projectsDir, { recursive: true, force: true });
  });

  it("two concurrent dequeues never claim the same job", async () => {
    const dir = (await cfs.resolveProjectDir("p"))!;
    const db = getStateDb(dir);

    // Enqueue 50 jobs
    for (let i = 0; i < 50; i++) {
      await cfs.queue.enqueue("p", {
        type: "noop",
        payload: { i },
        dedupeKey: null, // disable dedupe for this test
      });
    }

    // Spawn 20 racers each pulling 5 jobs
    const claims = await Promise.all(
      Array.from({ length: 20 }, async () => {
        const claimed: number[] = [];
        for (let i = 0; i < 5; i++) {
          const job = dequeue(db, process.pid + i, 60_000);
          if (job) claimed.push(job.id);
        }
        return claimed;
      }),
    );

    const allClaimed = claims.flat();
    const unique = new Set(allClaimed);
    expect(unique.size).toBe(allClaimed.length);
    expect(allClaimed.length).toBe(50);
  });

  it("dedupeKey prevents duplicate parallel enqueues", async () => {
    const tasks = Array.from({ length: 20 }, () =>
      cfs.queue.enqueue("p", {
        type: "submit",
        assetId: "vid-x",
        payload: { url: "u" },
      }),
    );
    const results = await Promise.all(tasks);
    const inserted = results.filter((r) => r?.inserted).length;
    expect(inserted).toBe(1);
    expect(results.every((r) => r?.job.id === results[0]?.job.id)).toBe(true);
  });
});
