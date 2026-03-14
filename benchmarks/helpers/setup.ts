import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import * as crypto from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { createFs, type ClipfirstFs } from "../../src/index.js";

const execFileAsync = promisify(execFile);

export interface BenchSandbox {
  dir: string;
  outputDir: string;
  fs: ClipfirstFs;
  cleanup: () => Promise<void>;
}

export async function createBenchSandbox(): Promise<BenchSandbox> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "clipfirst-bench-"));
  const outputDir = path.join(dir, "output");
  await fs.mkdir(outputDir, { recursive: true });

  await execFileAsync(
    "git",
    ["config", "--global", "user.email", "bench@clipfirst.test"],
    {
      env: { ...process.env, HOME: dir },
    },
  ).catch(() => {});
  await execFileAsync(
    "git",
    ["config", "--global", "user.name", "Bench User"],
    {
      env: { ...process.env, HOME: dir },
    },
  ).catch(() => {});

  const instance = createFs({ projectsDir: outputDir });

  return {
    dir,
    outputDir,
    fs: instance,
    cleanup: async () => {
      await fs.rm(dir, { recursive: true, force: true });
    },
  };
}

export const SMALL_BUFFER = crypto.randomBytes(1024); // 1KB
export const MEDIUM_BUFFER = crypto.randomBytes(100 * 1024); // 100KB
export const LARGE_BUFFER = crypto.randomBytes(1024 * 1024); // 1MB

let counter = 0;
export function uniqueName(prefix: string): string {
  counter += 1;
  return `${prefix}-${counter}`;
}

export function resetCounter(): void {
  counter = 0;
}

/** Default bench options for slow async operations (git/fs I/O) */
export const BENCH_OPTS = {
  time: 5_000,
  iterations: 5,
  warmupIterations: 1,
  warmupTime: 1_000,
  throws: true,
} as const;

/** Bench options for mutating operations that consume pre-created resources */
export const CONSUMING_BENCH_OPTS = {
  ...BENCH_OPTS,
  time: 0,
  iterations: 30,
  warmupIterations: 0,
  warmupTime: 0,
} as const;

/** Bench options for fast operations (pure fs, no git) */
export const FAST_BENCH_OPTS = {
  time: 2_000,
  iterations: 10,
  warmupIterations: 2,
  warmupTime: 500,
  throws: true,
} as const;

export async function populateProject(
  instance: ClipfirstFs,
  projectSlug: string,
  count: number,
): Promise<string[]> {
  const assetIds: string[] = [];
  for (let i = 0; i < count; i++) {
    const result = await instance.createAsset(
      "vid",
      uniqueName("asset"),
      projectSlug,
    );
    if (result.ok) {
      assetIds.push(result.value.assetId);
      await instance.writeFile(
        result.value.assetId,
        "file.txt",
        SMALL_BUFFER,
        projectSlug,
      );
    }
  }
  return assetIds;
}
