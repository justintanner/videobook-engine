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

it("can delete every prepared vector and index a replacement collection", async () => {
  const directory = await root();
  const first = load(directory);
  await first.prepare();
  for (const key of eligible.keys()) first.delete(key);
  first.dispose();
  const replacement = load(directory);
  await replacement.prepare();
  expect(replacement.nearest(query, 20, eligible)[0]?.key).toBe("frame-123");
});

it("filters deleted native keys across reopen and compacts them during preparation", async () => {
  const directory = await root();
  const first = load(directory);
  await first.prepare();
  for (let ordinal = 0; ordinal < 1000; ordinal++) first.delete(`frame-${ordinal}`);
  const expected = first.nearest(query, 100, eligible);
  expect(expected).toHaveLength(100);
  expect(first.nearest(query, 2048, eligible)).toHaveLength(1048);
  expect(expected.every(({ key }) => Number(key.slice(6)) >= 1000)).toBe(true);
  first.dispose();
  const reopened = load(directory);
  for (let ordinal = 0; ordinal < 1000; ordinal++) reopened.delete(`frame-${ordinal}`);
  expect(reopened.nearest(query, 100, eligible)).toEqual(expected);
  expect(await reopened.prepare()).toMatchObject({ updatedVectors: 1048, persisted: true });
  const metadata = JSON.parse(await readFile(join(directory, "vectors.json"), "utf8"));
  expect(metadata.entries).toHaveLength(1048);
  for (let ordinal = 0; ordinal < 1000; ordinal++) reopened.set(`new-${ordinal}`, vectors[ordinal]!, `new-${ordinal}`);
  const replacementEligible = new Map([...eligible, ...vectors.map((_, ordinal) => [`new-${ordinal}`, true] as const)]);
  expect(reopened.nearest(query, 20, replacementEligible)[0]?.key).toBe("new-123");
  reopened.dispose();
  const replacement = load(directory);
  for (let ordinal = 0; ordinal < 1000; ordinal++) {
    replacement.delete(`frame-${ordinal}`);
    replacement.set(`new-${ordinal}`, vectors[ordinal]!, `new-${ordinal}`);
  }
  expect(replacement.nearest(query, 20, replacementEligible)[0]?.key).toBe("new-123");
});

it("can checkpoint an empty compacted graph and repeatedly replace existing vectors", async () => {
  const directory = await root();
  const first = load(directory);
  await first.prepare();
  for (const key of eligible.keys()) first.delete(key);
  expect(await first.prepare()).toMatchObject({ vectors: 0, persisted: true });
  first.dispose();
  for (let cycle = 0; cycle < 3; cycle++) {
    const replacement = load(directory, cycle % 2 === 0);
    await replacement.prepare();
    for (const [ordinal, vector] of vectors.entries()) replacement.set(`frame-${ordinal}`, vector, `frame-${ordinal}`);
    expect(replacement.nearest(query, 20, eligible)[0]?.key).toBe("frame-123");
    replacement.dispose();
  }
});

it("rejects the older snapshot format before loading a graph that may have deleted slots", async () => {
  const directory = await root();
  const first = load(directory);
  await first.prepare();
  first.dispose();
  const path = join(directory, "vectors.json");
  const metadata = JSON.parse(await readFile(path, "utf8"));
  metadata.format = "usearch-2.26.0-cos-f16-16-128-128-v1";
  await writeFile(path, JSON.stringify(metadata));
  const reopened = load(directory);
  expect(() => reopened.nearest(query, 20, eligible)).toThrow("requires preparation");
  expect(await reopened.prepare()).toMatchObject({ loaded: false, updatedVectors: 2048 });
  expect(reopened.nearest(query, 20, eligible)[0]?.key).toBe("frame-123");
});

it("keeps the prior graph searchable when compaction is cancelled", async () => {
  const directory = await root();
  const index = load(directory);
  await index.prepare();
  for (let ordinal = 1148; ordinal < 2048; ordinal++) index.delete(`frame-${ordinal}`);
  const controller = new AbortController();
  const task = index.prepare(controller.signal);
  controller.abort();
  await expect(task).rejects.toMatchObject({ error: { code: "CANCELLED" } });
  expect(index.nearest(query, 20, eligible)[0]?.key).toBe("frame-123");
  await index.prepare();
  const metadata = JSON.parse(await readFile(join(directory, "vectors.json"), "utf8"));
  expect(metadata.entries).toHaveLength(1148);
});

it("discards a native graph after a failed replacement without checkpointing its removed slot", async () => {
  const directory = await root();
  const first = load(directory);
  await first.prepare();
  expect(() => first.set("frame-123", new Float32Array(15), "invalid")).toThrow();
  first.dispose();
  const reopened = load(directory);
  expect(reopened.nearest(query, 20, eligible)[0]?.key).toBe("frame-123");
  reopened.set("frame-456", query, "frame-456");
  expect(reopened.nearest(query, 20, eligible).slice(0, 2).map(({ key }) => key).sort()).toEqual(["frame-123", "frame-456"]);
});
