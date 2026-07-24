import { readdir, readFile } from "node:fs/promises";
import * as path from "node:path";

import { describe, expect, it } from "vitest";

const forbidden = [
  "createFs",
  "videocity-engine",
  "simple-git",
  "better-sqlite3",
  "state.sqlite",
  "metadata.sqlite",
  "runtime.sqlite",
] as const;

describe("Dolt-native cutover guard", () => {
  it("keeps legacy persistence out of production source", async () => {
    const sourceRoot = path.resolve(import.meta.dirname, "../src");
    const files = await sourceFiles(sourceRoot);
    const violations: string[] = [];

    for (const file of files) {
      const source = await readFile(file, "utf8");
      for (const token of forbidden) {
        if (source.includes(token)) {
          violations.push(
            `${path.relative(sourceRoot, file)} contains ${token}`,
          );
        }
      }
    }

    expect(violations).toEqual([]);
  });
});

async function sourceFiles(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry) => {
      const fullPath = path.join(root, entry.name);
      if (entry.isDirectory()) return sourceFiles(fullPath);
      return /\.[cm]?[jt]sx?$/.test(entry.name) ? [fullPath] : [];
    }),
  );
  return files.flat();
}
