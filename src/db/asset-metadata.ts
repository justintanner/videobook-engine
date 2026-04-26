import type { Database as DatabaseType } from "better-sqlite3";

import { canonicalJson } from "./canonical-json.js";

interface MetaRow {
  asset_id: string;
  meta_key: string;
  value: string;
  updated_at: number;
}

export function upsertAssetMetadata(
  db: DatabaseType,
  assetId: string,
  key: string,
  data: unknown,
): void {
  db.prepare(
    `INSERT INTO asset_metadata (asset_id, meta_key, value, updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(asset_id, meta_key) DO UPDATE SET
       value      = excluded.value,
       updated_at = excluded.updated_at`,
  ).run(assetId, key, JSON.stringify(data), Date.now());
}

export function readAssetMetadata<T>(
  db: DatabaseType,
  assetId: string,
  key: string,
): T | null {
  const row = db
    .prepare(
      `SELECT value FROM asset_metadata WHERE asset_id = ? AND meta_key = ?`,
    )
    .get(assetId, key) as { value: string } | undefined;
  if (!row) return null;
  try {
    return JSON.parse(row.value) as T;
  } catch {
    return null;
  }
}

export function deleteAssetMetadata(
  db: DatabaseType,
  assetId: string,
  key: string,
): void {
  db.prepare(
    `DELETE FROM asset_metadata WHERE asset_id = ? AND meta_key = ?`,
  ).run(assetId, key);
}

export function exportAssetMetadata(db: DatabaseType): string {
  const rows = db
    .prepare(
      `SELECT asset_id, meta_key, value, updated_at
       FROM asset_metadata
       ORDER BY asset_id, meta_key`,
    )
    .all() as MetaRow[];
  const out = rows.map((r) => ({
    asset_id: r.asset_id,
    meta_key: r.meta_key,
    value: safeParse(r.value),
    updated_at: r.updated_at,
  }));
  return canonicalJson(out);
}

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
