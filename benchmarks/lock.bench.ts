import { describe, bench } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { createFs } from "../src/index.js";
import { FAST_BENCH_OPTS } from "./helpers/setup.js";

// Top-level await: lock operations are pure filesystem, no git needed
const dir = await fs.mkdtemp(path.join(os.tmpdir(), "videocity-lock-bench-"));
const outputDir = path.join(dir, "output");
await fs.mkdir(outputDir, { recursive: true });
const instance = createFs({ outputDir });

const assetDir = path.join(dir, "asset-unlocked");
await fs.mkdir(assetDir, { recursive: true });

const lockedDir = path.join(dir, "asset-locked");
await fs.mkdir(lockedDir, { recursive: true });
await instance.acquireLock(lockedDir, { durationMs: 600_000 });

const staleDir = path.join(dir, "asset-stale");
await fs.mkdir(staleDir, { recursive: true });

describe("lock benchmarks", () => {
  bench(
    "acquireLock + releaseLock",
    async () => {
      await instance.acquireLock(assetDir, { durationMs: 60_000 });
      await instance.releaseLock(assetDir);
    },
    FAST_BENCH_OPTS,
  );

  bench(
    "isLocked (unlocked)",
    async () => {
      await instance.isLocked(assetDir);
    },
    FAST_BENCH_OPTS,
  );

  bench(
    "isLocked (locked)",
    async () => {
      await instance.isLocked(lockedDir);
    },
    FAST_BENCH_OPTS,
  );

  bench(
    "getLockData",
    async () => {
      await instance.getLockData(lockedDir);
    },
    FAST_BENCH_OPTS,
  );

  bench(
    "cleanStaleLock",
    async () => {
      const lockPath = path.join(staleDir, ".lock");
      const expired = JSON.stringify({
        created_at: 0,
        timeout_at: 1,
        pid: 999999,
      });
      await fs.writeFile(lockPath, expired);
      await instance.cleanStaleLock(staleDir);
    },
    FAST_BENCH_OPTS,
  );
});
