import { describe, bench } from "vitest";
import {
  createBenchSandbox,
  SMALL_BUFFER,
  MEDIUM_BUFFER,
  LARGE_BUFFER,
  BENCH_OPTS,
  FAST_BENCH_OPTS,
} from "./helpers/setup.js";

const sandbox = await createBenchSandbox();

const proj = await sandbox.fs.createProject("file-bench");
if (!proj.ok) throw new Error("Failed to create project");
const projectSlug = proj.value.slug;

const writeResult = await sandbox.fs.createAsset(
  "vid",
  "write-target",
  projectSlug,
);
if (!writeResult.ok) throw new Error("Failed to create write asset");
const writeAssetId = writeResult.value.assetId;

const readResult = await sandbox.fs.createAsset(
  "vid",
  "read-target",
  projectSlug,
);
if (!readResult.ok) throw new Error("Failed to create read asset");
const readAssetId = readResult.value.assetId;

await sandbox.fs.writeFile(readAssetId, "small.bin", SMALL_BUFFER, projectSlug);
await sandbox.fs.writeFile(
  readAssetId,
  "medium.bin",
  MEDIUM_BUFFER,
  projectSlug,
);
await sandbox.fs.writeFile(readAssetId, "large.bin", LARGE_BUFFER, projectSlug);

let writeCounter = 0;

describe("file benchmarks", () => {
  bench(
    "writeFile (1KB)",
    async () => {
      writeCounter++;
      await sandbox.fs.writeFile(
        writeAssetId,
        `small-${writeCounter}.bin`,
        SMALL_BUFFER,
        projectSlug,
      );
    },
    BENCH_OPTS,
  );

  bench(
    "writeFile (100KB)",
    async () => {
      writeCounter++;
      await sandbox.fs.writeFile(
        writeAssetId,
        `medium-${writeCounter}.bin`,
        MEDIUM_BUFFER,
        projectSlug,
      );
    },
    BENCH_OPTS,
  );

  bench(
    "writeFile (1MB)",
    async () => {
      writeCounter++;
      await sandbox.fs.writeFile(
        writeAssetId,
        `large-${writeCounter}.bin`,
        LARGE_BUFFER,
        projectSlug,
      );
    },
    BENCH_OPTS,
  );

  bench(
    "readFile (1KB)",
    async () => {
      await sandbox.fs.readFile(readAssetId, "small.bin", projectSlug);
    },
    FAST_BENCH_OPTS,
  );

  bench(
    "readFile (100KB)",
    async () => {
      await sandbox.fs.readFile(readAssetId, "medium.bin", projectSlug);
    },
    FAST_BENCH_OPTS,
  );

  bench(
    "readFile (1MB)",
    async () => {
      await sandbox.fs.readFile(readAssetId, "large.bin", projectSlug);
    },
    FAST_BENCH_OPTS,
  );
});
