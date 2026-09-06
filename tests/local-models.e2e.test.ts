import { execFile } from "node:child_process";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import sharp from "sharp";
import { afterAll, describe, expect, it } from "vitest";

import {
  LocalClapTemporalProvider,
  LocalClipTemporalProvider,
  createEngine,
} from "../src/index.js";

const execFileAsync = promisify(execFile);
const enabled = process.env.VIDEOBOOK_RUN_MODEL_E2E === "1";
const roots: string[] = [];

afterAll(async () => {
  await Promise.all(
    roots.splice(0).map((root) =>
      rm(root, { recursive: true, force: true }),
    ),
  );
});

describe.runIf(enabled)("pinned local semantic models", () => {
  it.runIf(process.env.VIDEOBOOK_RUN_TEXT_MODEL_E2E === "1")("loads verified external ONNX weights for text similarity and rejects a corrupted shard", async () => {
    const root = await mkdtemp(join(tmpdir(), "videobook-text-model-e2e-"));
    roots.push(root);
    const modelCacheDir = process.env.VIDEOBOOK_E2E_TEXT_MODEL_CACHE ?? join(homedir(), ".cache", "videobook", "models");
    const config = { rootDir: join(root, "book"), initialBookName: "text-integrity",
      similarity: { modelCacheDir, text: { allowModelDownload: process.env.VIDEOBOOK_TEXT_MODEL_DOWNLOAD === "enabled" } } };
    let engine = createEngine(config);
    let artifactId: string;
    try {
      await engine.ready;
      expect(await engine.similarity.prepare({ kind: "text" })).toMatchObject({ ok: true });
      const created = await engine.artifacts.create({ kind: "script", label: "Cat" });
      if (!created.ok) throw new Error(created.error.message);
      artifactId = created.value.artifactId;
      expect((await engine.files.write(artifactId, "original.txt", "A cat sleeps on a warm rug.")).ok).toBe(true);
      expect(await engine.similarity.index(artifactId)).toMatchObject({ ok: true, value: { kind: "text" } });
      expect(await engine.similarity.findSimilarText("A cat sleeps on a warm rug.")).toMatchObject({
        ok: true, value: [expect.objectContaining({ artifactId })],
      });
    } finally { engine.close(); }
    engine = createEngine({ ...config, similarity: { modelCacheDir, text: { allowModelDownload: false } } });
    try {
      await engine.ready;
      expect(await engine.similarity.findSimilarText("A cat sleeps on a warm rug.")).toMatchObject({
        ok: true, value: [expect.objectContaining({ artifactId })],
      });
    } finally { engine.close(); }
    const modelPath = "onnx-community/all-MiniLM-L6-v2-ONNX/aff7a1dc4e8a1ea593e6ea21e95c22ef0a25966f";
    const badCache = join(root, "bad-cache");
    await cp(join(modelCacheDir, modelPath), join(badCache, modelPath), { recursive: true });
    const shard = join(badCache, modelPath, "onnx/model_q4.onnx_data");
    const bytes = await readFile(shard);
    bytes[bytes.length - 1] = bytes[bytes.length - 1]! ^ 1;
    await writeFile(shard, bytes);
    engine = createEngine({ rootDir: join(root, "corrupted-book"), initialBookName: "corrupted-text",
      similarity: { modelCacheDir: badCache, text: {} } });
    try {
      await engine.ready;
      expect(await engine.similarity.prepare({ kind: "text" })).toMatchObject({ ok: false, error: { code: "MODEL_UNAVAILABLE" } });
      expect((await engine.artifacts.create({ kind: "script", label: "Still writable" })).ok).toBe(true);
    } finally { engine.close(); }
  }, 180_000);

  it("runs CLIP text and image inference in one normalized space", async () => {
    const root = await mkdtemp(join(tmpdir(), "videobook-clip-e2e-"));
    roots.push(root);
    const imagePath = join(root, "red.png");
    await sharp({
      create: {
        width: 224,
        height: 224,
        channels: 3,
        background: { r: 220, g: 20, b: 20 },
      },
    }).png().toFile(imagePath);
    const provider = new LocalClipTemporalProvider({
      modelCacheDir: join(homedir(), ".cache", "videobook", "models"),
      allowModelDownload: false,
    });
    const [text, image] = await Promise.all([
      provider.embedText("a solid red image"),
      provider.embedImage(imagePath),
    ]);
    expectNormalized(text, 512);
    expectNormalized(image, 512);
    expect(dot(text, image)).toBeGreaterThan(0);
  }, 15 * 60_000);

  it("runs CLAP text and decoded audio inference in one normalized space", async () => {
    const root = await mkdtemp(join(tmpdir(), "videobook-clap-e2e-"));
    roots.push(root);
    const audioPath = join(root, "tone.wav");
    await execFileAsync("ffmpeg", [
      "-y",
      "-f", "lavfi",
      "-i", "sine=frequency=440:duration=2:sample_rate=48000",
      audioPath,
    ]);
    const provider = new LocalClapTemporalProvider({
      modelCacheDir: join(homedir(), ".cache", "videobook", "models"),
      ffmpegPath: "ffmpeg",
      allowModelDownload: false,
    });
    const [text, audio] = await Promise.all([
      provider.embedText("a steady electronic tone"),
      provider.embedAudio(audioPath, 0, 2),
    ]);
    expectNormalized(text, 512);
    expectNormalized(audio, 512);
    expect(dot(text, audio)).toBeGreaterThan(-1);
    await expect(provider.embedAudio(audioPath, 0, 2, { timeoutMs: 1 }))
      .rejects.toMatchObject({ error: { code: "TIMEOUT" } });
    const controller = new AbortController();
    const cancelled = provider.embedAudio(audioPath, 0, 2, { signal: controller.signal });
    const assertion = expect(cancelled).rejects.toMatchObject({ error: { code: "CANCELLED" } });
    setTimeout(() => controller.abort(), 1);
    await assertion;
    const malformed = join(root, "malformed.wav");
    await writeFile(malformed, "not audio");
    await expect(provider.embedAudio(malformed)).rejects.toMatchObject({ error: { code: "INVALID_INPUT" } });
    expectNormalized(await provider.embedAudio(audioPath, 0, 2), 512);
  }, 15 * 60_000);
});

function expectNormalized(vector: Float32Array, dimensions: number): void {
  expect(vector).toHaveLength(dimensions);
  expect([...vector].every(Number.isFinite)).toBe(true);
  const magnitude = Math.sqrt(
    [...vector].reduce((sum, value) => sum + value * value, 0),
  );
  expect(magnitude).toBeCloseTo(1, 4);
}

function dot(left: Float32Array, right: Float32Array): number {
  return [...left].reduce(
    (sum, value, index) => sum + value * (right[index] ?? 0),
    0,
  );
}
