import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { expect, it } from "vitest";

const run = promisify(execFile);

it("measures independent edit preview/commit distributions with mutation and determinism proofs", async () => {
  const root = await mkdtemp(join(tmpdir(), "videobook-edit-benchmark-test-"));
  try {
    const output = join(root, "report.json");
    const result = await run(
      process.execPath,
      [
        "--import",
        "tsx",
        "benchmarks/run-edit-benchmark.ts",
        "--clips",
        "40",
        "--operations",
        "8",
        "--commits",
        "3",
        "--output",
        output,
      ],
      { maxBuffer: 2 ** 20 },
    );
    const printed = JSON.parse(result.stdout);
    const written = JSON.parse(await readFile(output, "utf8"));
    expect(written).toEqual(printed);
    expect(printed.workload).toMatchObject({
      clips: 40,
      operationsPerBatch: 8,
      commits: 3,
      operationKind: "set-clip-transform",
    });
    expect(printed.invariants).toEqual({
      previewsWithoutMutation: 3,
      deterministicRepeats: 3,
      commitsAdvancedRevision: 3,
      committedTransformsApplied: 24,
    });
    expect(printed.gates).toMatchObject({
      fullScale: false,
      noStorageMutation: true,
      deterministicPreviews: true,
      everyCommitAdvancedRevision: true,
    });
    for (const name of ["preview", "preview.repeat", "commit"]) {
      expect(printed.timings[name].samples).toBe(3);
      expect(printed.timings[name].samplesMs).toHaveLength(3);
      expect(printed.timings[name].p95Ms).toBeGreaterThan(0);
      expect(printed.timings[name].p95Ms).toBeGreaterThanOrEqual(
        printed.timings[name].p50Ms,
      );
    }
    expect(printed.timings["seed.commit"].samples).toBe(1);
    expect(typeof printed.source.commit).toBe("string");
    expect(printed.environment.logicalCpus).toBeGreaterThan(0);
    expect(printed.peakRssBytes).toBeGreaterThan(0);
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 3 });
  }
}, 60_000);

it("rejects batches that cannot address distinct clips", async () => {
  await expect(
    run(
      process.execPath,
      [
        "--import",
        "tsx",
        "benchmarks/run-edit-benchmark.ts",
        "--clips",
        "5",
        "--operations",
        "6",
        "--commits",
        "1",
      ],
      { maxBuffer: 2 ** 20 },
    ),
  ).rejects.toThrow(/distinct clips/);
});
