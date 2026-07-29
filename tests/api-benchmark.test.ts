import { describe, expect, it } from "vitest";

import {
  API_BENCHMARK_GROUPS,
  createApiBenchmarkReport,
  quickApiBenchmarkOptions,
} from "../benchmarks/api-benchmark.js";

describe("full API benchmark reporting", () => {
  it("computes stable distributions and the smallest 80% time frontier", () => {
    const report = createApiBenchmarkReport(
      new Map([
        [
          "artifacts.create",
          { group: "artifacts", kind: "write", samplesMs: [40, 60] },
        ],
        [
          "files.write",
          { group: "files", kind: "write", samplesMs: [20, 20] },
        ],
        [
          "book.get",
          { group: "book", kind: "read", samplesMs: [10] },
        ],
      ]),
      quickApiBenchmarkOptions(),
      200,
    );

    expect(report.measuredMs).toBe(150);
    expect(report.operations.map((operation) => operation.name)).toEqual([
      "artifacts.create",
      "files.write",
      "book.get",
    ]);
    expect(report.operations[0]).toMatchObject({
      samples: 2,
      totalMs: 100,
      meanMs: 50,
      p50Ms: 40,
      p95Ms: 60,
    });
    expect(report.pareto).toMatchObject({
      targetShare: 0.8,
      operationCount: 2,
      totalOperationCount: 3,
      capturedTimeShare: 140 / 150,
      operations: ["artifacts.create", "files.write"],
    });
  });

  it("reports every unmeasured top-level API group", () => {
    const report = createApiBenchmarkReport(
      new Map([
        [
          "engine.create",
          { group: "engine", kind: "lifecycle", samplesMs: [1] },
        ],
      ]),
      quickApiBenchmarkOptions(),
      1,
    );

    expect(report.coverage.observedGroups).toEqual(["engine"]);
    expect(report.coverage.missingGroups).toEqual(
      API_BENCHMARK_GROUPS.filter((group) => group !== "engine"),
    );
  });
});
