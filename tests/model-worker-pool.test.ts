import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { afterEach, expect, it } from "vitest";
import { ModelWorkerPool } from "../src/model-worker-pool.js";
import type { ModelWorkerConfiguration } from "../src/model-worker-protocol.js";
import { createEngine, QueueRunner } from "../src/index.js";
import { EngineFault } from "../src/store.js";
import { modelWorkerError } from "../src/model-worker-errors.js";

const pools: ModelWorkerPool[] = [];
const roots: string[] = [];
const configuration: ModelWorkerConfiguration = {
  kind: "clip", modelCacheDir: "/fixture-cache", allowModelDownload: false,
  remoteHost: "http://127.0.0.1/", remotePathTemplate: "{model}/resolve/{revision}/{file}",
  allowRemoteModels: false, allowLocalModels: true, localModelPath: "/fixture-cache",
};
afterEach(async () => {
  await Promise.all(pools.splice(0).map((pool) => pool.close()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true, maxRetries: 3 })));
});
function pool(maxWorkers = 2, idleMs = 30_000) {
  const value = new ModelWorkerPool({ workerUrl: new URL("./fixtures/model-worker.mjs", import.meta.url), maxWorkers, idleMs, heapMb: 32 });
  pools.push(value);
  return value;
}
async function marker() {
  const root = await mkdtemp(join(tmpdir(), "videobook-worker-test-"));
  roots.push(root);
  return join(root, "started.json");
}
async function started(file: string): Promise<{ pid: number; childPid?: number; cwd: string; hasProviderSecret: boolean; hasModelToken: boolean }> {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    try { return JSON.parse(await readFile(file, "utf8")); } catch { await new Promise((resolve) => setTimeout(resolve, 10)); }
  }
  throw new Error("Worker did not acknowledge starting");
}
async function dead(pid: number): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    try { process.kill(pid, 0); } catch { return; }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Worker process ${pid} is still alive`);
}

it("removes owned cache-publication staging after a killed worker", async () => {
  const workers = pool(1);
  const sourcePath = await marker();
  const controller = new AbortController();
  const call = workers.request({ ...configuration, modelCacheDir: join(dirname(sourcePath), "cache") },
    { method: "embedText", text: "cache-stage", sourcePath }, { signal: controller.signal });
  const assertion = expect(call).rejects.toMatchObject({ error: { code: "CANCELLED" } });
  let record: { pid: number; cwd: string; stage?: string };
  do { record = await started(sourcePath); } while (!("stage" in record));
  expect(await readFile(join(record.stage!, "incomplete-model"), "utf8")).toBe("incomplete");
  controller.abort();
  await assertion;
  await dead(record.pid);
  await expect(access(record.cwd)).rejects.toMatchObject({ code: "ENOENT" });
  await expect(access(record.stage!)).rejects.toMatchObject({ code: "ENOENT" });
});

it("reuses a model process and removes idle worker workspaces", async () => {
  const workers = pool(1, 100);
  const sourcePath = await marker();
  const first = await workers.request(configuration, { method: "embedText", text: "echo", sourcePath });
  const record = await started(sourcePath);
  const second = await workers.request(configuration, { method: "embedText", text: "echo" });
  expect(second).toEqual(first);
  expect(workers.stats().workers).toBe(1);
  await dead(record.pid);
  for (let attempt = 0; attempt < 100 && workers.stats().workers !== 0; attempt++) await new Promise((resolve) => setTimeout(resolve, 10));
  expect(workers.stats().workers).toBe(0);
  await expect(access(record.cwd)).rejects.toMatchObject({ code: "ENOENT" });
});

it("bounds concurrent workers across different model configurations", async () => {
  const workers = pool(2);
  let maximum = 0;
  const timer = setInterval(() => { maximum = Math.max(maximum, workers.stats().workers); }, 5);
  try {
    const values = await Promise.all(Array.from({ length: 6 }, (_, index) => workers.request(
      { ...configuration, modelCacheDir: `/fixture-${index}` }, { method: "embedText", text: "delay" }, { timeoutMs: 5000 },
    )));
    expect(values).toHaveLength(6);
    expect(maximum).toBe(2);
  } finally { clearInterval(timer); }
});

it("cancels queued work without killing the active request", async () => {
  const workers = pool(1);
  const sourcePath = await marker();
  const first = workers.request(configuration, { method: "embedText", text: "delay", durationSeconds: 500, sourcePath });
  await started(sourcePath);
  const controller = new AbortController();
  const queued = workers.request(configuration, { method: "embedText", text: "echo" }, { signal: controller.signal });
  const assertion = expect(queued).rejects.toMatchObject({ error: { code: "CANCELLED" } });
  controller.abort();
  await assertion;
  const result = await first;
  expect(await workers.request(configuration, { method: "embedText", text: "echo" })).toEqual(result);
});

it.each(["cancel", "timeout"] as const)("interrupts blocked native-style work by %s, then starts a fresh process", async (mode) => {
  const workers = pool(1);
  const sourcePath = await marker();
  const controller = new AbortController();
  const pending = workers.request(configuration, { method: "embedText", text: "loop", sourcePath }, { signal: controller.signal, timeoutMs: mode === "timeout" ? 1000 : 5000 });
  const assertion = expect(pending).rejects.toMatchObject({ error: { code: mode === "timeout" ? "TIMEOUT" : "CANCELLED" } });
  const record = await started(sourcePath);
  if (mode === "cancel") controller.abort();
  await assertion;
  await dead(record.pid);
  await expect(access(record.cwd)).rejects.toMatchObject({ code: "ENOENT" });
  const next = await workers.request(configuration, { method: "embedText", text: "echo" }) as Float32Array;
  expect(next[0]).not.toBe(record.pid);
});

it("kills decoder descendants along with the model worker", async () => {
  const workers = pool(1);
  const sourcePath = await marker();
  const controller = new AbortController();
  const pending = workers.request(configuration, { method: "embedText", text: "decoder", sourcePath }, { signal: controller.signal });
  const assertion = expect(pending).rejects.toMatchObject({ error: { code: "CANCELLED" } });
  let record = await started(sourcePath);
  for (let attempt = 0; !record.childPid && attempt < 100; attempt++) { await new Promise((resolve) => setTimeout(resolve, 10)); record = await started(sourcePath); }
  if (!record.childPid) throw new Error("Decoder did not start");
  controller.abort();
  await assertion;
  await dead(record.pid);
  await dead(record.childPid);
});

it("contains a real heap-exhaustion crash without damaging a live book and permits retry", async () => {
  const workers = pool(1);
  const sourcePath = await marker();
  const rootDir = await mkdtemp(join(tmpdir(), "videobook-worker-book-"));
  roots.push(rootDir);
  const engine = createEngine({ rootDir, initialBookName: "survives-worker-oom" });
  await engine.ready;
  const head = engine.head;
  try {
    await expect(workers.request(configuration, { method: "embedText", text: "oom", sourcePath }))
      .rejects.toMatchObject({ error: { code: "RESOURCE_EXHAUSTED" } });
    const record = await started(sourcePath);
    await dead(record.pid);
    expect(engine.head).toBe(head);
    expect(await engine.artifacts.create("image", "after-oom")).toMatchObject({ ok: true });
    expect(await workers.request(configuration, { method: "embedText", text: "echo" })).toBeInstanceOf(Float32Array);
  } finally { engine.close(); }
  const reopened = createEngine({ rootDir });
  await reopened.ready;
  expect(reopened.catalogIntegrity().artifacts).toHaveLength(1);
  reopened.close();
});

it("does not pass provider secrets or unapproved model tokens to the worker", async () => {
  const workers = pool();
  const previous = process.env.VIDEOBOOK_PRIVATE_FIXTURE;
  const previousToken = process.env.HF_TOKEN;
  process.env.VIDEOBOOK_PRIVATE_FIXTURE = "private-fixture-value";
  process.env.HF_TOKEN = "private-fixture-token";
  try {
    const first = await marker();
    await workers.request(configuration, { method: "embedText", text: "echo", sourcePath: first });
    expect(await started(first)).toMatchObject({ hasProviderSecret: false, hasModelToken: false });
    const second = await marker();
    await workers.request({ ...configuration, allowModelDownload: true }, { method: "embedText", text: "echo", sourcePath: second });
    expect(await started(second)).toMatchObject({ hasProviderSecret: false, hasModelToken: true });
  } finally {
    if (previous === undefined) delete process.env.VIDEOBOOK_PRIVATE_FIXTURE; else process.env.VIDEOBOOK_PRIVATE_FIXTURE = previous;
    if (previousToken === undefined) delete process.env.HF_TOKEN; else process.env.HF_TOKEN = previousToken;
  }
});

it("rejects invalid responses, oversized requests and requests after disposal", async () => {
  const workers = pool();
  await expect(workers.request(configuration, { method: "embedText", text: "invalid" })).rejects.toMatchObject({ error: { code: "MODEL_UNAVAILABLE" } });
  await expect(workers.request(configuration, { method: "embedText", text: "x".repeat(1024 * 1024 + 1) })).rejects.toMatchObject({ error: { code: "RESOURCE_EXHAUSTED" } });
  await workers.close();
  await expect(workers.request(configuration, { method: "prepare" })).rejects.toMatchObject({ error: { code: "CANCELLED" } });
});

it("kills cached workers and removes their scratch directory when the host exits", async () => {
  const sourcePath = await marker();
  const script = `
    import { ModelWorkerPool } from ${JSON.stringify(new URL("../src/model-worker-pool.ts", import.meta.url).href)};
    const pool = new ModelWorkerPool({ workerUrl: new URL(${JSON.stringify(new URL("./fixtures/model-worker.mjs", import.meta.url).href)}) });
    await pool.request(${JSON.stringify(configuration)}, { method: 'embedText', text: 'echo', sourcePath: ${JSON.stringify(sourcePath)} });
    process.exit(0);
  `;
  await promisify(execFile)(process.execPath, ["--import", import.meta.resolve("tsx"), "--input-type=module", "-e", script], { timeout: 5000 });
  const record = await started(sourcePath);
  await dead(record.pid);
  await expect(access(record.cwd)).rejects.toMatchObject({ code: "ENOENT" });
});

it("reports wrapped allocator failures as resource exhaustion instead of missing offline models", () => {
  expect(modelWorkerError(new EngineFault({ code: "OFFLINE", message: "Unable to load model: std::bad_alloc" })))
    .toEqual({ code: "RESOURCE_EXHAUSTED", message: "Model worker exhausted its available memory" });
  expect(modelWorkerError(new Error("private model input caused another failure")))
    .toEqual({ code: "MODEL_UNAVAILABLE", message: "Local model operation failed" });
});

it("records a worker OOM as a failed durable job and runs a later job successfully", async () => {
  const workers = pool(1);
  const rootDir = await mkdtemp(join(tmpdir(), "videobook-worker-queue-"));
  roots.push(rootDir);
  const engine = createEngine({ rootDir, initialBookName: "worker-queue" });
  await engine.ready;
  const runner = new QueueRunner(engine.jobs.queue, { concurrency: 1, pollIntervalMs: 10,
    resolveHandler: () => async (job, signal) => {
      const vector = await workers.request(configuration, { method: "embedText", text: String(job.payload.mode) }, { signal }) as Float32Array;
      return { dimensions: vector.length };
    },
  });
  try {
    const failed = engine.jobs.queue.enqueue({ type: "model-fixture", payload: { mode: "oom" }, maxAttempts: 1 }).job;
    runner.start();
    await expect(runner.waitFor(failed.id, 5000)).rejects.toThrow("failed");
    expect(engine.jobs.queue.get(failed.id)).toMatchObject({ state: "failed", error: { code: "RESOURCE_EXHAUSTED" } });
    const retry = engine.jobs.queue.enqueue({ type: "model-fixture", payload: { mode: "echo" }, maxAttempts: 1 }).job;
    expect(await runner.waitFor(retry.id, 5000)).toEqual({ dimensions: 512 });
    expect(engine.catalogIntegrity().tableRowCounts.runtime_commit_outbox).toBe(0);
  } finally { await runner.stop(); engine.close(); }
});
