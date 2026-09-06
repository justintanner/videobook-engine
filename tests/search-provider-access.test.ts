import { createServer, type Server } from "node:http";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createEngine, LocalClipTemporalProvider, LocalClapTemporalProvider,
  type Engine, type IndexManifest, type SearchProviderNetworkAccess,
  type SimilarityConfig, type TemporalSearchProvider, type MediaOperationOptions,
} from "../src/index.js";

const manifest: IndexManifest = {
  manifestId: "network-fixture", provider: "network-fixture", modelId: "fixture",
  modelRevision: "1", license: "test", embeddingSpace: "network-fixture", dimensions: 3,
  modalities: ["visual"], supportedLanguages: ["en"], preprocessingVersion: "1",
  extractorVersion: "1", createdAt: 1,
};

function value<T>(result: { ok: true; value: T } | { ok: false; error: { message: string } }): T {
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

describe("application-owned search provider consent", () => {
  let root: string;
  let engines: Engine[];
  let server: Server;
  let endpoint: string;
  let requests: Array<{ path: string; body: string }>;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "videobook-provider-access-"));
    engines = [];
    requests = [];
    server = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      requests.push({ path: request.url!, body: Buffer.concat(chunks).toString() });
      response.end(JSON.stringify([1, 0, 0]));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("No fixture listener");
    endpoint = `http://127.0.0.1:${address.port}`;
  });

  afterEach(async () => {
    for (const engine of engines) engine.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true, maxRetries: 3 });
  });

  function engine(similarity?: SimilarityConfig) {
    const created = createEngine({ rootDir: join(root, String(engines.length)), initialBookName: "consent", similarity });
    engines.push(created);
    return created;
  }

  function remote(networkAccess?: SearchProviderNetworkAccess): TemporalSearchProvider {
    return Object.freeze({
      manifestId: manifest.manifestId, networkAccess,
      async prepare() { await fetch(`${endpoint}/prepare`); },
      async embedText(text: string) {
        return new Float32Array(await (await fetch(`${endpoint}/inference`, { method: "POST", body: text })).json() as number[]);
      },
    });
  }

  async function indexed(target: Engine) {
    await target.ready;
    value(target.temporalSearch.manifests.register(manifest));
    const artifact = value(await target.artifacts.create("image", "Private media label"));
    value(await target.files.write(artifact.artifactId, "original.jpg", "private media bytes"));
    const objectHash = value(await target.files.manifest(artifact.artifactId)).files[0]!.objectHash;
    value(target.temporalSearch.commitBatch({
      artifactId: artifact.artifactId, objectHash, manifestId: manifest.manifestId, generation: "1", phase: "visual",
      maxUnits: 1, totalUnits: 1, complete: true, coveredRanges: [], observations: [{
        artifactId: artifact.artifactId, objectHash, sourcePath: "original.jpg", kind: "frame", segmentationVersion: "1", texts: [], fingerprints: [],
        embeddings: [{ modality: "visual", embeddingSpace: manifest.embeddingSpace, vector: [1, 0, 0], sourceHash: objectHash }],
      }],
    }));
    value(target.temporalSearch.activate(manifest.manifestId, "1"));
    return artifact.artifactId;
  }

  it("refuses undeclared behavior and distinguishes downloads from remote inference before any network request", () => {
    const target = engine();
    expect(() => target.temporalSearch.providers.register(remote())).toThrow("must declare");
    expect(() => target.temporalSearch.providers.register(remote({ modelDownloads: true, inference: true }), { modelDownloads: true })).toThrow("application consent");
    expect(() => target.temporalSearch.providers.register(remote({ modelDownloads: true, inference: false }), { inference: true })).toThrow("application consent");
    expect(() => target.temporalSearch.providers.register(remote({ modelDownloads: "false", inference: false } as unknown as SearchProviderNetworkAccess))).toThrow("must declare");
    expect(target.temporalSearch.providers.list()).toEqual([]);
    expect(requests).toEqual([]);
  });

  it("sends only query text after explicit consent, works with frozen providers, and scopes registrations to an Engine", async () => {
    const first = engine();
    const second = engine();
    const artifactId = await indexed(first);
    await indexed(second);
    const provider = remote({ modelDownloads: true, inference: true });
    first.temporalSearch.providers.register(provider, { modelDownloads: true, inference: true });
    const query = { text: "a cat", modalities: ["visual" as const] };
    expect(value(await first.temporalSearch.query(query)).hits[0]?.artifactId).toBe(artifactId);
    expect(requests).toEqual([{ path: "/prepare", body: "" }, { path: "/inference", body: "a cat" }]);
    expect(value(await second.temporalSearch.query(query)).hits).toEqual([]);
    expect(requests).toHaveLength(2);
    expect(first.temporalSearch.providers.unregister(manifest.manifestId)).toBe(true);
    expect(value(await first.temporalSearch.query(query)).hits).toEqual([]);
    expect(requests).toHaveLength(2);
  });

  it.each(["declaration", "unregister", "replace", "same"])("rechecks authorization after asynchronous preparation: %s", async (change) => {
    const target = engine();
    await indexed(target);
    const networkAccess = { modelDownloads: false, inference: false };
    let started!: () => void;
    let resume!: () => void;
    const preparing = new Promise<void>((resolve) => { started = resolve; });
    const continuation = new Promise<void>((resolve) => { resume = resolve; });
    let embedded = false;
    const provider = {
      ...remote(networkAccess),
      async embedText() { embedded = true; return new Float32Array([1, 0, 0]); },
      async prepare() { started(); await continuation; },
    };
    target.temporalSearch.providers.register(provider);
    const pending = target.temporalSearch.query({ text: "private query", modalities: ["visual"] });
    await preparing;
    if (change === "declaration") networkAccess.inference = true;
    else if (change === "unregister") target.temporalSearch.providers.unregister(manifest.manifestId);
    else if (change === "same") target.temporalSearch.providers.register(provider);
    else target.temporalSearch.providers.register({ ...provider, async prepare() {} });
    resume();
    expect(await pending).toMatchObject(change === "same"
      ? { ok: true }
      : { ok: false, error: { code: change === "declaration" ? "INVALID_INPUT" : "OFFLINE" } });
    expect(embedded).toBe(change === "same");
    expect(requests).toEqual([]);
  });

  it("keeps built-in inference local and snapshots constructor download configuration", () => {
    const options = { modelCacheDir: join(root, "models"), allowModelDownload: false };
    for (const Provider of [LocalClipTemporalProvider, LocalClapTemporalProvider]) {
      options.allowModelDownload = false;
      const provider = new Provider(options);
      options.allowModelDownload = true;
      expect(provider.networkAccess).toEqual({ modelDownloads: false, inference: false });
      expect(Object.isFrozen(provider.networkAccess)).toBe(true);
      const target = engine();
      target.temporalSearch.providers.register(provider);
      expect(() => target.temporalSearch.providers.register(new Provider(options))).toThrow("application consent");
      target.temporalSearch.providers.register(new Provider(options), { modelDownloads: true });
    }
    expect(requests).toEqual([]);
  });

  function compatibility(networkAccess?: SearchProviderNetworkAccess) {
    return {
      networkAccess, dimensions: 3, embeddingSpace: "consent-compat",
      async prepare() { await fetch(`${endpoint}/prepare`); },
      async embedImage(sourcePath: string) { return send(await readFile(sourcePath, "utf8")); },
      async embedVideo(sourcePath: string) { return { vector: await this.embedImage(sourcePath), frameCount: 1 }; },
      async embedAudio(sourcePath: string) { return this.embedImage(sourcePath); },
      async embedText(text: string) { return [{ startOffset: 0, endOffset: text.length, vector: await send(text) }]; },
    };
  }

  async function send(body: string) {
    const response = await fetch(`${endpoint}/inference`, { method: "POST", body });
    return new Float32Array(await response.json() as number[]);
  }

  it.each([undefined, { modelDownloads: false, inference: true }])("denies every legacy provider modality without a valid declaration and grant: %j", async (access) => {
    const provider = compatibility(access);
    const target = engine({ provider, audio: { provider }, text: { provider } });
    await target.ready;
    for (const [kind, filename] of [["image", "original.jpg"], ["video", "original.mp4"], ["audio", "original.wav"], ["script", "original.txt"]] as const) {
      const artifact = value(await target.artifacts.create(kind, "Private label"));
      value(await target.files.write(artifact.artifactId, filename, "private bytes"));
      expect(await target.similarity.index(artifact.artifactId)).toMatchObject({ ok: false, error: { code: access ? "OFFLINE" : "INVALID_INPUT" } });
    }
    expect(await target.similarity.findSimilarText("private query")).toMatchObject({ ok: false, error: { code: access ? "OFFLINE" : "INVALID_INPUT" } });
    expect(requests).toEqual([]);
  });

  it("dispatches each legacy modality only with its explicit grant", async () => {
    const provider = Object.freeze(compatibility({ modelDownloads: false, inference: true }));
    const providerConsent = { inference: true };
    const target = engine({ provider, providerConsent, audio: { provider, providerConsent }, text: { provider, providerConsent } });
    await target.ready;
    for (const [kind, filename] of [["image", "original.jpg"], ["video", "original.mp4"], ["audio", "original.wav"], ["script", "original.txt"]] as const) {
      const artifact = value(await target.artifacts.create(kind, "Unsent private label"));
      value(await target.files.write(artifact.artifactId, filename, `${kind} bytes`));
      expect(await target.similarity.index(artifact.artifactId)).toMatchObject({ ok: true });
      expect(requests.at(-1)).toEqual({ path: "/inference", body: `${kind} bytes` });
    }
    expect(requests.filter((request) => request.path === "/inference")).toHaveLength(4);
  });

  it("does not inherit legacy image consent into audio/text and snapshots grants", async () => {
    const provider = compatibility({ modelDownloads: false, inference: true });
    const consent = { inference: true };
    const target = engine({ provider, providerConsent: consent, audio: { provider }, text: { provider } });
    await target.ready;
    consent.inference = false;
    expect(await target.similarity.prepare({ kind: "image" })).toMatchObject({ ok: true });
    expect(await target.similarity.prepare({ kind: "audio" })).toMatchObject({ ok: false, error: { code: "OFFLINE" } });
    expect(await target.similarity.findSimilarText("private query")).toMatchObject({ ok: false, error: { code: "OFFLINE" } });
    expect(requests).toEqual([{ path: "/prepare", body: "" }]);
    const permitted = engine({ provider, providerConsent: { inference: true }, text: { provider, providerConsent: { inference: true } } });
    await permitted.ready;
    expect(await permitted.similarity.findSimilarText("explicit query")).toMatchObject({ ok: true });
    expect(requests.at(-1)).toEqual({ path: "/inference", body: "explicit query" });
  });
  it.each([["image", "original.jpg"], ["video", "original.mp4"], ["audio", "original.wav"], ["script", "original.txt"]] as const)(
    "scopes %s provider dispatch to the selected local file/text and operation controls", async (kind, filename) => {
      const controller = new AbortController();
      const receivedSignals: Array<AbortSignal | undefined> = [];
      const capture = async (phase: string, options?: MediaOperationOptions, source?: string) => {
        receivedSignals.push(options?.signal);
        await send(JSON.stringify({ phase, ...(source === undefined ? {} : { source }), options }));
        Object.assign(options ?? {}, { callerContext: "provider-change", force: false, limit: 0 });
        return new Float32Array([1, 0, 0]);
      };
      const provider = {
        networkAccess: { modelDownloads: false, inference: true }, dimensions: 3, embeddingSpace: "scoped-input-fixture",
        async prepare(options?: MediaOperationOptions) { await capture("prepare", options); },
        async embedImage(path: string, options?: MediaOperationOptions) { return capture("image", options, await readFile(path, "utf8")); },
        async embedVideo(path: string, options?: MediaOperationOptions) { return { vector: await capture("video", options, await readFile(path, "utf8")), frameCount: 1 }; },
        async embedAudio(path: string, options?: MediaOperationOptions) { return capture("audio", options, await readFile(path, "utf8")); },
        async embedText(text: string, options?: MediaOperationOptions) { return [{ startOffset: 0, endOffset: text.length, vector: await capture("text", options, text) }]; },
      };
      const providerConsent = { inference: true };
      const first = engine({ provider, providerConsent, audio: { provider, providerConsent }, text: { provider, providerConsent } });
      const second = engine();
      await Promise.all([first.ready, second.ready]);
      const owned = value(await first.artifacts.create(kind, "Unsent label"));
      const foreign = value(await second.artifacts.create(kind, "Other book private label"));
      value(await first.files.write(owned.artifactId, filename, `${kind} selected bytes`));
      value(await first.files.write(owned.artifactId, "private-sidecar.txt", "Unsent adjacent content"));
      value(await first.metadata.artifacts.write(owned.artifactId, "original", { secret: "Unsent metadata" }));
      value(await second.files.write(foreign.artifactId, filename, "Other book secret bytes"));
      const foreignManifest = value(await second.files.manifest(foreign.artifactId));
      const foreignHash = foreignManifest.files[0]!.objectHash;
      const ownManifest = value(await first.files.manifest(owned.artifactId));
      const ownHash = ownManifest.files.find((file) => file.name === filename)!.objectHash;
      for (const reference of [foreign.artifactId, foreignHash, join(foreignManifest.path, filename), ownHash, join(ownManifest.path, filename)]) {
        expect(await first.similarity.index(reference)).toMatchObject({ ok: false, error: { code: "NOT_FOUND" } });
        expect(await first.similarity.findSimilar(reference)).toMatchObject({ ok: false, error: { code: "NOT_FOUND" } });
      }
      expect(requests).toEqual([]);
      const options = { force: true, signal: controller.signal, timeoutMs: 3_210, callerContext: { secret: "Unsent application context" } };
      expect(await first.similarity.index(owned.artifactId, options)).toMatchObject({ ok: true });
      expect(requests.map((request) => JSON.parse(request.body))).toEqual([
        { phase: "prepare", options: { signal: {}, timeoutMs: 3_210 } },
        { phase: kind === "script" ? "text" : kind, source: `${kind} selected bytes`, options: { signal: {}, timeoutMs: 3_210 } },
      ]);
      expect(receivedSignals).toEqual([controller.signal, controller.signal]);
      expect(options).toMatchObject({ force: true, callerContext: { secret: "Unsent application context" } });
      expect(value(await first.files.read(owned.artifactId, "private-sidecar.txt")).toString()).toBe("Unsent adjacent content");
      expect(value(await second.files.read(foreign.artifactId, filename)).toString()).toBe("Other book secret bytes");
    },
  );

  it("does not expose or allow provider mutation of preparation and text-query controls", async () => {
    const observed: unknown[] = [];
    const provider = {
      networkAccess: { modelDownloads: false, inference: true }, dimensions: 3, embeddingSpace: "scoped-text-query",
      async prepare(options?: MediaOperationOptions) {
        observed.push({ ...options });
        await send(JSON.stringify(options));
        Object.assign(options ?? {}, { limit: 0, kind: "audio", callerContext: "changed" });
      },
      async embedText(text: string, options?: MediaOperationOptions) {
        observed.push({ ...options });
        return [{ startOffset: 0, endOffset: text.length, vector: await send(JSON.stringify({ text, options })) }];
      },
    };
    const target = engine({ text: { provider, providerConsent: { inference: true } } });
    await target.ready;
    const prepare = { kind: "text" as const, timeoutMs: 3_210, callerContext: "private preparation context" };
    expect(await target.similarity.prepare(prepare)).toMatchObject({ ok: true });
    expect(observed).toEqual([{ timeoutMs: 3_210 }]);
    const query = { limit: 1, minScore: 0.5, timeoutMs: 3_210, callerContext: "private query context" };
    expect(await target.similarity.findSimilarText("Selected query", query)).toMatchObject({ ok: true });
    expect(observed).toEqual([{ timeoutMs: 3_210 }, { timeoutMs: 3_210 }, { timeoutMs: 3_210 }]);
    expect(requests.map((request) => JSON.parse(request.body))).toEqual([
      { timeoutMs: 3_210 }, { timeoutMs: 3_210 }, { text: "Selected query", options: { timeoutMs: 3_210 } },
    ]);
    expect(prepare).toEqual({ kind: "text", timeoutMs: 3_210, callerContext: "private preparation context" });
    expect(query).toEqual({ limit: 1, minScore: 0.5, timeoutMs: 3_210, callerContext: "private query context" });
  });

  it("keeps temporal references and candidate filters book-scoped without sending them to providers", async () => {
    const first = engine();
    const second = engine();
    const ownId = await indexed(first);
    const foreignId = await indexed(second);
    first.temporalSearch.providers.register(remote({ modelDownloads: false, inference: true }), { inference: true });
    const denied = await first.temporalSearch.query({ reference: { kind: "image", artifact: foreignId }, modalities: ["visual"] });
    expect(denied).toMatchObject({ ok: false, error: { code: "NOT_FOUND" } });
    expect(requests).toEqual([]);
    const prepared = { kind: "image" as const, embeddingSpace: manifest.embeddingSpace, vector: [1, 0, 0], callerContext: "Unsent reference context" };
    const empty = value(await first.temporalSearch.queryPrepared({ sourceArtifactIds: [foreignId], modalities: ["visual"] }, prepared));
    expect(empty.hits).toEqual([]);
    const own = value(await first.temporalSearch.queryPrepared({ sourceArtifactIds: [ownId], modalities: ["visual"] }, prepared));
    expect(own.hits[0]?.artifactId).toBe(ownId);
    expect(requests).toEqual([]);
    const query = { text: "Explicit text", modalities: ["visual" as const], sourceArtifactIds: [ownId], callerContext: "Unsent query context" };
    expect(value(await first.temporalSearch.query(query)).hits[0]?.artifactId).toBe(ownId);
    expect(requests).toEqual([{ path: "/prepare", body: "" }, { path: "/inference", body: "Explicit text" }]);
  });

});
