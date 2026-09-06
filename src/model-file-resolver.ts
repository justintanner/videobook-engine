import { createHash, randomUUID } from "node:crypto";
import { createReadStream, constants } from "node:fs";
import { copyFile, mkdir, open, readFile, rename, rm, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import checksums from "./model-checksums.json" with { type: "json" };
import { modelCacheStagingRoot } from "./model-cache-paths.js";
import type { ModelWorkerConfiguration } from "./model-worker-protocol.js";
import { EngineFault } from "./store.js";

interface ModelDigest { algorithm: "sha256" | "git-sha1"; digest: string; size?: number }
interface ModelFileOptions { revision?: string; cache_dir?: string | null; local_files_only?: boolean }
interface Receipt extends ModelDigest { version: 1; modelId: string; revision: string; filename: string; source: "hub-etag" | "transport" }
type Catalog = Record<string, Record<string, ModelDigest>>;
const pinned = checksums as Catalog;
const MAX_FILE_BYTES = 2 * 1024 ** 3;
const MAX_BUFFER_BYTES = 16 * 1024 ** 2;

export class ModelFileResolver {
  failure?: EngineFault;
  private readonly active = new Set<Promise<string | Uint8Array | null>>();
  private readonly network = new AbortController();
  private stopped = false;
  private readonly pending = new Map<string, Promise<string | null>>();
  private readonly verified = new Map<string, string>();
  private readonly staging: string;

  constructor(private readonly config: ModelWorkerConfiguration, private readonly workspace: string) {
    this.staging = modelCacheStagingRoot(config.modelCacheDir, workspace);
  }

  get(modelId: string, filename: string, fatal = true, options: ModelFileOptions = {}, returnPath = false): Promise<string | Uint8Array | null> {
    if (this.stopped) return Promise.reject(new EngineFault({ code: "CANCELLED", message: "Model loading stopped after a failure" }));
    const operation = this.getVerified(modelId, filename, fatal, options, returnPath).catch((error) => {
      if (error instanceof EngineFault && ["MODEL_UNAVAILABLE", "RESOURCE_EXHAUSTED"].includes(error.error.code)) this.failure = error;
      throw error;
    });
    this.active.add(operation);
    void operation.then(() => this.active.delete(operation), () => this.active.delete(operation));
    return operation;
  }

  async drainAfterFailure(): Promise<EngineFault | undefined> {
    this.stopped = true;
    this.network.abort();
    await Promise.allSettled([...this.active]);
    return this.failure;
  }

  private async getVerified(modelId: string, filename: string, fatal: boolean, options: ModelFileOptions, returnPath: boolean): Promise<string | Uint8Array | null> {
    safeRelative(filename);
    const revision = options.revision ?? "main";
    safeRelative(revision);
    if (options.cache_dir && resolve(options.cache_dir) !== resolve(this.config.modelCacheDir)) throw unavailable("Model cache scope does not match its worker");
    const key = JSON.stringify([modelId, revision, filename, options.local_files_only === true]);
    let file = this.verified.get(key);
    if (!file) {
      let pending = this.pending.get(key);
      if (!pending) {
        pending = this.resolveFile(modelId, revision, filename, options).then(async (file) => {
          if (!file) return null;
          const directory = createHash("sha256").update(JSON.stringify([modelId, revision])).digest("hex");
          const sealed = join(this.workspace, "models", directory, filename);
          await mkdir(dirname(sealed), { recursive: true });
          await rename(file, sealed);
          return sealed;
        }).finally(() => this.pending.delete(key));
        this.pending.set(key, pending);
      }
      file = (await pending) ?? undefined;
      if (file) this.verified.set(key, file);
    }
    if (!file) {
      if (!fatal) return null;
      if (!this.downloadAllowed(options)) throw new EngineFault({ code: "OFFLINE", message: "Required model file is missing. Model downloads are disabled; explicitly prepare the model, then retry." });
      throw new EngineFault({ code: "FEATURE_UNAVAILABLE", message: "Required model file is unavailable from the configured snapshot" });
    }
    if (returnPath) return file;
    if ((await stat(file)).size > MAX_BUFFER_BYTES) throw exhausted("Model metadata exceeds the buffer limit");
    return new Uint8Array(await readFile(file));
  }

  private downloadAllowed(options: ModelFileOptions): boolean {
    return this.config.allowModelDownload && this.config.allowRemoteModels && options.local_files_only !== true;
  }

  private async resolveFile(modelId: string, revision: string, filename: string, options: ModelFileOptions): Promise<string | null> {
    if (isAbsolute(modelId)) {
      if (!this.config.allowLocalModels) return null;
      const path = join(modelId, filename);
      return await exists(path) ? (await this.snapshot(createReadStream(path))).path : null;
    }
    safeRelative(modelId);
    if (!/^[\w.-]+(?:\/[\w.-]+)?$/u.test(modelId)) throw unavailable("Invalid model repository identifier");
    const known = pinned[`${modelId}/${revision}`];
    const expected = known?.[filename];
    const cachePath = join(this.config.modelCacheDir, modelId, ...(revision === "main" ? [] : [revision]), filename);
    if (known && !expected) {
      if (await exists(cachePath)) throw unavailable("Unrecognized file in a pinned model snapshot");
      return null;
    }
    if (await exists(cachePath)) {
      const receipt = expected ? undefined : await this.receipt(cachePath, modelId, revision, filename);
      if (expected || receipt) return (await this.snapshot(createReadStream(cachePath), expected ?? receipt)).path;
      if (!this.downloadAllowed(options)) throw new EngineFault({ code: "OFFLINE", message: "Cached model has no integrity metadata. Model downloads are disabled; explicitly prepare the model to verify it." });
    }
    if (this.config.allowLocalModels) {
      const localPath = join(this.config.localModelPath, modelId, filename);
      if (await exists(localPath)) return (await this.snapshot(createReadStream(localPath), expected)).path;
    }
    if (!this.downloadAllowed(options)) return null;
    const remote = new URL(`${this.config.remoteHost.replace(/\/$/u, "")}/${this.config.remotePathTemplate
      .replaceAll("{model}", modelId).replaceAll("{revision}", encodeURIComponent(revision)).replace(/^\//u, "").replace(/\/$/u, "")}/${filename.split("/").map(encodeURIComponent).join("/")}`);
    const downloaded = await this.download(remote, expected);
    if (!downloaded) return null;
    try {
      const metadata: Receipt = { version: 1, modelId, revision, filename,
        ...(downloaded.expected ?? { algorithm: "sha256", digest: downloaded.sha256 }), size: downloaded.size,
        source: downloaded.expected ? "hub-etag" : "transport" };
      await this.publish(cachePath, downloaded.path, metadata);
      return downloaded.path;
    } catch (error) {
      await rm(downloaded.path, { force: true });
      throw error;
    }
  }

  private async receipt(path: string, modelId: string, revision: string, filename: string): Promise<Receipt | undefined> {
    const receiptPath = `${path}.videobook-integrity.json`;
    if (!await exists(receiptPath)) return undefined;
    if ((await stat(receiptPath)).size > 16_384) throw unavailable("Invalid model integrity metadata");
    let record: Receipt;
    try { record = JSON.parse(await readFile(receiptPath, "utf8")) as Receipt; }
    catch { throw unavailable("Invalid model integrity metadata"); }
    if (!record || record.version !== 1 || record.modelId !== modelId || record.revision !== revision || record.filename !== filename
      || !validDigest(record) || !Number.isSafeInteger(record.size) || record.size! < 0 || record.size! > MAX_FILE_BYTES
      || !["hub-etag", "transport"].includes(record.source)) throw unavailable("Invalid model integrity metadata");
    return record;
  }

  private async download(initial: URL, expected?: ModelDigest): Promise<(Awaited<ReturnType<ModelFileResolver["snapshot"]>> & { expected?: ModelDigest }) | null> {
    let url = initial;
    let upstream: ModelDigest | undefined;
    for (let redirects = 0; redirects <= 5; redirects++) {
      if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw unavailable("Unsupported model download URL");
      const headers = new Headers({ "Accept-Encoding": "identity" });
      const token = process.env.HF_TOKEN ?? process.env.HUGGING_FACE_HUB_TOKEN;
      if (token && url.origin === "https://huggingface.co") headers.set("Authorization", `Bearer ${token}`);
      const response = await fetch(url, { headers, redirect: "manual", signal: this.network.signal });
      if (redirects === 0) upstream = headerDigest(response.headers, response.status === 200);
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        await response.body?.cancel();
        const location = response.headers.get("location");
        if (!location) throw unavailable("Model download redirect is missing its location");
        const next = new URL(location, url);
        if (url.protocol === "https:" && next.protocol !== "https:") throw unavailable("Model download cannot redirect to an insecure connection");
        url = next;
        continue;
      }
      if (response.status !== 200 || !response.body) {
        await response.body?.cancel();
        if (response.status === 404) return null;
        throw unavailable("Model download did not return a complete file");
      }
      if (expected && upstream && (expected.algorithm !== upstream.algorithm || expected.digest !== upstream.digest)) {
        await response.body.cancel();
        throw unavailable("Model metadata does not match the pinned checksum");
      }
      const digest = expected ?? upstream;
      const length = Number(response.headers.get("content-length"));
      if ((digest?.size ?? 0) > MAX_FILE_BYTES || length > MAX_FILE_BYTES) {
        await response.body.cancel();
        throw exhausted("Model download exceeds the file limit");
      }
      return { ...await this.snapshot(response.body as unknown as AsyncIterable<Uint8Array>, digest), expected: digest };
    }
    throw unavailable("Model download exceeded its redirect limit");
  }

  private async snapshot(source: AsyncIterable<Uint8Array>, expected?: ModelDigest): Promise<{ path: string; sha256: string; size: number }> {
    await mkdir(join(this.workspace, "models"), { recursive: true });
    const path = join(this.workspace, "models", randomUUID());
    let size = 0;
    const sha256 = createHash("sha256");
    const output = await open(path, "wx", 0o600);
    try {
      for await (const chunk of source) {
        size += chunk.byteLength;
        if (size > MAX_FILE_BYTES) throw exhausted("Model file exceeds the supported size");
        sha256.update(chunk);
        await output.writeFile(chunk);
      }
      await output.sync();
      await output.close();
      const digest = sha256.digest("hex");
      if (expected) {
        if (expected.size !== undefined && expected.size !== size) throw unavailable("Model file size does not match its integrity metadata");
        let actual = digest;
        if (expected.algorithm === "git-sha1") {
          const hash = createHash("sha1").update(`blob ${size}\0`);
          for await (const chunk of createReadStream(path)) hash.update(chunk);
          actual = hash.digest("hex");
        }
        if (actual !== expected.digest) throw unavailable("Model checksum verification failed");
      }
      return { path, sha256: digest, size };
    } catch (error) {
      await output.close().catch(() => undefined);
      await rm(path, { force: true });
      throw error;
    }
  }

  private async publish(destination: string, snapshot: string, receipt: Receipt): Promise<void> {
    await mkdir(this.staging, { recursive: true });
    await mkdir(dirname(destination), { recursive: true });
    const temporary = join(this.staging, randomUUID());
    const metadata = `${temporary}.json`;
    try {
      await copyFile(snapshot, temporary, constants.COPYFILE_FICLONE);
      const output = await open(temporary, "r+");
      try { await output.sync(); } finally { await output.close(); }
      const record = await open(metadata, "wx", 0o600);
      try { await record.writeFile(JSON.stringify(receipt)); await record.sync(); } finally { await record.close(); }
      await rename(temporary, destination);
      await rename(metadata, `${destination}.videobook-integrity.json`);
    } finally {
      await Promise.all([rm(temporary, { force: true }), rm(metadata, { force: true })]);
    }
  }
}

function safeRelative(path: string): void {
  if (!path || isAbsolute(path) || path.includes("\\") || path.includes("\0") || path.split("/").some((part) => !part || part === "." || part === "..")) throw unavailable("Invalid model file path");
}

async function exists(path: string): Promise<boolean> {
  try { const file = await stat(path); if (!file.isFile()) throw unavailable("Model path is not a regular file"); return true; }
  catch (error) { if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return false; throw error; }
}

function validDigest(value: ModelDigest): boolean {
  return value.algorithm === "sha256" ? /^[a-f0-9]{64}$/u.test(value.digest)
    : value.algorithm === "git-sha1" && /^[a-f0-9]{40}$/u.test(value.digest);
}

function headerDigest(headers: Headers, complete: boolean): ModelDigest | undefined {
  const tag = (headers.get("x-linked-etag") ?? headers.get("etag"))?.replace(/^"|"$/gu, "");
  if (!tag) return undefined;
  const algorithm = /^[a-f0-9]{64}$/iu.test(tag) ? "sha256" : /^[a-f0-9]{40}$/iu.test(tag) ? "git-sha1" : undefined;
  if (!algorithm) return undefined;
  const rawSize = headers.get("x-linked-size") ?? (complete && !headers.get("content-encoding") ? headers.get("content-length") : null);
  const size = rawSize === null ? undefined : Number(rawSize);
  return { algorithm, digest: tag.toLowerCase(), ...(Number.isSafeInteger(size) && size! >= 0 ? { size } : {}) };
}

function unavailable(message: string): EngineFault { return new EngineFault({ code: "MODEL_UNAVAILABLE", message }); }
function exhausted(message: string): EngineFault { return new EngineFault({ code: "RESOURCE_EXHAUSTED", message }); }
