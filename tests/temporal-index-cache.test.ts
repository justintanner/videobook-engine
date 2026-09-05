import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, expect, it } from "vitest";

import { TemporalVectorIndex } from "../src/temporal-vector-index.js";

const roots: string[] = [];
const indexes: Array<TemporalVectorIndex<string>> = [];
afterEach(async () => {
  for (const index of indexes.splice(0)) index.dispose();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true, maxRetries: 3 });
});

const vectors = Array.from({ length: 2_048 }, (_, index) => {
  let seed = index + 1;
  return Float32Array.from({ length: 16 }, () => {
    seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5;
    return (seed >>> 0) / 0x100000000 * 2 - 1;
  });
});
const eligible = new Map(vectors.map((_, index) => [`frame-${index}`, true]));
const query = vectors[123]!;

async function root(): Promise<string> {
  const value = await mkdtemp(join(tmpdir(), "temporal-native-cache-"));
  roots.push(value);
  return value;
}

function load(directory: string, changed = false, identity = "fixture-v1"): TemporalVectorIndex<string> {
  const index = new TemporalVectorIndex<string>(16, { basePath: join(directory, "vectors"), identity });
  for (const [ordinal, vector] of vectors.entries()) {
    index.set(`frame-${ordinal}`, changed && ordinal === 456 ? query : vector, `frame-${ordinal}`);
  }
  indexes.push(index);
  return index;
}

it("prepares cooperatively and reuses the saved graph for the first query after reopen", async () => {
  const directory = await root();
  const first = load(directory);
  expect(() => first.nearest(query, 20, eligible)).toThrow("requires preparation");
  let ticks = 0;
  const timer = setInterval(() => { ticks++; }, 0);
  try {
    expect(await first.prepare()).toMatchObject({ vectors: 2048, updatedVectors: 2048, loaded: false, persisted: true });
  } finally { clearInterval(timer); }
  expect(ticks).toBeGreaterThan(0);
  const expected = first.nearest(query, 20, eligible);
  first.dispose();
  const reopened = load(directory);
  expect(reopened.nearest(query, 20, eligible)).toEqual(expected);
  expect(await reopened.prepare()).toMatchObject({ updatedVectors: 0, persisted: false });
});

it("detects stale vectors and reconciles only changed entries from a valid checkpoint", async () => {
  const directory = await root();
  const first = load(directory);
  await first.prepare();
  first.dispose();
  const changed = load(directory, true);
  expect(() => changed.nearest(query, 20, eligible)).toThrow("requires preparation");
  expect(await changed.prepare()).toMatchObject({ loaded: true, updatedVectors: 1, persisted: true });
  expect(changed.nearest(query, 20, eligible).slice(0, 2).map((entry) => entry.key).sort()).toEqual(["frame-123", "frame-456"]);
  changed.delete("frame-123");
  expect(changed.nearest(query, 20, eligible)[0]?.key).toBe("frame-456");
  changed.dispose();
  const reopened = load(directory, true);
  reopened.delete("frame-123");
  expect(reopened.nearest(query, 20, eligible)[0]?.key).toBe("frame-456");
});

it("rejects a damaged native file or mismatched identity and can rebuild from committed vectors", async () => {
  const directory = await root();
  const first = load(directory);
  await first.prepare();
  first.dispose();
  const metadata = JSON.parse(await readFile(join(directory, "vectors.json"), "utf8"));
  const graph = await readFile(join(directory, metadata.graph));
  graph[20] = graph[20]! ^ 255;
  await writeFile(join(directory, metadata.graph), graph);
  const damaged = load(directory);
  expect(() => damaged.nearest(query, 20, eligible)).toThrow("requires preparation");
  expect(await damaged.prepare()).toMatchObject({ loaded: false, updatedVectors: 2048, persisted: true });
  expect(damaged.nearest(query, 20, eligible)[0]?.key).toBe("frame-123");
  damaged.dispose();
  const mismatch = load(directory, false, "other-model");
  expect(() => mismatch.nearest(query, 20, eligible)).toThrow("requires preparation");
});

it("cancels preparation without publishing a partial graph and can retry", async () => {
  const directory = await root();
  const index = load(directory);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 0);
  try { await expect(index.prepare(controller.signal)).rejects.toMatchObject({ error: { code: "CANCELLED" } }); }
  finally { clearTimeout(timer); }
  await expect(readFile(join(directory, "vectors.json"))).rejects.toMatchObject({ code: "ENOENT" });
  expect(() => index.nearest(query, 20, eligible)).toThrow("requires preparation");
  await index.prepare();
  expect(index.nearest(query, 20, eligible)[0]?.key).toBe("frame-123");
});

it("reconciles mutations arriving during preparation before publishing the graph", async () => {
  const directory = await root();
  const index = load(directory);
  const preparing = index.prepare();
  const mutation = new Promise<void>((resolve) => setTimeout(() => {
    index.delete("frame-123");
    index.set("frame-456", query, "frame-456");
    resolve();
  }, 0));
  await Promise.all([preparing, mutation]);
  expect(index.nearest(query, 20, eligible)[0]?.key).toBe("frame-456");
  index.dispose();
  const reopened = load(directory, true);
  reopened.delete("frame-123");
  expect(reopened.nearest(query, 20, eligible)[0]?.key).toBe("frame-456");
});
