import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import type Sharp from "sharp";

import type {
  IndexManifest,
  TemporalSearchProvider,
} from "./mvp-contracts.js";
import { EngineFault } from "./store.js";

type TransformersModule = typeof import("./transformers-runtime.js");
type SharpFn = typeof Sharp;

let transformersModule: Promise<TransformersModule> | undefined;
let sharpModule: Promise<SharpFn> | undefined;

function loadTransformers(): Promise<TransformersModule> {
  transformersModule ??= import("./transformers-runtime.js");
  return transformersModule;
}

function loadSharp(): Promise<SharpFn> {
  sharpModule ??= import("sharp").then((mod) => mod.default);
  return sharpModule;
}

export const LOCAL_CLIP_MODEL_ID = "Xenova/clip-vit-base-patch32";
export const LOCAL_CLIP_MODEL_REVISION =
  "d15189d7028b43f1d3e65039190477f6af591c2a";
export const LOCAL_CLIP_MANIFEST: IndexManifest = {
  manifestId: "videobook-clip-vit-b32-q8-v1",
  provider: "huggingface-transformers",
  modelId: LOCAL_CLIP_MODEL_ID,
  modelRevision: LOCAL_CLIP_MODEL_REVISION,
  license: "MIT",
  embeddingSpace:
    "clip-vit-b32-q8-d15189d7028b43f1d3e65039190477f6af591c2a-v1",
  dimensions: 512,
  modalities: ["visual"],
  supportedLanguages: ["en"],
  preprocessingVersion: "clip-224-rgb-v1",
  extractorVersion: "transformers-js-4.2.0",
  createdAt: 1,
};

export const LOCAL_CLAP_MODEL_ID = "Xenova/clap-htsat-unfused";
export const LOCAL_CLAP_MODEL_REVISION =
  "c28f2883575e590e04d3146ff0713c2448d691ba";
export const LOCAL_CLAP_MANIFEST: IndexManifest = {
  manifestId: "videobook-clap-htsat-q8-v1",
  provider: "huggingface-transformers",
  modelId: LOCAL_CLAP_MODEL_ID,
  modelRevision: LOCAL_CLAP_MODEL_REVISION,
  license: "Apache-2.0",
  embeddingSpace:
    "clap-htsat-q8-c28f2883575e590e04d3146ff0713c2448d691ba-v1",
  dimensions: 512,
  modalities: ["audio"],
  supportedLanguages: ["en"],
  preprocessingVersion: "clap-mono-48khz-10s-v1",
  extractorVersion: "transformers-js-4.2.0",
  createdAt: 1,
};

export interface LocalClipTemporalProviderOptions {
  modelCacheDir: string;
  allowModelDownload?: boolean;
}

export interface LocalClapTemporalProviderOptions {
  modelCacheDir: string;
  ffmpegPath?: string;
  allowModelDownload?: boolean;
}

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

export class LocalClipTemporalProvider implements TemporalSearchProvider {
  readonly manifestId = LOCAL_CLIP_MANIFEST.manifestId;
  readonly embeddingSpace = LOCAL_CLIP_MANIFEST.embeddingSpace;
  readonly dimensions = LOCAL_CLIP_MANIFEST.dimensions;
  private imagePipeline: ImagePipeline | null = null;
  private tokenizer: ClipTokenizer | null = null;
  private textModel: ClipTextModel | null = null;

  constructor(private readonly options: LocalClipTemporalProviderOptions) {}

  async prepare(): Promise<void> {
    await Promise.all([this.loadImagePipeline(), this.loadTextModel()]);
  }

  async embedText(text: string): Promise<Float32Array> {
    const { tokenizer, model } = await this.loadTextModel();
    const output = await model(tokenizer([text], {
      padding: true,
      truncation: true,
    }));
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

  async embedImage(sourcePath: string): Promise<Float32Array> {
    const embedder = await this.loadImagePipeline();
    const image = await readNormalizedImage(sourcePath);
    const output = await embedder(image);
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

export class LocalClapTemporalProvider implements TemporalSearchProvider {
  readonly manifestId = LOCAL_CLAP_MANIFEST.manifestId;
  readonly embeddingSpace = LOCAL_CLAP_MANIFEST.embeddingSpace;
  readonly dimensions = LOCAL_CLAP_MANIFEST.dimensions;
  private processor: ClapProcessor | null = null;
  private audioModel: ClapAudioModel | null = null;
  private tokenizer: ClipTokenizer | null = null;
  private textModel: ClapTextModel | null = null;

  constructor(private readonly options: LocalClapTemporalProviderOptions) {}

  async prepare(): Promise<void> {
    await Promise.all([this.loadAudioModel(), this.loadTextModel()]);
  }

  async embedText(text: string): Promise<Float32Array> {
    const { tokenizer, model } = await this.loadTextModel();
    const output = await model(tokenizer([text], {
      padding: true,
      truncation: true,
    }));
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
  ): Promise<Float32Array> {
    const { processor, model } = await this.loadAudioModel();
    const decoded = await decodeAudio(
      this.options.ffmpegPath ?? "ffmpeg",
      sourcePath,
      startSeconds,
      durationSeconds,
    );
    const output = await model(await processor(decoded));
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

async function readNormalizedImage(sourcePath: string): Promise<unknown> {
  const [sharp, { RawImage }] = await Promise.all([
    loadSharp(),
    loadTransformers(),
  ]);
  const decoded = await sharp(sourcePath, { animated: false })
    .rotate()
    .toColourspace("srgb")
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  if (
    decoded.info.width <= 0
    || decoded.info.height <= 0
    || decoded.info.channels !== 3
  ) {
    throw new Error(`Unable to normalize image for CLIP: ${sourcePath}`);
  }
  return new RawImage(
    decoded.data,
    decoded.info.width,
    decoded.info.height,
    3,
  );
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

function decodeAudio(
  ffmpegPath: string,
  sourcePath: string,
  startSeconds: number,
  durationSeconds: number,
): Promise<Float32Array> {
  if (
    !Number.isFinite(startSeconds)
    || startSeconds < 0
    || !Number.isFinite(durationSeconds)
    || durationSeconds <= 0
  ) {
    throw new Error("CLAP audio range must have a non-negative start and positive duration");
  }
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegPath, [
      "-hide_banner",
      "-loglevel",
      "error",
      "-nostdin",
      "-ss",
      String(startSeconds),
      "-i",
      sourcePath,
      "-map",
      "0:a:0",
      "-vn",
      "-ac",
      "1",
      "-ar",
      "48000",
      "-t",
      String(Math.min(durationSeconds, 10)),
      "-f",
      "f32le",
      "-acodec",
      "pcm_f32le",
      "pipe:1",
    ], { stdio: ["ignore", "pipe", "pipe"] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.once("error", (error) => reject(localModelFault(
      "CLAP audio decoder",
      error,
      true,
    )));
    child.once("close", (code) => {
      if (code !== 0) {
        reject(new EngineFault({
          code: "INVALID_INPUT",
          message: `Unable to decode audio for CLAP: ${
            Buffer.concat(stderr).toString("utf8").trim()
          }`,
        }));
        return;
      }
      const buffer = Buffer.concat(stdout);
      if (
        buffer.byteLength === 0
        || buffer.byteLength % Float32Array.BYTES_PER_ELEMENT !== 0
      ) {
        reject(new Error("CLAP audio decoder returned invalid PCM"));
        return;
      }
      const bytes = new Uint8Array(buffer.byteLength);
      bytes.set(buffer);
      resolve(new Float32Array(bytes.buffer));
    });
  });
}

function modelFault(
  error: unknown,
  allowModelDownload: boolean | undefined,
): EngineFault {
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
