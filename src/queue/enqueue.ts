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

  if (externalTaskId) {
    const existing = findExistingByExternal(db, opts.type, externalTaskId);
    if (existing) return { inserted: false, job: rowToJob(existing) };
  }
  if (dedupeKey) {
    const existing = findExistingByDedupe(db, dedupeKey);
    if (existing) return { inserted: false, job: rowToJob(existing) };
  }

  const params: InsertParams = {
    operation_id: randomUUID(),
    type: opts.type,
    asset_id: opts.assetId ?? null,
    external_task_id: externalTaskId,
    state: initialState,
    payload: JSON.stringify(opts.payload),
    dedupe_key: dedupeKey,
    max_attempts: opts.maxAttempts ?? 1,
    enqueued_at: Date.now(),
  };

  try {
    const row = insertRow(db, params);
    return { inserted: true, job: rowToJob(row) };
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
