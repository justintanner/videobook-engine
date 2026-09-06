import { createServer, type Server } from "node:http";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createEngine, LOCAL_CLIP_MANIFEST, type Engine, type SimilarityConfig } from "../src/index.js";
import { env } from "../src/transformers-runtime.js";
import { ModelFileResolver } from "../src/model-file-resolver.js";
import type { ModelWorkerConfiguration } from "../src/model-worker-protocol.js";

const revision = "a".repeat(40);
const secondRevision = "b".repeat(40);
const kinds = ["image", "audio", "text"] as const;
type Kind = typeof kinds[number];
type Selection = { modelId?: string; modelRevision?: string };

function value<T>(result: { ok: true; value: T } | { ok: false; error: { message: string } }): T {
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

describe("immutable similarity model revisions", () => {
  let root: string;
  let server: Server;
  let originalHost: string;
  let requests: string[];
  let engines: Engine[];

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "videobook-model-revisions-"));
    engines = [];
    requests = [];
    originalHost = env.remoteHost;
    server = createServer((request, response) => {
      requests.push(request.url!);
      response.writeHead(404).end();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("No fixture address");
    env.remoteHost = `http://127.0.0.1:${address.port}/`;
  });

  afterEach(async () => {
    for (const engine of engines) engine.close();
    env.remoteHost = originalHost;
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true, maxRetries: 3 });
  });

  function engine(kind: Kind, selection: Selection = {}, allowModelDownload = false) {
    const model = { ...selection, allowModelDownload };
    const similarity: SimilarityConfig = { modelCacheDir: join(root, "cache"),
      ...(kind === "image" ? model : { [kind]: model }) };
    const engine = createEngine({ rootDir: join(root, `book-${engines.length}`), initialBookName: "revisions", similarity });
    engines.push(engine);
    return engine;
  }

  it.each(kinds)("rejects missing, moving and malformed custom %s revisions before network activity", async (kind) => {
    for (const modelRevision of [undefined, "main", "release-v1", "abcdef0", "../snapshot"]) {
      const target = engine(kind, { modelId: "fixture/custom-model", modelRevision }, true);
      await target.ready;
      expect(await target.similarity.prepare({ kind })).toMatchObject({ ok: false, error: { code: "INVALID_INPUT", message: expect.stringContaining("40-character commit") } });
      expect((await target.artifacts.create("script", "Still writable")).ok).toBe(true);
    }
    expect(requests).toEqual([]);
  });

  it.each(kinds)("forwards the same immutable custom %s revision to model file requests", async (kind) => {
    const target = engine(kind, { modelId: "fixture/custom-model", modelRevision: revision.toUpperCase() }, true);
    await target.ready;
    expect(await target.similarity.prepare({ kind })).toMatchObject({ ok: false, error: { code: "FEATURE_UNAVAILABLE" } });
    expect(requests.length).toBeGreaterThan(0);
    expect(requests.every((url) => url.startsWith(`/fixture/custom-model/resolve/${revision}/`))).toBe(true);
    expect(requests.some((url) => url.includes("main"))).toBe(false);
  });

  it.each(kinds)("separates custom %s model identities by repository and revision while preserving defaults", async (kind) => {
    const defaults = engine(kind);
    const first = engine(kind, { modelId: "fixture/model-one", modelRevision: revision });
    const equivalent = engine(kind, { modelId: "fixture/model-one", modelRevision: revision.toUpperCase() });
    const changed = engine(kind, { modelId: "fixture/model-one", modelRevision: secondRevision });
    const collision = engine(kind, { modelId: "fixture/model_one", modelRevision: revision });
    await Promise.all(engines.map((engine) => engine.ready));
    const space = (target: Engine) => value(target.similarity.stats()).embeddingSpaces[kind];
    expect(space(first)).toBe(space(equivalent));
    expect(new Set([space(defaults), space(first), space(changed), space(collision)]).size).toBe(4);
    if (kind === "image") expect(space(defaults)).toBe(`clip-vit-b32-q8-${LOCAL_CLIP_MANIFEST.modelRevision}-compat-visual-v2`);
    expect(requests).toEqual([]);
  });

  it("does not reuse ambiguous legacy custom visual vectors as built-in vectors", async () => {
    const bookRoot = join(root, "legacy-custom");
    const vector = new Float32Array(512);
    vector[0] = 1;
    const legacy = createEngine({ rootDir: bookRoot, initialBookName: "legacy custom", similarity: { provider: {
      networkAccess: { modelDownloads: false, inference: false },
      embeddingSpace: LOCAL_CLIP_MANIFEST.embeddingSpace, dimensions: 512,
      async prepare() {}, async embedImage() { return vector; },
      async embedVideo() { return { vector, frameCount: 1 }; },
    } } });
    await legacy.ready;
    let artifactId: string;
    try {
      artifactId = value(await legacy.artifacts.create("image", "Legacy custom vectors")).artifactId;
      value(await legacy.files.write(artifactId, "original.jpg", "source bytes"));
      value(await legacy.similarity.index(artifactId));
      expect(value(legacy.similarity.status(artifactId)).state).toBe("ready");
    } finally { legacy.close(); }
    const current = createEngine({ rootDir: bookRoot, similarity: { modelCacheDir: join(root, "cache") } });
    engines.push(current);
    await current.ready;
    expect(value(current.similarity.status(artifactId)).state).toBe("not_indexed");
    expect(await current.similarity.findSimilar(artifactId, { includeSelf: true })).toMatchObject({ ok: false, error: { code: "NOT_READY" } });
    expect(value(await current.files.read(artifactId, "original.jpg")).toString()).toBe("source bytes");
    expect(requests).toEqual([]);
  });

  it("does not inherit a visual model revision into the audio or text default", async () => {
    const target = createEngine({ rootDir: join(root, "separate-revisions"), initialBookName: "revisions",
      similarity: { modelId: "fixture/image", modelRevision: revision, audio: {}, text: {} } });
    engines.push(target);
    await target.ready;
    const spaces = value(target.similarity.stats()).embeddingSpaces;
    expect(spaces.audio).toBe("clap-htsat-unfused-q8-c28f2883575e590e04d3146ff0713c2448d691ba-audio-v1");
    expect(spaces.text).toBe("all-minilm-l6-v2-q4-aff7a1dc4e8a1ea593e6ea21e95c22ef0a25966f-text-v1");
    expect(spaces.image).toMatch(/^custom-/u);
  });

  it("snapshots model selection so later config changes cannot mix worker and index identities", async () => {
    const similarity = { modelCacheDir: join(root, "cache"), modelId: "fixture/first", modelRevision: revision, allowModelDownload: true };
    const target = createEngine({ rootDir: join(root, "snapshot"), initialBookName: "snapshot", similarity });
    engines.push(target);
    await target.ready;
    const before = value(target.similarity.stats()).embeddingSpace;
    similarity.modelId = "fixture/second";
    similarity.modelRevision = secondRevision;
    expect(await target.similarity.prepare({ kind: "image" })).toMatchObject({ ok: false, error: { code: "FEATURE_UNAVAILABLE" } });
    expect(value(target.similarity.stats()).embeddingSpace).toBe(before);
    expect(requests.length).toBeGreaterThan(0);
    expect(requests.every((url) => url.startsWith(`/fixture/first/resolve/${revision}/`))).toBe(true);
  });

  it.each(kinds)("keeps explicit local %s directories usable without a remote revision", async (kind) => {
    const directory = join(root, "local-model");
    await mkdir(directory);
    const absolute = engine(kind, { modelId: directory });
    const relativePath = `./${relative(process.cwd(), directory)}`;
    const local = engine(kind, { modelId: relativePath });
    await Promise.all([absolute.ready, local.ready]);
    expect(value(absolute.similarity.stats()).embeddingSpaces[kind]).toBe(value(local.similarity.stats()).embeddingSpaces[kind]);
    expect(await absolute.similarity.prepare({ kind })).toMatchObject({ ok: false, error: { code: "OFFLINE" } });
    expect(requests).toEqual([]);
  });

  it("rejects cross-repository and cross-revision file requests and avoids unversioned local fallback", async () => {
    const modelId = "fixture/custom-model";
    const localModelPath = join(root, "unversioned-local");
    await mkdir(join(localModelPath, modelId), { recursive: true });
    await writeFile(join(localModelPath, modelId, "config.json"), '{"unversioned":true}');
    const config: ModelWorkerConfiguration = {
      kind: "compat-clip", modelId, modelRevision: revision, modelCacheDir: join(root, "cache"),
      allowModelDownload: false, allowRemoteModels: true, allowLocalModels: true, localModelPath,
      remoteHost: env.remoteHost, remotePathTemplate: "{model}/resolve/{revision}/",
    };
    const resolver = new ModelFileResolver(config, join(root, "worker"));
    for (const [id, selected] of [[modelId, "main"], [modelId, secondRevision], ["fixture/other", revision]]) {
      await expect(resolver.get(id!, "config.json", true, { revision: selected })).rejects.toMatchObject({ error: { code: "MODEL_UNAVAILABLE" } });
    }
    await expect(resolver.get(modelId, "config.json", true, { revision })).rejects.toMatchObject({ error: { code: "OFFLINE" } });
    expect(requests).toEqual([]);
  });
});
