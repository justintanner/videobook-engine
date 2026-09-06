import { mkdir } from "node:fs/promises";
import type { MediaOperationOptions } from "./engine-types.js";
import { decodeModelImage } from "./media-image.js";
import { runMediaProcess, checkMediaCancellation } from "./media-process.js";

import type {
  TemporalSearchProvider,
} from "./mvp-contracts.js";
import { EngineFault } from "./store.js";

type TransformersModule = typeof import("./transformers-runtime.js");

let transformersModule: Promise<TransformersModule> | undefined;

function loadTransformers(): Promise<TransformersModule> {
  transformersModule ??= import("./transformers-runtime.js");
  return transformersModule;
}

import { LOCAL_CLIP_MANIFEST, LOCAL_CLAP_MANIFEST, LOCAL_CLIP_MODEL_ID, LOCAL_CLIP_MODEL_REVISION, LOCAL_CLAP_MODEL_ID, LOCAL_CLAP_MODEL_REVISION } from "./temporal-model-manifests.js";
import type { LocalClipTemporalProviderOptions, LocalClapTemporalProviderOptions } from "./temporal-model-manifests.js";

type ImagePipeline = (
  images: unknown,
) => Promise<{ data: Float32Array; dims: number[] }>;

type ClipTokenizer = (
  text: string[],
  options: { padding: boolean; truncation: boolean },
) => Record<string, unknown>;

type ClipTextModel = (
  input: Record<string, unknown>,
) => Promise<{
  text_embeds: {
    data: Float32Array;
    dims: number[];
  };
}>;

type ClapProcessor = (
  audio: Float32Array,
) => Promise<Record<string, unknown>>;

type ClapAudioModel = (
  input: Record<string, unknown>,
) => Promise<{
  audio_embeds: {
    data: Float32Array;
    dims: number[];
  };
}>;

type ClapTextModel = (
  input: Record<string, unknown>,
) => Promise<{
  text_embeds: {
    data: Float32Array;
    dims: number[];
  };
}>;

export class InlineClipTemporalProvider implements TemporalSearchProvider {
  readonly manifestId = LOCAL_CLIP_MANIFEST.manifestId;
  readonly embeddingSpace = LOCAL_CLIP_MANIFEST.embeddingSpace;
  readonly dimensions = LOCAL_CLIP_MANIFEST.dimensions;
  private imagePipeline: ImagePipeline | null = null;
  private tokenizer: ClipTokenizer | null = null;
  private textModel: ClipTextModel | null = null;

  readonly networkAccess;
  private readonly options: LocalClipTemporalProviderOptions;
  constructor(options: LocalClipTemporalProviderOptions) {
    this.options = Object.freeze({ ...options });
    this.networkAccess = Object.freeze({ modelDownloads: options.allowModelDownload === true, inference: false });
  }

  async prepare(options: MediaOperationOptions = {}): Promise<void> {
    checkMediaCancellation(options);
    await prepareModelBranches([this.loadImagePipeline(), this.loadTextModel()]);
    checkMediaCancellation(options);
  }

  async embedText(text: string, options: MediaOperationOptions = {}): Promise<Float32Array> {
    checkMediaCancellation(options);
    const { tokenizer, model } = await this.loadTextModel();
    const output = await model(tokenizer([text], {
      padding: true,
      truncation: true,
    }));
    checkMediaCancellation(options);
    if (
      output.text_embeds.dims.length !== 2
      || output.text_embeds.dims[0] !== 1
      || output.text_embeds.dims[1] !== this.dimensions
    ) {
      throw new Error(
        `Unexpected CLIP text embedding shape: ${output.text_embeds.dims.join("x")}`,
      );
    }
    return normalized(output.text_embeds.data.slice());
  }

  async embedImage(sourcePath: string, options: MediaOperationOptions = {}): Promise<Float32Array> {
    checkMediaCancellation(options);
    const embedder = await this.loadImagePipeline();
    const image = await readNormalizedImage(sourcePath, options);
    const output = await embedder(image);
    checkMediaCancellation(options);
    if (
      output.dims.length !== 2
      || output.dims[0] !== 1
      || output.dims[1] !== this.dimensions
    ) {
      throw new Error(
        `Unexpected CLIP image embedding shape: ${output.dims.join("x")}`,
      );
    }
    return normalized(output.data.slice());
  }

  private async loadImagePipeline(): Promise<ImagePipeline> {
    if (this.imagePipeline) return this.imagePipeline;
    await mkdir(this.options.modelCacheDir, { recursive: true });
    try {
      const { pipeline } = await loadTransformers();
      this.imagePipeline = await pipeline(
        "image-feature-extraction",
        LOCAL_CLIP_MODEL_ID,
        {
          dtype: "q8",
          cache_dir: this.options.modelCacheDir,
          local_files_only: this.options.allowModelDownload !== true,
          revision: LOCAL_CLIP_MODEL_REVISION,
        },
      ) as unknown as ImagePipeline;
      return this.imagePipeline;
    } catch (error) {
      throw modelFault(error, this.options.allowModelDownload);
    }
  }

  private async loadTextModel(): Promise<{
    tokenizer: ClipTokenizer;
    model: ClipTextModel;
  }> {
    if (this.tokenizer && this.textModel) {
      return { tokenizer: this.tokenizer, model: this.textModel };
    }
    await mkdir(this.options.modelCacheDir, { recursive: true });
    try {
      const options = {
        cache_dir: this.options.modelCacheDir,
        local_files_only: this.options.allowModelDownload !== true,
        revision: LOCAL_CLIP_MODEL_REVISION,
      };
      const { AutoTokenizer, CLIPTextModelWithProjection } =
        await loadTransformers();
      this.tokenizer = await AutoTokenizer.from_pretrained(
        LOCAL_CLIP_MODEL_ID,
        options,
      ) as unknown as ClipTokenizer;
      this.textModel = await CLIPTextModelWithProjection.from_pretrained(
        LOCAL_CLIP_MODEL_ID,
        { ...options, dtype: "q8" },
      ) as unknown as ClipTextModel;
      return { tokenizer: this.tokenizer, model: this.textModel };
    } catch (error) {
      throw modelFault(error, this.options.allowModelDownload);
    }
  }
}

export class InlineClapTemporalProvider implements TemporalSearchProvider {
  readonly manifestId = LOCAL_CLAP_MANIFEST.manifestId;
  readonly embeddingSpace = LOCAL_CLAP_MANIFEST.embeddingSpace;
  readonly dimensions = LOCAL_CLAP_MANIFEST.dimensions;
  private processor: ClapProcessor | null = null;
  private audioModel: ClapAudioModel | null = null;
  private tokenizer: ClipTokenizer | null = null;
  private textModel: ClapTextModel | null = null;

  readonly networkAccess;
  private readonly options: LocalClapTemporalProviderOptions;
  constructor(options: LocalClapTemporalProviderOptions) {
    this.options = Object.freeze({ ...options });
    this.networkAccess = Object.freeze({ modelDownloads: options.allowModelDownload === true, inference: false });
  }

  async prepare(options: MediaOperationOptions = {}): Promise<void> {
    checkMediaCancellation(options);
    await prepareModelBranches([this.loadAudioModel(), this.loadTextModel()]);
    checkMediaCancellation(options);
  }

  async embedText(text: string, options: MediaOperationOptions = {}): Promise<Float32Array> {
    checkMediaCancellation(options);
    const { tokenizer, model } = await this.loadTextModel();
    const output = await model(tokenizer([text], {
      padding: true,
      truncation: true,
    }));
    checkMediaCancellation(options);
    return checkedEmbedding(
      output.text_embeds,
      this.dimensions,
      "CLAP text",
    );
  }

  async embedAudio(
    sourcePath: string,
    startSeconds = 0,
    durationSeconds = 10,
    options: MediaOperationOptions = {},
  ): Promise<Float32Array> {
    checkMediaCancellation(options);
    const { processor, model } = await this.loadAudioModel();
    const decoded = await decodeAudio(
      this.options.ffmpegPath ?? "ffmpeg",
      sourcePath,
      startSeconds,
      durationSeconds,
      options,
    );
    const output = await model(await processor(decoded));
    checkMediaCancellation(options);
    return checkedEmbedding(
      output.audio_embeds,
      this.dimensions,
      "CLAP audio",
    );
  }

  private async loadAudioModel(): Promise<{
    processor: ClapProcessor;
    model: ClapAudioModel;
  }> {
    if (this.processor && this.audioModel) {
      return { processor: this.processor, model: this.audioModel };
    }
    await mkdir(this.options.modelCacheDir, { recursive: true });
    try {
      const options = modelOptions(
        this.options.modelCacheDir,
        this.options.allowModelDownload,
        LOCAL_CLAP_MODEL_REVISION,
      );
      const { AutoProcessor, ClapAudioModelWithProjection } =
        await loadTransformers();
      this.processor = await AutoProcessor.from_pretrained(
        LOCAL_CLAP_MODEL_ID,
        options,
      ) as unknown as ClapProcessor;
      this.audioModel = await ClapAudioModelWithProjection.from_pretrained(
        LOCAL_CLAP_MODEL_ID,
        { ...options, dtype: "q8" },
      ) as unknown as ClapAudioModel;
      return { processor: this.processor, model: this.audioModel };
    } catch (error) {
      throw localModelFault(
        "CLAP audio",
        error,
        this.options.allowModelDownload,
      );
    }
  }

  private async loadTextModel(): Promise<{
    tokenizer: ClipTokenizer;
    model: ClapTextModel;
  }> {
    if (this.tokenizer && this.textModel) {
      return { tokenizer: this.tokenizer, model: this.textModel };
    }
    await mkdir(this.options.modelCacheDir, { recursive: true });
    try {
      const options = modelOptions(
        this.options.modelCacheDir,
        this.options.allowModelDownload,
        LOCAL_CLAP_MODEL_REVISION,
      );
      const { AutoTokenizer, ClapTextModelWithProjection } =
        await loadTransformers();
      this.tokenizer = await AutoTokenizer.from_pretrained(
        LOCAL_CLAP_MODEL_ID,
        options,
      ) as unknown as ClipTokenizer;
      this.textModel = await ClapTextModelWithProjection.from_pretrained(
        LOCAL_CLAP_MODEL_ID,
        { ...options, dtype: "q8" },
      ) as unknown as ClapTextModel;
      return { tokenizer: this.tokenizer, model: this.textModel };
    } catch (error) {
      throw localModelFault(
        "CLAP text",
        error,
        this.options.allowModelDownload,
      );
    }
  }
}

async function readNormalizedImage(sourcePath: string, options: MediaOperationOptions): Promise<unknown> {
  const [{ RawImage }, decoded] = await Promise.all([loadTransformers(), decodeModelImage(sourcePath, options)]);
  return new RawImage(decoded.data, decoded.info.width, decoded.info.height, 3);
}

function normalized(vector: Float32Array): Float32Array {
  const magnitude = Math.sqrt(
    vector.reduce((sum, value) => sum + value * value, 0),
  );
  if (!Number.isFinite(magnitude) || magnitude <= 0) {
    throw new Error("CLIP returned a zero or invalid embedding");
  }
  return Float32Array.from(vector, (value) => value / magnitude);
}

function checkedEmbedding(
  output: { data: Float32Array; dims: number[] },
  dimensions: number,
  label: string,
): Float32Array {
  if (
    output.dims.length !== 2
    || output.dims[0] !== 1
    || output.dims[1] !== dimensions
  ) {
    throw new Error(
      `Unexpected ${label} embedding shape: ${output.dims.join("x")}`,
    );
  }
  return normalized(output.data.slice());
}

function modelOptions(
  cacheDir: string,
  allowModelDownload: boolean | undefined,
  revision: string,
) {
  return {
    cache_dir: cacheDir,
    local_files_only: allowModelDownload !== true,
    revision,
  };
}

async function decodeAudio(
  ffmpegPath: string,
  sourcePath: string,
  startSeconds: number,
  durationSeconds: number,
  options: MediaOperationOptions,
): Promise<Float32Array> {
  if (!Number.isFinite(startSeconds) || startSeconds < 0 || !Number.isFinite(durationSeconds) || durationSeconds <= 0) {
    throw new EngineFault({ code: "INVALID_INPUT", message: "CLAP audio range must have a non-negative start and positive duration" });
  }
  const duration = Math.min(durationSeconds, 10);
  const { stdout: buffer } = await runMediaProcess(ffmpegPath, [
    "-hide_banner", "-loglevel", "error", "-nostdin", "-ss", String(startSeconds),
    "-protocol_whitelist", "file,pipe", "-i", sourcePath, "-map", "0:a:0", "-vn", "-ac", "1", "-ar", "48000",
    "-t", String(duration), "-f", "f32le", "-acodec", "pcm_f32le", "pipe:1",
  ], { ...options, maxStdoutBytes: Math.ceil(duration * 48000) * Float32Array.BYTES_PER_ELEMENT });
  if (buffer.byteLength === 0 || buffer.byteLength % Float32Array.BYTES_PER_ELEMENT !== 0) {
    throw new EngineFault({ code: "INVALID_INPUT", message: "CLAP audio decoder returned invalid PCM" });
  }
  const bytes = new Uint8Array(buffer.byteLength);
  bytes.set(buffer);
  return new Float32Array(bytes.buffer);
}

function modelFault(
  error: unknown,
  allowModelDownload: boolean | undefined,
): EngineFault {
  if (error instanceof EngineFault) return error;
  return new EngineFault({
    code: allowModelDownload !== true ? "OFFLINE" : "FEATURE_UNAVAILABLE",
    message: `Unable to load the pinned local CLIP model: ${
      error instanceof Error ? error.message : String(error)
    }${downloadHint(allowModelDownload)}`,
  });
}

function localModelFault(
  label: string,
  error: unknown,
  allowModelDownload: boolean | undefined,
): EngineFault {
  if (error instanceof EngineFault) return error;
  return new EngineFault({
    code: allowModelDownload !== true ? "OFFLINE" : "FEATURE_UNAVAILABLE",
    message: `Unable to load the pinned local ${label} model: ${
      error instanceof Error ? error.message : String(error)
    }${downloadHint(allowModelDownload)}`,
  });
}

function downloadHint(allowed: boolean | undefined): string {
  return allowed === true ? "" : " Model downloads are disabled. Explicitly prepare the model with allowModelDownload: true, then retry using the populated cache.";
}

async function prepareModelBranches(branches: Promise<unknown>[]): Promise<void> {
  const settled = await Promise.allSettled(branches);
  const failures = settled.filter((result): result is PromiseRejectedResult => result.status === "rejected");
  const integrityFailure = failures.find(({ reason }: { reason: unknown }) =>
    reason instanceof EngineFault && ["MODEL_UNAVAILABLE", "RESOURCE_EXHAUSTED"].includes(reason.error.code));
  const failure = integrityFailure ?? failures[0];
  if (failure) throw failure.reason;
}
