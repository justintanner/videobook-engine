import { realpathSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { basename } from "node:path";
import { serialize } from "node:v8";
import { InlineClapTemporalProvider, InlineClipTemporalProvider } from "./inline-temporal-models.js";
import { createInlineSimilarityProvider } from "./similarity.js";
import { modelWorkerError } from "./model-worker-errors.js";
import { MAX_MODEL_MESSAGE_BYTES, type ModelWorkerRequest, type ModelWorkerResponse, type ModelWorkerValue } from "./model-worker-protocol.js";
import { EngineFault } from "./store.js";

let provider: InlineClipTemporalProvider | InlineClapTemporalProvider | ReturnType<typeof createInlineSimilarityProvider> | undefined;
let busy = false;
const workerRoot = process.env.VIDEOBOOK_MODEL_WORKER_ROOT;
if (!process.send || !workerRoot || realpathSync(workerRoot) !== realpathSync(process.cwd()) || !basename(workerRoot).startsWith("videobook-model-worker-")) {
  throw new Error("Model worker must run in its dedicated workspace");
}

process.on("disconnect", () => {
  rmSync(workerRoot, { recursive: true, force: true, maxRetries: 3 });
  if (process.platform === "win32") spawnSync("taskkill", ["/PID", String(process.pid), "/T", "/F"], { timeout: 5000, stdio: "ignore", windowsHide: true });
  else process.kill(-process.pid, "SIGKILL");
  process.exit(0);
});

process.on("message", (message: ModelWorkerRequest) => {
  if (busy) { process.exitCode = 1; process.disconnect?.(); return; }
  busy = true;
  void execute(message).then((response) => {
    busy = false;
    process.send?.(response);
  });
});

async function execute(request: ModelWorkerRequest): Promise<ModelWorkerResponse> {
  try {
    if (serialize(request).byteLength > MAX_MODEL_MESSAGE_BYTES) throw new EngineFault({ code: "RESOURCE_EXHAUSTED", message: "Model request exceeds the message limit" });
    if (!provider) {
      const config = request.configuration;
      const { env } = await import("./transformers-runtime.js");
      env.remoteHost = config.remoteHost;
      env.remotePathTemplate = config.remotePathTemplate;
      env.allowRemoteModels = config.allowRemoteModels;
      env.allowLocalModels = config.allowLocalModels;
      env.localModelPath = config.localModelPath;
      provider = config.kind === "clip" ? new InlineClipTemporalProvider(config)
        : config.kind === "clap" ? new InlineClapTemporalProvider(config) : createInlineSimilarityProvider(config);
    }
    const call = request.call;
    let value: ModelWorkerValue;
    if (call.method === "prepare") { await provider.prepare(); value = undefined; }
    else if (call.method === "embedText" && "embedText" in provider) value = await provider.embedText(call.text!);
    else if (call.method === "embedImage" && "embedImage" in provider) value = await provider.embedImage(call.sourcePath!);
    else if (call.method === "embedVideo" && "embedVideo" in provider) value = await provider.embedVideo(call.sourcePath!);
    else if (call.method === "embedAudio" && "embedAudio" in provider) {
      value = provider instanceof InlineClapTemporalProvider
        ? await provider.embedAudio(call.sourcePath!, call.startSeconds, call.durationSeconds)
        : await provider.embedAudio(call.sourcePath!);
    } else throw new EngineFault({ code: "INVALID_INPUT", message: "Model method does not match its provider" });
    const response: ModelWorkerResponse = { id: request.id, ok: true, value };
    if (serialize(response).byteLength > MAX_MODEL_MESSAGE_BYTES) throw new EngineFault({ code: "RESOURCE_EXHAUSTED", message: "Model result exceeds the message limit" });
    return response;
  } catch (error) {
    return { id: request.id, ok: false, error: modelWorkerError(error) };
  }
}
