import { randomUUID } from "node:crypto";

import { type FsError, type Result, ok, err } from "../types.js";
import { getStateDb } from "../db/client.js";

export type AssetWorkKind =
  | "render"
  | "generate"
  | "transcribe"
  | "isolate"
  | "download"
  | "archive"
  | "trim"
  | "crop"
  | "splice"
  | "reverse"
  | "change_speed"
  | "replace_audio"
  | "process"
  | "analyze"
  | "delete"
  | "upload"
  | "describe"
  | "rewrite_script"
  | "extract"
  | "apply_cuts"
  | "apply_sfx"
  | "final";

export type AssetOwnerKind = "job" | "provider";

export type AssetStatus = "pending" | "working" | "ready" | "error";

export interface AssetMeta {
  kind?: AssetWorkKind | null;
  orientation?: "portrait" | "landscape" | "square" | null;
  queued?: boolean;
  progress?: number | null;
  error?: { message: string; code: string | null } | null;
  [extra: string]: unknown;
}

export interface BeginAssetWorkInput {
  kind: AssetWorkKind;
  ownerKind: AssetOwnerKind;
  durationMs: number;
  pid?: number;
  meta?: Partial<AssetMeta>;
}

interface AssetRow {
  asset_id: string;
  status: AssetStatus;
  meta: string;
  owner_id: string | null;
  owner_kind: AssetOwnerKind | null;
  pid: number | null;
  deadline_at: number | null;
  updated_at: number;
  seen_at: number | null;
}

export interface AssetView {
  assetId: string;
  status: AssetStatus;
  meta: AssetMeta;
  ownerId: string | null;
  ownerKind: AssetOwnerKind | null;
  pid: number | null;
  deadlineAt: number | null;
  updatedAt: number;
  seenAt: number | null;
}

function parseMeta(text: string): AssetMeta {
  try {
    const parsed = JSON.parse(text) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as AssetMeta;
    }
  } catch {
    // tolerate corrupt json
  }
  return {};
}

function rowToView(row: AssetRow): AssetView {
  return {
    assetId: row.asset_id,
    status: row.status,
    meta: parseMeta(row.meta),
    ownerId: row.owner_id,
    ownerKind: row.owner_kind,
    pid: row.pid,
    deadlineAt: row.deadline_at,
    updatedAt: row.updated_at,
    seenAt: row.seen_at,
  };
}

export function readAssetRow(
  projectDir: string,
  assetId: string,
): Result<AssetView | null, FsError> {
  const db = getStateDb(projectDir);
  try {
    const row = db
      .prepare(
        `SELECT asset_id, status, meta, owner_id, owner_kind, pid, deadline_at, updated_at, seen_at
         FROM assets WHERE asset_id = ?`,
      )
      .get(assetId) as AssetRow | undefined;
    return ok(row ? rowToView(row) : null);
  } catch (error: unknown) {
    const e = error as { message?: string };
    return err({ code: "IO_ERROR", message: e.message ?? "read failed" });
  }
}

export function listAssetRows(
  projectDir: string,
): Result<AssetView[], FsError> {
  const db = getStateDb(projectDir);
  try {
    const rows = db
      .prepare(
        `SELECT asset_id, status, meta, owner_id, owner_kind, pid, deadline_at, updated_at, seen_at
         FROM assets`,
      )
      .all() as AssetRow[];
    return ok(rows.map(rowToView));
  } catch (error: unknown) {
    const e = error as { message?: string };
    return err({ code: "IO_ERROR", message: e.message ?? "list failed" });
  }
}

/**
 * Returns { ownerId } iff the row was idle (status='ready', or new) OR pending
 * with NULL owner_id (queued and unclaimed). NEVER overwrites an active owner —
 * returns null if the row already has a non-null owner_id in non-terminal state.
 *
 * Recovery is the only force-overwrite path; it does not go through this API.
 */
export function beginAssetWork(
  projectDir: string,
  assetId: string,
  input: BeginAssetWorkInput,
): { ownerId: string } | null {
  const db = getStateDb(projectDir);
  const now = Date.now() / 1000;
  const deadline = now + input.durationMs / 1000;
  const ownerId = randomUUID();
  const pid = input.pid ?? (input.ownerKind === "job" ? process.pid : null);
  const meta: AssetMeta = {
    kind: input.kind,
    orientation: input.meta?.orientation ?? null,
    queued: false,
    progress: input.meta?.progress ?? null,
    error: null,
    ...(input.meta ?? {}),
  };
  meta.queued = false;
  meta.error = null;

  const tx = db.transaction((): { ownerId: string } | null => {
    const existing = db
      .prepare(
        `SELECT status, owner_id FROM assets WHERE asset_id = ?`,
      )
      .get(assetId) as
      | { status: AssetStatus; owner_id: string | null }
      | undefined;

    if (existing) {
      if (existing.owner_id !== null) {
        // Active owner — refuse to overwrite.
        return null;
      }
      // Allow takeover if status is pending (queued/idle) or ready (re-run).
      if (existing.status === "working" || existing.status === "error") {
        return null;
      }
      db.prepare(
        `UPDATE assets
            SET status='working', meta=?, owner_id=?, owner_kind=?, pid=?,
                deadline_at=?, updated_at=?
          WHERE asset_id=?`,
      ).run(
        JSON.stringify(meta),
        ownerId,
        input.ownerKind,
        pid,
        deadline,
        now,
        assetId,
      );
    } else {
      db.prepare(
        `INSERT INTO assets
           (asset_id, status, meta, owner_id, owner_kind, pid, deadline_at, updated_at)
         VALUES (?, 'working', ?, ?, ?, ?, ?, ?)`,
      ).run(
        assetId,
        JSON.stringify(meta),
        ownerId,
        input.ownerKind,
        pid,
        deadline,
        now,
      );
    }
    return { ownerId };
  });

  return tx();
}

/**
 * CAS-complete the asset: status='ready', owner_id=NULL, deadline_at=NULL.
 * Returns true iff the owner_id matched at write time.
 */
export function completeAssetWork(
  projectDir: string,
  assetId: string,
  ownerId: string,
): boolean {
  const db = getStateDb(projectDir);
  const now = Date.now() / 1000;
  const result = db
    .prepare(
      `UPDATE assets
          SET status='ready', meta='{}', owner_id=NULL, owner_kind=NULL,
              pid=NULL, deadline_at=NULL, updated_at=?
        WHERE asset_id=? AND owner_id=?`,
    )
    .run(now, assetId, ownerId);
  return result.changes > 0;
}

/**
 * One transaction: CAS UPDATE assets to status='error' AND UPSERT
 * generation_errors. CAS on owner_id; if the owner has changed, neither write
 * happens. Returns true iff the owner matched.
 */
export function failAssetWork(
  projectDir: string,
  assetId: string,
  ownerId: string,
  failure: { message: string; code?: string },
): boolean {
  const db = getStateDb(projectDir);
  const now = Date.now() / 1000;
  const code = failure.code ?? null;
  const tx = db.transaction((): boolean => {
    const errorMeta = JSON.stringify({ message: failure.message, code });
    const result = db
      .prepare(
        `UPDATE assets
            SET status='error',
                meta=json_set(COALESCE(meta,'{}'), '$.error', json(?)),
                owner_id=NULL,
                owner_kind=NULL,
                pid=NULL,
                deadline_at=NULL,
                updated_at=?
          WHERE asset_id=? AND owner_id=?`,
      )
      .run(errorMeta, now, assetId, ownerId);
    if (result.changes === 0) return false;
    db.prepare(
      `INSERT INTO generation_errors (asset_id, message, fail_code, prompt, failed_at)
       VALUES (?, ?, ?, NULL, ?)
       ON CONFLICT(asset_id) DO UPDATE SET
         message   = excluded.message,
         fail_code = excluded.fail_code,
         failed_at = excluded.failed_at`,
    ).run(assetId, failure.message, code, now);
    return true;
  });
  return tx();
}

/**
 * CAS-extend the deadline: deadline_at = max(deadline_at, now + extendMs/1000).
 * Returns true iff the owner matched and status is still 'working'.
 */
export function renewAssetWork(
  projectDir: string,
  assetId: string,
  ownerId: string,
  extendMs: number,
): boolean {
  const db = getStateDb(projectDir);
  const now = Date.now() / 1000;
  const proposed = now + extendMs / 1000;
  const result = db
    .prepare(
      `UPDATE assets
          SET deadline_at = MAX(COALESCE(deadline_at, 0), ?),
              updated_at = ?
        WHERE asset_id=? AND owner_id=? AND status='working'`,
    )
    .run(proposed, now, assetId, ownerId);
  return result.changes > 0;
}

/**
 * Sets seen_at to now if currently NULL. Idempotent: re-marking an already-seen
 * asset is a no-op. Independent of work status — seen_at survives transitions
 * through working/ready/error so a "NEW" badge clears once and stays cleared.
 */
export function markAssetSeen(projectDir: string, assetId: string): boolean {
  const db = getStateDb(projectDir);
  const now = Date.now() / 1000;
  const result = db
    .prepare(
      `UPDATE assets SET seen_at = COALESCE(seen_at, ?) WHERE asset_id = ?`,
    )
    .run(now, assetId);
  return result.changes > 0;
}

/**
 * Recovery-internal: insert/replace an assets row. Bypasses beginAssetWork's
 * no-overwrite guard. Only called from asset/recover.ts.
 */
export function upsertAssetRow(
  projectDir: string,
  view: {
    assetId: string;
    status: AssetStatus;
    meta: AssetMeta;
    ownerId: string | null;
    ownerKind: AssetOwnerKind | null;
    pid: number | null;
    deadlineAt: number | null;
  },
): void {
  const db = getStateDb(projectDir);
  const now = Date.now() / 1000;
  db.prepare(
    `INSERT INTO assets
       (asset_id, status, meta, owner_id, owner_kind, pid, deadline_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(asset_id) DO UPDATE SET
       status      = excluded.status,
       meta        = excluded.meta,
       owner_id    = excluded.owner_id,
       owner_kind  = excluded.owner_kind,
       pid         = excluded.pid,
       deadline_at = excluded.deadline_at,
       updated_at  = excluded.updated_at`,
  ).run(
    view.assetId,
    view.status,
    JSON.stringify(view.meta),
    view.ownerId,
    view.ownerKind,
    view.pid,
    view.deadlineAt,
    now,
  );
}

