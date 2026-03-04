import { describe, bench } from "vitest";
import { createBenchSandbox, BENCH_OPTS } from "./helpers/setup.js";

const sandbox = await createBenchSandbox();

const proj = await sandbox.fs.createProject("query-bench");
if (!proj.ok) throw new Error("Failed to create project");
const projectSlug = proj.value.slug;

const existing = await sandbox.fs.createAsset(
  "vid",
  "existing-asset",
  projectSlug,
);
if (!existing.ok) throw new Error("Failed to create existing asset");
const existingSlug = existing.value.assetId;

const toDelete = await sandbox.fs.createAsset(
  "vid",
  "deleted-asset",
  projectSlug,
);
if (!toDelete.ok) throw new Error("Failed to create asset for deletion");
const deletedSlug = toDelete.value.assetId;
await sandbox.fs.deleteAsset(deletedSlug, projectSlug);

describe("query benchmarks", () => {
  bench(
    "slugTaken (exists)",
    async () => {
      await sandbox.fs.slugTaken(existingSlug, projectSlug);
    },
    BENCH_OPTS,
  );

  bench(
    "slugTaken (never existed)",
    async () => {
      await sandbox.fs.slugTaken("vid-never-existed-xyz", projectSlug);
    },
    BENCH_OPTS,
  );

  bench(
    "slugTaken (historically deleted)",
    async () => {
      await sandbox.fs.slugTaken(deletedSlug, projectSlug);
    },
    BENCH_OPTS,
  );
});
