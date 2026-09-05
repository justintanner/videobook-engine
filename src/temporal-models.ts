import type { MediaOperationOptions } from "./engine-types.js";
import type { TemporalSearchProvider } from "./mvp-contracts.js";
import { isolatedModelCall } from "./isolated-models.js";
import { LOCAL_CLIP_MANIFEST, LOCAL_CLAP_MANIFEST, type LocalClipTemporalProviderOptions, type LocalClapTemporalProviderOptions } from "./temporal-model-manifests.js";
export * from "./temporal-model-manifests.js";

export class LocalClipTemporalProvider implements TemporalSearchProvider {
  readonly manifestId = LOCAL_CLIP_MANIFEST.manifestId;
  readonly embeddingSpace = LOCAL_CLIP_MANIFEST.embeddingSpace;
  readonly dimensions = LOCAL_CLIP_MANIFEST.dimensions;
  constructor(private readonly options: LocalClipTemporalProviderOptions) {}
  async prepare(options: MediaOperationOptions = {}): Promise<void> {
    await isolatedModelCall({ ...this.options, kind: "clip" }, { method: "prepare" }, options);
  }
  async embedText(text: string, options: MediaOperationOptions = {}): Promise<Float32Array> {
    return isolatedModelCall({ ...this.options, kind: "clip" }, { method: "embedText", text }, options) as Promise<Float32Array>;
  }
  async embedImage(sourcePath: string, options: MediaOperationOptions = {}): Promise<Float32Array> {
    return isolatedModelCall({ ...this.options, kind: "clip" }, { method: "embedImage", sourcePath }, options) as Promise<Float32Array>;
  }
}

export class LocalClapTemporalProvider implements TemporalSearchProvider {
  readonly manifestId = LOCAL_CLAP_MANIFEST.manifestId;
  readonly embeddingSpace = LOCAL_CLAP_MANIFEST.embeddingSpace;
  readonly dimensions = LOCAL_CLAP_MANIFEST.dimensions;
  constructor(private readonly options: LocalClapTemporalProviderOptions) {}
  async prepare(options: MediaOperationOptions = {}): Promise<void> {
    await isolatedModelCall({ ...this.options, kind: "clap" }, { method: "prepare" }, options);
  }
  async embedText(text: string, options: MediaOperationOptions = {}): Promise<Float32Array> {
    return isolatedModelCall({ ...this.options, kind: "clap" }, { method: "embedText", text }, options) as Promise<Float32Array>;
  }
  async embedAudio(sourcePath: string, startSeconds = 0, durationSeconds = 10, options: MediaOperationOptions = {}): Promise<Float32Array> {
    return isolatedModelCall({ ...this.options, kind: "clap" }, { method: "embedAudio", sourcePath, startSeconds, durationSeconds }, options) as Promise<Float32Array>;
  }
}
