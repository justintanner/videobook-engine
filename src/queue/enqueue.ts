import { randomUUID } from "node:crypto";

import type { Database as DatabaseType } from "better-sqlite3";

import { dedupeKey as deriveDedupeKey } from "./canonicalize.js";
import { rowToJob } from "./row.js";
import {
  type EnqueueOptions,
  type EnqueueResult,
  type Job,
  type JobRow,
} from "./types.js";

const QUEUE_PENDING_DEADLINE_S = 5 * 60;

/**
 * Atomically refresh (or insert) the assets row at status='pending' for an
 * asset-scoped enqueue. CAS guard: never overwrites a row whose owner_id is
 * non-null — an in-flight worker keeps its lease. Caller must invoke this
 * inside the same transaction as the pending_jobs INSERT.
 */
function writePendingAssetRow(
  db: DatabaseType,
  assetId: string,
  jobType: string,
  nowSeconds: number,
): void {
  const deadline = nowSeconds + QUEUE_PENDING_DEADLINE_S;
  // CAS guard: do not overwrite an active owner OR a terminal 'error' row.
  // The error must be cleared explicitly via generationErrors.clear → recover
  // before the asset is eligible for new work.
  db.prepare(
    `INSERT INTO assets (asset_id, status, meta, owner_id, owner_kind, pid, deadline_at, updated_at)
     VALUES (?, 'pending', json_object('kind', ?, 'queued', json('true')), NULL, 'job', NULL, ?, ?)
     ON CONFLICT(asset_id) DO UPDATE SET
       status='pending',
       meta=json_set(COALESCE(meta,'{}'), '$.queued', json('true'), '$.kind', ?),
       deadline_at=?,
       updated_at=?
     WHERE assets.owner_id IS NULL AND assets.status != 'error'`,
  ).run(
    assetId,
    jobType,
    deadline,
    nowSeconds,
    jobType,
    deadline,
    nowSeconds,
  );
}

interface InsertParams {
  operation_id: string;
  type: string;
  asset_id: string | null;
  external_task_id: string | null;
  state: string;
  payload: string;
  dedupe_key: string | null;
  max_attempts: number;
  enqueued_at: number;
}

function computeDedupeKey(opts: EnqueueOptions): string | null {
  if (opts.dedupeKey === null) return null;
  if (typeof opts.dedupeKey === "string") return opts.dedupeKey;
  return deriveDedupeKey(opts.assetId ?? null, opts.type, opts.payload);
}

function findExistingByDedupe(
  db: DatabaseType,
  dedupeKey: string,
): JobRow | undefined {
  return db
    .prepare(
      `SELECT * FROM pending_jobs
       WHERE dedupe_key = ?
         AND state IN ('queued','running','completing')
       LIMIT 1`,
    )
    .get(dedupeKey) as JobRow | undefined;
}

function findExistingByExternal(
  db: DatabaseType,
  type: string,
  externalTaskId: string,
): JobRow | undefined {
  return db
    .prepare(
      `SELECT * FROM pending_jobs
       WHERE type = ? AND external_task_id = ?
       LIMIT 1`,
    )
    .get(type, externalTaskId) as JobRow | undefined;
}

function insertRow(db: DatabaseType, params: InsertParams): JobRow {
  const info = db
    .prepare(
      `INSERT INTO pending_jobs
       (operation_id, type, asset_id, external_task_id, state, payload, dedupe_key, max_attempts, enqueued_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      params.operation_id,
      params.type,
      params.asset_id,
      params.external_task_id,
      params.state,
      params.payload,
      params.dedupe_key,
      params.max_attempts,
      params.enqueued_at,
    );
  return db
    .prepare(`SELECT * FROM pending_jobs WHERE id = ?`)
    .get(info.lastInsertRowid as number) as JobRow;
}

export function enqueue(db: DatabaseType, opts: EnqueueOptions): EnqueueResult {
  const dedupeKey = computeDedupeKey(opts);
  const externalTaskId = opts.externalTaskId ?? null;
  const initialState = opts.initialState ?? (externalTaskId ? "running" : "queued");
  const assetId = opts.assetId ?? null;

  // Atomic enqueue: pending_jobs INSERT + (when assetId is set) a pending
  // assets row co-write share one transaction so we cannot leave the queue
  // and asset state divergent under crash/error.
  const tx = db.transaction((): EnqueueResult => {
    if (externalTaskId) {
      const existing = findExistingByExternal(db, opts.type, externalTaskId);
      if (existing) return { inserted: false, job: rowToJob(existing) };
    }
    if (dedupeKey) {
      const existing = findExistingByDedupe(db, dedupeKey);
      if (existing) return { inserted: false, job: rowToJob(existing) };
    }

    const enqueuedAt = Date.now();
    const params: InsertParams = {
      operation_id: randomUUID(),
      type: opts.type,
      asset_id: assetId,
      external_task_id: externalTaskId,
      state: initialState,
      payload: JSON.stringify(opts.payload),
      dedupe_key: dedupeKey,
      max_attempts: opts.maxAttempts ?? 1,
      enqueued_at: enqueuedAt,
    };

    const row = insertRow(db, params);
    if (assetId) {
      writePendingAssetRow(db, assetId, opts.type, enqueuedAt / 1000);
    }
    return { inserted: true, job: rowToJob(row) };
  });

  try {
    return tx();
  } catch (error: unknown) {
    const e = error as { code?: string };
    if (e.code === "SQLITE_CONSTRAINT_UNIQUE") {
      // Lost a race against another concurrent enqueue with the same key
      if (externalTaskId) {
        const existing = findExistingByExternal(db, opts.type, externalTaskId);
        if (existing) return { inserted: false, job: rowToJob(existing) };
      }
      if (dedupeKey) {
        const existing = findExistingByDedupe(db, dedupeKey);
        if (existing) return { inserted: false, job: rowToJob(existing) };
      }
    }
    throw error;
  }
}

export function getJob(db: DatabaseType, id: number): Job | null {
  const row = db
    .prepare(`SELECT * FROM pending_jobs WHERE id = ?`)
    .get(id) as JobRow | undefined;
  return row ? rowToJob(row) : null;
}

export function findJobByExternal(
  db: DatabaseType,
  type: string,
  externalTaskId: string,
): Job | null {
  const row = findExistingByExternal(db, type, externalTaskId);
  return row ? rowToJob(row) : null;
}
