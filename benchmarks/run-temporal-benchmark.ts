import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { cpus, freemem, tmpdir, totalmem } from "node:os";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";

import {
  createEngine,
  type Engine,
  type IndexManifest,
  type TemporalIndexPlan,
  type PreparedSearchReference,
  type SearchPage,
  type TemporalIndexObservation,
} from "../src/index.js";

const manifest: IndexManifest = {
  manifestId: "synthetic-scale-512-v1",
  provider: "deterministic-performance-fixture",
  modelId: "xorshift32-normalized-512",
  modelRevision: "1",
  embeddingSpace: "synthetic-scale-512-v1",
  dimensions: 512,
  modalities: ["visual", "metadata"],
  supportedLanguages: ["en"],
  preprocessingVersion: "1",
  extractorVersion: "1",
  createdAt: 1,
};
const generation = "scale-v1";
const args = process.argv.slice(2);
const readFlag = (name: string): string | undefined => {
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  const result = args[index + 1];
  if (!result || result.startsWith("--")) throw new Error(`${name} needs a value`);
  return result;
};
const integer = (name: string, fallback: number): number => {
  const value = Number(readFlag(name) ?? fallback);
  assert.ok(Number.isSafeInteger(value) && value > 0, `${name} must be a positive integer`);
  return value;
};
if (args.includes("--help")) {
  console.log(`Usage: npm run benchmark:temporal -- [options]
  --moments N       Indexed moments (default 100000)
  --artifacts N     Video artifacts (default 1000)
  --reads N         Warm queries per mode (default 50)
  --batch-units N   One-second moments per durable batch (default 30, maximum 60)
  --fixture PATH   Reuse a completed fixture created by this script
  --retain-fixture Keep the generated fixture for a later measurement
  --output PATH    Write the complete JSON report
  --assert         Exit nonzero when a measured NFR threshold fails
Synthetic vectors measure performance only; they do not prove search quality.`);
  process.exit(0);
}
const valueFlags = ["--moments", "--artifacts", "--reads", "--batch-units", "--fixture", "--output"];
for (let index = 0; index < args.length; index++) {
  if (valueFlags.includes(args[index]!)) { index++; continue; }
  assert.ok(["--retain-fixture", "--assert"].includes(args[index]!), `Unknown flag: ${args[index]}`);
}
const requestedMoments = integer("--moments", 100_000);
const requestedArtifacts = integer("--artifacts", 1_000);
const reads = integer("--reads", 50);
const batchUnits = integer("--batch-units", 30);
assert.ok(batchUnits <= 60, "Batches must publish coverage within 60 seconds of analyzed media");
assert.ok(requestedMoments >= requestedArtifacts, "Each artifact needs at least one moment");
const reused = readFlag("--fixture");
const root = reused ? resolve(reused) : await mkdtemp(join(tmpdir(), "videobook-temporal-scale-"));
const baselineRss = process.memoryUsage().rss;
const startedAt = new Date().toISOString();
const measurements = new Map<string, number[]>();
let engine: Engine | undefined;
const measure = async <T>(name: string, run: () => T | Promise<T>): Promise<T> => {
  const start = performance.now();
  const result = await run();
  const samples = measurements.get(name) ?? [];
  samples.push(performance.now() - start);
  measurements.set(name, samples);
  return result;
};
interface Fixture {
  kind: "videobook-temporal-scale-v1";
  manifest: IndexManifest;
  momentCount: number;
  artifacts: Array<{ artifactId: string; firstMoment: number; moments: number }>;
  indexing: {
    durationMs: number;
    batches: number;
    maxAnalyzedSecondsPerBatch: number;
    firstSearchableCoverageMs: number;
    resumeCursorsVerified: number;
  };
}
const unwrap = <T>(result: { ok: true; value: T } | { ok: false; error: { message: string } }): T => {
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
};
function vector(seed: number): number[] {
  let state = (seed + 1) >>> 0;
  const values = Array.from({ length: manifest.dimensions }, () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 0x100000000 * 2 - 1;
  });
  const norm = Math.hypot(...values);
  return values.map((item) => item / norm);
}
const registerProvider = (target: Engine): void => {
  target.temporalSearch.providers.register({
    manifestId: manifest.manifestId,
    prepare: async () => {},
    embedText: async (text) => Float32Array.from(vector(Number(text.match(/moment (\d+)/)?.[1] ?? 0))),
  });
};
try {
  let fixture: Fixture;
  if (reused) {
    fixture = JSON.parse(await readFile(join(root, "scale-fixture.json"), "utf8")) as Fixture;
    assert.equal(fixture.kind, "videobook-temporal-scale-v1", "Only owned benchmark fixtures may be reused");
    assert.deepEqual(fixture.manifest, manifest);
  } else {
    engine = createEngine({ rootDir: root, initialBookName: "Synthetic temporal scale fixture" });
    unwrap(engine.temporalSearch.manifests.register(manifest));
    registerProvider(engine);
    const seedStarted = performance.now();
    fixture = {
      kind: "videobook-temporal-scale-v1", manifest, momentCount: requestedMoments, artifacts: [],
      indexing: { durationMs: 0, batches: 0, maxAnalyzedSecondsPerBatch: 0,
        firstSearchableCoverageMs: 0, resumeCursorsVerified: 0 },
    };
    for (let artifactIndex = 0, firstMoment = 0; artifactIndex < requestedArtifacts; artifactIndex++) {
      const moments = Math.floor(requestedMoments / requestedArtifacts)
        + (artifactIndex < requestedMoments % requestedArtifacts ? 1 : 0);
      const artifact = unwrap(await engine.artifacts.create({ kind: "video", label: `Synthetic video ${artifactIndex}` }));
      unwrap(await engine.files.write(artifact.artifactId, "original.mp4", `synthetic scale fixture ${artifactIndex}`));
      const objectHash = unwrap(await engine.files.manifest(artifact.artifactId)).files[0]!.objectHash;
      const stream = unwrap(await engine.streams.register({
        artifactId: artifact.artifactId, sourcePath: "original.mp4", objectHash, streamIndex: 0,
        kind: "video", timeBase: { numerator: 1, denominator: 1_000 }, durationTicks: moments * 1_000,
        codec: "synthetic", video: { width: 1920, height: 1080, rotationDegrees: 0,
          pixelAspect: { numerator: 1, denominator: 1 } },
      }));
      fixture.artifacts.push({ artifactId: artifact.artifactId, firstMoment, moments });
      for (let start = 0; start < moments; start += batchUnits) {
        const count = Math.min(batchUnits, moments - start);
        const observations = Array.from({ length: count }, (_, relative): TemporalIndexObservation => {
          const tick = (start + relative) * 1_000;
          const moment = firstMoment + start + relative;
          return {
            artifactId: artifact.artifactId, objectHash, streamId: stream.streamId,
            range: { streamId: stream.streamId, objectHash, startTick: tick, durationTicks: 1_000, timeBase: stream.timeBase },
            kind: "window", representativeTick: tick, segmentationVersion: "synthetic-1fps-v1",
            texts: [{ kind: "description", language: "en", text: `synthetic scene ${artifactIndex} moment ${moment}` }],
            embeddings: [{ modality: "visual", embeddingSpace: manifest.embeddingSpace,
              vector: vector(moment), sourceHash: `${objectHash}:${moment}` }],
            fingerprints: [],
          };
        });
        const end = start + count;
        unwrap(await measure("index.commitBatch", () => engine!.temporalSearch.commitBatch({
          artifactId: artifact.artifactId, objectHash, manifestId: manifest.manifestId, generation,
          phase: "visual", cursor: String(start), nextCursor: end < moments ? String(end) : undefined,
          maxUnits: batchUnits, totalUnits: moments, complete: end === moments, observations,
          coveredRanges: [{ streamId: stream.streamId, objectHash, startTick: 0,
            durationTicks: end * 1_000, timeBase: stream.timeBase }],
        })));
        fixture.indexing.batches++;
        fixture.indexing.maxAnalyzedSecondsPerBatch = Math.max(fixture.indexing.maxAnalyzedSecondsPerBatch, count);
        const plan: TemporalIndexPlan = unwrap(engine.temporalSearch.plan(artifact.artifactId, objectHash, manifest.manifestId, generation));
        const coverage = plan.coverage.find((item) => item.phase === "visual")!;
        assert.equal(coverage.indexedUnits, end);
        assert.equal(coverage.nextCursor, end < moments ? String(end) : undefined);
        fixture.indexing.resumeCursorsVerified++;
        if (fixture.indexing.batches === 1) {
          unwrap(engine.temporalSearch.activate(manifest.manifestId, generation));
          const firstPage = unwrap(await engine.temporalSearch.queryPrepared({ limit: 10 }, {
            kind: "image", embeddingSpace: manifest.embeddingSpace, vector: vector(firstMoment),
          }));
          assert.ok(firstPage.hits.some((hit) => hit.artifactId === artifact.artifactId));
          fixture.indexing.firstSearchableCoverageMs = performance.now() - seedStarted;
        }
      }
      firstMoment += moments;
      if (artifactIndex % 10 === 0 || artifactIndex + 1 === requestedArtifacts) {
        console.error(`Indexed ${firstMoment}/${requestedMoments} moments in ${artifactIndex + 1} artifacts; RSS ${(process.memoryUsage().rss / 2 ** 20).toFixed(0)} MiB`);
      }
    }
    fixture.indexing.durationMs = performance.now() - seedStarted;
    await writeFile(join(root, "scale-fixture.json"), `${JSON.stringify(fixture)}\n`);
    engine.close();
    engine = undefined;
  }
  const openStarted = performance.now();
  engine = createEngine({ rootDir: root });
  const book = engine.book.get();
  const stats = engine.temporalSearch.stats();
  const openAndSummaryMs = performance.now() - openStarted;
  assert.ok(book.bookId);
  assert.equal(stats.segments, fixture.momentCount);
  assert.equal(unwrap(engine.temporalSearch.coverage()).indexedArtifactCount, fixture.artifacts.length);
  registerProvider(engine);
  const runQuery = async (mode: string, seed: number): Promise<SearchPage> => {
    const artifact = fixture.artifacts[seed % fixture.artifacts.length]!;
    const offset = seed % Math.max(1, artifact.moments - 8);
    const first = artifact.firstMoment + offset;
    if (mode === "hybrid") return unwrap(await engine!.temporalSearch.query({ text: `moment ${first}`, limit: 20 }));
    const reference: PreparedSearchReference = mode === "image" ? {
      kind: "image", embeddingSpace: manifest.embeddingSpace, vector: vector(first),
    } : {
      kind: "video", embeddingSpace: manifest.embeddingSpace,
      durationMs: Math.min(8, artifact.moments - offset) * 1_000,
      samples: Array.from({ length: Math.min(8, artifact.moments - offset) }, (_, index) => ({
        offsetMs: index * 1_000, vector: vector(first + index),
      })),
    };
    const page = unwrap(await engine!.temporalSearch.queryPrepared({ modalities: ["visual"], limit: 20 }, reference));
    assert.ok(page.hits.some((hit) => hit.artifactId === artifact.artifactId), `${mode} omitted its own source`);
    return page;
  };
  for (const mode of ["image", "video", "hybrid"]) {
    const first = await measure(`${mode}.first`, () => runQuery(mode, 0));
    const repeat = await runQuery(mode, 0);
    assert.deepEqual(repeat.hits, first.hits, `${mode} ordering must remain deterministic`);
    for (let index = 0; index < reads; index++) {
      await measure(`${mode}.warm`, () => runQuery(mode, (index * 37) % fixture.artifacts.length));
    }
    console.error(`${mode}: ${reads} warm queries complete`);
  }
  const timings = Object.fromEntries([...measurements].map(([name, samples]) => {
    const ordered = [...samples].sort((left, right) => left - right);
    const quantile = (p: number) => ordered[Math.max(0, Math.ceil(p * ordered.length) - 1)]!;
    return [name, { samples: samples.length, p50Ms: quantile(0.5), p95Ms: quantile(0.95),
      maxMs: ordered.at(-1)!, totalMs: samples.reduce((sum, item) => sum + item, 0), samplesMs: samples }];
  }));
  const peakRssBytes = process.resourceUsage().maxRSS * 1024;
  const gates = {
    fullScale: fixture.momentCount >= 100_000 && fixture.artifacts.length >= 1_000 && reads >= 50,
    openUnderTwoSeconds: openAndSummaryMs < 2_000,
    warmLatency: ["image", "video", "hybrid"].every((mode) => timings[`${mode}.warm`]!.p50Ms < 500 && timings[`${mode}.warm`]!.p95Ms < 1_500),
    processRssUnderFourGiB: peakRssBytes < 4 * 2 ** 30,
    coverageWithinSixtyAnalyzedSeconds: fixture.indexing.maxAnalyzedSecondsPerBatch <= 60,
  };
  const report = {
    schemaVersion: 1, startedAt, completedAt: new Date().toISOString(),
    source: {
      commit: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
      dirty: Boolean(execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" }).trim()),
    },
    purpose: "Synthetic performance only; no recall or corpus-quality claim",
    environment: { node: process.version, platform: process.platform, arch: process.arch,
      cpu: cpus()[0]?.model, logicalCpus: cpus().length, totalMemoryBytes: totalmem(), freeMemoryBytes: freemem(),
      embeddingModelLoaded: false },
    workload: { moments: fixture.momentCount, artifacts: fixture.artifacts.length, dimensions: manifest.dimensions,
      readsPerMode: reads, manifest },
    fixtureRoot: root, reusedFixture: Boolean(reused), indexing: fixture.indexing,
    queryOrder: ["image", "video", "hybrid"],
    firstQueryNote: "First call per mode after reopen; not a cold OS page-cache measurement",
    openAndSummaryMs, baselineRssBytes: baselineRss, peakRssBytes, timings, gates,
  };
  const serialized = `${JSON.stringify(report, null, 2)}\n`;
  if (readFlag("--output")) await writeFile(resolve(readFlag("--output")!), serialized);
  console.log(serialized);
  if (args.includes("--assert") && Object.values(gates).some((passed) => !passed)) process.exitCode = 1;
} finally {
  engine?.close();
  if (!reused && !args.includes("--retain-fixture")) await rm(root, { recursive: true, force: true, maxRetries: 3 });
  else console.error(`Fixture retained at ${root}`);
}
