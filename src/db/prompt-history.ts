import type { Database as DatabaseType } from "better-sqlite3";

export interface PromptHistoryEntry {
  id: number;
  surface: string;
  prompt: string;
  params: Record<string, unknown> | null;
  created_at: number;
}

interface PromptHistoryRow {
  id: number;
  surface: string;
  prompt: string;
  params_json: string | null;
  created_at: number;
}

export interface RecordPromptArgs {
  surface: string;
  prompt: string;
  params?: Record<string, unknown>;
}

export interface ListPromptHistoryArgs {
  surface: string;
  limit?: number;
}

export function recordPromptRow(
  db: DatabaseType,
  args: RecordPromptArgs,
): { id: number } {
  const paramsJson =
    args.params !== undefined ? JSON.stringify(args.params) : null;
  const result = db
    .prepare(
      `INSERT INTO prompt_history (surface, prompt, params_json, created_at)
       VALUES (?, ?, ?, ?)`,
    )
    .run(args.surface, args.prompt, paramsJson, Date.now());
  return { id: Number(result.lastInsertRowid) };
}

function parseParams(raw: string | null): Record<string, unknown> | null {
  if (raw === null || raw === "") return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return null;
  } catch {
    return null;
  }
}

export function listPromptHistoryRows(
  db: DatabaseType,
  args: ListPromptHistoryArgs,
): PromptHistoryEntry[] {
  const limit = Math.max(1, Math.min(args.limit ?? 100, 1000));
  const rows = db
    .prepare(
      `SELECT id, surface, prompt, params_json, created_at
       FROM prompt_history
       WHERE surface = ?
       ORDER BY id DESC
       LIMIT ?`,
    )
    .all(args.surface, limit) as PromptHistoryRow[];
  return rows.map((r) => ({
    id: r.id,
    surface: r.surface,
    prompt: r.prompt,
    params: parseParams(r.params_json),
    created_at: r.created_at,
  }));
}

export function countPromptHistoryRows(
  db: DatabaseType,
  surface: string,
): number {
  const row = db
    .prepare(`SELECT COUNT(*) AS n FROM prompt_history WHERE surface = ?`)
    .get(surface) as { n: number } | undefined;
  return row?.n ?? 0;
}
