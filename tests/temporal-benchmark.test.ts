import { execFile } from "node:child_process";
import { rm } from "node:fs/promises";
import { promisify } from "node:util";

import { expect, it } from "vitest";

const run = promisify(execFile);

it("measures bounded indexing and repeated temporal queries on a reusable fixture", async () => {
  let root: string | undefined;
  try {
    const first = await run(process.execPath, [
      "--import", "tsx", "benchmarks/run-temporal-benchmark.ts",
      "--moments", "100", "--artifacts", "5", "--reads", "3", "--retain-fixture",
    ], { maxBuffer: 2 ** 20 });
    const report = JSON.parse(first.stdout);
    root = report.fixtureRoot;
    expect(report.workload).toMatchObject({ moments: 100, artifacts: 5, dimensions: 512, readsPerMode: 3 });
    expect(report.environment.embeddingModelLoaded).toBe(false);
    expect(report.indexing).toMatchObject({ batches: 5, maxAnalyzedSecondsPerBatch: 20, resumeCursorsVerified: 5 });
    expect(report.indexing.firstSearchableCoverageMs).toBeGreaterThan(0);
    expect(report.peakRssBytes).toBeGreaterThan(0);
    expect(report.openAndSummaryMs).toBeGreaterThan(0);
    expect(report.gates.fullScale).toBe(false);
    for (const mode of ["image", "video", "hybrid"]) {
      expect(report.timings[`${mode}.first`].samplesMs).toHaveLength(1);
      expect(report.timings[`${mode}.warm`].samplesMs).toHaveLength(3);
      expect(report.timings[`${mode}.warm`].p95Ms).toBeGreaterThan(0);
    }
    const reused = await run(process.execPath, [
      "--import", "tsx", "benchmarks/run-temporal-benchmark.ts", "--fixture", root!, "--reads", "2",
    ], { maxBuffer: 2 ** 20 });
    const second = JSON.parse(reused.stdout);
    expect(second.reusedFixture).toBe(true);
    expect(second.workload.moments).toBe(100);
    expect(second.indexing).toEqual(report.indexing);
    expect(second.timings["index.commitBatch"]).toBeUndefined();
    expect(second.timings["image.warm"].samples).toBe(2);
  } finally {
    if (root) await rm(root, { recursive: true, force: true, maxRetries: 3 });
  }
}, 60_000);
