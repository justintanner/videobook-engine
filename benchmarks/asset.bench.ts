import { describe, bench } from "vitest";
import {
  createBenchSandbox,
  uniqueName,
  populateProject,
  SMALL_BUFFER,
  BENCH_OPTS,
  CONSUMING_BENCH_OPTS,
  FAST_BENCH_OPTS,
} from "./helpers/setup.js";

const sandbox = await createBenchSandbox();

const proj = await sandbox.fs.createProject("asset-bench");
if (!proj.ok) throw new Error("Failed to create project");
const projectSlug = proj.value.slug;

await populateProject(sandbox.fs, projectSlug, 20);

const manifestResult = await sandbox.fs.createAsset(
  "vid",
  "manifest-target",
  projectSlug,
);
if (!manifestResult.ok) throw new Error("Failed to create manifest asset");
const manifestAssetId = manifestResult.value.assetId;
for (let i = 0; i < 5; i++) {
  await sandbox.fs.writeFile(
    manifestAssetId,
    `file-${i}.txt`,
    SMALL_BUFFER,
    projectSlug,
  );
}

const deleteAssets: string[] = [];
for (let i = 0; i < 50; i++) {
  const r = await sandbox.fs.createAsset("vid", uniqueName("del"), projectSlug);
  if (r.ok) deleteAssets.push(r.value.assetId);
}
let deleteIdx = 0;

const renameAssets: string[] = [];
for (let i = 0; i < 50; i++) {
  const r = await sandbox.fs.createAsset("vid", uniqueName("ren"), projectSlug);
  if (r.ok) renameAssets.push(r.value.assetId);
}
let renameIdx = 0;

describe("asset benchmarks", () => {
  bench(
    "createAsset",
    async () => {
      await sandbox.fs.createAsset("vid", uniqueName("bench"), projectSlug);
    },
    BENCH_OPTS,
  );

  bench(
    "listAssets (20+)",
    async () => {
      await sandbox.fs.listAssets(projectSlug);
    },
    BENCH_OPTS,
  );

  bench(
    "deleteAsset",
    async () => {
      const id = deleteAssets[deleteIdx];
      if (id) {
        await sandbox.fs.deleteAsset(id, projectSlug);
        deleteIdx++;
      }
    },
    CONSUMING_BENCH_OPTS,
  );

  bench(
    "renameAsset",
    async () => {
      const id = renameAssets[renameIdx];
      if (id) {
        await sandbox.fs.renameAsset(id, uniqueName("renamed"), projectSlug);
        renameIdx++;
      }
    },
    CONSUMING_BENCH_OPTS,
  );

  bench(
    "getManifest (5 files)",
    async () => {
      await sandbox.fs.getManifest(manifestAssetId, projectSlug);
    },
    FAST_BENCH_OPTS,
  );
});
