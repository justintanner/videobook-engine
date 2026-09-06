import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { cpus, freemem, tmpdir, totalmem } from "node:os";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";

import { v7 as uuidv7 } from "uuid";

import {
  canonicalContractJson,
  createEngine,
  MVP_CONTRACT_VERSION,
  type ArtifactStream,
  type ClipTransform,
  type EditIntent,
  type EditPreview,
  type Engine,
  type Sequence,
} from "../src/index.js";

/**
 * VE-NFR-005 / VE-NFR-006 / VE-NFR-009 distribution benchmark.
 *
 * Seeds one sequence with `--clips` one-frame clips, then performs
 * `--commits` independent edit transactions. Every transaction previews a
 * fresh `--operations`-operation batch against the current head, proves the
 * preview mutated no storage, previews the identical intent again and
 * requires identical canonical operations and hashes, then commits it and
 * requires the head revision to advance. Preview and commit latencies are
 * reported as full distributions, not single samples.
 */
const args = process.argv.slice(2);
const readFlag = (name: string): string | undefined => {
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  const result = args[index + 1];
  if (!result || result.startsWith("--"))
    throw new Error(`${name} needs a value`);
  return result;
};
const integer = (name: string, fallback: number): number => {
  const value = Number(readFlag(name) ?? fallback);
  assert.ok(
    Number.isSafeInteger(value) && value > 0,
    `${name} must be a positive integer`,
  );
  return value;
};
if (args.includes("--help")) {
  console.log(`Usage: npm run benchmark:edits -- [options]
  --clips N        Seeded clips on the primary sequence (default 1000)
  --operations N   Operations per previewed and committed batch (default 100)
  --commits N      Independent preview/commit transactions (default 50)
  --output PATH    Write the complete JSON report
  --assert         Exit nonzero when a measured NFR threshold fails
Each transaction previews against the current head, proves no storage
mutation, repeats the preview for determinism, then commits.`);
  process.exit(0);
}
const valueFlags = ["--clips", "--operations", "--commits", "--output"];
for (let index = 0; index < args.length; index++) {
  if (valueFlags.includes(args[index]!)) {
    index++;
    continue;
  }
  assert.ok(args[index] === "--assert", `Unknown flag: ${args[index]}`);
}
const clipCount = integer("--clips", 1_000);
const operationCount = integer("--operations", 100);
const commitCount = integer("--commits", 50);
assert.ok(
  operationCount <= clipCount,
  "Each batch must address distinct clips",
);

const unwrap = <T>(
  result: { ok: true; value: T } | { ok: false; error: { message: string } },
): T => {
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
};
const measurements = new Map<string, number[]>();
const measure = <T>(name: string, run: () => T): T => {
  const start = performance.now();
  const result = run();
  const samples = measurements.get(name) ?? [];
  samples.push(performance.now() - start);
  measurements.set(name, samples);
  return result;
};
const measureAsync = async <T>(
  name: string,
  run: () => Promise<T>,
): Promise<T> => {
  const start = performance.now();
  const result = await run();
  const samples = measurements.get(name) ?? [];
  samples.push(performance.now() - start);
  measurements.set(name, samples);
  return result;
};

function transform(iteration: number, ordinal: number): ClipTransform {
  return {
    fit: (["fit", "fill", "crop"] as const)[(iteration + ordinal) % 3]!,
    positionX: ((iteration * 7 + ordinal) % 100) / 100,
    positionY: ((iteration * 11 + ordinal) % 100) / 100,
    scaleX: 1 + ((iteration + ordinal) % 5) / 10,
    scaleY: 1 + ((iteration * 3 + ordinal) % 5) / 10,
    anchorX: 0.5,
    anchorY: 0.5,
    rotationDegrees: (iteration * 13 + ordinal) % 360,
    cropTop: 0,
    cropRight: 0,
    cropBottom: 0,
    cropLeft: 0,
    opacity: 1 - ((iteration + ordinal) % 10) / 20,
    blendMode: "normal",
  };
}

function intent(
  sequence: Sequence,
  commandId: string,
  operations: EditIntent["operations"],
): EditIntent {
  return {
    intentVersion: MVP_CONTRACT_VERSION,
    commandId,
    sequenceId: sequence.sequenceId,
    baseRevision: sequence.revision,
    actor: "edit-benchmark",
    sourceSurface: "ui",
    confirmationPolicy: "risk-based",
    operations,
  };
}

function batchIntent(sequence: Sequence, iteration: number): EditIntent {
  const offset = (iteration * operationCount) % sequence.clips.length;
  const operations = Array.from({ length: operationCount }, (_, ordinal) => ({
    kind: "set-clip-transform" as const,
    clipId: sequence.clips[(offset + ordinal) % sequence.clips.length]!.clipId,
    transform: transform(iteration, ordinal),
  }));
  return intent(sequence, `edit-benchmark-${iteration}`, operations);
}

interface StorageSnapshot {
  head: string;
  rowCounts: string;
  sequence: string;
}

function snapshot(engine: Engine, sequenceId: string): StorageSnapshot {
  const head = engine.history.revisions(1)[0]?.hash;
  assert.ok(head, "Catalog head revision is missing");
  return {
    head,
    rowCounts: canonicalContractJson(engine.catalogIntegrity().tableRowCounts),
    sequence: canonicalContractJson(unwrap(engine.sequences.get(sequenceId))),
  };
}

function previewIdentity(preview: EditPreview): string {
  return canonicalContractJson({
    operations: preview.operations,
    affectedRanges: preview.affectedRanges,
    writeSet: preview.writeSet,
    warnings: preview.warnings,
    conflicts: preview.conflicts,
    diff: preview.diff,
    beforeHash: preview.beforeHash,
    afterHash: preview.afterHash,
    previewHash: preview.previewHash,
  });
}

async function seed(
  engine: Engine,
): Promise<{ stream: ArtifactStream; sequence: Sequence }> {
  const artifact = unwrap(
    await engine.artifacts.create({
      kind: "video",
      label: "edit-benchmark-source",
    }),
  );
  unwrap(
    await engine.files.write(
      artifact.artifactId,
      "original.mp4",
      "edit benchmark source",
    ),
  );
  const objectHash = unwrap(await engine.files.manifest(artifact.artifactId))
    .files[0]?.objectHash;
  assert.ok(objectHash, "Source object hash is missing");
  const stream = unwrap(
    await engine.streams.register({
      artifactId: artifact.artifactId,
      sourcePath: "original.mp4",
      objectHash,
      streamIndex: 0,
      kind: "video",
      timeBase: { numerator: 1, denominator: 1_000 },
      durationTicks: Math.max(60_000, clipCount * 1_000),
      codec: "h264",
      video: {
        width: 1920,
        height: 1080,
        rotationDegrees: 0,
        pixelAspect: { numerator: 1, denominator: 1 },
        nominalFrameRate: { numerator: 30, denominator: 1 },
      },
    }),
  );
  const primary = engine.sequences.getPrimary();
  const track = primary.tracks.find((item) => item.kind === "video");
  assert.ok(track, "Video track is missing");
  const seedIntent = intent(
    primary,
    "edit-benchmark-seed",
    Array.from({ length: clipCount }, (_, index) => ({
      kind: "insert-clip" as const,
      clipId: uuidv7(),
      placement: {
        trackId: track.trackId,
        timelineStartFrame: index,
        durationFrames: 1,
        source: {
          kind: "timed" as const,
          artifactId: stream.artifactId,
          range: {
            streamId: stream.streamId,
            objectHash: stream.objectHash,
            startTick: index,
            durationTicks: 1,
            timeBase: stream.timeBase,
          },
        },
        speed: { numerator: 1, denominator: 1 },
        reverse: false,
        audioPolicy: "preserve-pitch" as const,
      },
      mode: "overwrite" as const,
    })),
  );
  const preview = unwrap(
    measure("seed.preview", () => engine.edits.preview(seedIntent)),
  );
  const committed = unwrap(
    await measureAsync("seed.commit", () =>
      engine.edits.commit(seedIntent, preview.previewHash),
    ),
  );
  assert.equal(committed.sequence.clips.length, clipCount);
  return { stream, sequence: committed.sequence };
}

const root = await mkdtemp(join(tmpdir(), "videobook-edit-benchmark-"));
const startedAt = new Date().toISOString();
const invariants = {
  previewsWithoutMutation: 0,
  deterministicRepeats: 0,
  commitsAdvancedRevision: 0,
  committedTransformsApplied: 0,
};
let engine: Engine | undefined;
let lastRevision = "";
let sequenceId = "";
try {
  engine = createEngine({
    rootDir: root,
    initialBookName: "Edit distribution benchmark",
  });
  const seeded = await seed(engine);
  sequenceId = seeded.sequence.sequenceId;
  console.error(
    `Seeded ${clipCount} clips in ${(measurements.get("seed.commit")![0]! / 1_000).toFixed(2)} s`,
  );
  for (let iteration = 0; iteration < commitCount; iteration++) {
    const current = engine.sequences.getPrimary();
    const batch = batchIntent(current, iteration);
    const before = snapshot(engine, sequenceId);
    const preview = unwrap(
      measure("preview", () => engine!.edits.preview(batch)),
    );
    assert.ok(preview.valid, "Preview against the current head must be valid");
    assert.equal(
      preview.diff.changedClipIds.length,
      operationCount,
      "Every operation must change its clip",
    );
    const afterPreview = snapshot(engine, sequenceId);
    assert.deepEqual(afterPreview, before, "Preview must not mutate storage");
    invariants.previewsWithoutMutation++;
    const repeat = unwrap(
      measure("preview.repeat", () => engine!.edits.preview(batch)),
    );
    assert.equal(
      previewIdentity(repeat),
      previewIdentity(preview),
      "Repeated preview must be identical",
    );
    invariants.deterministicRepeats++;
    const committed = unwrap(
      await measureAsync("commit", () =>
        engine!.edits.commit(batch, preview.previewHash),
      ),
    );
    assert.notEqual(
      committed.revision,
      before.head,
      "Commit must advance the head revision",
    );
    assert.equal(
      engine.history.revisions(1)[0]?.hash,
      committed.revision,
      "Committed revision must be the new head",
    );
    invariants.commitsAdvancedRevision++;
    const expected = new Map(
      batch.operations.map((operation) =>
        operation.kind === "set-clip-transform"
          ? [operation.clipId, operation.transform]
          : ["", undefined],
      ),
    );
    const applied = committed.sequence.clips.filter(
      (clip) =>
        expected.has(clip.clipId) &&
        canonicalContractJson(clip.transform) ===
          canonicalContractJson(expected.get(clip.clipId)),
    );
    assert.equal(
      applied.length,
      operationCount,
      "Committed sequence must carry every transform",
    );
    invariants.committedTransformsApplied += applied.length;
    lastRevision = committed.revision;
    if ((iteration + 1) % 10 === 0 || iteration + 1 === commitCount) {
      console.error(
        `Committed ${iteration + 1}/${commitCount} batches; RSS ${(process.memoryUsage().rss / 2 ** 20).toFixed(0)} MiB`,
      );
    }
  }
  engine.close();
  engine = createEngine({ rootDir: root });
  const reopened = unwrap(engine.sequences.get(sequenceId));
  assert.equal(
    reopened.revision,
    lastRevision,
    "Reopened catalog must expose the last committed revision",
  );
  assert.equal(reopened.clips.length, clipCount);
  const timings = Object.fromEntries(
    [...measurements].map(([name, samples]) => {
      const ordered = [...samples].sort((left, right) => left - right);
      const quantile = (p: number) =>
        ordered[Math.max(0, Math.ceil(p * ordered.length) - 1)]!;
      return [
        name,
        {
          samples: samples.length,
          p50Ms: quantile(0.5),
          p95Ms: quantile(0.95),
          maxMs: ordered.at(-1)!,
          totalMs: samples.reduce((sum, item) => sum + item, 0),
          samplesMs: samples,
        },
      ];
    }),
  );
  const peakRssBytes = process.resourceUsage().maxRSS * 1024;
  const gates = {
    fullScale: clipCount >= 1_000 && operationCount >= 100 && commitCount >= 50,
    previewP95Under250Ms: timings.preview!.p95Ms < 250,
    commitP95Under1Second: timings.commit!.p95Ms < 1_000,
    noStorageMutation: invariants.previewsWithoutMutation === commitCount,
    deterministicPreviews: invariants.deterministicRepeats === commitCount,
    everyCommitAdvancedRevision:
      invariants.commitsAdvancedRevision === commitCount &&
      invariants.committedTransformsApplied === commitCount * operationCount,
  };
  const report = {
    schemaVersion: 1,
    startedAt,
    completedAt: new Date().toISOString(),
    source: {
      commit: execFileSync("git", ["rev-parse", "HEAD"], {
        encoding: "utf8",
      }).trim(),
      dirty: Boolean(
        execFileSync("git", ["status", "--porcelain"], {
          encoding: "utf8",
        }).trim(),
      ),
    },
    purpose:
      "Edit preview/commit latency distributions with mutation and determinism invariants; no derived jobs run",
    environment: {
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      cpu: cpus()[0]?.model,
      logicalCpus: cpus().length,
      totalMemoryBytes: totalmem(),
      freeMemoryBytes: freemem(),
    },
    workload: {
      clips: clipCount,
      operationsPerBatch: operationCount,
      commits: commitCount,
      operationKind: "set-clip-transform",
      batchSelection: "rotating distinct clip window per transaction",
      baseRevision: "current head before each preview",
    },
    mutationProof:
      "head revision, every table row count and the canonical sequence projection are compared before and after each preview",
    determinismProof:
      "the identical intent is previewed twice; canonical operations, ranges, write set, diff and all hashes must match",
    invariants,
    peakRssBytes,
    timings,
    gates,
  };
  const serialized = `${JSON.stringify(report, null, 2)}\n`;
  if (readFlag("--output"))
    await writeFile(resolve(readFlag("--output")!), serialized);
  console.log(serialized);
  if (
    args.includes("--assert") &&
    Object.values(gates).some((passed) => !passed)
  )
    process.exitCode = 1;
} finally {
  engine?.close();
  await rm(root, { recursive: true, force: true, maxRetries: 3 });
}
