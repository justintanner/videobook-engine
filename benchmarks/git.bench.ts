import { describe, bench } from "vitest";
import {
  createBenchSandbox,
  uniqueName,
  populateProject,
  SMALL_BUFFER,
  BENCH_OPTS,
  CONSUMING_BENCH_OPTS,
} from "./helpers/setup.js";

const sandbox = await createBenchSandbox();

const proj = await sandbox.fs.createProject("git-bench");
if (!proj.ok) throw new Error("Failed to create project");
const projectSlug = proj.value.slug;

const ids = await populateProject(sandbox.fs, projectSlug, 15);
const assetId = ids[0]!;

const restoreAssets: Array<{ assetId: string; hash: string }> = [];
for (let i = 0; i < 50; i++) {
  const r = await sandbox.fs.createAsset(
    "vid",
    uniqueName("restore"),
    projectSlug,
  );
  if (r.ok) {
    await sandbox.fs.writeFile(
      r.value.assetId,
      "original.txt",
      SMALL_BUFFER,
      projectSlug,
    );
    await sandbox.fs.writeFile(
      r.value.assetId,
      "updated.txt",
      SMALL_BUFFER,
      projectSlug,
    );
    const assetHistory = await sandbox.fs.getAssetHistory(
      r.value.assetId,
      projectSlug,
      2,
    );
    if (assetHistory.length >= 2) {
      restoreAssets.push({
        assetId: r.value.assetId,
        hash: assetHistory[1]!.hash,
      });
    }
  }
}
let restoreIdx = 0;

describe("git benchmarks", () => {
  bench(
    "getHistory (default)",
    async () => {
      await sandbox.fs.getHistory(projectSlug);
    },
    BENCH_OPTS,
  );

  bench(
    "getHistory (limit 10)",
    async () => {
      await sandbox.fs.getHistory(projectSlug, 10);
    },
    BENCH_OPTS,
  );

  bench(
    "getAssetHistory",
    async () => {
      await sandbox.fs.getAssetHistory(assetId, projectSlug);
    },
    BENCH_OPTS,
  );

  bench(
    "commitOperation",
    async () => {
      await sandbox.fs.commitOperation(
        "benchmark",
        assetId,
        { iter: Date.now() },
        projectSlug,
      );
    },
    BENCH_OPTS,
  );

  bench(
    "restoreAsset",
    async () => {
      const entry = restoreAssets[restoreIdx];
      if (entry) {
        await sandbox.fs.restoreAsset(entry.assetId, entry.hash, projectSlug);
        restoreIdx++;
      }
    },
    CONSUMING_BENCH_OPTS,
  );
});
