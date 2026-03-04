import { describe, bench } from "vitest";
import {
  createBenchSandbox,
  uniqueName,
  BENCH_OPTS,
  FAST_BENCH_OPTS,
} from "./helpers/setup.js";

const sandbox = await createBenchSandbox();
const result = await sandbox.fs.createProject("bench-project");
const projectSlug = result.ok ? result.value.slug : "";

for (let i = 0; i < 10; i++) {
  await sandbox.fs.createProject(uniqueName("proj"));
}

describe("project benchmarks", () => {
  bench(
    "createProject",
    async () => {
      await sandbox.fs.createProject(uniqueName("create"));
    },
    BENCH_OPTS,
  );

  bench(
    "listProjects (10+)",
    async () => {
      await sandbox.fs.listProjects();
    },
    BENCH_OPTS,
  );

  bench(
    "getProject",
    async () => {
      await sandbox.fs.getProject(projectSlug);
    },
    FAST_BENCH_OPTS,
  );

  bench(
    "switchProject",
    async () => {
      await sandbox.fs.switchProject(projectSlug);
    },
    FAST_BENCH_OPTS,
  );
});
