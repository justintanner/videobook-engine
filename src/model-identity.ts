import { createHash } from "node:crypto";
import { isAbsolute, resolve } from "node:path";
import type { ModelWorkerConfiguration } from "./model-worker-protocol.js";
import { LOCAL_CLIP_MODEL_ID, LOCAL_CLIP_MODEL_REVISION, LOCAL_CLAP_MODEL_ID, LOCAL_CLAP_MODEL_REVISION } from "./temporal-model-manifests.js";
import { EngineFault } from "./store.js";

interface ModelSelection { modelId?: string; modelRevision?: string }
interface ModelIdentity { modelId: string; modelRevision?: string; embeddingSpace: string }

const textIdentity: ModelIdentity = {
  modelId: "onnx-community/all-MiniLM-L6-v2-ONNX",
  modelRevision: "aff7a1dc4e8a1ea593e6ea21e95c22ef0a25966f",
  embeddingSpace: "all-minilm-l6-v2-q4-aff7a1dc4e8a1ea593e6ea21e95c22ef0a25966f-text-v1",
};

export function modelIdentity(kind: ModelWorkerConfiguration["kind"], selection: ModelSelection): ModelIdentity {
  const defaults = kind === "compat-text" ? textIdentity
    : kind === "clap" || kind === "compat-clap"
      ? { modelId: LOCAL_CLAP_MODEL_ID, modelRevision: LOCAL_CLAP_MODEL_REVISION,
          embeddingSpace: kind === "clap" ? `clap-htsat-q8-${LOCAL_CLAP_MODEL_REVISION}-v1`
            : "clap-htsat-unfused-q8-c28f2883575e590e04d3146ff0713c2448d691ba-audio-v1" }
      : { modelId: LOCAL_CLIP_MODEL_ID, modelRevision: LOCAL_CLIP_MODEL_REVISION, embeddingSpace: kind === "compat-clip"
          ? `clip-vit-b32-q8-${LOCAL_CLIP_MODEL_REVISION}-compat-visual-v2`
          : `clip-vit-b32-q8-${LOCAL_CLIP_MODEL_REVISION}-v1` };
  const modelId = selection.modelId ?? defaults.modelId;
  if (typeof modelId !== "string" || !modelId || modelId.trim() !== modelId) throw invalid("Model ID must be a non-empty repository ID or explicit local directory");
  if (isAbsolute(modelId) || modelId.startsWith(".")) {
    if (selection.modelRevision !== undefined) throw invalid("modelRevision applies to remote repositories; use a separate immutable local directory for each local model version");
    const localId = resolve(modelId);
    return { modelId: localId, embeddingSpace: customSpace(kind, localId) };
  }
  if (!/^[\w.-]+(?:\/[\w.-]+)?$/u.test(modelId) || modelId.split("/").some((part) => part === "." || part === "..")) throw invalid("Invalid remote model repository ID; local directories must be absolute or begin with ./ or ../");
  const revision = selection.modelRevision ?? (modelId === defaults.modelId ? defaults.modelRevision : undefined);
  if (typeof revision !== "string" || !/^[a-f\d]{40}$/iu.test(revision)) throw invalid("Remote models require modelRevision to be a full 40-character commit SHA; moving branches and tags are not supported");
  const modelRevision = revision.toLowerCase();
  return { modelId, modelRevision,
    embeddingSpace: modelId === defaults.modelId && modelRevision === defaults.modelRevision
      ? defaults.embeddingSpace : customSpace(kind, modelId, modelRevision) };
}

function customSpace(kind: string, modelId: string, revision?: string): string {
  const source = revision ? ["remote", modelId, revision] : ["local", modelId];
  const digest = createHash("sha256").update(JSON.stringify([kind, source, "preprocessing-v1"])).digest("hex");
  return `custom-${kind}-${digest}-v2`;
}

function invalid(message: string) { return new EngineFault({ code: "INVALID_INPUT", message }); }
