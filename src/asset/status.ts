import type { LockData } from "../types.js";
import type { PendingTask, GenerationError } from "../pending-task/types.js";
import { type FsError, type Result, ok } from "../types.js";
import { getManifest } from "./manifest.js";
import { getLockData } from "../lock/query.js";
import { readPendingTask } from "../pending-task/read.js";
import { readGenerationError } from "../pending-task/errors.js";
import {
  type AssetMeta,
  type AssetStatus as AssetRowStatus,
  readAssetRow,
} from "./work.js";

/**
 * Well-known terminal/lifecycle statuses surfaced to the UI. Lock-driven
 * statuses (e.g. `rendering-portrait`, `downloading`) are passed through
 * verbatim from `LockData.state`, so this union enumerates the values that
 * are NOT lock states. Treat the type as a closed set when reasoning about
 * non-lock states; the runtime may still return a lock state string.
 */
export type AssetStatus =
  | "uploading"
  | "loading"
  | "generating"
  | "processing"
  | "analyzing"
  | "trimming"
  | "cropping"
  | "splicing"
  | "reversing"
  | "changing-speed"
  | "replacing-audio"
  | "isolating"
  | "rendering"
  | "rendering-landscape"
  | "rendering-portrait"
  | "rendering-square"
  | "render-queued"
  | "render-queued-landscape"
  | "render-queued-portrait"
  | "render-queued-square"
  | "downloading"
  | "archiving"
  | "transcribing"
  | "error"
  | "deleting"
  | "ready";

const PARTIAL_DOWNLOAD_RE = /\.(mp4|mov)\.part$/i;
const IMAGE_LIKE_MEDIA_RE = /\.(jpe?g|png|webp)$/i;

export interface AssetStatusInput {
  assetId: string;
  fileNames: ReadonlySet<string>;
  primaryMediaName: string | null;
  hasPartFile: boolean;
  lockData: LockData | null;
  pendingTask: PendingTask | null;
  generationError: GenerationError | null;
  /** Materialized assets-table row, or null if no row exists. The row's
   *  status='error' beats stale lock data (rule 1); status='pending'/'working'
   *  with a meta.kind set drives the in-progress UI state (rule 4) so a
   *  freshly-enqueued asset never falls through to the orphan "error".
   *  `deadlineAt` (unix seconds) lets rule 10 treat a kindless pending row
   *  from createAsset as "loading" while the deadline is live, instead of
   *  orphan "error" during the createAsset→enqueue window. */
  assetRow: {
    status: AssetRowStatus;
    meta: AssetMeta;
    deadlineAt?: number | null;
  } | null;
}

/**
 * Maps the assets-table (`meta.kind`, `meta.orientation`, queued/working) to
 * a concrete UI AssetStatus. Returns null when no kind is set so the caller
 * can fall through to file-based rules (e.g. rows created via createAsset
 * before any worker claimed them carry no kind).
 */
function mapKindToStatus(meta: AssetMeta, queued: boolean): AssetStatus | null {
  const kind = meta.kind ?? null;
  if (kind === null) return null;
  const o = meta.orientation;
  switch (kind) {
    case "render": {
      const orient =
        o === "portrait" || o === "landscape" || o === "square" ? o : null;
      if (queued) {
        return orient ? (`render-queued-${orient}` as AssetStatus) : "render-queued";
      }
      return orient ? (`rendering-${orient}` as AssetStatus) : "rendering";
    }
    case "generate":       return "generating";
    case "transcribe":     return "transcribing";
    case "isolate":        return "isolating";
    case "download":       return "downloading";
    case "archive":        return "archiving";
    case "upload":         return "uploading";
    case "trim":           return "trimming";
    case "crop":           return "cropping";
    case "splice":         return "splicing";
    case "reverse":        return "reversing";
    case "change_speed":   return "changing-speed";
    case "replace_audio":  return "replacing-audio";
    case "process":        return "processing";
    case "analyze":        return "analyzing";
    case "delete":         return "deleting";
    case "describe":       return "analyzing";
    case "rewrite_script": return "generating";
    case "extract":        return "processing";
    case "apply_cuts":     return "processing";
    case "apply_sfx":      return "processing";
    case "final":          return "rendering";
    default: {
      const _exhaustive: never = kind;
      void _exhaustive;
      return null;
    }
  }
}

/**
 * Pure-function rule cascade. First matching rule wins. The status is the
 * single source of truth the UI displays for the asset.
 *
 * Rule order:
 *   1. assetRow.status === 'error'             → "error"
 *      (durable structured failure; beats stale lock data)
 *   2. Active lock (timeout in future)         → lock.state ?? "loading"
 *   3. Pending task (sqlite row)               → "transcribing" | "isolating" | "generating"
 *   4. assetRow non-terminal with meta.kind:
 *      a. status='pending'                     → mapKindToStatus(meta, queued=true)
 *      b. status='working'                     → mapKindToStatus(meta, queued=false)
 *      (status='ready' or no kind falls through)
 *   5. Legacy `.processing.json` marker        → "processing"
 *   6. Legacy `.analyzing.json` marker         → "analyzing"
 *   7. vid- with .part file but no real video  → "error"
 *   8. Has primary media:
 *      a. Generation error recorded            → "error"
 *      b. id === "final"                       → "ready"
 *      c. vid- without .original.json          → "processing"
 *      d. otherwise                            → "ready"
 *   9. Has part file (any kind)                → "error"
 *  10. Kindless pending row, live deadline     → "loading"
 *      (createAsset co-writes a kindless pending row before the job enqueue
 *      stamps meta.kind; without this the createAsset→enqueue window reads
 *      as orphan "error")
 *  11. Otherwise                               → "error" (orphan)
 */
export function computeAssetStatus(input: AssetStatusInput): AssetStatus {
  const {
    assetId,
    fileNames,
    primaryMediaName,
    hasPartFile,
    lockData,
    pendingTask,
    generationError,
    assetRow,
  } = input;

  if (assetRow !== null && assetRow.status === "error") return "error";

  const now = Date.now() / 1000;
  const isLockActive = lockData != null && now < lockData.timeout_at;
  if (isLockActive) {
    const state =
      typeof lockData!.state === "string" ? (lockData!.state as string) : null;
    return (state ?? "loading") as AssetStatus;
  }

  if (pendingTask) {
    if (pendingTask.taskType === "transcribe") return "transcribing";
    if (pendingTask.taskType === "isolate_vocals") return "isolating";
    return "generating";
  }

  if (assetRow !== null) {
    if (assetRow.status === "pending") {
      const mapped = mapKindToStatus(assetRow.meta, true);
      if (mapped !== null) return mapped;
    } else if (assetRow.status === "working") {
      const mapped = mapKindToStatus(assetRow.meta, false);
      if (mapped !== null) return mapped;
    }
  }

  if (fileNames.has(".processing.json")) return "processing";
  if (fileNames.has(".analyzing.json")) return "analyzing";

  const isVideo = assetId.startsWith("vid-");
  const mediaIsImageLike =
    primaryMediaName !== null && IMAGE_LIKE_MEDIA_RE.test(primaryMediaName);

  if (
    hasPartFile &&
    isVideo &&
    (primaryMediaName === null || mediaIsImageLike)
  ) {
    return "error";
  }

  if (primaryMediaName !== null) {
    if (generationError !== null) return "error";
    if (assetId === "final") return "ready";
    if (isVideo && !fileNames.has(".original.json")) return "processing";
    return "ready";
  }

  // Notebook and character assets have no required primary media.
  // Treat as ready.
  if (assetId.startsWith("nb-") || assetId.startsWith("char-")) return "ready";

  if (hasPartFile) return "error";

  const pendingRowLive =
    assetRow !== null &&
    assetRow.status === "pending" &&
    typeof assetRow.deadlineAt === "number" &&
    now < assetRow.deadlineAt;
  if (pendingRowLive) return "loading";

  return "error";
}

export function hasPartFile(fileNames: ReadonlySet<string>): boolean {
  for (const name of fileNames) {
    if (PARTIAL_DOWNLOAD_RE.test(name)) return true;
  }
  return false;
}

export interface GetAssetStatusOptions {
  /** Override the primary media filename (e.g. when the caller has its own
   *  asset-type-aware picker). If omitted, the first file matching
   *  `original.(mp4|mov|mp3|wav|jpg|jpeg|png|webp)` is used. */
  primaryMediaName?: string | null;
}

const DEFAULT_PRIMARY_MEDIA_RE =
  /^original\.(mp4|mov|mp3|wav|jpe?g|png|webp)$/i;

export async function getAssetStatus(
  projectDir: string,
  projectsDir: string,
  assetId: string,
  options?: GetAssetStatusOptions,
): Promise<Result<AssetStatus, FsError>> {
  const manifestResult = await getManifest(projectDir, assetId, {
    includeDotfiles: true,
  });
  const files = manifestResult.ok ? manifestResult.value.files : [];
  const fileNames = new Set(files.map((f) => f.name));

  const assetDir = manifestResult.ok ? manifestResult.value.path : "";
  const lockData =
    assetDir !== "" ? await getLockData(projectsDir, assetDir) : null;

  const pendingTaskResult = readPendingTask(projectDir, assetId);
  const pendingTask = pendingTaskResult.ok ? pendingTaskResult.value : null;

  const generationErrorResult = readGenerationError(projectDir, assetId);
  const generationError = generationErrorResult.ok
    ? generationErrorResult.value
    : null;

  const assetRowResult = readAssetRow(projectDir, assetId);
  const assetRow = assetRowResult.ok && assetRowResult.value
    ? {
        status: assetRowResult.value.status,
        meta: assetRowResult.value.meta,
        deadlineAt: assetRowResult.value.deadlineAt,
      }
    : null;

  const primaryMediaName =
    options?.primaryMediaName !== undefined
      ? options.primaryMediaName
      : (files.find((f) => DEFAULT_PRIMARY_MEDIA_RE.test(f.name))?.name ?? null);

  const status = computeAssetStatus({
    assetId,
    fileNames,
    primaryMediaName,
    hasPartFile: hasPartFile(fileNames),
    lockData,
    pendingTask,
    generationError,
    assetRow,
  });
  return ok(status);
}
