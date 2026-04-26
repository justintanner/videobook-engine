import type { Database as DatabaseType } from "better-sqlite3";

import { canonicalJson } from "./canonical-json.js";

interface EventRow {
  id: number;
  operation_id: string;
  subject_type: string;
  subject_id: string;
  kind: string;
  detail: string | null;
  occurred_at: number;
}

export function exportAssetEvents(db: DatabaseType): string {
  const rows = db
    .prepare(
      `SELECT id, operation_id, subject_type, subject_id, kind, detail, occurred_at
       FROM asset_events
       ORDER BY occurred_at, id`,
    )
    .all() as EventRow[];
  return canonicalJson(
    rows.map((r) => ({
      id: r.id,
      operation_id: r.operation_id,
      subject_type: r.subject_type,
      subject_id: r.subject_id,
      kind: r.kind,
      detail: r.detail ? safeParse(r.detail) : null,
      occurred_at: r.occurred_at,
    })),
  );
}

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
