import { createHash } from "node:crypto";
import { createServer, type Server, type ServerResponse } from "node:http";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ModelFileResolver } from "../src/model-file-resolver.js";
import type { ModelWorkerConfiguration } from "../src/model-worker-protocol.js";
import { LOCAL_CLIP_MODEL_ID, LOCAL_CLIP_MODEL_REVISION } from "../src/temporal-model-manifests.js";

describe("verified model files", () => {
  let root: string;
  let server: Server;
  let config: ModelWorkerConfiguration;
  let requests: string[];
  let respond: (path: string, response: ServerResponse) => void;
  const content = Buffer.from('{"model_type":"fixture","value":"original"}');
  const sha256 = createHash("sha256").update(content).digest("hex");
  const gitSha1 = createHash("sha1").update(`blob ${content.length}\0`).update(content).digest("hex");
  const model = "fixture/model";
  const filename = "config.json";

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "videobook-model-integrity-"));
    requests = [];
    respond = (_path, response) => response.writeHead(200, { ETag: `"${sha256}"`, "Content-Length": content.length }).end(content);
    server = createServer((request, response) => {
      expect(request.headers.authorization).toBeUndefined();
      requests.push(request.url!);
      respond(request.url!, response);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("No HTTP fixture address");
    config = { kind: "clip", modelCacheDir: join(root, "cache"), allowModelDownload: true,
      remoteHost: `http://127.0.0.1:${address.port}/`, remotePathTemplate: "{model}/resolve/{revision}/",
      allowRemoteModels: true, allowLocalModels: true, localModelPath: join(root, "local") };
  });

  afterEach(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  });

  function resolver(name = "worker", offline = false) {
    return new ModelFileResolver({ ...config, allowModelDownload: !offline }, join(root, name));
  }
  function cached(file = filename) { return join(config.modelCacheDir, model, file); }

  it.each(["sha256", "git-sha1"])("verifies %s before cache publication and rejects offline cache corruption", async (algorithm) => {
    respond = (_path, response) => response.writeHead(200, { ETag: `"${algorithm === "sha256" ? sha256 : gitSha1}"` }).end(content);
    expect(await resolver().get(model, filename)).toEqual(new Uint8Array(content));
    expect(await readFile(cached())).toEqual(content);
    const receipt = JSON.parse(await readFile(`${cached()}.videobook-integrity.json`, "utf8"));
    expect(receipt).toMatchObject({ algorithm, size: content.length, source: "hub-etag" });
    const offline = resolver("offline", true);
    const snapshot = await offline.get(model, filename, true, {}, true);
    expect(typeof snapshot).toBe("string");
    expect(snapshot).not.toBe(cached());
    await writeFile(cached(), Buffer.alloc(content.length, 120));
    expect(await readFile(snapshot as string)).toEqual(content);
    expect(await offline.get(model, filename)).toEqual(new Uint8Array(content));
    await expect(resolver("corrupted", true).get(model, filename)).rejects.toMatchObject({ error: { code: "MODEL_UNAVAILABLE" } });
    expect(requests).toHaveLength(1);
  });

  it("uses the resolver's linked digest across CDN redirects rather than a CDN ETag", async () => {
    respond = (path, response) => {
      if (path === "/cdn") response.writeHead(200, { ETag: '"cdn-object-version"' }).end(content);
      else response.writeHead(302, { "x-linked-etag": `"${sha256}"`, "x-linked-size": content.length, location: "/cdn" }).end("redirect");
    };
    expect(await resolver().get(model, filename)).toEqual(new Uint8Array(content));
    expect(requests).toEqual(["/fixture/model/resolve/main/config.json", "/cdn"]);
  });

  it("rejects corrupt downloads without publishing or retaining their bytes, then permits a valid retry", async () => {
    respond = (_path, response) => response.writeHead(200, { ETag: `"${sha256}"` }).end(Buffer.alloc(content.length, 120));
    const bad = resolver();
    await expect(bad.get(model, filename)).rejects.toMatchObject({ error: { code: "MODEL_UNAVAILABLE", message: "Model checksum verification failed" } });
    expect(bad.failure?.error.code).toBe("MODEL_UNAVAILABLE");
    await expect(readFile(cached())).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readdir(join(root, "worker", "models"))).toEqual([]);
    respond = (_path, response) => response.writeHead(200, { ETag: `"${sha256}"` }).end(content);
    expect(await resolver("retry").get(model, filename)).toEqual(new Uint8Array(content));
  });

  it("does not mistake raw SHA-1 for Git blob SHA-1", async () => {
    respond = (_path, response) => response.writeHead(200, { ETag: `"${createHash("sha1").update(content).digest("hex")}"` }).end(content);
    await expect(resolver().get(model, filename)).rejects.toThrow("Model checksum verification failed");
  });

  it("records transport integrity when upstream has no supported digest, without claiming upstream verification", async () => {
    respond = (_path, response) => response.writeHead(200, { ETag: 'W/"opaque-version"' }).end(content);
    await resolver().get(model, filename);
    expect(JSON.parse(await readFile(`${cached()}.videobook-integrity.json`, "utf8"))).toMatchObject({ source: "transport", algorithm: "sha256", digest: sha256 });
    await writeFile(cached(), "corrupted");
    await expect(resolver("offline", true).get(model, filename)).rejects.toThrow("integrity metadata");
    expect(requests).toHaveLength(1);
  });

  it("requires integrity metadata for legacy remote-model caches while remaining offline", async () => {
    await mkdir(join(config.modelCacheDir, model), { recursive: true });
    await writeFile(cached(), content);
    await expect(resolver("offline", true).get(model, filename)).rejects.toMatchObject({ error: { code: "OFFLINE" } });
    expect(requests).toEqual([]);
    expect(await resolver("prepared").get(model, filename)).toEqual(new Uint8Array(content));
    expect(await resolver("verified-offline", true).get(model, filename)).toEqual(new Uint8Array(content));
    expect(requests).toHaveLength(1);
  });

  it("rejects malformed or mis-scoped integrity receipts", async () => {
    await resolver().get(model, filename);
    const record = JSON.parse(await readFile(`${cached()}.videobook-integrity.json`, "utf8"));
    await writeFile(`${cached()}.videobook-integrity.json`, JSON.stringify({ ...record, filename: "other.json" }));
    await expect(resolver("offline", true).get(model, filename)).rejects.toThrow("Invalid model integrity metadata");
    await writeFile(`${cached()}.videobook-integrity.json`, "not json");
    await expect(resolver("malformed", true).get(model, filename)).rejects.toThrow("Invalid model integrity metadata");
    expect(requests).toHaveLength(1);
  });

  it("rejects corrupt pinned cached files without relying on a receipt or network access", async () => {
    const directory = join(config.modelCacheDir, LOCAL_CLIP_MODEL_ID, LOCAL_CLIP_MODEL_REVISION);
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, filename), content);
    await expect(resolver("offline", true).get(LOCAL_CLIP_MODEL_ID, filename, true, { revision: LOCAL_CLIP_MODEL_REVISION })).rejects.toMatchObject({ error: { code: "MODEL_UNAVAILABLE" } });
    expect(requests).toEqual([]);
    expect(await readFile(join(directory, filename))).toEqual(content);
  });

  it("deduplicates concurrent loads while preserving path and buffer return contracts", async () => {
    const files = resolver();
    const [path, buffer] = await Promise.all([files.get(model, filename, true, {}, true), files.get(model, filename)]);
    expect(typeof path).toBe("string");
    expect(buffer).toEqual(new Uint8Array(content));
    expect(requests).toHaveLength(1);
    expect(await readFile(path as string)).toEqual(content);
  });

  it("keeps verified external ONNX data adjacent to its named model file", async () => {
    const files = resolver();
    const [modelFile, dataFile] = await Promise.all([
      files.get(model, "onnx/model_q4.onnx", true, {}, true),
      files.get(model, "onnx/model_q4.onnx_data", true, {}, true),
    ]);
    expect(dirname(modelFile as string)).toBe(dirname(dataFile as string));
    expect(basename(modelFile as string)).toBe("model_q4.onnx");
    expect(basename(dataFile as string)).toBe("model_q4.onnx_data");
    expect(await readFile(dataFile as string)).toEqual(content);
  });

  it("does not cache missing optional files or disable local-only behavior", async () => {
    respond = (_path, response) => response.writeHead(404).end();
    expect(await resolver().get(model, filename, false)).toBeNull();
    await expect(resolver("required").get(model, filename)).rejects.toMatchObject({ error: { code: "FEATURE_UNAVAILABLE" } });
    const count = requests.length;
    expect(await resolver("optional-offline", true).get(model, filename, false)).toBeNull();
    await expect(resolver("required-offline", true).get(model, filename)).rejects.toMatchObject({ error: { code: "OFFLINE" } });
    expect(requests).toHaveLength(count);
  });

  it("rejects traversal, cache-scope changes and oversized responses before publication", async () => {
    await expect(resolver().get(model, "../outside")).rejects.toThrow("Invalid model file path");
    await expect(resolver().get(model, filename, true, { cache_dir: join(root, "other") })).rejects.toThrow("cache scope");
    expect(requests).toEqual([]);
    respond = (_path, response) => response.writeHead(200, { "Content-Length": 3 * 1024 ** 3 }).end();
    await expect(resolver("large").get(model, filename)).rejects.toMatchObject({ error: { code: "RESOURCE_EXHAUSTED" } });
    await expect(readFile(cached())).rejects.toMatchObject({ code: "ENOENT" });
  });
});
