import type { LockData } from "../types.js";
import type { PendingTask, GenerationError } from "../pending-task/types.js";
import { type FsError, type Result, ok } from "../types.js";
import { getManifest } from "./manifest.js";
import { getLockData } from "../lock/query.js";
import { readPendingTask } from "../pending-task/read.js";
import { readGenerationError } from "../pending-task/errors.js";

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
  | "transcribing"
  | "untranscribed"
  | "corrupt"
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
}

/**
 * Pure-function rule cascade. First matching rule wins. The status is the
 * single source of truth the UI displays for the asset.
 *
 * Rule order:
 *   1. Active lock (timeout in future)         → lock.state ?? "loading"
 *   2. Pending task (sqlite row)               → "transcribing" | "isolating" | "generating"
 *   3. Legacy `.processing.json` marker        → "processing"
 *   4. Legacy `.analyzing.json` marker         → "analyzing"
 *   5. vid- with .part file but no real video  → "error"
 *   6. Has primary media:
 *      a. Generation error recorded            → "error"
 *      b. id === "final"                       → "ready"
 *      c. vid- without .original.json          → "processing"
 *      d. vid- without .original.analysis.json → "analyzing"
 *      e. otherwise                            → "ready"
 *   7. Has part file (any kind)                → "error"
 *   8. Otherwise                               → "error" (orphan)
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
  } = input;

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
    if (isVideo && !fileNames.has(".original.analysis.json")) return "analyzing";
    return "ready";
  }

  if (hasPartFile) return "error";
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
  });
  return ok(status);
}
