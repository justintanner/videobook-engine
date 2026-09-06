import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  createEngine,
  LOCAL_CLIP_MANIFEST,
  LocalClipTemporalProvider,
  type Artifact,
  type ArtifactStream,
  type Engine,
  type SourceRange,
  type TemporalIndexObservation,
} from "../src/index.js";

const run = promisify(execFile);
const enabled = process.env.VIDEOBOOK_RUN_MODEL_E2E === "1";
const fixtureImage = fileURLToPath(
  new URL("../fixtures/media/vancat_profile.jpg", import.meta.url),
);
const fixtureVideo = fileURLToPath(
  new URL("../fixtures/media/vancat.mp4", import.meta.url),
);
const generation = "real-reverse-media-v1";
const sampleCount = 6;
const sampleDurationTicks = 1_000;

interface IndexedVideo {
  artifact: Artifact;
  stream: ArtifactStream;
  range: SourceRange;
}

describe.runIf(enabled)("real-media reverse search", () => {
  let root: string;
  let engine: Engine;
  let referenceImage: Artifact;
  let queryVideo: IndexedVideo;
  let forwardVideo: IndexedVideo;
  let reversedVideo: IndexedVideo;
  let distractorVideo: IndexedVideo;
  let sparseVideo: IndexedVideo;
  let referenceVectors: Float32Array[];

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "videobook-reverse-e2e-"));
    const reversedPath = join(root, "vancat-reversed.mp4");
    const distractorPath = join(root, "blue-distractor.mp4");
    await Promise.all([
      run("ffmpeg", [
        "-hide_banner",
        "-loglevel",
        "error",
        "-nostdin",
        "-y",
        "-i",
        fixtureVideo,
        "-vf",
        "reverse",
        "-an",
        "-c:v",
        "libx264",
        "-preset",
        "ultrafast",
        "-crf",
        "18",
        reversedPath,
      ]),
      run("ffmpeg", [
        "-hide_banner",
        "-loglevel",
        "error",
        "-nostdin",
        "-y",
        "-f",
        "lavfi",
        "-i",
        "color=c=blue:s=720x720:r=24:d=6",
        "-an",
        "-c:v",
        "libx264",
        "-pix_fmt",
        "yuv420p",
        distractorPath,
      ]),
    ]);

    const [forwardFrames, reverseFrames, distractorFrames] = await Promise.all([
      extractFrames(fixtureVideo, join(root, "forward-frames")),
      extractFrames(reversedPath, join(root, "reverse-frames")),
      extractFrames(distractorPath, join(root, "distractor-frames")),
    ]);
    expect(forwardFrames).toHaveLength(sampleCount);
    expect(reverseFrames).toHaveLength(sampleCount);
    expect(distractorFrames).toHaveLength(sampleCount);

    const provider = new LocalClipTemporalProvider({
      modelCacheDir: process.env.VIDEOBOOK_E2E_MODEL_CACHE ??
        join(homedir(), ".cache", "videobook", "models"),
      allowModelDownload: true,
    });
    await provider.prepare();
    const imageVector = await provider.embedImage(fixtureImage);
    const forwardVectors = await embedFrames(provider, forwardFrames);
    referenceVectors = forwardVectors;
    const reverseVectors = await embedFrames(provider, reverseFrames);
    const distractorVector = await provider.embedImage(distractorFrames[0]!);

    engine = createEngine({
      dataDir: join(root, "data"),
      workspaceDir: join(root, "workspaces"),
      initialBookName: "reverse-search-e2e",
    });
    value(engine.temporalSearch.manifests.register(LOCAL_CLIP_MANIFEST));
    engine.temporalSearch.providers.register(provider, { modelDownloads: true });

    referenceImage = value(
      await engine.artifacts.create({ kind: "image", label: "white-cat-reference" }),
    );
    value(
      await engine.files.writeFromPath(
        referenceImage.artifactId,
        "original.jpg",
        fixtureImage,
      ),
    );
    const imageObjectHash = await objectHash(engine, referenceImage);
    commit(
      engine,
      referenceImage,
      imageObjectHash,
      [{
        artifactId: referenceImage.artifactId,
        objectHash: imageObjectHash,
        sourcePath: "original.jpg",
        kind: "frame",
        segmentationVersion: "real-image-v1",
        texts: [],
        embeddings: [embedding(imageVector, imageObjectHash)],
        fingerprints: [],
      }],
      [],
    );

    queryVideo = await addVideo(engine, "query-action", fixtureVideo);
    forwardVideo = await addVideo(engine, "forward-action", fixtureVideo);
    reversedVideo = await addVideo(engine, "reversed-action", reversedPath);
    distractorVideo = await addVideo(engine, "blue-distractor", distractorPath);
    sparseVideo = await addVideo(engine, "sparsely-indexed-action", fixtureVideo);
    commitVideo(engine, sparseVideo, forwardVectors.filter((_, index) => index % 2 === 0), 2_000);
    commitVideo(engine, queryVideo, forwardVectors);
    commitVideo(engine, forwardVideo, forwardVectors);
    commitVideo(engine, reversedVideo, reverseVectors);
    commitVideo(
      engine,
      distractorVideo,
      Array.from({ length: sampleCount }, () => distractorVector),
    );
    value(engine.temporalSearch.activate(LOCAL_CLIP_MANIFEST.manifestId, generation));
  }, 15 * 60_000);

  afterAll(async () => {
    engine?.close();
    if (root) await rm(root, { recursive: true, force: true });
  });

  it("finds a bounded video moment from a real reference image", async () => {
    const result = value(
      await engine.temporalSearch.query({
        reference: { kind: "image", artifact: referenceImage.artifactId },
        artifactKinds: ["video"],
        sourceArtifactIds: [
          forwardVideo.artifact.artifactId,
          distractorVideo.artifact.artifactId,
        ],
        modalities: ["visual"],
      }),
    );

    expect(result.hits[0]).toMatchObject({
      artifactId: forwardVideo.artifact.artifactId,
      artifactKind: "video",
      location: {
        kind: "timed",
        range: { durationTicks: sampleDurationTicks },
      },
      signals: [
        expect.objectContaining({
          kind: "visual",
          explanation: "image reference similarity",
        }),
      ],
    });
    expect(result.hits[0]?.score).toBeGreaterThan(result.hits.at(-1)?.score ?? 0);
  });

  it("ranks a real forward action above its reversed copy", async () => {
    const result = value(
      await engine.temporalSearch.query({
        reference: { kind: "video", range: queryVideo.range },
        sourceArtifactIds: [
          forwardVideo.artifact.artifactId,
          reversedVideo.artifact.artifactId,
        ],
        modalities: ["visual"],
      }),
    );

    expect(result.hits).toHaveLength(2);
    expect(result.hits[0]).toMatchObject({
      artifactId: forwardVideo.artifact.artifactId,
      location: {
        kind: "timed",
        range: { startTick: 0, durationTicks: sampleCount * sampleDurationTicks },
      },
      signals: expect.arrayContaining([
        expect.objectContaining({
          kind: "exact",
          explanation: expect.stringContaining("Exact"),
        }),
        expect.objectContaining({
          kind: "visual",
          explanation: expect.stringContaining("temporal coherence"),
        }),
      ]),
    });
    expect(result.hits[1]?.artifactId).toBe(reversedVideo.artifact.artifactId);
    expect(result.hits[0]!.score).toBeGreaterThan(result.hits[1]!.score);
    const forwardVisualScore = result.hits[0]?.signals
      .find((signal) => signal.kind === "visual")?.score;
    const reversedVisualScore = result.hits[1]?.signals
      .find((signal) => signal.kind === "visual")?.score;
    expect(forwardVisualScore).toBeGreaterThan(reversedVisualScore!);
  });

  it("retrieves a sparsely indexed real video from a denser prepared reference", async () => {
    const result = value(await engine.temporalSearch.queryPrepared({
      modalities: ["visual"],
      sourceArtifactIds: [sparseVideo.artifact.artifactId, distractorVideo.artifact.artifactId],
    }, {
      kind: "video",
      embeddingSpace: LOCAL_CLIP_MANIFEST.embeddingSpace,
      durationMs: sampleCount * sampleDurationTicks,
      samples: referenceVectors.map((vector, index) => ({
        offsetMs: index * sampleDurationTicks, vector: [...vector],
      })),
    }));
    expect(result.hits[0]).toMatchObject({
      artifactId: sparseVideo.artifact.artifactId,
      location: { kind: "timed", range: { startTick: 0, durationTicks: 6_000 } },
    });
  });
});

async function extractFrames(sourcePath: string, framesDir: string): Promise<string[]> {
  await mkdir(framesDir, { recursive: true });
  await run("ffmpeg", [
    "-hide_banner",
    "-loglevel",
    "error",
    "-nostdin",
    "-i",
    sourcePath,
    "-an",
    "-vf",
    "fps=1,scale=224:224:force_original_aspect_ratio=increase,crop=224:224",
    "-frames:v",
    String(sampleCount),
    join(framesDir, "frame-%02d.png"),
  ]);
  return (await readdir(framesDir))
    .filter((name) => name.endsWith(".png"))
    .sort()
    .map((name) => join(framesDir, name));
}

async function embedFrames(
  provider: LocalClipTemporalProvider,
  frames: string[],
): Promise<Float32Array[]> {
  const vectors: Float32Array[] = [];
  for (const frame of frames) vectors.push(await provider.embedImage(frame));
  return vectors;
}

async function addVideo(
  engine: Engine,
  label: string,
  sourcePath: string,
): Promise<IndexedVideo> {
  const artifact = value(await engine.artifacts.create({ kind: "video", label }));
  value(await engine.files.writeFromPath(artifact.artifactId, "original.mp4", sourcePath));
  const hash = await objectHash(engine, artifact);
  const stream = value(
    await engine.streams.register({
      artifactId: artifact.artifactId,
      sourcePath: "original.mp4",
      objectHash: hash,
      streamIndex: 0,
      kind: "video",
      timeBase: { numerator: 1, denominator: 1_000 },
      durationTicks: sampleCount * sampleDurationTicks,
      codec: "h264",
      video: {
        width: 720,
        height: 720,
        rotationDegrees: 0,
        pixelAspect: { numerator: 1, denominator: 1 },
      },
    }),
  );
  return {
    artifact,
    stream,
    range: {
      streamId: stream.streamId,
      objectHash: hash,
      startTick: 0,
      durationTicks: sampleCount * sampleDurationTicks,
      timeBase: stream.timeBase,
    },
  };
}

function commitVideo(
  engine: Engine,
  video: IndexedVideo,
  vectors: Float32Array[],
  intervalTicks = sampleDurationTicks,
): void {
  const observations = vectors.map((vector, index): TemporalIndexObservation => {
    const range: SourceRange = {
      ...video.range,
      startTick: index * intervalTicks,
      durationTicks: intervalTicks,
    };
    return {
      artifactId: video.artifact.artifactId,
      objectHash: video.stream.objectHash,
      streamId: video.stream.streamId,
      range,
      kind: "window",
      representativeTick: range.startTick + Math.floor(sampleDurationTicks / 2),
      segmentationVersion: "real-video-1fps-v1",
      texts: [],
      embeddings: [
        embedding(vector, `${video.stream.objectHash}:${range.startTick}`),
      ],
      fingerprints: [],
    };
  });
  commit(
    engine,
    video.artifact,
    video.stream.objectHash,
    observations,
    observations.map((observation) => observation.range!),
  );
}

function commit(
  engine: Engine,
  artifact: Artifact,
  objectHashValue: string,
  observations: TemporalIndexObservation[],
  coveredRanges: SourceRange[],
): void {
  value(
    engine.temporalSearch.commitBatch({
      artifactId: artifact.artifactId,
      objectHash: objectHashValue,
      manifestId: LOCAL_CLIP_MANIFEST.manifestId,
      generation,
      phase: "visual",
      maxUnits: Math.max(1, observations.length),
      observations,
      coveredRanges,
      totalUnits: observations.length,
      complete: true,
    }),
  );
}

function embedding(vector: Float32Array, sourceHash: string) {
  return {
    modality: "visual" as const,
    embeddingSpace: LOCAL_CLIP_MANIFEST.embeddingSpace,
    vector: [...vector],
    sourceHash,
  };
}

async function objectHash(engine: Engine, artifact: Artifact): Promise<string> {
  const hash = value(await engine.files.manifest(artifact.artifactId))
    .files[0]?.objectHash;
  if (!hash) throw new Error(`Missing object hash for ${artifact.artifactId}`);
  return hash;
}

function value<T>(
  result:
    | { ok: true; value: T }
    | { ok: false; error: { message: string } },
): T {
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}
