import { modelIdentity } from "./model-identity.js";
import { resolve } from "node:path";
import type { MediaOperationOptions } from "./engine-types.js";
import { checkMediaCancellation } from "./media-process.js";
import { ModelWorkerPool } from "./model-worker-pool.js";
import type { ModelWorkerCall, ModelWorkerConfiguration, ModelWorkerValue } from "./model-worker-protocol.js";

type ModelConfiguration = Pick<ModelWorkerConfiguration, "kind" | "modelCacheDir" | "modelId" | "modelRevision" | "ffmpegPath" | "ffprobePath"> & { allowModelDownload?: boolean };
const pool = new ModelWorkerPool({ workerUrl: new URL(import.meta.url.endsWith(".ts") ? "./model-worker.ts" : "./model-worker.js", import.meta.url) });

export async function isolatedModelCall(configuration: ModelConfiguration, call: ModelWorkerCall, options: MediaOperationOptions): Promise<ModelWorkerValue> {
  checkMediaCancellation(options);
  const identity = modelIdentity(configuration.kind, configuration);
  const { env } = await import("./transformers-runtime.js");
  return pool.request({
    kind: configuration.kind,
    modelId: identity.modelId,
    modelRevision: identity.modelRevision,
    modelCacheDir: resolve(configuration.modelCacheDir),
    ffmpegPath: executable(configuration.ffmpegPath), ffprobePath: executable(configuration.ffprobePath),
    allowModelDownload: configuration.allowModelDownload === true,
    remoteHost: env.remoteHost, remotePathTemplate: env.remotePathTemplate,
    allowRemoteModels: env.allowRemoteModels, allowLocalModels: env.allowLocalModels,
    localModelPath: resolve(env.localModelPath),
  }, { ...call, ...(call.sourcePath ? { sourcePath: resolve(call.sourcePath) } : {}) }, options);
}

function executable(command: string | undefined): string | undefined {
  return command && /[/\\]/u.test(command) ? resolve(command) : command;
}
