import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";

import { v7 as uuidv7 } from "uuid";
import { afterEach, describe, expect, it } from "vitest";

import { createEngine, type Engine } from "../src/index.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

function value<T>(
  result:
    | { ok: true; value: T }
    | { ok: false; error: { message: string } },
): T {
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

async function setup(slug = "semantic-model"): Promise<Engine> {
  const root = await mkdtemp(path.join(tmpdir(), "videobook-v5-"));
  roots.push(root);
  return createEngine({
    dataDir: path.join(root, "data"),
    workspaceDir: path.join(root, "workspace"),
    initialBookSlug: slug,
  });
}

describe("v5 semantic media model", () => {
  it("creates a primary sequence and preserves sequence revisions", async () => {
    const engine = await setup();
    const primary = engine.sequences.getPrimary();
    expect(primary.name).toBe("Main");
    expect(primary.width).toBe(1920);
    expect(primary.height).toBe(1080);
    expect(primary.frameRate).toEqual({ numerator: 30, denominator: 1 });
    expect(primary.tracks.filter((track) => track.kind === "video")).toHaveLength(2);
    expect(primary.tracks.filter((track) => track.kind === "audio")).toHaveLength(4);
    expect(primary.tracks.filter((track) => track.kind === "caption")).toHaveLength(1);

    const selects = value(
      await engine.sequences.create({
        name: "Selects",
        width: 1080,
        height: 1920,
        frameRate: { numerator: 30_000, denominator: 1_001 },
      }),
    );
    const createdRevision = selects.revision;
    expect(value(await engine.sequences.rename(selects.sequenceId, "Rough cut")).name)
      .toBe("Rough cut");
    expect(
      value(engine.sequences.getAtRevision(selects.sequenceId, createdRevision)).name,
    ).toBe("Selects");
    expect(value(await engine.sequences.delete(selects.sequenceId))).toEqual({
      sequenceId: selects.sequenceId,
    });
    expect(await engine.sequences.delete(primary.sequenceId)).toMatchObject({
      ok: false,
      error: { code: "IN_USE" },
    });
    engine.close();
  });

  it("binds immutable streams and normalized transcripts to source objects", async () => {
    const engine = await setup();
    const artifact = value(
      await engine.artifacts.create({ kind: "video", slug: "interview" }),
    );
    value(await engine.files.write(artifact.artifactId, "original.mp4", "version one"));
    const firstManifest = value(await engine.files.manifest(artifact.artifactId));
    const firstHash = firstManifest.files[0]?.objectHash;
    if (!firstHash) throw new Error("Source object hash is missing");
    const firstStream = value(
      await engine.streams.register({
        artifactId: artifact.artifactId,
        sourcePath: "original.mp4",
        objectHash: firstHash,
        streamIndex: 0,
        kind: "video",
        timeBase: { numerator: 1, denominator: 1_000 },
        durationTicks: 12_000,
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
    const transcript = value(
      await engine.transcripts.import({
        artifactId: artifact.artifactId,
        streamId: firstStream.streamId,
        objectHash: firstHash,
        language: "en",
        provider: "fixture",
        segments: [
          {
            ordinal: 0,
            range: {
              streamId: firstStream.streamId,
              objectHash: firstHash,
              startTick: 1_000,
              durationTicks: 2_000,
              timeBase: firstStream.timeBase,
            },
            speaker: "A",
            text: "Make the opening tighter",
            confidence: 0.98,
            kind: "speech",
            words: [
              {
                ordinal: 0,
                startTick: 1_000,
                durationTicks: 400,
                text: "Make",
                confidence: 0.99,
                corrected: false,
              },
              {
                ordinal: 1,
                startTick: 1_500,
                durationTicks: 600,
                text: "opening",
                confidence: 0.97,
                corrected: true,
              },
            ],
          },
        ],
      }),
    );
    expect(transcript.segments[0]?.words.map((word) => word.text)).toEqual([
      "Make",
      "opening",
    ]);
    expect(
      value(
        engine.transcripts.getAtRevision(
          transcript.transcriptId,
          transcript.revision,
        ),
      ),
    ).toEqual(transcript);
    const firstWord = transcript.segments[0]?.words[0];
    const secondWord = transcript.segments[0]?.words[1];
    if (!firstWord || !secondWord) throw new Error("Transcript words are missing");
    expect(
      value(
        engine.transcripts.selectionRange(
          transcript.transcriptId,
          firstWord.wordId,
          secondWord.wordId,
        ),
      ),
    ).toEqual({
      streamId: firstStream.streamId,
      objectHash: firstHash,
      startTick: 1_000,
      durationTicks: 1_100,
      timeBase: firstStream.timeBase,
    });
    const corrected = value(
      await engine.transcripts.revise({
        sourceTranscriptId: transcript.transcriptId,
        segments: [
          {
            ordinal: 0,
            range: transcript.segments[0]!.range,
            speaker: "A",
            text: "Make the opening much tighter",
            kind: "speech",
            words: [
              {
                ordinal: 0,
                startTick: 1_000,
                durationTicks: 500,
                text: "Make",
                corrected: false,
              },
              {
                ordinal: 1,
                startTick: 1_500,
                durationTicks: 700,
                text: "tighter",
                corrected: true,
              },
            ],
          },
        ],
      }),
    );
    expect(corrected.transcriptId).not.toBe(transcript.transcriptId);
    expect(corrected.objectHash).toBe(transcript.objectHash);
    expect(corrected.segments[0]?.words[1]).toMatchObject({
      text: "tighter",
      corrected: true,
    });
    expect(value(await engine.files.manifest(artifact.artifactId)).files[0]?.objectHash)
      .toBe(firstHash);

    expect(
      await engine.transcripts.import({
        artifactId: artifact.artifactId,
        streamId: firstStream.streamId,
        objectHash: firstHash,
        language: "en",
        segments: [
          {
            ordinal: 0,
            range: {
              streamId: firstStream.streamId,
              objectHash: firstHash,
              startTick: 11_500,
              durationTicks: 1_000,
              timeBase: firstStream.timeBase,
            },
            text: "Out of bounds",
            kind: "speech",
            words: [],
          },
        ],
      }),
    ).toMatchObject({ ok: false, error: { code: "INVALID_RANGE" } });

    value(await engine.files.write(artifact.artifactId, "original.mp4", "version two"));
    const secondManifest = value(await engine.files.manifest(artifact.artifactId));
    const secondHash = secondManifest.files[0]?.objectHash;
    if (!secondHash) throw new Error("Replacement object hash is missing");
    expect(secondHash).not.toBe(firstHash);
    const secondStream = value(
      await engine.streams.register({
        ...firstStream,
        streamId: undefined,
        objectHash: secondHash,
      }),
    );
    expect(secondStream.streamId).not.toBe(firstStream.streamId);
    expect(value(engine.streams.get(firstStream.streamId)).objectHash).toBe(firstHash);
    engine.close();
  });

  it("round-trips typed notebook references and pinned search selections", async () => {
    const engine = await setup();
    const artifact = value(
      await engine.artifacts.create({ kind: "audio", slug: "voiceover" }),
    );
    value(await engine.files.write(artifact.artifactId, "original.wav", "audio"));
    const objectHash = value(await engine.files.manifest(artifact.artifactId))
      .files[0]?.objectHash;
    if (!objectHash) throw new Error("Audio object hash is missing");
    const stream = value(
      await engine.streams.register({
        artifactId: artifact.artifactId,
        sourcePath: "original.wav",
        objectHash,
        streamIndex: 0,
        kind: "audio",
        timeBase: { numerator: 1, denominator: 48_000 },
        durationTicks: 96_000,
        codec: "pcm_s16le",
        audio: {
          sampleRateHz: 48_000,
          channels: 2,
          channelLayout: "stereo",
        },
      }),
    );
    const notebook = value(await engine.notebooks.create("Audio notebook"));
    const cell = engine.notebooks.createCell({
      type: "search",
      title: "Find the intro",
      slot: { row: 2, column: 3 },
      references: [
        {
          id: uuidv7(),
          kind: "source-range",
          targetId: stream.streamId,
          snapshot: {
            objectHash,
            startTick: 0,
            durationTicks: 48_000,
          },
          ordinal: 0,
        },
      ],
      pinnedResults: [
        {
          id: uuidv7(),
          artifactId: artifact.artifactId,
          objectHash,
          location: {
            kind: "timed",
            artifactId: artifact.artifactId,
            range: {
              streamId: stream.streamId,
              objectHash,
              startTick: 0,
              durationTicks: 48_000,
              timeBase: stream.timeBase,
            },
          },
          representativeTick: 24_000,
          query: { text: "opening voice", modalities: ["speech"] },
          signals: [{ kind: "speech", rank: 1, score: 0.94 }],
          selectedRevision: engine.head,
          ordinal: 0,
          createdAt: Date.now(),
        },
      ],
    });
    value(await engine.notebooks.write({ ...notebook, cells: [cell], edges: [] }));
    const stored = value(engine.notebooks.read(notebook.id)).cells[0];
    expect(stored?.references).toEqual(cell.references);
    expect(stored?.pinnedResults).toEqual(cell.pinnedResults);
    engine.close();
  });

  it("isolates primary sequences between book roots", async () => {
    const first = await setup("first");
    const second = await setup("second");
    const extra = value(
      await first.sequences.create({
        name: "Only first",
        width: 1920,
        height: 1080,
        frameRate: { numerator: 24, denominator: 1 },
      }),
    );
    expect(first.sequences.list().map((sequence) => sequence.sequenceId)).toContain(
      extra.sequenceId,
    );
    expect(second.sequences.list()).toHaveLength(1);
    first.close();
    second.close();
  });
});
