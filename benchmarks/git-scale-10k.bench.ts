import * as path from "node:path";
import { describe, bench } from "vitest";
import { createBenchSandbox } from "./helpers/setup.js";
import { seedHistory } from "./helpers/seed-history.js";

const TIER = 10_000;
const TARGET_ASSET = "vid-target";

const sandbox = await createBenchSandbox();
const proj = await sandbox.fs.createProject("scale-10k");
if (!proj.ok) throw new Error("Failed to create project");
const projectSlug = proj.value.slug;
const projectDir = path.join(sandbox.outputDir, projectSlug);
await seedHistory(projectDir, TIER, TARGET_ASSET);

const SCALE_BENCH_OPTS = {
  time: 10_000,
  iterations: 10,
  warmupIterations: 2,
  warmupTime: 2_000,
  throws: true,
} as const;

describe(`git-scale-10k (${TIER.toLocaleString()} commits)`, () => {
  bench(
    "getHistory (limit 20)",
    async () => {
      await sandbox.fs.getHistory(projectSlug, 20);
    },
    SCALE_BENCH_OPTS,
  );

  bench(
    "getHistory (limit 1000)",
    async () => {
      await sandbox.fs.getHistory(projectSlug, 1000);
    },
    SCALE_BENCH_OPTS,
  );

  bench(
    "getAssetHistory (limit 20)",
    async () => {
      await sandbox.fs.getAssetHistory(TARGET_ASSET, projectSlug, 20);
    },
    SCALE_BENCH_OPTS,
  );

  bench(
    "getAssetHistory (limit 1000)",
    async () => {
      await sandbox.fs.getAssetHistory(TARGET_ASSET, projectSlug, 1000);
    },
    SCALE_BENCH_OPTS,
  );

  bench(
    "getActionLog (limit 20)",
    async () => {
      await sandbox.fs.getActionLog({ limit: 20 }, projectSlug);
    },
    SCALE_BENCH_OPTS,
  );

  bench(
    "getActionLog (limit 1000)",
    async () => {
      await sandbox.fs.getActionLog({ limit: 1000 }, projectSlug);
    },
    SCALE_BENCH_OPTS,
  );
});
