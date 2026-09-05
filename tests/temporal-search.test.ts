import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  createEngine,
  compareSearchBenchmarks,
  evaluateSearchBenchmark,
  type Artifact,
  type ArtifactStream,
  type Engine,
  type IndexManifest,
  type TemporalIndexObservation,
  type TemporalSearchProvider,
} from "../src/index.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map(removeRoot));
});

async function removeRoot(root: string): Promise<void> {
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

function value<T>(
  result:
    | { ok: true; value: T }
    | { ok: false; error: { message: string } },
): T {
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

const manifest: IndexManifest = {
  manifestId: "local-multimodal-v1",
  provider: "fixture-local",
  modelId: "fixture-cross-modal",
  modelRevision: "1",
  license: "test",
  embeddingSpace: "fixture-visual-audio-v1",
  dimensions: 3,
  modalities: ["visual", "speech", "ocr", "audio", "metadata"],
  supportedLanguages: ["en"],
  preprocessingVersion: "1",
  extractorVersion: "1",
  createdAt: 1,
};

class QueryProvider implements TemporalSearchProvider {
  readonly manifestId = manifest.manifestId;

  async prepare(): Promise<void> {}

  async embedText(text: string): Promise<Float32Array> {
    const normalized = text.toLocaleLowerCase();
    if (normalized.includes("purr") || normalized.includes("cat")) {
      return Float32Array.from([0, 1, 0]);
    }
    if (normalized.includes("thunder") || normalized.includes("audio")) {
      return Float32Array.from([0, 0, 1]);
    }
    return Float32Array.from([1, 0, 0]);
  }
}

async function setup(): Promise<Engine> {
  const root = await mkdtemp(path.join(tmpdir(), "videobook-temporal-"));
  roots.push(root);
  const engine = createEngine({
    dataDir: path.join(root, "data"),
    workspaceDir: path.join(root, "workspace"),
    initialBookName: "temporal-search",
  });
  value(engine.temporalSearch.manifests.register(manifest));
  engine.temporalSearch.providers.register(new QueryProvider());
  return engine;
}

async function media(
  engine: Engine,
  kind: "video" | "audio",
  label: string,
): Promise<{ artifact: Artifact; stream: ArtifactStream }> {
  const artifact = value(await engine.artifacts.create({ kind, label }));
  const extension = kind === "video" ? "mp4" : "wav";
  const sourcePath = `original.${extension}`;
  value(await engine.files.write(artifact.artifactId, sourcePath, label));
  const objectHash = value(await engine.files.manifest(artifact.artifactId))
    .files[0]?.objectHash;
  if (!objectHash) throw new Error("Object hash is missing");
  const stream = value(
    await engine.streams.register({
      artifactId: artifact.artifactId,
      sourcePath,
      objectHash,
      streamIndex: 0,
      kind,
      timeBase:
        kind === "video"
          ? { numerator: 1, denominator: 1_000 }
          : { numerator: 1, denominator: 48_000 },
      durationTicks: kind === "video" ? 30_000 : 480_000,
      codec: kind === "video" ? "h264" : "pcm",
      ...(kind === "video"
        ? {
            video: {
              width: 1920,
              height: 1080,
              rotationDegrees: 0,
              pixelAspect: { numerator: 1, denominator: 1 },
            },
          }
        : {
            audio: {
              sampleRateHz: 48_000,
              channels: 2,
              channelLayout: "stereo",
            },
          }),
    }),
  );
  return { artifact, stream };
}

async function still(
  engine: Engine,
  label: string,
): Promise<{ artifact: Artifact; objectHash: string }> {
  const artifact = value(
    await engine.artifacts.create({ kind: "image", label }),
  );
  value(await engine.files.write(artifact.artifactId, "original.jpg", label));
  const objectHash = value(await engine.files.manifest(artifact.artifactId))
    .files[0]?.objectHash;
  if (!objectHash) throw new Error("Object hash is missing");
  return { artifact, objectHash };
}

function timedObservation(
  artifact: Artifact,
  stream: ArtifactStream,
  startTick: number,
  durationTicks: number,
  vector: number[],
  texts: TemporalIndexObservation["texts"],
  fingerprint: string,
): TemporalIndexObservation {
  return {
    artifactId: artifact.artifactId,
    objectHash: stream.objectHash,
    streamId: stream.streamId,
    range: {
      streamId: stream.streamId,
      objectHash: stream.objectHash,
      startTick,
      durationTicks,
      timeBase: stream.timeBase,
    },
    kind: stream.kind === "video" ? "shot" : "audio-event",
    representativeTick: startTick + Math.floor(durationTicks / 2),
    segmentationVersion: "fixture-1",
    texts,
    embeddings: [
      {
        modality: stream.kind === "video" ? "visual" : "audio",
        embeddingSpace: manifest.embeddingSpace,
        vector,
        sourceHash: `${stream.objectHash}:${startTick}:${durationTicks}`,
      },
    ],
    fingerprints: [
      {
        kind: "perceptual",
        value: fingerprint,
        extractorVersion: "1",
      },
    ],
  };
}

function commit(
  engine: Engine,
  artifact: Artifact,
  objectHash: string,
  phase: "visual" | "audio",
  observations: TemporalIndexObservation[],
  complete = true,
) {
  const coveredRanges = observations.flatMap((observation) =>
    observation.range ? [observation.range] : [],
  );
  return value(
    engine.temporalSearch.commitBatch({
      artifactId: artifact.artifactId,
      objectHash,
      manifestId: manifest.manifestId,
      generation: "generation-1",
      phase,
      maxUnits: 100,
      observations,
      coveredRanges,
      totalUnits: observations.length,
      complete,
    }),
  );
}

describe("progressive temporal multimodal search", () => {
  it("exposes durable next cursors through generation plans", async () => {
    const engine = await setup();
    const source = await media(engine, "video", "cursor-source");
    const observation = timedObservation(
      source.artifact,
      source.stream,
      0,
      1_000,
      [1, 0, 0],
      [],
      "cursor-frame",
    );
    value(engine.temporalSearch.commitBatch({
      artifactId: source.artifact.artifactId,
      objectHash: source.stream.objectHash,
      manifestId: manifest.manifestId,
      generation: "cursor-generation",
      phase: "visual",
      cursor: "0",
      maxUnits: 1,
      observations: [observation],
      coveredRanges: [observation.range!],
      totalUnits: 2,
      nextCursor: "1",
      complete: false,
    }));
    expect(value(engine.temporalSearch.plan(
      source.artifact.artifactId,
      source.stream.objectHash,
      manifest.manifestId,
      "cursor-generation",
    )).coverage).toContainEqual(expect.objectContaining({
      phase: "visual",
      state: "partial",
      indexedUnits: 1,
      totalUnits: 2,
      nextCursor: "1",
    }));
    engine.close();
  });

  it("replaces observation children and collapses only overlapping moments", async () => {
    const engine = await setup();
    const source = await media(engine, "video", "collapse-source");
    const first = {
      ...timedObservation(
        source.artifact,
        source.stream,
        0,
        1_000,
        [1, 0, 0],
        [{ kind: "description" as const, text: "obsolete-only" }],
        "old-fingerprint",
      ),
      segmentId: "stable-segment",
    };
    commit(
      engine,
      source.artifact,
      source.stream.objectHash,
      "visual",
      [first],
    );
    const replacement = {
      ...timedObservation(
        source.artifact,
        source.stream,
        100,
        1_000,
        [1, 0, 0],
        [{ kind: "description" as const, text: "replacement-only" }],
        "new-fingerprint",
      ),
      segmentId: first.segmentId,
    };
    const independent = timedObservation(
      source.artifact,
      source.stream,
      3_000,
      1_000,
      [1, 0, 0],
      [{ kind: "description", text: "replacement-only" }],
      "independent-fingerprint",
    );
    commit(
      engine,
      source.artifact,
      source.stream.objectHash,
      "visual",
      [replacement, independent],
    );
    value(engine.temporalSearch.activate(manifest.manifestId, "generation-1"));

    expect(
      value(
        await engine.temporalSearch.query({
          text: "obsolete-only",
          modalities: ["metadata"],
        }),
      ).hits,
    ).toEqual([]);
    const page = value(
      await engine.temporalSearch.queryPrepared(
        {
          sourceArtifactIds: [source.artifact.artifactId],
          modalities: ["visual"],
          limit: 10,
        },
        {
          kind: "image",
          embeddingSpace: manifest.embeddingSpace,
          vector: [1, 0, 0],
        },
      ),
    );
    expect(page.hits).toHaveLength(2);
    expect(
      page.hits.map((hit) =>
        hit.location.kind === "timed" ? hit.location.range.startTick : -1,
      ),
    ).toEqual(expect.arrayContaining([100, 3_000]));
    expect(engine.temporalSearch.stats()).toMatchObject({
      segments: 2,
      textObservations: 2,
      embeddings: 2,
      fingerprints: 2,
    });
    engine.close();
  });

  it("retrieves bounded visual moments from language and reverse image/frame queries", async () => {
    const engine = await setup();
    const van = await media(engine, "video", "red-van");
    const cat = await media(engine, "video", "cat-window");
    const reference = await still(engine, "red-van-reference");
    const vanMoment = timedObservation(
      van.artifact,
      van.stream,
      5_000,
      4_000,
      [1, 0, 0],
      [
        {
          kind: "description",
          language: "en",
          text: "A delivery vehicle crosses the yard at sunset",
        },
        {
          kind: "transcript",
          language: "en",
          text: "The red van arrives at dusk",
        },
        {
          kind: "ocr",
          language: "en",
          text: "WAREHOUSE 7",
        },
      ],
      "van-near",
    );
    commit(engine, van.artifact, van.stream.objectHash, "visual", [vanMoment]);
    commit(engine, cat.artifact, cat.stream.objectHash, "visual", [
      timedObservation(
        cat.artifact,
        cat.stream,
        10_000,
        3_000,
        [0, 1, 0],
        [{ kind: "description", text: "A cat purrs beside a window" }],
        "cat-near",
      ),
    ]);
    commit(engine, reference.artifact, reference.objectHash, "visual", [
      {
        artifactId: reference.artifact.artifactId,
        objectHash: reference.objectHash,
        sourcePath: "original.jpg",
        kind: "frame",
        segmentationVersion: "fixture-1",
        texts: [],
        embeddings: [
          {
            modality: "visual",
            embeddingSpace: manifest.embeddingSpace,
            vector: [1, 0, 0],
            sourceHash: reference.objectHash,
          },
        ],
        fingerprints: [
          {
            kind: "perceptual",
            value: "van-near",
            extractorVersion: "1",
          },
        ],
      },
    ]);
    value(
      engine.temporalSearch.activate(manifest.manifestId, "generation-1"),
    );

    const language = value(
      await engine.temporalSearch.query({
        text: "red delivery van at dusk",
        artifactKinds: ["video"],
      }),
    );
    expect(language.hits[0]).toMatchObject({
      artifactId: van.artifact.artifactId,
      location: {
        kind: "timed",
        range: { startTick: 5_000, durationTicks: 4_000 },
      },
    });
    expect(language.hits[0]?.signals).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "visual" }),
        expect.objectContaining({ kind: "speech" }),
      ]),
    );

    const reverseImage = value(
      await engine.temporalSearch.query({
        reference: { kind: "image", artifact: reference.artifact.artifactId },
        artifactKinds: ["video"],
      }),
    );
    expect(reverseImage.hits[0]).toMatchObject({
      artifactId: van.artifact.artifactId,
      signals: expect.arrayContaining([
        expect.objectContaining({ kind: "near" }),
      ]),
    });
    const preparedReverseImage = value(
      await engine.temporalSearch.queryPrepared(
        { artifactKinds: ["video"] },
        {
          kind: "image",
          embeddingSpace: manifest.embeddingSpace,
          vector: [1, 0, 0],
          fingerprints: [{ kind: "perceptual", value: "van-near" }],
        },
      ),
    );
    expect(preparedReverseImage.hits[0]).toMatchObject({
      artifactId: van.artifact.artifactId,
      signals: expect.arrayContaining([
        expect.objectContaining({ kind: "near" }),
        expect.objectContaining({ kind: "visual" }),
      ]),
    });
    expect(
      await engine.temporalSearch.queryPrepared(
        { artifactKinds: ["video"] },
        {
          kind: "image",
          embeddingSpace: manifest.embeddingSpace,
          vector: [1, 0],
        },
      ),
    ).toMatchObject({
      ok: false,
      error: { code: "MANIFEST_INCOMPATIBLE" },
    });

    const reverseFrame = value(
      await engine.temporalSearch.query({
        reference: {
          kind: "frame",
          source: {
            streamId: van.stream.streamId,
            objectHash: van.stream.objectHash,
            tick: 6_000,
            timeBase: van.stream.timeBase,
          },
        },
        artifactKinds: ["video"],
      }),
    );
    expect(reverseFrame.hits[0]?.artifactId).toBe(van.artifact.artifactId);
    const report = await evaluateSearchBenchmark(
      "fixture-v1",
      [manifest.manifestId],
      [
        {
          caseId: "language-van",
          class: "natural-language-visual",
          query: { text: "red delivery van", artifactKinds: ["video"] },
          judgments: [
            {
              artifactId: van.artifact.artifactId,
              range: vanMoment.range,
            },
          ],
        },
        {
          caseId: "reverse-van",
          class: "reverse-image-exact",
          query: {
            reference: {
              kind: "image",
              artifact: reference.artifact.artifactId,
            },
            artifactKinds: ["video"],
          },
          judgments: [
            {
              artifactId: van.artifact.artifactId,
              range: vanMoment.range,
            },
          ],
        },
      ],
      async (item) => value(await engine.temporalSearch.query(item.query)),
    );
    expect(report).toMatchObject({
      corpusVersion: "fixture-v1",
      passed: true,
      latencyP50Ms: expect.any(Number),
      medianBoundaryErrorMs: 0,
    });
    expect(compareSearchBenchmarks(report, report)).toEqual([]);
    engine.close();
  });

  it("keeps non-visual embeddings out of reverse-image references", async () => {
    const engine = await setup();
    const target = await media(engine, "video", "visual-target");
    const distractor = await media(engine, "video", "audio-shaped-distractor");
    const reference = await still(engine, "mixed-modality-reference");
    commit(engine, target.artifact, target.stream.objectHash, "visual", [
      timedObservation(
        target.artifact,
        target.stream,
        0,
        1_000,
        [1, 0, 0],
        [],
        "visual-target",
      ),
    ]);
    commit(engine, distractor.artifact, distractor.stream.objectHash, "visual", [
      timedObservation(
        distractor.artifact,
        distractor.stream,
        0,
        1_000,
        [0.4, 0.9165, 0],
        [],
        "visual-distractor",
      ),
    ]);
    commit(engine, reference.artifact, reference.objectHash, "visual", [{
      artifactId: reference.artifact.artifactId,
      objectHash: reference.objectHash,
      sourcePath: "original.jpg",
      kind: "frame",
      segmentationVersion: "fixture-1",
      texts: [],
      embeddings: [
        {
          modality: "visual",
          embeddingSpace: manifest.embeddingSpace,
          vector: [1, 0, 0],
          sourceHash: `${reference.objectHash}:visual`,
        },
        {
          modality: "audio",
          embeddingSpace: manifest.embeddingSpace,
          vector: [0, 1, 0],
          sourceHash: `${reference.objectHash}:audio`,
        },
      ],
      fingerprints: [],
    }]);
    value(engine.temporalSearch.activate(manifest.manifestId, "generation-1"));

    const result = value(
      await engine.temporalSearch.query({
        reference: { kind: "image", artifact: reference.artifact.artifactId },
        sourceArtifactIds: [
          target.artifact.artifactId,
          distractor.artifact.artifactId,
        ],
      }),
    );
    expect(result.hits[0]?.artifactId).toBe(target.artifact.artifactId);
    engine.close();
  });

  it("combines quoted transcript and OCR evidence with stable pagination", async () => {
    const engine = await setup();
    const first = await media(engine, "video", "speech-one");
    const second = await media(engine, "video", "speech-two");
    for (const [index, item] of [first, second].entries()) {
      commit(engine, item.artifact, item.stream.objectHash, "visual", [
        timedObservation(
          item.artifact,
          item.stream,
          index * 5_000,
          4_000,
          [1, index * 0.1, 0],
          [
            {
              kind: "transcript",
              text:
                index === 0
                  ? "bring the camera closer"
                  : "move the camera outside",
            },
            {
              kind: "ocr",
              text: index === 0 ? "STUDIO A" : "STUDIO B",
            },
          ],
          `speech-${index}`,
        ),
      ]);
    }
    value(engine.temporalSearch.activate(manifest.manifestId, "generation-1"));
    const exact = value(
      await engine.temporalSearch.query({
        text: "\"bring the camera closer\" \"STUDIO A\"",
        limit: 1,
      }),
    );
    expect(exact.hits[0]).toMatchObject({
      artifactId: first.artifact.artifactId,
      signals: expect.arrayContaining([
        expect.objectContaining({ kind: "speech" }),
        expect.objectContaining({ kind: "ocr" }),
      ]),
    });
    expect(exact.nextCursor).toBeDefined();
    const secondPage = value(
      await engine.temporalSearch.query({
        text: "camera studio",
        limit: 1,
        cursor: value(
          await engine.temporalSearch.query({
            text: "camera studio",
            limit: 1,
          }),
        ).nextCursor,
      }),
    );
    expect(secondPage.hits).toHaveLength(1);
    expect(secondPage.hits[0]?.artifactId).not.toBe(
      value(
        await engine.temporalSearch.query({
          text: "camera studio",
          limit: 1,
        }),
      ).hits[0]?.artifactId,
    );
    engine.close();
  });

  it("searches audio ranges and preserves progressive/stale coverage", async () => {
    const engine = await setup();
    const thunder = await media(engine, "audio", "thunder");
    const rain = await media(engine, "audio", "rain");
    const thunderObservation = timedObservation(
      thunder.artifact,
      thunder.stream,
      48_000,
      96_000,
      [0, 0, 1],
      [{ kind: "description", text: "A loud thunder crack" }],
      "thunder",
    );
    const firstBatch = commit(
      engine,
      thunder.artifact,
      thunder.stream.objectHash,
      "audio",
      [thunderObservation],
      false,
    );
    expect(
      commit(
        engine,
        thunder.artifact,
        thunder.stream.objectHash,
        "audio",
        [thunderObservation],
        false,
      ),
    ).toEqual(firstBatch);
    commit(engine, rain.artifact, rain.stream.objectHash, "audio", [
      timedObservation(
        rain.artifact,
        rain.stream,
        0,
        96_000,
        [0.1, 0, 0.9],
        [{ kind: "description", text: "Steady rain ambience" }],
        "rain",
      ),
    ]);
    value(engine.temporalSearch.activate(manifest.manifestId, "generation-1"));
    const result = value(
      await engine.temporalSearch.query({
        reference: {
          kind: "audio",
          range: thunderObservation.range!,
        },
        artifactKinds: ["audio"],
      }),
    );
    expect(result.hits[0]).toMatchObject({
      artifactId: thunder.artifact.artifactId,
      location: {
        kind: "timed",
        range: { startTick: 48_000, durationTicks: 96_000 },
      },
    });
    expect(result.coverage.partialResults).toBe(true);
    expect(
      value(
        engine.temporalSearch.invalidate(
          thunder.artifact.artifactId,
          thunder.stream.objectHash,
        ),
      ),
    ).toBeGreaterThan(0);
    expect(value(engine.temporalSearch.coverage()).state).toBe("stale");
    expect(engine.temporalSearch.stats()).toMatchObject({
      activeGenerations: 1,
      segments: 2,
    });
    engine.close();
  });

  it("atomically switches generations after source replacement and cleans retired rows", async () => {
    const engine = await setup();
    const source = await media(engine, "video", "replace-source");
    const oldObservation = timedObservation(
      source.artifact,
      source.stream,
      0,
      4_000,
      [1, 0, 0],
      [{ kind: "description", text: "Old red van moment" }],
      "old-van",
    );
    commit(
      engine,
      source.artifact,
      source.stream.objectHash,
      "visual",
      [oldObservation],
    );
    value(engine.temporalSearch.activate(manifest.manifestId, "generation-1"));
    value(
      engine.temporalSearch.invalidate(
        source.artifact.artifactId,
        source.stream.objectHash,
      ),
    );
    value(
      await engine.files.write(
        source.artifact.artifactId,
        "original.mp4",
        "replacement",
      ),
    );
    const objectHash = value(
      await engine.files.manifest(source.artifact.artifactId),
    ).files[0]?.objectHash;
    if (!objectHash) throw new Error("Replacement object hash is missing");
    const replacementStream = value(
      await engine.streams.register({
        ...source.stream,
        streamId: undefined,
        objectHash,
      }),
    );
    const replacement = timedObservation(
      source.artifact,
      replacementStream,
      8_000,
      4_000,
      [0, 1, 0],
      [{ kind: "description", text: "Replacement cat moment" }],
      "replacement-cat",
    );
    value(
      engine.temporalSearch.commitBatch({
        artifactId: source.artifact.artifactId,
        objectHash,
        manifestId: manifest.manifestId,
        generation: "generation-2",
        phase: "visual",
        maxUnits: 10,
        observations: [replacement],
        coveredRanges: [replacement.range!],
        totalUnits: 1,
        complete: true,
      }),
    );
    expect(
      value(
        await engine.temporalSearch.query({
          text: "old red van",
          artifactKinds: ["video"],
        }),
      ).hits[0]?.location,
    ).toMatchObject({ kind: "timed", range: { startTick: 0 } });
    value(engine.temporalSearch.activate(manifest.manifestId, "generation-2"));
    expect(
      value(
        await engine.temporalSearch.query({
          text: "cat",
          artifactKinds: ["video"],
        }),
      ).hits[0]?.location,
    ).toMatchObject({ kind: "timed", range: { startTick: 8_000 } });
    expect(value(engine.temporalSearch.cleanup()).removedSegments).toBe(1);
    expect(engine.temporalSearch.stats().segments).toBe(1);
    engine.close();
  });

  it("ranks a coherent ordered video action above shuffled moments", async () => {
    const engine = await setup();
    const queryVideo = await media(engine, "video", "query-action");
    const coherent = await media(engine, "video", "coherent-action");
    const shuffled = await media(engine, "video", "shuffled-action");
    const vectors = [
      [1, 0, 0],
      [0, 1, 0],
      [0, 0, 1],
    ];
    const observations = (
      item: { artifact: Artifact; stream: ArtifactStream },
      order: number[],
    ) =>
      order.map((vectorIndex, index) =>
        timedObservation(
          item.artifact,
          item.stream,
          index * 1_000,
          1_000,
          vectors[vectorIndex]!,
          [],
          `${item.artifact.artifactId}-${index}`,
        ),
      );
    commit(
      engine,
      queryVideo.artifact,
      queryVideo.stream.objectHash,
      "visual",
      observations(queryVideo, [0, 1, 2]),
    );
    commit(
      engine,
      coherent.artifact,
      coherent.stream.objectHash,
      "visual",
      observations(coherent, [0, 1, 2]),
    );
    commit(
      engine,
      shuffled.artifact,
      shuffled.stream.objectHash,
      "visual",
      observations(shuffled, [2, 0, 1]),
    );
    value(engine.temporalSearch.activate(manifest.manifestId, "generation-1"));
    const result = value(
      await engine.temporalSearch.query({
        reference: {
          kind: "video",
          range: {
            streamId: queryVideo.stream.streamId,
            objectHash: queryVideo.stream.objectHash,
            startTick: 0,
            durationTicks: 3_000,
            timeBase: queryVideo.stream.timeBase,
          },
        },
        sourceArtifactIds: [
          coherent.artifact.artifactId,
          shuffled.artifact.artifactId,
        ],
      }),
    );
    expect(result.hits[0]).toMatchObject({
      artifactId: coherent.artifact.artifactId,
      location: {
        kind: "timed",
        range: { startTick: 0, durationTicks: 3_000 },
      },
      signals: [
        expect.objectContaining({
          kind: "visual",
          explanation: expect.stringContaining("temporal coherence"),
        }),
      ],
    });
    expect(result.hits[1]?.artifactId).toBe(shuffled.artifact.artifactId);
    expect(result.hits[0]!.score).toBeGreaterThan(result.hits[1]!.score);
    const portable = value(
      await engine.temporalSearch.queryPrepared(
        {
          sourceArtifactIds: [
            coherent.artifact.artifactId,
            shuffled.artifact.artifactId,
          ],
        },
        {
          kind: "video",
          embeddingSpace: manifest.embeddingSpace,
          samples: vectors.map((vector, index) => ({
            offsetMs: index * 1_000,
            vector,
          })),
        },
      ),
    );
    expect(portable.hits[0]?.artifactId).toBe(coherent.artifact.artifactId);
    const trimmed = value(
      await engine.temporalSearch.queryPrepared(
        {
          sourceArtifactIds: [
            coherent.artifact.artifactId,
            shuffled.artifact.artifactId,
          ],
        },
        {
          kind: "video",
          embeddingSpace: manifest.embeddingSpace,
          samples: vectors.map((vector, index) => ({
            offsetMs: index * 1_000,
            vector,
          })),
        },
        { range: { startMs: 1_000, durationMs: 1_000 } },
      ),
    );
    expect(trimmed.hits.find((hit) => hit.artifactId === coherent.artifact.artifactId)).toMatchObject({
      artifactId: coherent.artifact.artifactId,
      location: {
        kind: "timed",
        range: { startTick: 1_000, durationTicks: 1_000 },
      },
    });
    expect(
      await engine.temporalSearch.queryPrepared(
        {},
        {
          kind: "video",
          embeddingSpace: manifest.embeddingSpace,
          samples: Array.from({ length: 17 }, (_, index) => ({
            offsetMs: index,
            vector: [1, 0, 0],
          })),
        },
      ),
    ).toMatchObject({
      ok: false,
      error: { code: "INVALID_INPUT" },
    });
    engine.close();
  });

  it.each([
    { queryOffsets: [0, 998, 1996, 2994, 3992], indexOffsets: [0, 1980, 3960] },
    { queryOffsets: [0, 1980, 3960], indexOffsets: [0, 998, 1996, 2994, 3992] },
  ])("aligns different sampling densities by time: $queryOffsets", async ({ queryOffsets, indexOffsets }) => {
    const engine = await setup();
    try {
      const source = await media(engine, "video", "density-source");
      const shuffled = await media(engine, "video", "density-shuffled");
      const stretched = await media(engine, "video", "density-stretched");
      const durationMs = 4042;
      const vectorAt = (offset: number) => {
        const phase = Math.min(2, offset / 1980);
        return phase <= 1 ? [1 - phase, phase, 0] : [0, 2 - phase, phase - 1];
      };
      for (const [item, scale, reverse] of [
        [source, 1, false], [shuffled, 1, true], [stretched, 5, false],
      ] as const) {
        commit(engine, item.artifact, item.stream.objectHash, "visual",
          indexOffsets.map((offset, index) => timedObservation(
            item.artifact, item.stream, offset * scale,
            ((indexOffsets[index + 1] ?? durationMs) - offset) * scale,
            vectorAt(reverse ? durationMs - offset : offset), [],
            `${item.artifact.artifactId}-${index}`,
          )));
      }
      value(engine.temporalSearch.activate(manifest.manifestId, "generation-1"));
      const result = value(await engine.temporalSearch.queryPrepared({}, {
        kind: "video", embeddingSpace: manifest.embeddingSpace, durationMs,
        samples: queryOffsets.map((offsetMs) => ({ offsetMs, vector: vectorAt(offsetMs) })),
      }));
      expect(result.hits[0]).toMatchObject({
        artifactId: source.artifact.artifactId,
        location: { kind: "timed", range: { startTick: 0, durationTicks: durationMs } },
      });
      expect(result.hits[0]!.signals.find((signal) => signal.kind === "visual")!.score).toBeGreaterThan(0.9);
      for (const hit of result.hits) {
        if (hit.location.kind === "timed") {
          expect(hit.location.range.durationTicks).toBeLessThanOrEqual(durationMs);
        }
      }
      const stored = value(await engine.temporalSearch.query({
        reference: { kind: "video", range: {
          streamId: source.stream.streamId, objectHash: source.stream.objectHash,
          startTick: 0, durationTicks: durationMs, timeBase: source.stream.timeBase,
        } },
      }));
      expect(stored.hits[0]?.artifactId).toBe(source.artifact.artifactId);
      for (const duration of [0, -1, NaN, Infinity, 3992]) {
        const invalid = await engine.temporalSearch.queryPrepared({}, {
          kind: "video", embeddingSpace: manifest.embeddingSpace, durationMs: duration,
          samples: [{ offsetMs: 3992, vector: [0, 0, 1] }],
        });
        expect(invalid).toMatchObject({ ok: false, error: { code: "INVALID_INPUT" } });
      }
    } finally {
      engine.close();
    }
  });

  it("preserves an exact signal for the same ordered source bytes and range", async () => {
    const engine = await setup();
    const queryVideo = await media(engine, "video", "identical-action");
    const duplicate = await media(engine, "video", "identical-action");
    const vectors = [
      [1, 0, 0],
      [0, 1, 0],
      [0, 0, 1],
    ];
    const observations = (
      item: { artifact: Artifact; stream: ArtifactStream },
    ) => vectors.map((vector, index) =>
      timedObservation(
        item.artifact,
        item.stream,
        index * 1_000,
        1_000,
        vector,
        [],
        `identical-${index}`,
      )
    );
    commit(
      engine,
      queryVideo.artifact,
      queryVideo.stream.objectHash,
      "visual",
      observations(queryVideo),
    );
    commit(
      engine,
      duplicate.artifact,
      duplicate.stream.objectHash,
      "visual",
      observations(duplicate),
    );
    value(engine.temporalSearch.activate(manifest.manifestId, "generation-1"));

    const result = value(
      await engine.temporalSearch.query({
        reference: {
          kind: "video",
          range: {
            streamId: queryVideo.stream.streamId,
            objectHash: queryVideo.stream.objectHash,
            startTick: 0,
            durationTicks: 3_000,
            timeBase: queryVideo.stream.timeBase,
          },
        },
        sourceArtifactIds: [duplicate.artifact.artifactId],
      }),
    );
    expect(result.hits[0]?.signals).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "exact" }),
      expect.objectContaining({ kind: "visual" }),
    ]));
    engine.close();
  });

  it("penalizes ordered video moments separated by large temporal gaps", async () => {
    const engine = await setup();
    const queryVideo = await media(engine, "video", "gap-query");
    const contiguous = await media(engine, "video", "gap-contiguous");
    const sparse = await media(engine, "video", "gap-sparse");
    const vectors = [
      [1, 0, 0],
      [0, 1, 0],
      [0, 0, 1],
    ];
    const observations = (
      item: { artifact: Artifact; stream: ArtifactStream },
      starts: number[],
    ) => vectors.map((vector, index) =>
      timedObservation(
        item.artifact,
        item.stream,
        starts[index]!,
        1_000,
        vector,
        [],
        `${item.artifact.artifactId}-${index}`,
      )
    );
    commit(
      engine,
      queryVideo.artifact,
      queryVideo.stream.objectHash,
      "visual",
      observations(queryVideo, [0, 1_000, 2_000]),
    );
    commit(
      engine,
      contiguous.artifact,
      contiguous.stream.objectHash,
      "visual",
      observations(contiguous, [0, 1_000, 2_000]),
    );
    commit(
      engine,
      sparse.artifact,
      sparse.stream.objectHash,
      "visual",
      observations(sparse, [0, 10_000, 20_000]),
    );
    value(engine.temporalSearch.activate(manifest.manifestId, "generation-1"));

    const result = value(
      await engine.temporalSearch.query({
        reference: {
          kind: "video",
          range: {
            streamId: queryVideo.stream.streamId,
            objectHash: queryVideo.stream.objectHash,
            startTick: 0,
            durationTicks: 3_000,
            timeBase: queryVideo.stream.timeBase,
          },
        },
        sourceArtifactIds: [
          contiguous.artifact.artifactId,
          sparse.artifact.artifactId,
        ],
      }),
    );
    const contiguousScore = result.hits
      .find((hit) => hit.artifactId === contiguous.artifact.artifactId)
      ?.signals.find((signal) => signal.kind === "visual")?.score;
    const sparseScore = result.hits
      .find((hit) => hit.artifactId === sparse.artifact.artifactId)
      ?.signals.find((signal) => signal.kind === "visual")?.score;
    expect(contiguousScore).toBeGreaterThan(sparseScore!);
    engine.close();
  });
});
