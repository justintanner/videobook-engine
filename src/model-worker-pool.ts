import { fork, spawnSync, type ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { rmSync } from "node:fs";
import { Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serialize } from "node:v8";
import type { MediaOperationOptions } from "./engine-types.js";
import { ENGINE_ERROR_CODES } from "./engine-types.js";
import { checkMediaCancellation, mediaTimeout } from "./media-process.js";
import { MAX_MODEL_MESSAGE_BYTES, type ModelWorkerCall, type ModelWorkerConfiguration, type ModelWorkerResponse, type ModelWorkerValue } from "./model-worker-protocol.js";
import { EngineFault } from "./store.js";
import { modelCacheStagingRoot } from "./model-cache-paths.js";

interface PendingCall {
  id: number;
  key: string;
  configuration: ModelWorkerConfiguration;
  call: ModelWorkerCall;
  resolve(value: ModelWorkerValue): void;
  reject(error: EngineFault): void;
  cleanup(): void;
  session?: Session;
  done: boolean;
}
interface Session {
  key: string;
  child?: ChildProcess;
  root?: string;
  cacheStaging?: string;
  job?: PendingCall;
  initialized: Promise<void>;
  exited?: Promise<void>;
  stopping?: Promise<void>;
  closing: boolean;
  idle?: ReturnType<typeof setTimeout>;
}
interface PoolOptions { workerUrl: URL; maxWorkers?: number; idleMs?: number; heapMb?: number }

export class ModelWorkerPool {
  private readonly sessions = new Map<string, Session>();
  private readonly queue: PendingCall[] = [];
  private nextId = 1;
  private closed = false;
  private readonly onExit = () => {
    for (const session of this.sessions.values()) {
      killTree(session.child);
      if (session.root) { try { rmSync(session.root, { recursive: true, force: true, maxRetries: 3 }); } catch {} }
      if (session.cacheStaging) { try { rmSync(session.cacheStaging, { recursive: true, force: true, maxRetries: 3 }); } catch {} }
    }
  };

  constructor(private readonly options: PoolOptions) {
    process.on("exit", this.onExit);
  }

  async request(configuration: ModelWorkerConfiguration, call: ModelWorkerCall, options: MediaOperationOptions = {}): Promise<ModelWorkerValue> {
    checkMediaCancellation(options);
    if (this.closed) throw new EngineFault({ code: "CANCELLED", message: "Model worker pool is closed" });
    if (this.queue.length >= 64) throw new EngineFault({ code: "RESOURCE_EXHAUSTED", message: "Model worker queue is full" });
    if (Buffer.byteLength(call.text ?? "") > 1024 * 1024 || Buffer.byteLength(call.sourcePath ?? "") > 4096) {
      throw new EngineFault({ code: "RESOURCE_EXHAUSTED", message: "Model input exceeds the supported size" });
    }
    if (serialize({ configuration, call }).byteLength > MAX_MODEL_MESSAGE_BYTES) {
      throw new EngineFault({ code: "RESOURCE_EXHAUSTED", message: "Model input exceeds the message limit" });
    }
    const timeoutMs = mediaTimeout({ timeoutMs: options.timeoutMs ?? (call.method === "prepare" ? 900_000 : 120_000) });
    return new Promise((resolve, reject) => {
      const job: PendingCall = {
        id: this.nextId++, key: JSON.stringify(configuration), configuration, call, resolve, reject,
        done: false, cleanup: () => { clearTimeout(timer); options.signal?.removeEventListener("abort", cancel); },
      };
      const cancel = () => this.cancel(job, new EngineFault({ code: "CANCELLED", message: "Model operation cancelled" }));
      const timer = setTimeout(() => this.cancel(job, new EngineFault({
        code: "TIMEOUT", message: "Model operation exceeded its time limit", details: { timeoutMs },
      })), timeoutMs);
      options.signal?.addEventListener("abort", cancel, { once: true });
      this.queue.push(job);
      if (options.signal?.aborted) cancel();
      else this.pump();
    });
  }

  stats() {
    return { workers: this.sessions.size, queued: this.queue.length,
      processIds: [...this.sessions.values()].flatMap((session) => session.child?.pid ? [session.child.pid] : []) };
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const job of [...this.queue]) this.cancel(job, new EngineFault({ code: "CANCELLED", message: "Model worker pool closed" }));
    await Promise.all([...this.sessions.values()].map(async (session) => {
      if (session.job) this.cancel(session.job, new EngineFault({ code: "CANCELLED", message: "Model worker pool closed" }));
      await this.stop(session);
    }));
    process.removeListener("exit", this.onExit);
  }

  private pump(): void {
    if (this.closed) return;
    for (const job of [...this.queue]) {
      let session = this.sessions.get(job.key);
      if (session?.job || session?.closing) continue;
      if (!session && this.sessions.size >= (this.options.maxWorkers ?? 2)) {
        const idle = [...this.sessions.values()].find((item) => !item.job && !item.closing);
        if (idle) void this.stop(idle);
        continue;
      }
      this.queue.splice(this.queue.indexOf(job), 1);
      if (!session) {
        session = { key: job.key, job, initialized: Promise.resolve(), closing: false };
        this.sessions.set(job.key, session);
        job.session = session;
        session.initialized = this.start(session, job.configuration);
      } else {
        clearTimeout(session.idle);
        session.job = job;
        job.session = session;
      }
      void this.dispatch(session, job);
    }
  }

  private async start(session: Session, configuration: ModelWorkerConfiguration): Promise<void> {
    session.root = await mkdtemp(join(tmpdir(), "videobook-model-worker-"));
    session.cacheStaging = modelCacheStagingRoot(configuration.modelCacheDir, session.root);
    if (session.closing) return;
    const child = fork(this.options.workerUrl, [], {
      cwd: session.root, detached: process.platform !== "win32", serialization: "advanced",
      stdio: ["ignore", "ignore", "pipe", "ipc"], env: { ...workerEnvironment(configuration.allowModelDownload), VIDEOBOOK_MODEL_WORKER_ROOT: session.root },
      execArgv: [...(this.options.workerUrl.pathname.endsWith(".ts") ? ["--import", import.meta.resolve("tsx")] : []), `--max-old-space-size=${this.options.heapMb ?? 512}`],
    });
    session.child = child;
    session.exited = new Promise<void>((resolve) => child.once("close", () => resolve()));
    child.unref();
    child.channel?.unref();
    if (child.stderr instanceof Socket) child.stderr.unref();
    let stderrBytes = 0;
    child.stderr?.on("data", (chunk: Buffer) => {
      stderrBytes += chunk.length;
      if (stderrBytes > 64 * 1024 && session.job) this.cancel(session.job, new EngineFault({ code: "RESOURCE_EXHAUSTED", message: "Model worker exceeded its diagnostic output limit" }));
    });
    child.on("message", (message) => this.receive(session, message));
    child.once("error", () => {
      if (session.job) this.cancel(session.job, new EngineFault({ code: "MODEL_UNAVAILABLE", message: "Unable to start model worker" }));
      else void this.stop(session);
    });
    child.once("exit", (code, signal) => {
      if (session.closing) return;
      if (session.job) this.cancel(session.job, new EngineFault({
        code: signal === "SIGABRT" || signal === "SIGKILL" ? "RESOURCE_EXHAUSTED" : "MODEL_UNAVAILABLE",
        message: "Model worker terminated before completing the operation", details: { exitCode: code, signal },
      }));
      else void this.stop(session);
    });
  }

  private async dispatch(session: Session, job: PendingCall): Promise<void> {
    try {
      await session.initialized;
      if (job.done || session.closing) return;
      session.child!.send({ id: job.id, configuration: job.configuration, call: job.call }, (error) => {
        if (error) this.cancel(job, new EngineFault({ code: "MODEL_UNAVAILABLE", message: "Unable to communicate with model worker" }));
      });
    } catch {
      this.cancel(job, new EngineFault({ code: "MODEL_UNAVAILABLE", message: "Unable to initialize model worker" }));
    }
  }

  private receive(session: Session, raw: unknown): void {
    const job = session.job;
    if (!job || job.done || session.closing) return;
    if (!raw || typeof raw !== "object" || !("id" in raw) || raw.id !== job.id || !("ok" in raw)
      || serialize(raw).byteLength > MAX_MODEL_MESSAGE_BYTES) {
      this.cancel(job, new EngineFault({ code: "MODEL_UNAVAILABLE", message: "Model worker returned an invalid response" }));
      return;
    }
    const response = raw as ModelWorkerResponse;
    if (!response.ok) {
      const error = response.error;
      this.cancel(job, new EngineFault(error && ENGINE_ERROR_CODES.includes(error.code) && typeof error.message === "string"
        ? error : { code: "MODEL_UNAVAILABLE", message: "Model worker failed" }));
      return;
    }
    if (!validValue(job, response.value)) {
      this.cancel(job, new EngineFault({ code: "MODEL_UNAVAILABLE", message: "Model worker returned invalid embeddings" }));
      return;
    }
    job.done = true;
    job.cleanup();
    session.job = undefined;
    job.resolve(response.value);
    session.idle = setTimeout(() => void this.stop(session), this.options.idleMs ?? 30_000);
    session.idle.unref();
    this.pump();
  }

  private cancel(job: PendingCall, error: EngineFault): void {
    if (job.done) return;
    job.done = true;
    job.cleanup();
    const index = this.queue.indexOf(job);
    if (index !== -1) this.queue.splice(index, 1);
    if (job.session) {
      void this.stop(job.session).then(() => job.reject(error));
    } else { job.reject(error); this.pump(); }
  }

  private stop(session: Session): Promise<void> {
    if (session.stopping) return session.stopping;
    session.closing = true;
    clearTimeout(session.idle);
    session.stopping = (async () => {
      await session.initialized.catch(() => undefined);
      session.child?.ref();
      session.child?.channel?.ref();
      killTree(session.child);
      await session.exited;
      if (session.root) await rm(session.root, { recursive: true, force: true, maxRetries: 3 }).catch(() => undefined);
      if (session.cacheStaging) await rm(session.cacheStaging, { recursive: true, force: true, maxRetries: 3 }).catch(() => undefined);
      if (this.sessions.get(session.key) === session) this.sessions.delete(session.key);
      this.pump();
    })();
    return session.stopping;
  }
}

function validValue(job: PendingCall, value: ModelWorkerValue): boolean {
  if (job.call.method === "prepare") return value === undefined;
  const vector = (candidate: unknown, dimensions: number) => candidate instanceof Float32Array
    && candidate.length === dimensions && candidate.every(Number.isFinite);
  if (job.configuration.kind === "compat-text") return Array.isArray(value) && value.every((chunk) =>
    Number.isSafeInteger(chunk.startOffset) && Number.isSafeInteger(chunk.endOffset)
    && chunk.startOffset >= 0 && chunk.endOffset > chunk.startOffset && vector(chunk.vector, 384));
  if (job.call.method === "embedVideo") return Boolean(value && typeof value === "object" && "vector" in value
    && vector(value.vector, 512) && "frameCount" in value && Number.isSafeInteger(value.frameCount) && value.frameCount > 0 && value.frameCount <= 120);
  return vector(value, 512);
}

function killTree(child: ChildProcess | undefined): void {
  if (!child?.pid) return;
  try {
    if (process.platform === "win32") spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { timeout: 5000, stdio: "ignore", windowsHide: true });
    else process.kill(-child.pid, "SIGKILL");
  } catch { child.kill("SIGKILL"); }
}

function workerEnvironment(downloadAllowed: boolean): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const key of ["PATH", "Path", "SystemRoot", "WINDIR", "HOME", "USERPROFILE", "TMPDIR", "TEMP", "TMP", "LANG", "LC_ALL",
    ...(downloadAllowed ? ["HF_TOKEN", "HUGGING_FACE_HUB_TOKEN"] : [])]) {
    if (process.env[key] !== undefined) environment[key] = process.env[key];
  }
  return environment;
}
