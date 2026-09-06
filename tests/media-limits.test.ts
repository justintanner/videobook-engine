import { mkdtemp, open, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { afterEach, expect, it } from "vitest";
import { runMediaProcess } from "../src/media-process.js";
import { decodeModelImage, MAX_MODEL_IMAGE_BYTES, MAX_MODEL_IMAGE_PIXELS } from "../src/media-image.js";
import { createEngine, LocalClapTemporalProvider, LocalClipTemporalProvider } from "../src/index.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true, maxRetries: 3 })));
});
async function root() {
  const value = await mkdtemp(join(tmpdir(), "videobook-media-limits-"));
  roots.push(value);
  return value;
}

it("passes untrusted arguments literally without a shell", async () => {
  const argument = "$(touch forbidden); `exit 1` & <secret>";
  const result = await runMediaProcess(process.execPath, ["-e", "process.stdout.write(process.argv[1])", argument]);
  expect(result.stdout.toString()).toBe(argument);
});

it.each(["stdout", "stderr"] as const)("kills a noisy child at the %s byte limit", async (stream) => {
  const promise = runMediaProcess(process.execPath, ["-e", `setInterval(() => process.${stream}.write(Buffer.alloc(65536)), 1)`], {
    maxStdoutBytes: 1024, maxStderrBytes: 1024, timeoutMs: 2000,
  });
  await expect(promise).rejects.toMatchObject({ error: { code: "RESOURCE_EXHAUSTED", details: { stream, limitBytes: 1024 } } });
});

it("kills a stalled process at its deadline", async () => {
  const started = performance.now();
  await expect(runMediaProcess(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { timeoutMs: 100 }))
    .rejects.toMatchObject({ error: { code: "TIMEOUT" } });
  expect(performance.now() - started).toBeLessThan(2000);
});

it("cancels a running process and rejects cancellation before spawn", async () => {
  const controller = new AbortController();
  const promise = runMediaProcess(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { signal: controller.signal });
  const assertion = expect(promise).rejects.toMatchObject({ error: { code: "CANCELLED" } });
  controller.abort("private cancellation reason");
  await assertion;
  await expect(runMediaProcess("missing-executable", [], { signal: controller.signal }))
    .rejects.toMatchObject({ error: { code: "CANCELLED" } });
});

it("returns bounded errors without decoder output or private input content", async () => {
  const result = runMediaProcess(process.execPath, ["-e", "process.stderr.write('secret-token=private'); process.exit(7)"]);
  await expect(result).rejects.toMatchObject({ error: { code: "INVALID_INPUT", message: "Media process failed", details: { exitCode: 7 } } });
  await expect(runMediaProcess("/missing/media-executable", [])).rejects.toMatchObject({ error: { code: "FEATURE_UNAVAILABLE" } });
});

it.each([0, -1, Infinity, NaN, 2 ** 32])("rejects invalid timeout %s", async (timeoutMs) => {
  await expect(runMediaProcess(process.execPath, [], { timeoutMs })).rejects.toMatchObject({ error: { code: "INVALID_INPUT" } });
});

it("normalizes a real image and rejects malformed, oversized and high-expansion inputs", async () => {
  const directory = await root();
  const valid = join(directory, "valid.png");
  await sharp({ create: { width: 24, height: 16, channels: 4, background: "red" } }).png().toFile(valid);
  expect((await decodeModelImage(valid)).info).toMatchObject({ width: 24, height: 16, channels: 3 });
  const malformed = join(directory, "malformed.png");
  await writeFile(malformed, "not an image");
  await expect(decodeModelImage(malformed)).rejects.toMatchObject({ error: { code: "INVALID_INPUT" } });
  const oversized = join(directory, "oversized.png");
  const handle = await open(oversized, "w");
  await handle.truncate(MAX_MODEL_IMAGE_BYTES + 1);
  await handle.close();
  await expect(decodeModelImage(oversized)).rejects.toMatchObject({ error: { code: "RESOURCE_EXHAUSTED" } });
  const expansion = join(directory, "expansion.svg");
  const side = Math.ceil(Math.sqrt(MAX_MODEL_IMAGE_PIXELS)) + 1;
  await writeFile(expansion, `<svg xmlns="http://www.w3.org/2000/svg" width="${side}" height="${side}"><rect width="100%" height="100%" fill="red"/></svg>`);
  await expect(decodeModelImage(expansion)).rejects.toMatchObject({ error: { code: "RESOURCE_EXHAUSTED" } });
});

it("rejects already cancelled model work before preparation or decoding", async () => {
  const modelCacheDir = await root();
  const options = { signal: AbortSignal.abort() };
  const clip = new LocalClipTemporalProvider({ modelCacheDir });
  const clap = new LocalClapTemporalProvider({ modelCacheDir });
  for (const promise of [clip.prepare(options), clap.prepare(options), clip.embedImage("missing", options), clap.embedAudio("missing", 0, 1, options)]) {
    await expect(promise).rejects.toMatchObject({ error: { code: "CANCELLED" } });
  }
});

it("keeps book state and prior coverage intact when real image decoding fails, then allows retry", async () => {
  const rootDir = await root();
  const engine = createEngine({ rootDir, initialBookName: "decode-retry", similarity: { provider: {
    networkAccess: { modelDownloads: false, inference: false },
    embeddingSpace: "real-image-decoder-fixture", dimensions: 3, async prepare() {},
    async embedImage(source, options) { await decodeModelImage(source, options); return Float32Array.from([1, 0, 0]); },
    async embedVideo() { throw new Error("Video is outside this fixture"); },
  } } });
  await engine.ready;
  try {
    const artifact = await engine.artifacts.create("image", "decode-retry");
    if (!artifact.ok) throw new Error(artifact.error.message);
    const artifactId = artifact.value.artifactId;
    await engine.files.write(artifactId, "original.png", "malformed");
    const head = engine.head;
    expect(await engine.similarity.index(artifactId)).toMatchObject({ ok: false, error: { code: "INVALID_INPUT" } });
    expect(engine.head).toBe(head);
    expect((await engine.files.read(artifactId, "original.png"))).toMatchObject({ ok: true });
    const image = await sharp({ create: { width: 10, height: 10, channels: 3, background: "red" } }).png().toBuffer();
    await engine.files.write(artifactId, "original.png", image);
    expect(await engine.similarity.index(artifactId)).toMatchObject({ ok: true });
    const ready = engine.similarity.status(artifactId);
    expect(await engine.similarity.index(artifactId, { force: true, signal: AbortSignal.abort() })).toMatchObject({ ok: false, error: { code: "CANCELLED" } });
    expect(engine.similarity.status(artifactId)).toEqual(ready);
  } finally { engine.close(); }
});
