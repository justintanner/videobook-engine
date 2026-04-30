import { randomUUID } from "node:crypto";

import { type FsError, type Result, ok, err } from "../types.js";
import { getStateDb } from "../db/client.js";
import { type AssetWorkKind } from "../asset/work.js";
import { type PendingTask, type TaskType } from "./types.js";

export interface WritePendingTaskInput {
  assetId: string;
  taskId: string;
  taskType: TaskType;
  assetDir: string;
  meta?: Record<string, unknown>;
  completing?: boolean;
}

export interface WritePendingTaskResult {
  pendingTask: PendingTask;
  /** Newly minted provider owner_id; same value lives on both rows. */
  providerOwnerId: string;
}

function kindFromTaskType(taskType: TaskType): AssetWorkKind {
  if (taskType === "transcribe" || taskType === "fal_transcribe")
    return "transcribe";
  if (taskType === "isolate_vocals") return "isolate";
  if (taskType === "describe_image") return "describe";
  if (taskType === "rewrite_script") return "rewrite_script";
  return "generate";
}

const PROVIDER_DEADLINE_MS = 30 * 60_000;

/**
 * Provider hand-off. Caller must already hold a local job lease created by
 * `beginAssetWork` and pass its ownerId as `expectedOwnerId`. In one txn:
 *   1. Read assets.owner_id; if != expectedOwnerId → return ok(null)
 *      (lease lost — caller should abort and try to cancel any provider work
 *      it just submitted).
 *   2. Mint a fresh providerOwnerId and write it to BOTH pending_tasks and
 *      assets so sync's per-task renew finds the matching token.
 *   3. Update assets owner_kind='provider', meta.kind=<from task_type>,
 *      deadline_at=now+30m. Status stays 'working'.
 *   4. Delete any prior generation_errors row.
 */
export function writePendingTask(
  projectDir: string,
  input: WritePendingTaskInput,
  expectedOwnerId?: string,
): Result<WritePendingTaskResult | null, FsError> {
  const db = getStateDb(projectDir);
  const now = Date.now() / 1000;
  const meta = input.meta ?? {};
  const completing = input.completing === true ? 1 : 0;
  const providerOwnerId = randomUUID();
  const kind = kindFromTaskType(input.taskType);

  try {
    const tx = db.transaction((): WritePendingTaskResult | null => {
      const existing = db
        .prepare("SELECT owner_id, status FROM assets WHERE asset_id = ?")
        .get(input.assetId) as
        | { owner_id: string | null; status: string }
        | undefined;

      // Strict CAS path: only proceed if assets row's owner matches the
      // expected local job lease that's handing off to the provider.
      if (expectedOwnerId !== undefined) {
        if (!existing || existing.owner_id !== expectedOwnerId) {
          return null;
        }
      } else if (existing?.status === "error") {
        // Defense in depth: refuse to resurrect a row the reaper already
        // declared dead. A late Pattern A handler that takes longer than the
        // queue deadline would otherwise overwrite generation_errors.
        return null;
      }

      db.prepare("DELETE FROM generation_errors WHERE asset_id = ?").run(
        input.assetId,
      );

      db.prepare(
        `INSERT INTO pending_tasks
           (asset_id, task_id, task_type, asset_dir, created_at, meta, completing, owner_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(asset_id) DO UPDATE SET
           task_id    = excluded.task_id,
           task_type  = excluded.task_type,
           asset_dir  = excluded.asset_dir,
           created_at = excluded.created_at,
           meta       = excluded.meta,
           completing = excluded.completing,
           owner_id   = excluded.owner_id`,
      ).run(
        input.assetId,
        input.taskId,
        input.taskType,
        input.assetDir,
        now,
        JSON.stringify(meta),
        completing,
        providerOwnerId,
      );

      // Ensure an assets row exists (legacy callers may not have one) and set
      // it to working+provider with the same owner_id mirror.
      db.prepare(
        `INSERT INTO assets
           (asset_id, status, meta, owner_id, owner_kind, pid, deadline_at, updated_at)
         VALUES (?, 'working',
                 json_object('kind', ?, 'queued', json('false'), 'error', json('null')),
                 ?, 'provider', NULL, ?, ?)
         ON CONFLICT(asset_id) DO UPDATE SET
           status      = 'working',
           owner_id    = excluded.owner_id,
           owner_kind  = 'provider',
           meta        = json_set(COALESCE(meta,'{}'),
                                  '$.kind', ?,
                                  '$.queued', json('false'),
                                  '$.error', json('null')),
           deadline_at = excluded.deadline_at,
           pid         = NULL,
           updated_at  = excluded.updated_at`,
      ).run(
        input.assetId,
        kind,
        providerOwnerId,
        now + PROVIDER_DEADLINE_MS / 1000,
        now,
        kind,
      );

      return {
        pendingTask: {
          assetId: input.assetId,
          taskId: input.taskId,
          taskType: input.taskType,
          assetDir: input.assetDir,
          createdAt: now,
          meta,
          completing: completing === 1,
          ownerId: providerOwnerId,
        },
        providerOwnerId,
      };
    });
    const result = tx();
    return ok(result);
  } catch (error: unknown) {
    const e = error as { message?: string };
    return err({
      code: "IO_ERROR",
      message: e.message ?? "Failed to write pending task",
    });
  }
}

export function markPendingTaskCompleting(
  projectDir: string,
  assetId: string,
): Result<boolean, FsError> {
  const db = getStateDb(projectDir);
  try {
    const result = db
      .prepare(
        "UPDATE pending_tasks SET completing = 1 WHERE asset_id = ?",
      )
      .run(assetId);
    return ok(result.changes > 0);
  } catch (error: unknown) {
    const e = error as { message?: string };
    return err({
      code: "IO_ERROR",
      message: e.message ?? "Failed to mark pending task completing",
    });
  }
}

export function clearPendingTaskCompleting(
  projectDir: string,
  assetId: string,
): Result<boolean, FsError> {
  const db = getStateDb(projectDir);
  try {
    const result = db
      .prepare(
        "UPDATE pending_tasks SET completing = 0 WHERE asset_id = ?",
      )
      .run(assetId);
    return ok(result.changes > 0);
  } catch (error: unknown) {
    const e = error as { message?: string };
    return err({
      code: "IO_ERROR",
      message: e.message ?? "Failed to clear completing flag",
    });
  }
}
