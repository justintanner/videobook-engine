import type { EngineError, SimilarityTextChunk } from "./engine-types.js";

export interface ModelWorkerConfiguration {
  kind: "clip" | "clap" | "compat-clip" | "compat-clap" | "compat-text";
  modelCacheDir: string;
  modelId?: string;
  allowModelDownload: boolean;
  ffmpegPath?: string;
  ffprobePath?: string;
  remoteHost: string;
  remotePathTemplate: string;
  allowRemoteModels: boolean;
  allowLocalModels: boolean;
  localModelPath: string;
}

export interface ModelWorkerCall {
  method: "prepare" | "embedText" | "embedImage" | "embedVideo" | "embedAudio";
  text?: string;
  sourcePath?: string;
  startSeconds?: number;
  durationSeconds?: number;
}

export type ModelWorkerValue = undefined | Float32Array | SimilarityTextChunk[] | { vector: Float32Array; frameCount: number };
export interface ModelWorkerRequest { id: number; configuration: ModelWorkerConfiguration; call: ModelWorkerCall }
export type ModelWorkerResponse = { id: number; ok: true; value: ModelWorkerValue } | { id: number; ok: false; error: EngineError };
export const MAX_MODEL_MESSAGE_BYTES = 2 * 1024 * 1024;
