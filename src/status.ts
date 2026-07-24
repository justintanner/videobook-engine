import type {
  ArtifactRuntimeMeta,
  ArtifactStatus,
  ArtifactStatusInput,
  EngineError,
  GetArtifactStatusOptions,
  Result,
} from "./engine-types.js";
import { ok } from "./engine-types.js";
import {
  EngineContext,
  resultOf,
  type ArtifactRow,
} from "./context.js";
import { createFilesApi } from "./files.js";
import { findPrimaryMediaFile } from "./media.js";
import { parseJson } from "./store.js";

const PARTIAL_DOWNLOAD_RE = /\.(mp4|mov)\.part$/i;
const IMAGE_LIKE_MEDIA_RE = /\.(jpe?g|png|webp)$/i;

interface ViewRow {
  status: ArtifactStatusInput["artifactRow"] extends infer T
    ? T extends { status: infer S }
      ? S
      : never
    : never;
  meta_json: string;
  deadline_at: number | null;
}

interface PendingRow {
  task_id: string;
  task_type: string;
  created_at: number;
  meta_json: string;
  completing: number;
  owner_id: string | null;
}

interface FailureRow {
  message: string;
  fail_code: string | null;
  prompt: string | null;
  failed_at: number;
}

interface LeaseRow {
  lease_id: string;
  resource_key: string;
  owner_id: string;
  acquired_at: number;
  expires_at: number;
  pid: number | null;
  state: string | null;
  data_json: string;
}

export function createStatusApi(context: EngineContext) {
  return {
    get: (
      artifact: string,
      options?: GetArtifactStatusOptions,
    ): Promise<Result<ArtifactStatus, EngineError>> =>
      getArtifactStatus(context, artifact, options),
    compute: computeArtifactStatus,
  };
}

export function computeArtifactStatus(
  input: ArtifactStatusInput,
): ArtifactStatus {
  const {
    artifactSlug,
    fileNames,
    primaryMediaName,
    hasOriginalMetadata,
    hasPartFile,
    lockData,
    pendingTask,
    generationError,
    artifactRow,
  } = input;

  if (artifactRow?.status === "error") return "error";
  if (lockData && Date.now() < lockData.timeout_at) {
    return (lockData.state ?? "loading") as ArtifactStatus;
  }
  if (pendingTask) {
    if (pendingTask.taskType === "transcribe") return "transcribing";
    if (pendingTask.taskType === "isolate_vocals") return "isolating";
    return "generating";
  }
  if (artifactRow?.status === "pending") {
    const mapped = mapKindToStatus(artifactRow.meta, true);
    if (mapped) return mapped;
  } else if (artifactRow?.status === "working") {
    const mapped = mapKindToStatus(artifactRow.meta, false);
    if (mapped) return mapped;
  }
  if (generationError) return "error";

  const isVideo = artifactSlug.startsWith("vid-");
  const mediaIsImageLike =
    primaryMediaName !== null &&
    IMAGE_LIKE_MEDIA_RE.test(primaryMediaName);
  if (
    hasPartFile &&
    isVideo &&
    (primaryMediaName === null || mediaIsImageLike)
  ) {
    return "error";
  }
  if (primaryMediaName !== null) {
    if (artifactSlug === "final") return "ready";
    if (isVideo && !hasOriginalMetadata) {
      return "processing";
    }
    return "ready";
  }
  if (hasPartFile) return "error";
  if (
    artifactSlug.startsWith("char-") ||
    artifactSlug.startsWith("prompt-") ||
    artifactSlug.startsWith("scene-")
  ) {
    return "ready";
  }
  if (
    artifactRow?.status === "pending" &&
    typeof artifactRow.deadlineAt === "number" &&
    Date.now() < artifactRow.deadlineAt
  ) {
    return "loading";
  }
  return "error";
}

export function hasPartialMediaFile(
  fileNames: ReadonlySet<string>,
): boolean {
  for (const name of fileNames) {
    if (PARTIAL_DOWNLOAD_RE.test(name)) return true;
  }
  return false;
}

async function getArtifactStatus(
  context: EngineContext,
  artifactReference: string,
  options?: GetArtifactStatusOptions,
): Promise<Result<ArtifactStatus, EngineError>> {
  return resultOf(async () => {
    const artifact = context.artifactRow(artifactReference);
    const manifestResult = await createFilesApi(context).manifest(
      artifact.artifact_id,
      { includeDotfiles: true },
    );
    if (!manifestResult.ok) return manifestResult;
    const fileNames = new Set(
      manifestResult.value.files.map((file) => file.name),
    );
    const primary =
      options && "primaryMediaName" in options
        ? (options.primaryMediaName ?? null)
        : findPrimaryMediaFile(
            manifestResult.value.files,
            artifact.slug,
          )?.name ?? null;
    const hasOriginalMetadata = Boolean(
      context.store.db
        .prepare(
          `SELECT 1 AS present
           FROM artifact_metadata
           WHERE artifact_id=? AND key='original'`,
        )
        .get(artifact.artifact_id),
    );
    return computeArtifactStatus({
      artifactSlug: artifact.slug,
      fileNames,
      primaryMediaName: primary,
      hasOriginalMetadata,
      hasPartFile: hasPartialMediaFile(fileNames),
      lockData: activeArtifactLock(context, artifact),
      pendingTask: pendingTask(context, artifact),
      generationError: generationError(context, artifact),
      artifactRow: artifactView(context, artifact),
    });
  });
}

function mapKindToStatus(
  meta: ArtifactRuntimeMeta,
  queued: boolean,
): ArtifactStatus | null {
  const orientation =
    meta.orientation === "portrait" ||
    meta.orientation === "landscape" ||
    meta.orientation === "square"
      ? meta.orientation
      : null;
  switch (meta.kind ?? null) {
    case "render":
      return orientation
        ? queued
          ? `render-queued-${orientation}`
          : `rendering-${orientation}`
        : queued
          ? "render-queued"
          : "rendering";
    case "generate":
    case "rewrite_script":
      return "generating";
    case "transcribe":
      return "transcribing";
    case "isolate":
      return "isolating";
    case "download":
      return "downloading";
    case "archive":
      return "archiving";
    case "upload":
      return "uploading";
    case "trim":
      return "trimming";
    case "crop":
      return "cropping";
    case "splice":
      return "splicing";
    case "reverse":
      return "reversing";
    case "change_speed":
      return "changing-speed";
    case "replace_audio":
      return "replacing-audio";
    case "process":
    case "extract":
    case "apply_cuts":
    case "apply_sfx":
      return "processing";
    case "analyze":
    case "describe":
      return "analyzing";
    case "delete":
      return "deleting";
    case "final":
      return "rendering";
    case null:
      return null;
  }
}

function artifactView(
  context: EngineContext,
  artifact: ArtifactRow,
): ArtifactStatusInput["artifactRow"] {
  const row = context.store.db
    .prepare(
      `SELECT status, meta_json, deadline_at
       FROM runtime_artifact_views WHERE artifact_id=?`,
    )
    .get(artifact.artifact_id) as unknown as ViewRow | undefined;
  return row
    ? {
        status: row.status,
        meta: parseJson(row.meta_json, {}),
        deadlineAt: row.deadline_at,
      }
    : null;
}

function pendingTask(
  context: EngineContext,
  artifact: ArtifactRow,
): ArtifactStatusInput["pendingTask"] {
  const row = context.store.db
    .prepare(
      `SELECT task_id, task_type, created_at, meta_json,
              completing, owner_id
       FROM runtime_pending_tasks WHERE artifact_id=?`,
    )
    .get(artifact.artifact_id) as unknown as PendingRow | undefined;
  return row
    ? {
        artifactId: artifact.artifact_id,
        artifactSlug: artifact.slug,
        taskId: row.task_id,
        taskType: row.task_type,
        workspacePath: context.artifactPath(artifact.artifact_id),
        createdAt: row.created_at,
        meta: parseJson(row.meta_json, {}),
        completing: row.completing === 1,
        ownerId: row.owner_id,
      }
    : null;
}

function generationError(
  context: EngineContext,
  artifact: ArtifactRow,
): ArtifactStatusInput["generationError"] {
  const row = context.store.db
    .prepare(
      `SELECT message, fail_code, prompt, failed_at
       FROM runtime_generation_errors WHERE artifact_id=?`,
    )
    .get(artifact.artifact_id) as unknown as FailureRow | undefined;
  return row
    ? {
        artifactId: artifact.artifact_id,
        artifactSlug: artifact.slug,
        message: row.message,
        ...(row.fail_code ? { failCode: row.fail_code } : {}),
        ...(row.prompt !== null ? { prompt: row.prompt } : {}),
        failedAt: row.failed_at,
      }
    : null;
}

function activeArtifactLock(
  context: EngineContext,
  artifact: ArtifactRow,
): ArtifactStatusInput["lockData"] {
  const prefix = context.artifactPath(artifact.artifact_id);
  const row = context.store.db
    .prepare(
      `SELECT lease_id, resource_key, owner_id, acquired_at, expires_at,
              pid, state, data_json
       FROM runtime_resource_leases
       WHERE artifact_id=? AND revoked_at IS NULL AND expires_at>?
       ORDER BY acquired_at DESC LIMIT 1`,
    )
    .get(artifact.artifact_id, Date.now()) as unknown as
    | LeaseRow
    | undefined;
  return row
    ? {
        id: row.lease_id,
        resource: row.resource_key || prefix,
        ownerId: row.owner_id,
        created_at: row.acquired_at,
        timeout_at: row.expires_at,
        ...(row.pid !== null ? { pid: row.pid } : {}),
        ...(row.state ? { state: row.state } : {}),
        data: parseJson(row.data_json, {}),
      }
    : null;
}
