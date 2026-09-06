import { createServer, type ServerResponse } from "node:http";
import { mkdtemp, readFile, readdir, rm, stat, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createEngine, type ContentStore, type Engine, type SimilarityEmbeddingProvider } from "../src/index.js";

const bytes = Buffer.from("local image contents");
const cleanups: Array<() => Promise<void>> = [];
const provider: SimilarityEmbeddingProvider = {
  networkAccess: { modelDownloads: false, inference: false },
  embeddingSpace: "local-media-test", dimensions: 3,
  async prepare() {},
  async embedImage(source) {
    const input = await readFile(source);
    return new Float32Array([input.length, input[0]!, 1]);
  },
  async embedVideo(source) {
    return { vector: await this.embedImage(source), frameCount: 1 };
  },
};

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function value<T>(result: { ok: true; value: T } | { ok: false; error: { message: string } }): T {
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "videobook-local-media-"));
  const requests: string[] = [];
  const calls: string[] = [];
  const held: ServerResponse[] = [];
  let hold = false;
  const server = createServer((request, response) => {
    requests.push(request.url ?? "");
    if (hold) held.push(response);
    else response.end(bytes);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing fixture address");
  const remote: ContentStore = {
    async head() { calls.push("head"); return { exists: false }; },
    async uploadFile() { calls.push("upload"); },
    async delete() { calls.push("delete"); },
    async downloadFile(key, destination) {
      calls.push("download");
      const result = await fetch(`http://127.0.0.1:${address.port}/${key}`);
      await writeFile(destination, Buffer.from(await result.arrayBuffer()));
    },
  };
  const open = () => createEngine({ rootDir: root, initialBookName: "local", remoteObjects: remote, similarity: { provider } });
  let engine: Engine = open();
  cleanups.push(async () => {
    for (const response of held) response.destroy();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    engine.close();
    await rm(root, { recursive: true, force: true, maxRetries: 3 });
  });
  await engine.ready;
  const artifact = value(await engine.artifacts.create("image", "Original"));
  value(await engine.files.write(artifact.artifactId, "original.png", bytes));
  const manifest = value(await engine.files.manifest(artifact.artifactId));
  const hash = manifest.files[0]!.objectHash;
  const cas = join(root, "data", "objects", "sha256", hash.slice(0, 2), hash);
  const revision = engine.head;
  return {
    get engine() { return engine; },
    artifactId: artifact.artifactId, hash, cas, revision, root,
    media: join(manifest.path, "original.png"), calls, requests,
    async removeLocalBytes() {
      value(await engine.workspaces.evict(artifact.artifactId));
      engine.close();
      await unlink(cas);
      engine = open();
      await engine.ready;
    },
    hold() { hold = true; },
    release() { hold = false; for (const response of held.splice(0)) response.end(bytes); },
  };
}

describe("local media scope", () => {
  it.each(["read", "manifest", "workspace"])("rejects missing %s media across awaits without fetching or changing history", async (operation) => {
    const f = await fixture();
    await f.removeLocalBytes();
    const head = f.engine.head;
    const result = await f.engine.withLocalMedia(async () => {
      await Promise.resolve();
      return f.engine.withLocalMedia(() => operation === "read"
        ? f.engine.files.read(f.artifactId, "original.png")
        : operation === "manifest" ? f.engine.files.manifest(f.artifactId)
        : f.engine.workspaces.materialize(f.artifactId));
    });
    expect(result).toMatchObject({ ok: false, error: { code: "MEDIA_MISSING", details: { objectHash: f.hash, reason: "local_media_missing" } } });
    expect(f.calls).toEqual([]);
    expect(f.requests).toEqual([]);
    expect(f.engine.head).toBe(head);
    await expect(stat(f.cas)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(f.media)).rejects.toMatchObject({ code: "ENOENT" });
    expect((await readdir(join(f.root, "data", "objects", "sha256", f.hash.slice(0, 2)))).filter((name) => name.endsWith(".download"))).toEqual([]);
    expect(value(await f.engine.files.read(f.artifactId, "original.png"))).toEqual(bytes);
    expect(f.calls).toEqual(["download"]);
  });

  it("isolates a concurrent explicit download from a pending local scope on the same engine", async () => {
    const f = await fixture();
    await f.removeLocalBytes();
    f.hold();
    let resume!: () => void;
    const barrier = new Promise<void>((resolve) => { resume = resolve; });
    const local = f.engine.withLocalMedia(async () => {
      await barrier;
      return f.engine.files.read(f.artifactId, "original.png");
    });
    const explicit = f.engine.files.read(f.artifactId, "original.png");
    await expect.poll(() => f.requests.length).toBe(1);
    resume();
    expect(await local).toMatchObject({ ok: false, error: { code: "MEDIA_MISSING" } });
    expect(f.calls).toEqual(["download"]);
    f.release();
    expect(value(await explicit)).toEqual(bytes);
    expect(value(await f.engine.withLocalMedia(() => f.engine.files.read(f.artifactId, "original.png")))).toEqual(bytes);
    expect(f.requests).toHaveLength(1);
  });

  it("does not impose one book's scope on another engine or leak after a thrown callback", async () => {
    const first = await fixture();
    const second = await fixture();
    await first.removeLocalBytes();
    await second.removeLocalBytes();
    expect(value(await first.engine.withLocalMedia(() => second.engine.files.read(second.artifactId, "original.png")))).toEqual(bytes);
    expect(first.calls).toEqual([]);
    expect(second.calls).toEqual(["download"]);
    expect(() => first.engine.withLocalMedia(() => { throw new Error("callback failure"); })).toThrow("callback failure");
    expect(value(await first.engine.files.read(first.artifactId, "original.png"))).toEqual(bytes);
    expect(first.calls).toEqual(["download"]);
  });

  it("guards compatibility indexing and rebuilding automatically while cached indexing succeeds", async () => {
    const f = await fixture();
    expect((await f.engine.similarity.index(f.artifactId)).ok).toBe(true);
    expect((await f.engine.similarity.findSimilar(f.artifactId)).ok).toBe(true);
    expect(f.calls).toEqual([]);
    await f.removeLocalBytes();
    expect(await f.engine.similarity.index(f.artifactId, { force: true })).toMatchObject({ ok: false, error: { code: "MEDIA_MISSING" } });
    expect(await f.engine.similarity.rebuild({ force: true })).toMatchObject({ ok: false, error: { code: "MEDIA_MISSING" } });
    expect((await f.engine.similarity.findSimilar(f.artifactId)).ok).toBe(true);
    expect(f.calls).toEqual([]);
  });

  it.each(["artifact", "book"])("commits %s history restoration with missing bytes, deferring explicit retrieval", async (kind) => {
    const f = await fixture();
    value(await f.engine.files.write(f.artifactId, "original.png", "new version"));
    await f.removeLocalBytes();
    const before = f.engine.head;
    const restored = kind === "artifact"
      ? await f.engine.history.restoreArtifact(f.artifactId, f.revision)
      : await f.engine.history.restore(f.revision);
    expect(restored.ok).toBe(true);
    expect(f.engine.head).not.toBe(before);
    expect(f.calls).toEqual([]);
    expect(await f.engine.withLocalMedia(() => f.engine.files.read(f.artifactId, "original.png"))).toMatchObject({ ok: false, error: { code: "MEDIA_MISSING" } });
    const restoredHead = f.engine.head;
    expect(value(await f.engine.files.read(f.artifactId, "original.png"))).toEqual(bytes);
    expect(f.calls).toEqual(["download"]);
    expect(f.engine.head).toBe(restoredHead);
  });
});
