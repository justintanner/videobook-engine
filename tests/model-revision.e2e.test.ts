import { execFile } from "node:child_process";
import { createReadStream } from "node:fs";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { createServer } from "node:http";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { createEngine, type Engine, type SimilarityConfig } from "../src/index.js";
import { env } from "../src/transformers-runtime.js";
import checksums from "../src/model-checksums.json" with { type: "json" };

const run = promisify(execFile);
const fixtures = [
  { kind: "image", repository: "Xenova/clip-vit-base-patch32", revision: "d15189d7028b43f1d3e65039190477f6af591c2a", filename: "original.jpg" },
  { kind: "audio", repository: "Xenova/clap-htsat-unfused", revision: "c28f2883575e590e04d3146ff0713c2448d691ba", filename: "original.wav" },
  { kind: "text", repository: "onnx-community/all-MiniLM-L6-v2-ONNX", revision: "aff7a1dc4e8a1ea593e6ea21e95c22ef0a25966f", filename: "original.txt" },
] as const;

function value<T>(result: { ok: true; value: T } | { ok: false; error: { message: string } }): T {
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

describe.runIf(process.env.VIDEOBOOK_RUN_CUSTOM_MODEL_E2E === "1")("real models through custom immutable repository IDs", () => {
  it.each(fixtures)("keeps $kind files and embedding identity pinned through indexing, offline reopen and local-directory use", async (fixture) => {
    const root = await mkdtemp(join(tmpdir(), "videobook-custom-model-e2e-"));
    const sourceCache = process.env.VIDEOBOOK_MODEL_FIXTURE_CACHE ?? join(homedir(), ".cache", "videobook", "models");
    const source = join(sourceCache, fixture.repository, fixture.revision);
    const catalog = checksums as Record<string, Record<string, { digest: string }>>;
    const inventory = catalog[`${fixture.repository}/${fixture.revision}`]!;
    const modelId = `fixture/${fixture.kind}`;
    const modelCacheDir = join(root, "cache");
    const requests: string[] = [];
    const secondRevision = "b".repeat(40);
    let movingAlias = fixture.revision as string;
    const server = createServer((request, response) => {
      void (async () => {
        const url = request.url!;
        requests.push(url);
        movingAlias = secondRevision;
        const prefix = `/${modelId}/resolve/${fixture.revision}/`;
        if (!url.startsWith(prefix)) { response.writeHead(404).end(); return; }
        const filename = url.slice(prefix.length);
        const digest = inventory[filename]?.digest;
        if (!digest) { response.writeHead(404).end(); return; }
        const path = join(source, filename);
        response.writeHead(200, { ETag: `"${digest}"`, "Content-Length": (await stat(path)).size });
        createReadStream(path).pipe(response);
      })().catch(() => response.writeHead(404).end());
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Fixture server has no address");
    const oldHost = env.remoteHost;
    env.remoteHost = `http://127.0.0.1:${address.port}/`;
    let engine: Engine | undefined;
    const configuration = (selection: { modelId: string; modelRevision?: string; allowModelDownload?: boolean }): SimilarityConfig => ({
      modelCacheDir, ...(fixture.kind === "image" ? selection : { [fixture.kind]: selection }),
    });
    try {
      let media: Buffer;
      if (fixture.kind === "image") media = await readFile(fileURLToPath(new URL("../fixtures/media/vancat_profile.jpg", import.meta.url)));
      else if (fixture.kind === "audio") {
        const audio = join(root, "tone.wav");
        await run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-nostdin", "-y", "-f", "lavfi", "-i", "sine=frequency=440:duration=1:sample_rate=48000", audio]);
        media = await readFile(audio);
      } else media = Buffer.from("A white cat rides in a van and looks through the window.");
      const bookRoot = join(root, "book");
      engine = createEngine({ rootDir: bookRoot, initialBookName: "custom pin", similarity: configuration({ modelId, modelRevision: fixture.revision, allowModelDownload: true }) });
      await engine.ready;
      value(await engine.similarity.prepare({ kind: fixture.kind }));
      const artifact = value(await engine.artifacts.create(fixture.kind === "text" ? "script" : fixture.kind, "Fixture"));
      value(await engine.files.write(artifact.artifactId, fixture.filename, media));
      const indexed = value(await engine.similarity.index(artifact.artifactId));
      expect(indexed.embeddingSpace).toMatch(/^custom-/u);
      expect(value(await engine.similarity.findSimilar(artifact.artifactId, { includeSelf: true }))[0]?.artifactId).toBe(artifact.artifactId);
      const requestCount = requests.length;
      expect(requestCount).toBeGreaterThan(1);
      expect(movingAlias).toBe(secondRevision);
      expect(requests.every((url) => url.startsWith(`/${modelId}/resolve/${fixture.revision}/`))).toBe(true);
      const receipt = JSON.parse(await readFile(join(modelCacheDir, modelId, fixture.revision, "config.json.videobook-integrity.json"), "utf8"));
      expect(receipt).toMatchObject({ modelId, revision: fixture.revision, source: "hub-etag" });
      engine.close();
      engine = createEngine({ rootDir: bookRoot, similarity: configuration({ modelId, modelRevision: fixture.revision }) });
      await engine.ready;
      value(await engine.similarity.prepare({ kind: fixture.kind }));
      expect(value(await engine.similarity.index(artifact.artifactId, { force: true })).embeddingSpace).toBe(indexed.embeddingSpace);
      expect(value(await engine.similarity.findSimilar(artifact.artifactId, { includeSelf: true }))[0]?.artifactId).toBe(artifact.artifactId);
      expect(requests).toHaveLength(requestCount);
      engine.close();
      engine = createEngine({ rootDir: bookRoot, similarity: configuration({ modelId, modelRevision: secondRevision }) });
      await engine.ready;
      expect(value(engine.similarity.status(artifact.artifactId))).toMatchObject({ state: "not_indexed" });
      expect(value(engine.similarity.stats()).embeddingSpaces[fixture.kind]).not.toBe(indexed.embeddingSpace);
      expect(await engine.similarity.findSimilar(artifact.artifactId, { includeSelf: true })).toMatchObject({ ok: false, error: { code: "NOT_READY" } });
      expect(await engine.similarity.prepare({ kind: fixture.kind })).toMatchObject({ ok: false, error: { code: "OFFLINE" } });
      expect(value(await engine.files.read(artifact.artifactId, fixture.filename))).toEqual(media);
      expect(requests).toHaveLength(requestCount);
      engine.close();
      engine = createEngine({ rootDir: join(root, "local-book"), initialBookName: "local directory", similarity: configuration({ modelId: source }) });
      await engine.ready;
      value(await engine.similarity.prepare({ kind: fixture.kind }));
      const local = value(await engine.artifacts.create(fixture.kind === "text" ? "script" : fixture.kind, "Local fixture"));
      value(await engine.files.write(local.artifactId, fixture.filename, media));
      value(await engine.similarity.index(local.artifactId));
      expect(value(await engine.similarity.findSimilar(local.artifactId, { includeSelf: true }))[0]?.artifactId).toBe(local.artifactId);
      expect(requests).toHaveLength(requestCount);
    } finally {
      engine?.close();
      env.remoteHost = oldHost;
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(root, { recursive: true, force: true, maxRetries: 3 });
    }
  }, 180_000);
});
