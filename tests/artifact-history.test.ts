import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";

import { DatabaseSync } from "@dolthub/doltlite";
import { afterEach, describe, expect, it } from "vitest";

import { createEngine, type Engine } from "../src/index.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function value<T>(result: { ok: true; value: T } | { ok: false; error: { message: string } }): T {
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

async function setup() {
  const root = await mkdtemp(path.join(tmpdir(), "videobook-artifact-history-"));
  roots.push(root);
  const options = { rootDir: root, initialBookName: "Media history" };
  const engine = createEngine(options);
  await engine.ready;
  return { root, options, engine };
}

async function registerAudio(engine: Engine, artifactId: string) {
  const file = value(await engine.files.manifest(artifactId)).files.find((entry) => entry.name === "original.wav");
  if (!file) throw new Error("Missing source file");
  return value(await engine.streams.register({
    artifactId,
    sourcePath: file.name,
    objectHash: file.objectHash,
    streamIndex: 0,
    kind: "audio",
    timeBase: { numerator: 1, denominator: 48_000 },
    durationTicks: 144_000,
    codec: "pcm_s16le",
    audio: { sampleRateHz: 48_000, channels: 1, channelLayout: "mono" },
  }));
}

describe("artifact media history", () => {
  it("restores edited files without breaking immutable streams and transcripts", async () => {
    const { root, options, engine } = await setup();
    const artifact = value(await engine.artifacts.create("audio", "Source"));
    value(await engine.files.write(artifact.artifactId, "original.wav", "version one"));
    const firstStream = await registerAudio(engine, artifact.artifactId);
    const transcript = value(await engine.transcripts.import({
      artifactId: artifact.artifactId,
      streamId: firstStream.streamId,
      objectHash: firstStream.objectHash,
      language: "en",
      segments: [{
        ordinal: 0,
        range: {
          streamId: firstStream.streamId,
          objectHash: firstStream.objectHash,
          startTick: 0,
          durationTicks: 48_000,
          timeBase: firstStream.timeBase,
        },
        text: "Original speech",
        kind: "speech",
        words: [{ ordinal: 0, startTick: 0, durationTicks: 24_000, text: "Original", corrected: false }],
      }],
    }));
    const revision = engine.head;
    value(await engine.files.write(artifact.artifactId, "original.wav", "version two"));
    const secondStream = await registerAudio(engine, artifact.artifactId);
    value(await engine.files.write(artifact.artifactId, "later.md", "remove me"));

    const restored = value(await engine.history.restoreArtifact(artifact.artifactId, revision));
    expect(restored.operation).toBe("restore_artifact");
    expect(restored.hash).not.toBe(revision);
    expect(value(await engine.files.read(artifact.artifactId, "original.wav")).toString()).toBe("version one");
    expect(value(await engine.files.manifest(artifact.artifactId)).files.map((file) => file.name)).toEqual(["original.wav"]);
    expect(value(engine.streams.get(firstStream.streamId))).toEqual(firstStream);
    expect(value(engine.streams.get(secondStream.streamId))).toEqual(secondStream);
    expect(value(await engine.transcripts.get(transcript.transcriptId)).segments).toEqual(transcript.segments);
    engine.close();

    const reopened = createEngine(options);
    await reopened.ready;
    expect(value(await reopened.files.read(artifact.artifactId, "original.wav")).toString()).toBe("version one");
    expect(value(reopened.streams.list(artifact.artifactId))).toHaveLength(2);
    expect(value(await reopened.transcripts.get(transcript.transcriptId)).segments).toEqual(transcript.segments);
    reopened.close();
    const db = new DatabaseSync(path.join(root, "data", "videobook.db"));
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    db.close();
  });

  it("refuses to remove a referenced stream source without partially restoring the artifact", async () => {
    const { engine } = await setup();
    const artifact = value(await engine.artifacts.create("audio", "Before media"));
    const revision = engine.head;
    value(await engine.files.write(artifact.artifactId, "original.wav", "keep me"));
    const stream = await registerAudio(engine, artifact.artifactId);
    value(await engine.artifacts.rename(artifact.artifactId, "After media"));
    const head = engine.head;

    expect(await engine.history.restoreArtifact(artifact.artifactId, revision)).toMatchObject({
      ok: false,
      error: { code: "IN_USE", message: expect.stringContaining("original.wav") },
    });
    expect(engine.head).toBe(head);
    expect(value(engine.artifacts.get(artifact.artifactId)).label).toBe("After media");
    expect(value(await engine.files.read(artifact.artifactId, "original.wav")).toString()).toBe("keep me");
    expect(value(engine.streams.get(stream.streamId))).toEqual(stream);
    engine.close();
  });
});
