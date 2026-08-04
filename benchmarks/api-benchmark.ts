import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { performance } from "node:perf_hooks";

import { v7 as uuidv7 } from "uuid";

import {
  createEngine,
  MVP_CONTRACT_VERSION,
  type Artifact,
  type ArtifactKind,
  type ArtifactStream,
  type ContentStore,
  type EditIntent,
  type Engine,
  type IndexManifest,
  type NotebookCell,
  type Result,
  type SimilarityAudioEmbeddingProvider,
  type SimilarityEmbeddingProvider,
  type SimilarityTextEmbeddingProvider,
  type TemporalIndexObservation,
  type TemporalSearchProvider,
} from "../src/index.js";

export const API_BENCHMARK_GROUPS = [
  "engine",
  "book",
  "artifacts",
  "files",
  "workspaces",
  "metadata",
  "streams",
  "transcripts",
  "sequences",
  "edits",
  "temporalSearch",
  "entities",
  "notebooks",
  "prompts",
  "messages",
  "history",
  "status",
  "storage",
  "logs",
  "settings",
  "jobs",
  "similarity",
] as const;

export type ApiBenchmarkGroup = (typeof API_BENCHMARK_GROUPS)[number];
export type ApiBenchmarkOperationKind =
  | "lifecycle"
  | "read"
  | "runtime"
  | "write";

export interface ApiBenchmarkOptions {
  artifactCount: number;
  momentCount: number;
  readIterations: number;
  retainFixture: boolean;
}

export interface ApiBenchmarkOperation {
  name: string;
  group: ApiBenchmarkGroup;
  kind: ApiBenchmarkOperationKind;
  samples: number;
  totalMs: number;
  meanMs: number;
  minMs: number;
  p50Ms: number;
  p95Ms: number;
  maxMs: number;
  totalShare: number;
  cumulativeShare: number;
}

export interface ApiBenchmarkReport {
  schemaVersion: 1;
  generatedAt: string;
  environment: {
    node: string;
    platform: NodeJS.Platform;
    arch: string;
  };
  workload: ApiBenchmarkOptions;
  durationMs: number;
  measuredMs: number;
  coverage: {
    expectedGroups: readonly ApiBenchmarkGroup[];
    observedGroups: ApiBenchmarkGroup[];
    missingGroups: ApiBenchmarkGroup[];
  };
  pareto: {
    targetShare: 0.8;
    operationCount: number;
    totalOperationCount: number;
    operationShare: number;
    capturedTimeShare: number;
    operations: string[];
  };
  operations: ApiBenchmarkOperation[];
  fixtureRoot?: string;
}

interface RecordedOperation {
  group: ApiBenchmarkGroup;
  kind: ApiBenchmarkOperationKind;
  samplesMs: number[];
}

const DEFAULT_OPTIONS: ApiBenchmarkOptions = {
  artifactCount: 40,
  momentCount: 2_000,
  readIterations: 100,
  retainFixture: false,
};

const QUICK_OPTIONS: ApiBenchmarkOptions = {
  artifactCount: 4,
  momentCount: 20,
  readIterations: 2,
  retainFixture: false,
};

const temporalManifest: IndexManifest = {
  manifestId: "api-benchmark-temporal-v1",
  provider: "api-benchmark",
  modelId: "deterministic-vector",
  modelRevision: "1",
  license: "test-only",
  embeddingSpace: "api-benchmark-3d-v1",
  dimensions: 3,
  modalities: ["visual", "speech", "ocr", "audio", "metadata"],
  supportedLanguages: ["en"],
  preprocessingVersion: "1",
  extractorVersion: "1",
  createdAt: 1,
};

class BenchmarkRecorder {
  private readonly recorded = new Map<string, RecordedOperation>();

  async measure<T>(
    name: `${ApiBenchmarkGroup}.${string}`,
    kind: ApiBenchmarkOperationKind,
    operation: () => T | Promise<T>,
  ): Promise<T> {
    const started = performance.now();
    const value = await operation();
    const elapsed = performance.now() - started;
    const group = name.slice(0, name.indexOf(".")) as ApiBenchmarkGroup;
    const entry = this.recorded.get(name);
    if (entry) {
      if (entry.kind !== kind || entry.group !== group) {
        throw new Error(`Conflicting benchmark metadata for ${name}`);
      }
      entry.samplesMs.push(elapsed);
    } else {
      this.recorded.set(name, { group, kind, samplesMs: [elapsed] });
    }
    return value;
  }

  report(
    options: ApiBenchmarkOptions,
    durationMs: number,
    fixtureRoot?: string,
  ): ApiBenchmarkReport {
    return createApiBenchmarkReport(
      this.recorded,
      options,
      durationMs,
      fixtureRoot,
    );
  }
}

class MemoryContentStore implements ContentStore {
  private readonly objects = new Map<string, Buffer>();

  async head(key: string): Promise<{ exists: boolean; size?: number }> {
    const object = this.objects.get(key);
    return object
      ? { exists: true, size: object.byteLength }
      : { exists: false };
  }

  async uploadFile(key: string, sourcePath: string): Promise<void> {
    this.objects.set(key, await readFile(sourcePath));
  }

  async downloadFile(key: string, destinationPath: string): Promise<void> {
    const object = this.objects.get(key);
    if (!object) throw new Error(`Missing benchmark object: ${key}`);
    await mkdir(path.dirname(destinationPath), { recursive: true });
    await writeFile(destinationPath, object);
  }

  async delete(key: string): Promise<void> {
    this.objects.delete(key);
  }
}

const mediaSimilarityProvider: SimilarityEmbeddingProvider = {
  embeddingSpace: "api-benchmark-media-v1",
  dimensions: 3,
  async prepare() {},
  async embedImage(sourcePath) {
    return vectorFor(await readFile(sourcePath));
  },
  async embedVideo(sourcePath) {
    return {
      vector: vectorFor(await readFile(sourcePath)),
      frameCount: 1,
    };
  },
};

const audioSimilarityProvider: SimilarityAudioEmbeddingProvider = {
  embeddingSpace: "api-benchmark-audio-v1",
  dimensions: 3,
  async prepare() {},
  async embedAudio(sourcePath) {
    return vectorFor(await readFile(sourcePath));
  },
};

const textSimilarityProvider: SimilarityTextEmbeddingProvider = {
  embeddingSpace: "api-benchmark-text-v1",
  dimensions: 3,
  async prepare() {},
  async embedText(text) {
    return [
      {
        startOffset: 0,
        endOffset: text.length,
        vector: vectorFor(Buffer.from(text)),
      },
    ];
  },
};

class BenchmarkTemporalProvider implements TemporalSearchProvider {
  readonly manifestId = temporalManifest.manifestId;

  async prepare(): Promise<void> {}

  async embedText(text: string): Promise<Float32Array> {
    return vectorFor(Buffer.from(text));
  }
}

export function quickApiBenchmarkOptions(): ApiBenchmarkOptions {
  return { ...QUICK_OPTIONS };
}

export async function runFullApiBenchmark(
  input: Partial<ApiBenchmarkOptions> = {},
): Promise<ApiBenchmarkReport> {
  const options = benchmarkOptions(input);
  const fixtureRoot = await mkdtemp(
    path.join(tmpdir(), "videobook-api-benchmark-"),
  );
  const dataDir = path.join(fixtureRoot, "data");
  const workspaceDir = path.join(fixtureRoot, "workspace");
  const remoteObjects = new MemoryContentStore();
  const recorder = new BenchmarkRecorder();
  const benchmarkStarted = performance.now();
  let engine: Engine | undefined;

  try {
    engine = await recorder.measure("engine.create", "lifecycle", () =>
      createEngine({
        dataDir,
        workspaceDir,
        initialBookName: "api-benchmark",
        remoteObjects,
        similarity: {
          provider: mediaSimilarityProvider,
          audio: { provider: audioSimilarityProvider },
          text: { provider: textSimilarityProvider },
        },
      }),
    );
    await recorder.measure("engine.ready", "lifecycle", () => engine!.ready);
    await recorder.measure("engine.initialize", "lifecycle", () =>
      engine!.initialize(),
    );
    await recorder.measure("engine.head", "read", () => engine!.head);

    await exerciseBookApi(engine, recorder);
    const seeded = await seedArtifacts(engine, recorder, options);
    await exerciseArtifactReads(engine, recorder, seeded, options);
    const scratch = await exerciseFilesAndWorkspaces(
      engine,
      recorder,
      fixtureRoot,
      seeded,
    );
    await exerciseMetadata(engine, recorder, seeded);
    const stream = await exerciseStreamsAndTranscripts(
      engine,
      recorder,
      seeded,
    );
    await exerciseSequencesAndEdits(engine, recorder, stream);
    await exerciseTemporalSearch(
      engine,
      recorder,
      stream,
      options.momentCount,
    );
    await exerciseDomainApis(engine, recorder);
    await exerciseCommunicationsAndHistory(engine, recorder, seeded);
    await exerciseStatus(engine, recorder, seeded);
    await exerciseRuntimeApis(engine, recorder, seeded);
    await exerciseSimilarity(engine, recorder, seeded);
    await exerciseStorage(engine, recorder, scratch);
    await exerciseDestructiveHistory(engine, recorder, seeded);

    await recorder.measure("engine.close", "lifecycle", () => engine!.close());
    engine = undefined;
    engine = await recorder.measure("engine.reopen", "lifecycle", () =>
      createEngine({
        dataDir,
        workspaceDir,
        remoteObjects,
        similarity: {
          provider: mediaSimilarityProvider,
          audio: { provider: audioSimilarityProvider },
          text: { provider: textSimilarityProvider },
        },
      }),
    );
    await recorder.measure("engine.reopen-ready", "lifecycle", () =>
      engine!.ready,
    );
    await recorder.measure("engine.reopen-summary", "read", () => ({
      book: engine!.book.get(),
      artifacts: engine!.artifacts.list().length,
      revisions: engine!.history.revisions(5).length,
    }));
  } finally {
    engine?.close();
  }

  const durationMs = performance.now() - benchmarkStarted;
  const report = recorder.report(
    options,
    durationMs,
    options.retainFixture ? fixtureRoot : undefined,
  );
  if (!options.retainFixture) {
    await removeFixture(fixtureRoot);
  }
  if (report.coverage.missingGroups.length > 0) {
    throw new Error(
      `API benchmark missed groups: ${report.coverage.missingGroups.join(", ")}`,
    );
  }
  return report;
}

export function createApiBenchmarkReport(
  recorded: ReadonlyMap<string, RecordedOperation>,
  options: ApiBenchmarkOptions,
  durationMs: number,
  fixtureRoot?: string,
): ApiBenchmarkReport {
  const measuredMs = [...recorded.values()].reduce(
    (total, entry) =>
      total + entry.samplesMs.reduce((sum, sample) => sum + sample, 0),
    0,
  );
  let cumulativeMs = 0;
  const operations = [...recorded.entries()]
    .map(([name, entry]) => {
      const samples = [...entry.samplesMs].sort((left, right) => left - right);
      const totalMs = samples.reduce((sum, sample) => sum + sample, 0);
      return {
        name,
        group: entry.group,
        kind: entry.kind,
        samples: samples.length,
        totalMs,
        meanMs: totalMs / samples.length,
        minMs: samples[0] ?? 0,
        p50Ms: percentile(samples, 0.5),
        p95Ms: percentile(samples, 0.95),
        maxMs: samples.at(-1) ?? 0,
      };
    })
    .sort(
      (left, right) =>
        right.totalMs - left.totalMs || left.name.localeCompare(right.name),
    )
    .map((operation) => {
      cumulativeMs += operation.totalMs;
      return {
        ...operation,
        totalShare: measuredMs === 0 ? 0 : operation.totalMs / measuredMs,
        cumulativeShare: measuredMs === 0 ? 0 : cumulativeMs / measuredMs,
      };
    });
  const paretoOperations: ApiBenchmarkOperation[] = [];
  for (const operation of operations) {
    paretoOperations.push(operation);
    if (operation.cumulativeShare >= 0.8) break;
  }
  const observedGroups = API_BENCHMARK_GROUPS.filter((group) =>
    operations.some((operation) => operation.group === group),
  );
  const missingGroups = API_BENCHMARK_GROUPS.filter(
    (group) => !observedGroups.includes(group),
  );
  const capturedTimeShare =
    paretoOperations.at(-1)?.cumulativeShare ?? 0;

  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    environment: {
      node: process.version,
      platform: process.platform,
      arch: process.arch,
    },
    workload: { ...options },
    durationMs,
    measuredMs,
    coverage: {
      expectedGroups: API_BENCHMARK_GROUPS,
      observedGroups,
      missingGroups,
    },
    pareto: {
      targetShare: 0.8,
      operationCount: paretoOperations.length,
      totalOperationCount: operations.length,
      operationShare:
        operations.length === 0 ? 0 : paretoOperations.length / operations.length,
      capturedTimeShare,
      operations: paretoOperations.map((operation) => operation.name),
    },
    operations,
    ...(fixtureRoot ? { fixtureRoot } : {}),
  };
}

async function exerciseBookApi(
  engine: Engine,
  recorder: BenchmarkRecorder,
): Promise<void> {
  await recorder.measure("book.get", "read", () => engine.book.get());
  value(
    await recorder.measure("book.rename", "write", () =>
      engine.book.rename("api-benchmark-renamed"),
    ),
  );
}

async function seedArtifacts(
  engine: Engine,
  recorder: BenchmarkRecorder,
  options: ApiBenchmarkOptions,
): Promise<{
  artifacts: Artifact[];
  filenames: string[];
  fileRevisions: string[];
}> {
  const artifacts: Artifact[] = [];
  const filenames: string[] = [];
  const fileRevisions: string[] = [];

  for (let index = 0; index < options.artifactCount; index += 1) {
    const kind = artifactKind(index);
    const artifact = value(
      await recorder.measure("artifacts.create", "write", () =>
        engine.artifacts.create({
          kind,
          label: `benchmark ${kind} ${index}`,
        }),
      ),
    );
    const filename = primaryFilename(kind);
    value(
      await recorder.measure("files.write", "write", () =>
        engine.files.write(
          artifact.artifactId,
          filename,
          `${kind} benchmark payload ${index}`,
        ),
      ),
    );
    fileRevisions.push(engine.head);
    value(
      await recorder.measure("metadata.artifacts.write", "write", () =>
        engine.metadata.artifacts.write(artifact.artifactId, "benchmark", {
          index,
          kind,
        }),
      ),
    );
    artifacts.push(artifact);
    filenames.push(filename);
  }
  return { artifacts, filenames, fileRevisions };
}

async function exerciseArtifactReads(
  engine: Engine,
  recorder: BenchmarkRecorder,
  seeded: Awaited<ReturnType<typeof seedArtifacts>>,
  options: ApiBenchmarkOptions,
): Promise<void> {
  for (let index = 0; index < options.readIterations; index += 1) {
    const artifact = seeded.artifacts[index % seeded.artifacts.length]!;
    await recorder.measure("artifacts.list", "read", () =>
      engine.artifacts.list({ sort: index % 2 === 0 ? "newest" : "oldest" }),
    );
    value(
      await recorder.measure("artifacts.get", "read", () =>
        engine.artifacts.get(artifact.artifactId),
      ),
    );
    value(
      await recorder.measure("files.read", "read", () =>
        engine.files.read(
          artifact.artifactId,
          seeded.filenames[index % seeded.filenames.length]!,
        ),
      ),
    );
    value(
      await recorder.measure("files.manifest", "read", () =>
        engine.files.manifest(artifact.artifactId),
      ),
    );
    value(
      await recorder.measure("metadata.artifacts.read", "read", () =>
        engine.metadata.artifacts.read(artifact.artifactId, "benchmark"),
      ),
    );
  }
}

async function exerciseFilesAndWorkspaces(
  engine: Engine,
  recorder: BenchmarkRecorder,
  fixtureRoot: string,
  seeded: Awaited<ReturnType<typeof seedArtifacts>>,
): Promise<{ objectHash: string }> {
  const scratch = value(
    await recorder.measure("artifacts.create", "write", () =>
      engine.artifacts.create({ kind: "script", label: "file operations" }),
    ),
  );
  const sourcePath = path.join(fixtureRoot, "source.txt");
  await writeFile(sourcePath, "source path payload");
  value(
    await recorder.measure("files.writeFromPath", "write", () =>
      engine.files.writeFromPath(scratch.artifactId, "source.txt", sourcePath),
    ),
  );
  const sourceRevision = engine.head;
  await recorder.measure("files.importObject", "write", () =>
    engine.files.importObject(sourcePath),
  );
  value(
    await recorder.measure("files.copy", "write", () =>
      engine.files.copy(
        scratch.artifactId,
        "source.txt",
        scratch.artifactId,
        "copies/source.txt",
      ),
    ),
  );
  value(
    await recorder.measure("files.rename", "write", () =>
      engine.files.rename(
        scratch.artifactId,
        "copies/source.txt",
        "copies/renamed.txt",
      ),
    ),
  );
  value(
    await recorder.measure("files.listSubdir", "read", () =>
      engine.files.listSubdir(scratch.artifactId, "copies"),
    ),
  );
  value(
    await recorder.measure("files.readAtRevision", "read", () =>
      engine.files.readAtRevision(
        scratch.artifactId,
        "source.txt",
        sourceRevision,
      ),
    ),
  );
  const workspace = value(
    await recorder.measure("workspaces.resolveArtifact", "runtime", () =>
      engine.workspaces.resolveArtifact(scratch.artifactId),
    ),
  );
  value(
    await recorder.measure("workspaces.materialize", "runtime", () =>
      engine.workspaces.materialize(scratch.artifactId),
    ),
  );
  await mkdir(path.join(workspace, "generated"), { recursive: true });
  await writeFile(
    path.join(workspace, "generated", "result.txt"),
    "workspace result",
  );
  value(
    await recorder.measure("files.ingestWorkspace", "write", () =>
      engine.files.ingestWorkspace(
        scratch.artifactId,
        ["generated"],
        "benchmark_ingest",
      ),
    ),
  );
  value(
    await recorder.measure("workspaces.evict", "runtime", () =>
      engine.workspaces.evict(scratch.artifactId),
    ),
  );
  value(
    await recorder.measure("files.delete", "write", () =>
      engine.files.delete(scratch.artifactId, "copies/renamed.txt"),
    ),
  );
  const objectHash = value(
    await engine.files.manifest(scratch.artifactId),
  ).files.find((file) => file.name === "source.txt")!.objectHash;

  const renameTarget = seeded.artifacts.at(-1)!;
  const renamed = value(
    await recorder.measure("artifacts.rename", "write", () =>
      engine.artifacts.rename(renameTarget.artifactId, "renamed benchmark"),
    ),
  );
  if (renamed.artifactId !== renameTarget.artifactId) {
    throw new Error("Artifact rename changed identity");
  }
  return { objectHash };
}

async function exerciseMetadata(
  engine: Engine,
  recorder: BenchmarkRecorder,
  seeded: Awaited<ReturnType<typeof seedArtifacts>>,
): Promise<void> {
  const artifact = seeded.artifacts[0]!;
  const metadataRevision = engine.head;
  value(
    await recorder.measure("metadata.artifacts.readAtRevision", "read", () =>
      engine.metadata.artifacts.readAtRevision(
        artifact.artifactId,
        "benchmark",
        metadataRevision,
      ),
    ),
  );
  value(
    await recorder.measure("metadata.book.write", "write", () =>
      engine.metadata.book.write("benchmark", { enabled: true }),
    ),
  );
  value(
    await recorder.measure("metadata.book.read", "read", () =>
      engine.metadata.book.read("benchmark"),
    ),
  );
  value(
    await recorder.measure("metadata.book.delete", "write", () =>
      engine.metadata.book.delete("benchmark"),
    ),
  );
  value(
    await recorder.measure("metadata.waveforms.write", "write", () =>
      engine.metadata.waveforms.write(
        seeded.artifacts[1]!.artifactId,
        Array.from({ length: 512 }, (_, index) => Math.sin(index / 10)),
      ),
    ),
  );
  value(
    await recorder.measure("metadata.waveforms.read", "read", () =>
      engine.metadata.waveforms.read(seeded.artifacts[1]!.artifactId),
    ),
  );
  value(
    await recorder.measure("metadata.waveforms.delete", "write", () =>
      engine.metadata.waveforms.delete(seeded.artifacts[1]!.artifactId),
    ),
  );
  value(
    await recorder.measure("metadata.artifacts.delete", "write", () =>
      engine.metadata.artifacts.delete(artifact.artifactId, "benchmark"),
    ),
  );
}

async function exerciseStreamsAndTranscripts(
  engine: Engine,
  recorder: BenchmarkRecorder,
  seeded: Awaited<ReturnType<typeof seedArtifacts>>,
): Promise<ArtifactStream> {
  const artifact = seeded.artifacts[0]!;
  const objectHash = value(
    await engine.files.manifest(artifact.artifactId),
  ).files[0]!.objectHash;
  const stream = value(
    await recorder.measure("streams.register", "write", () =>
      engine.streams.register({
        artifactId: artifact.artifactId,
        sourcePath: seeded.filenames[0]!,
        objectHash,
        streamIndex: 0,
        kind: "video",
        timeBase: { numerator: 1, denominator: 1_000 },
        durationTicks: 60_000,
        codec: "h264",
        video: {
          width: 1920,
          height: 1080,
          rotationDegrees: 0,
          pixelAspect: { numerator: 1, denominator: 1 },
          nominalFrameRate: { numerator: 30, denominator: 1 },
        },
      }),
    ),
  );
  const streamRevision = engine.head;
  value(
    await recorder.measure("streams.get", "read", () =>
      engine.streams.get(stream.streamId),
    ),
  );
  value(
    await recorder.measure("streams.getAtRevision", "read", () =>
      engine.streams.getAtRevision(stream.streamId, streamRevision),
    ),
  );
  value(
    await recorder.measure("streams.list", "read", () =>
      engine.streams.list(artifact.artifactId),
    ),
  );

  const transcript = value(
    await recorder.measure("transcripts.import", "write", () =>
      engine.transcripts.import({
        artifactId: artifact.artifactId,
        streamId: stream.streamId,
        objectHash,
        language: "en",
        provider: "api-benchmark",
        segments: [
          {
            ordinal: 0,
            range: {
              streamId: stream.streamId,
              objectHash,
              startTick: 1_000,
              durationTicks: 2_000,
              timeBase: stream.timeBase,
            },
            text: "Benchmark transcript segment",
            kind: "speech",
            words: [
              {
                ordinal: 0,
                startTick: 1_000,
                durationTicks: 500,
                text: "Benchmark",
                corrected: false,
              },
              {
                ordinal: 1,
                startTick: 1_500,
                durationTicks: 500,
                text: "segment",
                corrected: false,
              },
            ],
          },
        ],
      }),
    ),
  );
  value(
    await recorder.measure("transcripts.get", "read", () =>
      engine.transcripts.get(transcript.transcriptId),
    ),
  );
  value(
    await recorder.measure("transcripts.getAtRevision", "read", () =>
      engine.transcripts.getAtRevision(
        transcript.transcriptId,
        transcript.revision,
      ),
    ),
  );
  value(
    await recorder.measure("transcripts.list", "read", () =>
      engine.transcripts.list(artifact.artifactId),
    ),
  );
  const words = transcript.segments[0]!.words;
  value(
    await recorder.measure("transcripts.selectionRange", "read", () =>
      engine.transcripts.selectionRange(
        transcript.transcriptId,
        words[0]!.wordId,
        words[1]!.wordId,
      ),
    ),
  );
  const revised = value(
    await recorder.measure("transcripts.revise", "write", () =>
      engine.transcripts.revise({
        sourceTranscriptId: transcript.transcriptId,
        segments: transcript.segments.map((segment) => ({
          ordinal: segment.ordinal,
          range: segment.range,
          text: `${segment.text} revised`,
          kind: segment.kind,
          words: segment.words.map((word) => ({
            ordinal: word.ordinal,
            startTick: word.startTick,
            durationTicks: word.durationTicks,
            text: word.text,
            corrected: word.corrected,
          })),
        })),
      }),
    ),
  );
  value(
    await recorder.measure("transcripts.delete", "write", () =>
      engine.transcripts.delete(revised.transcriptId),
    ),
  );
  return stream;
}

async function exerciseSequencesAndEdits(
  engine: Engine,
  recorder: BenchmarkRecorder,
  stream: ArtifactStream,
): Promise<void> {
  await recorder.measure("sequences.list", "read", () =>
    engine.sequences.list(),
  );
  const primary = await recorder.measure("sequences.getPrimary", "read", () =>
    engine.sequences.getPrimary(),
  );
  value(
    await recorder.measure("sequences.get", "read", () =>
      engine.sequences.get(primary.sequenceId),
    ),
  );
  value(
    await recorder.measure("sequences.getAtRevision", "read", () =>
      engine.sequences.getAtRevision(primary.sequenceId, primary.revision),
    ),
  );
  const scratch = value(
    await recorder.measure("sequences.create", "write", () =>
      engine.sequences.create({
        name: "Benchmark selects",
        width: 1920,
        height: 1080,
        frameRate: { numerator: 30, denominator: 1 },
      }),
    ),
  );
  value(
    await recorder.measure("sequences.rename", "write", () =>
      engine.sequences.rename(scratch.sequenceId, "Benchmark rough cut"),
    ),
  );
  value(
    await recorder.measure("sequences.updateCanvas", "write", () =>
      engine.sequences.updateCanvas(scratch.sequenceId, {
        width: 1080,
        height: 1920,
      }),
    ),
  );
  const withTrack = value(
    await recorder.measure("sequences.addTrack", "write", () =>
      engine.sequences.addTrack(scratch.sequenceId, {
        kind: "video",
        name: "Benchmark overlay",
      }),
    ),
  );
  const addedTrack = withTrack.tracks.at(-1)!;
  value(
    await recorder.measure("sequences.updateTrack", "write", () =>
      engine.sequences.updateTrack(addedTrack.trackId, {
        name: "Benchmark overlay renamed",
      }),
    ),
  );
  value(
    await recorder.measure("sequences.moveTrack", "write", () =>
      engine.sequences.moveTrack(addedTrack.trackId, 0),
    ),
  );
  value(
    await recorder.measure("sequences.removeTrack", "write", () =>
      engine.sequences.removeTrack(addedTrack.trackId),
    ),
  );
  value(
    await recorder.measure("sequences.delete", "write", () =>
      engine.sequences.delete(scratch.sequenceId),
    ),
  );

  const current = engine.sequences.getPrimary();
  const videoTrack = current.tracks.find((track) => track.kind === "video");
  if (!videoTrack) throw new Error("Primary video track is missing");
  const insertIntent: EditIntent = {
    intentVersion: MVP_CONTRACT_VERSION,
    commandId: "api-benchmark-insert",
    sequenceId: current.sequenceId,
    baseRevision: current.revision,
    actor: "api-benchmark",
    sourceSurface: "system",
    confirmationPolicy: "risk-based",
    operations: [
      {
        kind: "insert-clip",
        clipId: uuidv7(),
        placement: {
          trackId: videoTrack.trackId,
          timelineStartFrame: 0,
          durationFrames: 30,
          source: {
            kind: "timed",
            artifactId: stream.artifactId,
            range: {
              streamId: stream.streamId,
              objectHash: stream.objectHash,
              startTick: 0,
              durationTicks: 1_000,
              timeBase: stream.timeBase,
            },
          },
          speed: { numerator: 1, denominator: 1 },
          reverse: false,
          audioPolicy: "preserve-pitch",
        },
        mode: "overwrite",
      },
    ],
  };
  const preview = value(
    await recorder.measure("edits.preview", "read", () =>
      engine.edits.preview(insertIntent),
    ),
  );
  const commit = value(
    await recorder.measure("edits.commit", "write", () =>
      engine.edits.commit(insertIntent, preview.previewHash),
    ),
  );
  value(
    await recorder.measure("edits.get", "read", () =>
      engine.edits.get(commit.actionId),
    ),
  );
  value(
    await recorder.measure("edits.restore", "write", () =>
      engine.edits.restore({
        targetActionId: commit.actionId,
        actor: "api-benchmark",
        sourceSurface: "system",
        baseRevision: engine.head,
      }),
    ),
  );
}

async function exerciseTemporalSearch(
  engine: Engine,
  recorder: BenchmarkRecorder,
  stream: ArtifactStream,
  momentCount: number,
): Promise<void> {
  await recorder.measure("temporalSearch.providers.register", "runtime", () =>
    engine.temporalSearch.providers.register(new BenchmarkTemporalProvider()),
  );
  await recorder.measure("temporalSearch.providers.list", "read", () =>
    engine.temporalSearch.providers.list(),
  );
  value(
    await recorder.measure("temporalSearch.manifests.register", "runtime", () =>
      engine.temporalSearch.manifests.register(temporalManifest),
    ),
  );
  await recorder.measure("temporalSearch.manifests.list", "read", () =>
    engine.temporalSearch.manifests.list(),
  );
  value(
    await recorder.measure("temporalSearch.manifests.get", "read", () =>
      engine.temporalSearch.manifests.get(temporalManifest.manifestId),
    ),
  );
  value(
    await recorder.measure("temporalSearch.plan", "read", () =>
      engine.temporalSearch.plan(
        stream.artifactId,
        stream.objectHash,
        temporalManifest.manifestId,
        "api-benchmark-generation",
      ),
    ),
  );

  const observations = Array.from(
    { length: momentCount },
    (_, index): TemporalIndexObservation => {
      const startTick = index % 59_999;
      return {
        artifactId: stream.artifactId,
        objectHash: stream.objectHash,
        streamId: stream.streamId,
        range: {
          streamId: stream.streamId,
          objectHash: stream.objectHash,
          startTick,
          durationTicks: 1,
          timeBase: stream.timeBase,
        },
        kind: "shot",
        representativeTick: startTick,
        segmentationVersion: "api-benchmark-1",
        texts: [
          {
            kind: "description",
            language: "en",
            text: `benchmark moment ${index}`,
          },
        ],
        embeddings: [
          {
            modality: "visual",
            embeddingSpace: temporalManifest.embeddingSpace,
            vector: [
              (index % 3) / 2,
              ((index + 1) % 3) / 2,
              ((index + 2) % 3) / 2,
            ],
            sourceHash: `${stream.objectHash}:${index}`,
          },
        ],
        fingerprints: [
          {
            kind: "perceptual",
            value: `benchmark-${index}`,
            extractorVersion: "1",
          },
        ],
      };
    },
  );
  value(
    await recorder.measure("temporalSearch.commitBatch", "runtime", () =>
      engine.temporalSearch.commitBatch({
        artifactId: stream.artifactId,
        objectHash: stream.objectHash,
        manifestId: temporalManifest.manifestId,
        generation: "api-benchmark-generation",
        phase: "visual",
        maxUnits: momentCount,
        observations,
        coveredRanges: [
          {
            streamId: stream.streamId,
            objectHash: stream.objectHash,
            startTick: 0,
            durationTicks: 60_000,
            timeBase: stream.timeBase,
          },
        ],
        totalUnits: momentCount,
        complete: true,
      }),
    ),
  );
  value(
    await recorder.measure("temporalSearch.activate", "runtime", () =>
      engine.temporalSearch.activate(
        temporalManifest.manifestId,
        "api-benchmark-generation",
      ),
    ),
  );
  value(
    await recorder.measure("temporalSearch.coverage", "read", () =>
      engine.temporalSearch.coverage(stream.artifactId),
    ),
  );
  value(
    await recorder.measure("temporalSearch.query", "read", () =>
      engine.temporalSearch.query({
        text: "benchmark moment",
        sourceArtifactIds: [stream.artifactId],
        limit: 20,
      }),
    ),
  );
  value(
    await recorder.measure("temporalSearch.queryPrepared", "read", () =>
      engine.temporalSearch.queryPrepared(
        {
          sourceArtifactIds: [stream.artifactId],
          modalities: ["visual"],
          limit: 20,
        },
        {
          kind: "image",
          embeddingSpace: temporalManifest.embeddingSpace,
          vector: [1, 0, 0],
        },
      ),
    ),
  );
  await recorder.measure("temporalSearch.stats", "read", () =>
    engine.temporalSearch.stats(),
  );
  value(
    await recorder.measure("temporalSearch.invalidate", "runtime", () =>
      engine.temporalSearch.invalidate(stream.artifactId, stream.objectHash),
    ),
  );
  value(
    await recorder.measure("temporalSearch.cleanup", "runtime", () =>
      engine.temporalSearch.cleanup(),
    ),
  );
}

async function exerciseDomainApis(
  engine: Engine,
  recorder: BenchmarkRecorder,
): Promise<void> {
  const entity = value(
    await recorder.measure("entities.create", "write", () =>
      engine.entities.create("character", "Benchmark character", {
        description: "Created by the API benchmark",
      }),
    ),
  );
  await recorder.measure("entities.list", "read", () =>
    engine.entities.list("character"),
  );
  value(
    await recorder.measure("entities.read", "read", () =>
      engine.entities.read(entity.id),
    ),
  );
  value(
    await recorder.measure("entities.write", "write", () =>
      engine.entities.write({
        ...entity,
        description: "Updated by the API benchmark",
      }),
    ),
  );

  const notebook = value(
    await recorder.measure("notebooks.create", "write", () =>
      engine.notebooks.create("Benchmark notebook"),
    ),
  );
  const firstCell = await recorder.measure(
    "notebooks.createCell",
    "runtime",
    () =>
      engine.notebooks.createCell({
        type: "prompt",
        label: "prompt-benchmark",
        slot: { row: 0, column: 0 },
        prompt: "Benchmark prompt",
      }),
  );
  const secondCell = engine.notebooks.createCell({
    type: "image",
    label: "img-benchmark",
    slot: { row: 0, column: 1 },
  });
  await recorder.measure("notebooks.createEdge", "runtime", () =>
    engine.notebooks.createEdge({
      source: firstCell.id,
      target: secondCell.id,
      targetInput: "source",
    }),
  );
  value(
    await recorder.measure("notebooks.insertCell", "write", () =>
      engine.notebooks.insertCell(notebook.id, firstCell),
    ),
  );
  value(
    await recorder.measure("notebooks.updateCell", "write", () =>
      engine.notebooks.updateCell(notebook.id, {
        ...firstCell,
        prompt: "Updated benchmark prompt",
      }),
    ),
  );
  value(
    await recorder.measure("notebooks.moveCell", "write", () =>
      engine.notebooks.moveCell(notebook.id, firstCell.id, {
        row: 1,
        column: 0,
      }),
    ),
  );
  await recorder.measure("notebooks.list", "read", () =>
    engine.notebooks.list(),
  );
  const readNotebook = value(
    await recorder.measure("notebooks.read", "read", () =>
      engine.notebooks.read(notebook.id),
    ),
  );
  value(
    await recorder.measure("notebooks.write", "write", () =>
      engine.notebooks.write({
        ...readNotebook,
        description: "Full-document benchmark update",
      }),
    ),
  );
  value(
    await recorder.measure("notebooks.recordRun", "write", () =>
      engine.notebooks.recordRun({
        id: uuidv7(),
        notebookId: notebook.id,
        status: "completed",
        startedAt: new Date(0).toISOString(),
        completedAt: new Date(1).toISOString(),
        cellOrder: [firstCell.id],
        outputs: {},
      }),
    ),
  );
  value(
    await recorder.measure("notebooks.removeCell", "write", () =>
      engine.notebooks.removeCell(notebook.id, firstCell.id),
    ),
  );
  value(
    await recorder.measure("notebooks.delete", "write", () =>
      engine.notebooks.delete(notebook.id),
    ),
  );
  value(
    await recorder.measure("entities.delete", "write", () =>
      engine.entities.delete(entity.id),
    ),
  );
}

async function exerciseCommunicationsAndHistory(
  engine: Engine,
  recorder: BenchmarkRecorder,
  seeded: Awaited<ReturnType<typeof seedArtifacts>>,
): Promise<void> {
  value(
    await recorder.measure("prompts.record", "write", () =>
      engine.prompts.record({
        surface: "api-benchmark",
        prompt: "Measure the public API",
        context: { artifactCount: seeded.artifacts.length },
      }),
    ),
  );
  value(
    await recorder.measure("prompts.list", "read", () =>
      engine.prompts.list({ surface: "api-benchmark", limit: 10 }),
    ),
  );
  value(
    await recorder.measure("prompts.count", "read", () =>
      engine.prompts.count({ surface: "api-benchmark" }),
    ),
  );
  value(
    await recorder.measure("messages.append", "write", () =>
      engine.messages.append({
        role: "user",
        body: { text: "Benchmark message" },
      }),
    ),
  );
  value(
    await recorder.measure("messages.list", "read", () =>
      engine.messages.list({ role: "user", limit: 10 }),
    ),
  );
  const revisions = await recorder.measure("history.revisions", "read", () =>
    engine.history.revisions(100),
  );
  await recorder.measure("history.artifact", "read", () =>
    engine.history.artifact(seeded.artifacts[0]!.artifactId, 100),
  );
  await recorder.measure("history.resolveRevision", "read", () =>
    engine.history.resolveRevision(revisions[0]!.hash),
  );
  value(
    await recorder.measure("history.recordOperation", "write", () =>
      engine.history.recordOperation(
        "api_benchmark_checkpoint",
        seeded.artifacts[0]!.artifactId,
        { measured: true },
      ),
    ),
  );
  value(
    await recorder.measure("history.logAction", "write", () =>
      engine.history.logAction("api-benchmark", { measured: true }),
    ),
  );
  await recorder.measure("history.actionLog", "read", () =>
    engine.history.actionLog({ action: "api-benchmark", limit: 10 }),
  );
}

async function exerciseStatus(
  engine: Engine,
  recorder: BenchmarkRecorder,
  seeded: Awaited<ReturnType<typeof seedArtifacts>>,
): Promise<void> {
  value(
    await recorder.measure("status.get", "read", () =>
      engine.status.get(seeded.artifacts[0]!.artifactId),
    ),
  );
  await recorder.measure("status.compute", "read", () =>
    engine.status.compute({
      kind: seeded.artifacts[0]!.kind,
      fileNames: new Set([seeded.filenames[0]!]),
      primaryMediaName: seeded.filenames[0]!,
      hasOriginalMetadata: true,
      hasPartFile: false,
      lockData: null,
      pendingTask: null,
      generationError: null,
      artifactRow: null,
    }),
  );
}

async function exerciseRuntimeApis(
  engine: Engine,
  recorder: BenchmarkRecorder,
  seeded: Awaited<ReturnType<typeof seedArtifacts>>,
): Promise<void> {
  value(
    await recorder.measure("logs.append", "runtime", () =>
      engine.logs.append("api-benchmark", { event: "sample" }),
    ),
  );
  await recorder.measure("logs.read", "read", () =>
    engine.logs.read("api-benchmark", { limit: 10 }),
  );
  value(
    await recorder.measure("settings.set", "runtime", () =>
      engine.settings.set("api-benchmark", { enabled: true }),
    ),
  );
  await recorder.measure("settings.get", "read", () =>
    engine.settings.get("api-benchmark"),
  );
  value(
    await recorder.measure("settings.delete", "runtime", () =>
      engine.settings.delete("api-benchmark"),
    ),
  );

  const enqueued = await recorder.measure("jobs.queue.enqueue", "runtime", () =>
    engine.jobs.queue.enqueue({
      type: "api-benchmark",
      externalTaskId: "api-benchmark-external",
      payload: { measured: true },
    }),
  );
  await recorder.measure("jobs.queue.get", "read", () =>
    engine.jobs.queue.get(enqueued.job.id),
  );
  await recorder.measure("jobs.queue.findByExternal", "read", () =>
    engine.jobs.queue.findByExternal(
      "api-benchmark",
      "api-benchmark-external",
    ),
  );
  await recorder.measure("jobs.queue.list", "read", () =>
    engine.jobs.queue.list({ type: "api-benchmark" }),
  );
  await recorder.measure("jobs.queue.count", "read", () =>
    engine.jobs.queue.count({ type: "api-benchmark" }),
  );
  const dequeued = await recorder.measure("jobs.queue.dequeue", "runtime", () =>
    engine.jobs.queue.dequeue(process.pid, 30_000),
  );
  if (!dequeued) throw new Error("Benchmark job did not dequeue");
  await recorder.measure("jobs.queue.heartbeat", "runtime", () =>
    engine.jobs.queue.heartbeat(dequeued.id, dequeued.fence, 30_000),
  );
  await recorder.measure("jobs.queue.complete", "runtime", () =>
    engine.jobs.queue.complete(
      dequeued.id,
      { result: { measured: true } },
      dequeued.fence,
    ),
  );

  const work = await recorder.measure(
    "jobs.artifactWork.begin",
    "runtime",
    () =>
      engine.jobs.artifactWork.begin(seeded.artifacts[0]!.artifactId, {
        kind: "analyze",
        ownerKind: "job",
        durationMs: 30_000,
      }),
  );
  if (!work) throw new Error("Benchmark artifact work did not start");
  await recorder.measure("jobs.artifactWork.renew", "runtime", () =>
    engine.jobs.artifactWork.renew(
      seeded.artifacts[0]!.artifactId,
      work.ownerId,
      30_000,
    ),
  );
  value(
    await recorder.measure("jobs.artifactWork.read", "read", () =>
      engine.jobs.artifactWork.read(seeded.artifacts[0]!.artifactId),
    ),
  );
  value(
    await recorder.measure("jobs.artifactWork.list", "read", () =>
      engine.jobs.artifactWork.list(),
    ),
  );
  await recorder.measure("jobs.artifactWork.markSeen", "runtime", () =>
    engine.jobs.artifactWork.markSeen(seeded.artifacts[0]!.artifactId),
  );
  await recorder.measure("jobs.artifactWork.complete", "runtime", () =>
    engine.jobs.artifactWork.complete(
      seeded.artifacts[0]!.artifactId,
      work.ownerId,
    ),
  );

  const pendingWork = engine.jobs.artifactWork.begin(
    seeded.artifacts[1]!.artifactId,
    {
      kind: "generate",
      ownerKind: "provider",
      durationMs: 30_000,
    },
  );
  if (!pendingWork) throw new Error("Benchmark pending work did not start");
  value(
    await recorder.measure("jobs.pending.write", "runtime", () =>
      engine.jobs.pending.write(
        {
          artifactId: seeded.artifacts[1]!.artifactId,
          taskId: "api-benchmark-task",
          taskType: "generate",
          meta: { measured: true },
        },
        pendingWork.ownerId,
      ),
    ),
  );
  value(
    await recorder.measure("jobs.pending.read", "read", () =>
      engine.jobs.pending.read(seeded.artifacts[1]!.artifactId),
    ),
  );
  value(
    await recorder.measure("jobs.pending.findAll", "read", () =>
      engine.jobs.pending.findAll(),
    ),
  );
  value(
    await recorder.measure("jobs.pending.findByExternalId", "read", () =>
      engine.jobs.pending.findByExternalId("api-benchmark-task"),
    ),
  );
  await recorder.measure("jobs.pending.getOwner", "read", () =>
    engine.jobs.pending.getOwner(
      seeded.artifacts[1]!.artifactId,
      "api-benchmark-task",
    ),
  );
  value(
    await recorder.measure("jobs.pending.markCompleting", "runtime", () =>
      engine.jobs.pending.markCompleting(seeded.artifacts[1]!.artifactId),
    ),
  );
  value(
    await recorder.measure("jobs.pending.clearCompleting", "runtime", () =>
      engine.jobs.pending.clearCompleting(seeded.artifacts[1]!.artifactId),
    ),
  );
  value(
    await recorder.measure("jobs.pending.delete", "runtime", () =>
      engine.jobs.pending.delete(
        seeded.artifacts[1]!.artifactId,
        "api-benchmark-task",
      ),
    ),
  );
  engine.jobs.artifactWork.complete(
    seeded.artifacts[1]!.artifactId,
    pendingWork.ownerId,
  );

  value(
    await recorder.measure("jobs.failures.write", "write", () =>
      engine.jobs.failures.write(seeded.artifacts[2]!.artifactId, {
        message: "Benchmark failure",
        failCode: "BENCHMARK",
      }),
    ),
  );
  value(
    await recorder.measure("jobs.failures.read", "read", () =>
      engine.jobs.failures.read(seeded.artifacts[2]!.artifactId),
    ),
  );
  value(
    await recorder.measure("jobs.failures.findAll", "read", () =>
      engine.jobs.failures.findAll(),
    ),
  );
  value(
    await recorder.measure("jobs.failures.clear", "write", () =>
      engine.jobs.failures.clear(seeded.artifacts[2]!.artifactId),
    ),
  );

  const lock = value(
    await recorder.measure("jobs.locks.acquire", "runtime", () =>
      engine.jobs.locks.acquire("api-benchmark-resource", {
        durationMs: 30_000,
        state: "benchmarking",
      }),
    ),
  );
  await recorder.measure("jobs.locks.isLocked", "read", () =>
    engine.jobs.locks.isLocked("api-benchmark-resource"),
  );
  await recorder.measure("jobs.locks.get", "read", () =>
    engine.jobs.locks.get("api-benchmark-resource"),
  );
  value(
    await recorder.measure("jobs.locks.release", "runtime", () =>
      engine.jobs.locks.release("api-benchmark-resource", lock.ownerId),
    ),
  );
  await recorder.measure("jobs.locks.cleanStale", "runtime", () =>
    engine.jobs.locks.cleanStale("api-benchmark-resource"),
  );
  value(
    await recorder.measure("jobs.recoverArtifact", "runtime", () =>
      engine.jobs.recoverArtifact(seeded.artifacts[0]!.artifactId),
    ),
  );
  value(
    await recorder.measure("jobs.recoverAll", "runtime", () =>
      engine.jobs.recoverAll(),
    ),
  );
  await recorder.measure("jobs.checkSchema", "read", () =>
    engine.jobs.checkSchema(),
  );
  const reaper = await recorder.measure("jobs.startReaper", "runtime", () =>
    engine.jobs.startReaper({ intervalMs: 60_000 }),
  );
  reaper.stop();
}

async function exerciseSimilarity(
  engine: Engine,
  recorder: BenchmarkRecorder,
  seeded: Awaited<ReturnType<typeof seedArtifacts>>,
): Promise<void> {
  value(
    await recorder.measure("similarity.prepare", "runtime", () =>
      engine.similarity.prepare(),
    ),
  );
  const indexable = seeded.artifacts.slice(0, Math.min(8, seeded.artifacts.length));
  for (const artifact of indexable) {
    value(
      await recorder.measure("similarity.index", "runtime", () =>
        engine.similarity.index(artifact.artifactId),
      ),
    );
  }
  value(
    await recorder.measure("similarity.status", "read", () =>
      engine.similarity.status(indexable[0]!.artifactId),
    ),
  );
  value(
    await recorder.measure("similarity.stats", "read", () =>
      engine.similarity.stats(),
    ),
  );
  value(
    await recorder.measure("similarity.findSimilar", "read", () =>
      engine.similarity.findSimilar(indexable[0]!.artifactId, {
        includeSelf: true,
        limit: 10,
      }),
    ),
  );
  value(
    await recorder.measure("similarity.findSimilarText", "read", () =>
      engine.similarity.findSimilarText("benchmark payload", { limit: 10 }),
    ),
  );
  value(
    await recorder.measure("similarity.rebuild", "runtime", () =>
      engine.similarity.rebuild(),
    ),
  );
}

async function exerciseStorage(
  engine: Engine,
  recorder: BenchmarkRecorder,
  scratch: { objectHash: string },
): Promise<void> {
  await recorder.measure("storage.status", "read", () =>
    engine.storage.status(),
  );
  value(
    await recorder.measure("storage.backup", "runtime", () =>
      engine.storage.backup(),
    ),
  );
  value(
    await recorder.measure("storage.gc", "runtime", () =>
      engine.storage.gc({ dryRun: true }),
    ),
  );

  const scratchArtifact = value(
    await engine.artifacts.create({ kind: "script", label: "object deletion" }),
  );
  value(
    await engine.files.write(
      scratchArtifact.artifactId,
      "original.txt",
      "object deletion payload",
    ),
  );
  const objectHash = value(
    await engine.files.manifest(scratchArtifact.artifactId),
  ).files[0]!.objectHash;
  value(
    await recorder.measure("artifacts.delete", "write", () =>
      engine.artifacts.delete(scratchArtifact.artifactId),
    ),
  );
  value(
    await recorder.measure("storage.deleteObject", "write", () =>
      engine.storage.deleteObject(objectHash),
    ),
  );
  if (scratch.objectHash.length !== 64) {
    throw new Error("Scratch object hash is invalid");
  }
}

async function exerciseDestructiveHistory(
  engine: Engine,
  recorder: BenchmarkRecorder,
  seeded: Awaited<ReturnType<typeof seedArtifacts>>,
): Promise<void> {
  value(
    await recorder.measure("history.restoreArtifact", "write", () =>
      engine.history.restoreArtifact(
        seeded.artifacts[2]!.artifactId,
        seeded.fileRevisions[2]!,
      ),
    ),
  );
  const target = engine.history.revisions(3).at(-1);
  if (!target) throw new Error("Benchmark restore target is missing");
  value(
    await recorder.measure("history.restore", "write", () =>
      engine.history.restore(target.hash),
    ),
  );
}

function benchmarkOptions(
  input: Partial<ApiBenchmarkOptions>,
): ApiBenchmarkOptions {
  const options = { ...DEFAULT_OPTIONS, ...input };
  for (const key of [
    "artifactCount",
    "momentCount",
    "readIterations",
  ] as const) {
    if (!Number.isSafeInteger(options[key]) || options[key] < 1) {
      throw new Error(`${key} must be a positive safe integer`);
    }
  }
  if (options.artifactCount < 4) {
    throw new Error("artifactCount must be at least 4");
  }
  return options;
}

function artifactKind(index: number): ArtifactKind {
  if (index === 0) return "video";
  if (index === 1) return "audio";
  if (index === 2) return "script";
  return index % 3 === 0 ? "script" : "image";
}

function primaryFilename(kind: ArtifactKind): string {
  if (kind === "video") return "original.mp4";
  if (kind === "audio") return "original.wav";
  if (kind === "image") return "original.jpg";
  return "original.md";
}

function vectorFor(data: Buffer): Float32Array {
  let first = 1;
  let second = 1;
  let third = 1;
  for (let index = 0; index < data.length; index += 1) {
    const value = data[index]!;
    if (index % 3 === 0) first += value;
    else if (index % 3 === 1) second += value;
    else third += value;
  }
  const magnitude = Math.hypot(first, second, third);
  return Float32Array.from([
    first / magnitude,
    second / magnitude,
    third / magnitude,
  ]);
}

function value<T, E extends { message: string }>(result: Result<T, E>): T {
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

function percentile(sortedValues: readonly number[], quantile: number): number {
  if (sortedValues.length === 0) return 0;
  const index = Math.min(
    sortedValues.length - 1,
    Math.max(0, Math.ceil(sortedValues.length * quantile) - 1),
  );
  return sortedValues[index]!;
}

async function removeFixture(root: string): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      await rm(root, { recursive: true, force: true, maxRetries: 1 });
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  throw lastError;
}
