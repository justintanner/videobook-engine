import { randomUUID } from "node:crypto";
import * as path from "node:path";

import { type FsError, type Result, ok, err } from "../types.js";
import { getStateDb } from "../db/client.js";
import { getLockData } from "../lock/query.js";
import { computeAssetStatus, hasPartFile } from "./status.js";
import { getManifest } from "./manifest.js";
import { listAssets } from "./list.js";
import {
  type AssetMeta,
  type AssetOwnerKind,
  type AssetWorkKind,
  upsertAssetRow,
} from "./work.js";
import {
  rowToPendingTask,
  type PendingTask,
  type PendingTaskRow,
  type TaskType,
  rowToGenerationError,
  type GenerationError,
  type GenerationErrorRow,
} from "../pending-task/types.js";

const PROVIDER_DEADLINE_MS = 30 * 60_000;

const DEFAULT_PRIMARY_MEDIA_RE =
  /^original\.(mp4|mov|mp3|wav|jpe?g|png|webp)$/i;

function kindFromTaskType(taskType: TaskType): AssetWorkKind {
  if (taskType === "transcribe" || taskType === "fal_transcribe")
    return "transcribe";
  if (taskType === "isolate_vocals") return "isolate";
  if (taskType === "describe_image") return "describe";
  if (taskType === "rewrite_script") return "rewrite_script";
  return "generate";
}

interface RecoveryEvidence {
  pendingTask: PendingTask | null;
  generationError: GenerationError | null;
  hasLock: boolean;
}

function readEvidence(
  projectDir: string,
  projectsDir: string,
  assetId: string,
  assetDir: string,
): Promise<RecoveryEvidence> {
  const db = getStateDb(projectDir);
  const ptRow = db
    .prepare(
      `SELECT asset_id, task_id, task_type, asset_dir, created_at, meta, completing, owner_id
         FROM pending_tasks WHERE asset_id = ?`,
    )
    .get(assetId) as PendingTaskRow | undefined;
  const errRow = db
    .prepare(
      `SELECT asset_id, message, fail_code, prompt, failed_at
         FROM generation_errors WHERE asset_id = ?`,
    )
    .get(assetId) as GenerationErrorRow | undefined;
  return getLockData(projectsDir, assetDir).then((lock) => ({
    pendingTask: ptRow ? rowToPendingTask(ptRow) : null,
    generationError: errRow ? rowToGenerationError(errRow) : null,
    hasLock: lock !== null,
  }));
}

/**
 * Recovery-internal: reconstruct the assets row for `assetId` from disk +
 * existing tables. Bypasses beginAssetWork's no-overwrite guard.
 *
 * Precedence:
 *   1. generation_errors row exists → status='error' with that message.
 *   2. pending_tasks row exists, no error → mint fresh ownerId, write to BOTH
 *      pending_tasks and assets in one txn, clear `completing` flag, set
 *      deadline_at = now + 30m.
 *   3. locks row exists, no pending_tasks, no error → status='error',
 *      meta.error.message='abandoned at restart', also writes generation_errors.
 *      The original handler's process is dead by definition.
 *   4. Otherwise → run computeAssetStatus over disk; map ready→ready,
 *      error→error, anything else→pending.
 */
export async function recoverAssetRow(
  projectDir: string,
  projectsDir: string,
  assetId: string,
): Promise<Result<void, FsError>> {
  const assetDir = path.join(projectDir, assetId);
  const evidence = await readEvidence(projectDir, projectsDir, assetId, assetDir);

  // Precedence 1: generation_errors row beats other evidence.
  if (evidence.generationError !== null) {
    upsertAssetRow(projectDir, {
      assetId,
      status: "error",
      meta: {
        kind: null,
        orientation: null,
        queued: false,
        progress: null,
        error: {
          message: evidence.generationError.message,
          code: evidence.generationError.failCode ?? null,
        },
      },
      ownerId: null,
      ownerKind: null,
      pid: null,
      deadlineAt: null,
    });
    return ok(undefined);
  }

  // Precedence 2: live provider task — mint fresh ownerId, refresh both rows.
  if (evidence.pendingTask !== null) {
    const newOwner = randomUUID();
    const now = Date.now() / 1000;
    const deadline = now + PROVIDER_DEADLINE_MS / 1000;
    const db = getStateDb(projectDir);
    db.prepare(
      `UPDATE pending_tasks SET owner_id = ?, completing = 0 WHERE asset_id = ?`,
    ).run(newOwner, assetId);
    upsertAssetRow(projectDir, {
      assetId,
      status: "working",
      meta: {
        kind: kindFromTaskType(evidence.pendingTask.taskType),
        orientation: null,
        queued: false,
        progress: null,
        error: null,
      },
      ownerId: newOwner,
      ownerKind: "provider" as AssetOwnerKind,
      pid: null,
      deadlineAt: deadline,
    });
    return ok(undefined);
  }

  // Precedence 3: stale lock without provider task → abandoned at restart.
  if (evidence.hasLock) {
    const message = "abandoned at restart";
    const code = "recovery_no_live_worker";
    const failedAt = Date.now() / 1000;
    const db = getStateDb(projectDir);
    db.prepare(
      `INSERT INTO generation_errors (asset_id, message, fail_code, prompt, failed_at)
       VALUES (?, ?, ?, NULL, ?)
       ON CONFLICT(asset_id) DO UPDATE SET
         message=excluded.message, fail_code=excluded.fail_code, failed_at=excluded.failed_at`,
    ).run(assetId, message, code, failedAt);
    upsertAssetRow(projectDir, {
      assetId,
      status: "error",
      meta: {
        kind: null,
        orientation: null,
        queued: false,
        progress: null,
        error: { message, code },
      },
      ownerId: null,
      ownerKind: null,
      pid: null,
      deadlineAt: null,
    });
    return ok(undefined);
  }

  // Precedence 4: derive from disk via computeAssetStatus.
  const manifest = await getManifest(projectDir, assetId, {
    includeDotfiles: true,
  });
  if (!manifest.ok) {
    // Asset directory is gone or unreadable; remove any stale row.
    const db = getStateDb(projectDir);
    db.prepare(`DELETE FROM assets WHERE asset_id = ?`).run(assetId);
    return ok(undefined);
  }

  const fileNames = new Set(manifest.value.files.map((f) => f.name));
  const primaryMediaName =
    manifest.value.files.find((f) => DEFAULT_PRIMARY_MEDIA_RE.test(f.name))
      ?.name ?? null;

  const status = computeAssetStatus({
    assetId,
    fileNames,
    primaryMediaName,
    hasPartFile: hasPartFile(fileNames),
    lockData: null,
    pendingTask: null,
    generationError: null,
  });

  if (status === "ready") {
    upsertAssetRow(projectDir, {
      assetId,
      status: "ready",
      meta: {},
      ownerId: null,
      ownerKind: null,
      pid: null,
      deadlineAt: null,
    });
    return ok(undefined);
  }
  if (status === "error") {
    upsertAssetRow(projectDir, {
      assetId,
      status: "error",
      meta: {
        kind: null,
        orientation: null,
        queued: false,
        progress: null,
        error: { message: "asset has no recoverable media", code: "no_media" },
      },
      ownerId: null,
      ownerKind: null,
      pid: null,
      deadlineAt: null,
    });
    return ok(undefined);
  }
  // Anything else (analyzing/processing/transcribing/...) at recovery time
  // means there was a marker file (.processing.json/.analyzing.json) but no
  // live worker. Treat as pending so a fresh job can pick it up; the marker
  // files will be removed when handlers stop writing them.
  upsertAssetRow(projectDir, {
    assetId,
    status: "pending",
    meta: { kind: null, orientation: null, queued: false, progress: null, error: null },
    ownerId: null,
    ownerKind: null,
    pid: null,
    deadlineAt: Date.now() / 1000 + PROVIDER_DEADLINE_MS / 1000,
  });
  return ok(undefined);
}

/**
 * Walk the project's asset directories and rebuild every assets row from
 * existing evidence. Called at engine boot via the consumer.
 */
export async function recoverAssetsTable(
  projectDir: string,
  projectsDir: string,
): Promise<Result<{ recovered: number }, FsError>> {
  try {
    const assets = await listAssets(projectDir);
    let recovered = 0;
    for (const a of assets) {
      const r = await recoverAssetRow(projectDir, projectsDir, a.id);
      if (!r.ok) continue;
      recovered++;
    }
    // Clean up assets rows whose directories no longer exist.
    const db = getStateDb(projectDir);
    const knownIds = new Set(assets.map((a) => a.id));
    const allRows = db.prepare(`SELECT asset_id FROM assets`).all() as {
      asset_id: string;
    }[];
    for (const row of allRows) {
      if (!knownIds.has(row.asset_id)) {
        db.prepare(`DELETE FROM assets WHERE asset_id = ?`).run(row.asset_id);
      }
    }
    return ok({ recovered });
  } catch (error: unknown) {
    const e = error as { message?: string };
    return err({ code: "IO_ERROR", message: e.message ?? "recovery failed" });
  }
}
