import * as path from "node:path";
import { describe, bench } from "vitest";
import { createBenchSandbox } from "./helpers/setup.js";
import { seedHistory } from "./helpers/seed-history.js";

const TIER = 100_000_000;
const TARGET_ASSET = "vid-target";

const runFull = !!process.env.BENCH_100M;

const setup = runFull
  ? async () => {
      const sandbox = await createBenchSandbox();
      const proj = await sandbox.fs.createProject("scale-100m");
      if (!proj.ok) throw new Error("Failed to create project");
      const projectSlug = proj.value.slug;
      const projectDir = path.join(sandbox.outputDir, projectSlug);
      await seedHistory(projectDir, TIER, TARGET_ASSET);
      return { sandbox, projectSlug };
    }
  : null;

const SCALE_BENCH_OPTS = {
  time: 10_000,
  iterations: 10,
  warmupIterations: 2,
  warmupTime: 2_000,
  throws: true,
} as const;

const describeFn = runFull ? describe : describe.skip;

// eslint-disable-next-line @typescript-eslint/no-non-null-assertion
const { sandbox, projectSlug } = runFull
  ? await setup!()
  : { sandbox: null as never, projectSlug: "" };

describeFn(`git-scale-100m (${TIER.toLocaleString()} commits)`, () => {
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
