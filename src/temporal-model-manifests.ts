import type { IndexManifest } from "./mvp-contracts.js";

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

