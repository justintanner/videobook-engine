import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { EngineContext } from "../src/context.js";
import { JobQueue, QueueRunner } from "../src/job-queue.js";

const contexts: EngineContext[] = [];
const roots: string[] = [];
const runners: QueueRunner[] = [];

afterEach(async () => {
  for (const runner of runners.splice(0)) await runner.stop();
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const context of contexts.splice(0)) context.store.close();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function setup() {
  const root = await mkdtemp(path.join(tmpdir(), "videobook-idle-queue-"));
  roots.push(root);
  const context = new EngineContext({ rootDir: root, initialBookName: "idle" });
  contexts.push(context);
  const { store } = context;
  const terminal = vi.fn(async () => {});
  const queue = new JobQueue(store, (id) => id, terminal);
  return { store, queue, terminal };
}

describe("idle queue reads", () => {
  it("polls an empty queue without runtime transactions or Dolt status scans", async () => {
    const { store, queue } = await setup();
    const runtime = vi.spyOn(store, "runtime");
    const status = vi.spyOn(store.db, "doltStatus");
    const dequeue = vi.spyOn(queue, "dequeue");
    vi.useFakeTimers();
    const runner = queue.createRunner({ concurrency: 1, resolveHandler: () => null });
    runners.push(runner);
    runner.start();
    await vi.advanceTimersByTimeAsync(1000);
    expect(dequeue).toHaveBeenCalledTimes(5);
    expect(runtime).not.toHaveBeenCalled();
    expect(status).not.toHaveBeenCalled();
  });

  it("skips transactions when queued jobs belong only to other runners", async () => {
    const { store, queue } = await setup();
    const job = queue.enqueue({ type: "background", payload: {} }).job;
    const runtime = vi.spyOn(store, "runtime");
    const status = vi.spyOn(store.db, "doltStatus");
    expect(queue.dequeue(1, 30_000, ["background"], ["interactive"])).toBeNull();
    expect(queue.dequeue(1, 30_000, [], [])).toBeNull();
    expect(runtime).not.toHaveBeenCalled();
    expect(status).not.toHaveBeenCalled();
    expect(queue.get(job.id)?.state).toBe("queued");
  });

  it("reaps without transactions or status scans until a lease expires", async () => {
    const { store, queue } = await setup();
    vi.useFakeTimers();
    const runtime = vi.spyOn(store, "runtime");
    const status = vi.spyOn(store.db, "doltStatus");
    expect(await queue.reap()).toEqual({ requeued: 0, failed: 0 });
    expect(runtime).not.toHaveBeenCalled();
    expect(status).not.toHaveBeenCalled();
    const job = queue.enqueue({ type: "work", payload: {}, maxAttempts: 2 }).job;
    queue.dequeue(1, 1000);
    queue.markCompleting(job.id);
    queue.enqueue({ type: "unleased", payload: {}, initialState: "running" });
    runtime.mockClear();
    status.mockClear();
    await vi.advanceTimersByTimeAsync(1000);
    expect(await queue.reap()).toEqual({ requeued: 0, failed: 0 });
    expect(runtime).not.toHaveBeenCalled();
    expect(status).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(await queue.reap()).toEqual({ requeued: 1, failed: 0 });
    expect(runtime).toHaveBeenCalledTimes(1);
    expect(queue.get(job.id)).toMatchObject({ state: "queued", fence: 2, attempts: 1 });
  });

  it("picks up work enqueued while idle at the next poll", async () => {
    const { queue } = await setup();
    vi.useFakeTimers();
    const handler = vi.fn(async () => "done");
    const runner = queue.createRunner({ concurrency: 1, pollIntervalMs: 250, resolveHandler: () => handler });
    runners.push(runner);
    runner.start();
    await vi.advanceTimersByTimeAsync(500);
    const job = queue.enqueue({ type: "work", payload: {} }).job;
    await vi.advanceTimersByTimeAsync(249);
    expect(handler).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(queue.get(job.id)?.state).toBe("done");
  });

  it("returns null if another runner claims the job after the pre-check", async () => {
    const { store, queue } = await setup();
    const job = queue.enqueue({ type: "work", payload: {} }).job;
    const other = new JobQueue(store, (id) => id, async () => {});
    const runtime = store.runtime.bind(store);
    vi.spyOn(store, "runtime").mockImplementationOnce((mutate) => {
      expect(other.dequeue(2, 30_000)?.id).toBe(job.id);
      return runtime(mutate);
    });
    expect(queue.dequeue(1, 30_000)).toBeNull();
    expect(queue.get(job.id)).toMatchObject({ state: "running", attempts: 1, fence: 1 });
  });

  it("rechecks a lease renewed after the reap pre-check", async () => {
    const { store, queue, terminal } = await setup();
    const job = queue.enqueue({ type: "work", payload: {} }).job;
    queue.dequeue(1, -1);
    const runtime = store.runtime.bind(store);
    vi.spyOn(store, "runtime").mockImplementationOnce((mutate) => {
      expect(queue.heartbeat(job.id, 1, 30_000)).toBe(true);
      return runtime(mutate);
    });
    expect(await queue.reap()).toEqual({ requeued: 0, failed: 0 });
    expect(queue.get(job.id)).toMatchObject({ state: "running", attempts: 1, fence: 1 });
    expect(terminal).not.toHaveBeenCalled();
  });
});
