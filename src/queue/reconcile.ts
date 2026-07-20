import * as fs from "node:fs/promises";
import * as path from "node:path";

import type { Database as DatabaseType } from "better-sqlite3";

import { enqueue, findJobByExternal } from "./enqueue.js";
import { dedupeKey as deriveDedupeKey } from "./canonicalize.js";

export interface ReconcileOptions {
  /** Provided by callers that want to map sidecar payloads to the new queue
   *  job `type` and any extra metadata; unmatched sidecars are skipped. */
  mapper?: (sidecar: SidecarRecord) => MappedSidecar | null;
}

export interface SidecarRecord {
  assetId: string;
  /** Absolute path to the asset directory containing the sidecar. */
  assetDir: string;
  /** Absolute path to the .kie-task.json sidecar. */
  sidecarPath: string;
  /** Parsed JSON contents of .kie-task.json. */
  data: Record<string, unknown>;
}

export interface MappedSidecar {
  /** Queue job type to enqueue (defaults to `complete_kie_task` when null). */
  type: string;
  payload: Record<string, unknown>;
  externalTaskId: string | null;
  /** When externalTaskId is null we treat the sidecar as still-queued. */
  isQueuedSentinel: boolean;
}

const QUEUED_SIDECAR_SENTINEL = "queued";

interface ReconcileResult {
  insertedQueued: number;
  insertedRunning: number;
  matchedExisting: number;
  skipped: number;
  scanned: number;
}

const DEFAULT_TYPE = "complete_kie_task";

function defaultMapper(sidecar: SidecarRecord): MappedSidecar | null {
  const data = sidecar.data;
  const taskId = typeof data.taskId === "string" ? data.taskId : null;
  if (!taskId) return null;
  const taskType = typeof data.taskType === "string" ? data.taskType : DEFAULT_TYPE;
  const isQueuedSentinel = taskId === QUEUED_SIDECAR_SENTINEL;
  return {
    type: taskType,
    payload: { ...data, sidecarPath: sidecar.sidecarPath },
    externalTaskId: isQueuedSentinel ? null : taskId,
    isQueuedSentinel,
  };
}

async function listAssetDirs(projectDir: string): Promise<string[]> {
  let entries: string[];
  try {
    entries = await fs.readdir(projectDir);
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const name of entries) {
    if (name.startsWith(".")) continue;
    const full = path.join(projectDir, name);
    const stat = await fs.stat(full).catch(() => null);
    if (stat?.isDirectory()) out.push(full);
  }
  return out;
}

async function readSidecar(
  assetDir: string,
): Promise<SidecarRecord | null> {
  const sidecarPath = path.join(assetDir, ".kie-task.json");
  let raw: string;
  try {
    raw = await fs.readFile(sidecarPath, "utf-8");
  } catch {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return {
      assetId: path.basename(assetDir),
      assetDir,
      sidecarPath,
      data: parsed,
    };
  } catch {
    return null;
  }
}

/**
 * Walk the project's asset dirs and align state.pending_jobs with on-disk
 * .kie-task.json sidecars.
 *
 * Two paths:
 *   - sidecar.taskId === "queued": sentinel — never reached the provider.
 *     Insert a state='queued' row keyed by the canonical dedupe_key so a
 *     re-submission can claim it.
 *   - sidecar.taskId is a real external task id: the provider holds the work.
 *     Upsert a state='running' row keyed by (type, external_task_id) so the
 *     next sync poll resumes status-checking.
 */
export async function reconcileFromSidecars(
  db: DatabaseType,
  projectDir: string,
  opts: ReconcileOptions = {},
): Promise<ReconcileResult> {
  const mapper = opts.mapper ?? defaultMapper;
  const dirs = await listAssetDirs(projectDir);
  const result: ReconcileResult = {
    insertedQueued: 0,
    insertedRunning: 0,
    matchedExisting: 0,
    skipped: 0,
    scanned: 0,
  };

  for (const dir of dirs) {
    const sidecar = await readSidecar(dir);
    if (!sidecar) continue;
    result.scanned += 1;
    const mapped = mapper(sidecar);
    if (!mapped) {
      result.skipped += 1;
      continue;
    }

    if (mapped.isQueuedSentinel) {
      const dKey = deriveDedupeKey(sidecar.assetId, mapped.type, mapped.payload);
      const enq = enqueue(db, {
        type: mapped.type,
        assetId: sidecar.assetId,
        payload: mapped.payload,
        dedupeKey: dKey,
        initialState: "queued",
      });
      if (enq.inserted) result.insertedQueued += 1;
      else result.matchedExisting += 1;
      continue;
    }

    if (mapped.externalTaskId == null) {
      result.skipped += 1;
      continue;
    }

    const existing = findJobByExternal(db, mapped.type, mapped.externalTaskId);
    if (existing) {
      result.matchedExisting += 1;
      // SQLite trumps sidecar; do not downgrade.
      continue;
    }
    const enq = enqueue(db, {
      type: mapped.type,
      assetId: sidecar.assetId,
      payload: mapped.payload,
      externalTaskId: mapped.externalTaskId,
      initialState: "running",
    });
    if (enq.inserted) result.insertedRunning += 1;
    else result.matchedExisting += 1;
  }

  return result;
}
