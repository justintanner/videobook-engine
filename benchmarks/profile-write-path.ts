// Attribution profiler for the semantic write path.
//
// History: writes once cost ~40-60ms because doltStatus over-reports (~25 of
// 34 semantic tables flagged modified on a one-table write) and the store
// row-probed every candidate twice per write, thrashing a doltlite-internal
// cache (~0.6ms per distinct table vs ~0.01ms repeated). Declared write sets
// (OperationInput.tables) removed the sweeps: writes now probe and stage only
// the tables their operation declared, and the full-catalog sweep runs once
// per open (verifyCleanSemanticWorktree). A healthy write is ~5-10ms,
// dominated by dolt_add + dolt_commit.
//
// Times are INCLUSIVE (a method's total includes its callees), so read
// `semantic` as the whole operation and the rest as its breakdown.
//
// Usage: tsx benchmarks/profile-write-path.ts [iterations]

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { performance } from "node:perf_hooks";

import { createEngine, type Result } from "../src/index.js";
import { DoltStore } from "../src/store.js";

function value<T, E extends { message: string }>(result: Result<T, E>): T {
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

interface Bucket {
  calls: number;
  totalMs: number;
}

const buckets = new Map<string, Bucket>();
let capturing = false;

function record(label: string, ms: number): void {
  if (!capturing) return;
  const bucket = buckets.get(label) ?? { calls: 0, totalMs: 0 };
  bucket.calls += 1;
  bucket.totalMs += ms;
  buckets.set(label, bucket);
}

const METHODS = [
  "semantic",
  "commitOutbox",
  "sqlCommit",
  "stageTables",
  "hasWorkingDiff",
  "assertCommittedTablesClean",
  "assertOnlyVersionedStaged",
  "assertRuntimeUnstaged",
  "verifyCleanSemanticWorktree",
  "clearOutboxRow",
  "recoverOutbox",
  "runtime",
  "begin",
  "commitSql",
] as const;

function patch(): void {
  const proto = DoltStore.prototype as unknown as Record<string, unknown>;
  for (const name of METHODS) {
    const original = proto[name] as
      ((...args: unknown[]) => unknown) | undefined;
    if (typeof original !== "function") continue;
    Object.defineProperty(proto, name, {
      configurable: true,
      writable: true,
      value: function patched(this: unknown, ...args: unknown[]) {
        const start = performance.now();
        const finish = () => record(name, performance.now() - start);
        let result: unknown;
        try {
          result = original.apply(this, args);
        } catch (error) {
          finish();
          throw error;
        }
        if (result instanceof Promise) {
          return result.finally(finish);
        }
        finish();
        return result;
      },
    });
  }
}

async function main(): Promise<void> {
  const iterations = Number(process.argv[2] ?? 20);
  patch();

  const root = await mkdtemp(path.join(tmpdir(), "videobook-write-profile-"));
  const engine = await createEngine({
    dataDir: path.join(root, "data"),
    workspaceDir: path.join(root, "workspace"),
    initialBookName: "write-profile",
  });
  await engine.ready;
  await engine.initialize();

  // Warm: the first write pays one-time costs that would skew the average.
  const warm = value(
    await engine.artifacts.create({ kind: "video", label: "warmup" }),
  );
  value(await engine.files.write(warm.artifactId, "warm.txt", "warm"));

  capturing = true;
  const started = performance.now();
  for (let index = 0; index < iterations; index += 1) {
    const artifact = value(
      await engine.artifacts.create({
        kind: "video",
        label: `profile ${index}`,
      }),
    );
    value(
      await engine.files.write(
        artifact.artifactId,
        "clip.txt",
        `payload ${index}`,
      ),
    );
  }
  const wall = performance.now() - started;
  capturing = false;

  const rows = [...buckets.entries()]
    .map(([name, bucket]) => ({ name, ...bucket }))
    .sort((a, b) => b.totalMs - a.totalMs);

  const operations = iterations * 2;
  console.log(
    `${iterations} iterations = ${operations} write operations in ` +
      `${wall.toFixed(1)}ms (${(wall / operations).toFixed(2)}ms per operation)`,
  );
  console.log("(inclusive times: `semantic` is the whole write)\n");
  console.log(
    "DoltStore method".padEnd(32) +
      "calls".padStart(8) +
      "total".padStart(12) +
      "per-op".padStart(11) +
      "share".padStart(9),
  );
  for (const row of rows) {
    console.log(
      row.name.padEnd(32) +
        String(row.calls).padStart(8) +
        `${row.totalMs.toFixed(1)}ms`.padStart(12) +
        `${(row.totalMs / operations).toFixed(2)}ms`.padStart(11) +
        `${((row.totalMs / wall) * 100).toFixed(1)}%`.padStart(9),
    );
  }

  const semantic = buckets.get("semantic");
  if (semantic) {
    const outside = wall - semantic.totalMs;
    console.log(
      `\nOutside DoltStore.semantic: ${outside.toFixed(1)}ms ` +
        `(${((outside / wall) * 100).toFixed(1)}% of wall) — engine-layer work ` +
        "before/after the store call.",
    );
  }

  await rm(root, { recursive: true, force: true });
}

void main();
