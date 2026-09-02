import type { DatabaseSync } from "@dolthub/doltlite";

/** Rewrites the grid mentions inside one stored text value. */
type MentionRewriter = (text: string) => string;

/**
 * Picks the rewriter for rows scoped to `notebookId`; `null` asks for the
 * book-wide rewriter used by tables that carry no notebook column.
 */
type MentionRewriterResolver = (
  notebookId: string | null,
) => MentionRewriter;

interface RewriteTarget {
  table: string;
  idColumn: string;
  columns: readonly string[];
  scope: "notebook" | "book";
}

const REWRITE_TARGETS: readonly RewriteTarget[] = [
  {
    table: "cells",
    idColumn: "cell_id",
    columns: ["prompt", "label", "inputs_json"],
    scope: "notebook",
  },
  {
    table: "generations",
    idColumn: "generation_id",
    columns: ["prompt", "resolved_prompt"],
    scope: "notebook",
  },
  {
    table: "notebook_generation_plans",
    idColumn: "plan_id",
    columns: ["plan_json"],
    scope: "notebook",
  },
  {
    table: "notebook_run_plans",
    idColumn: "plan_id",
    columns: ["plan_json", "outputs_json"],
    scope: "notebook",
  },
  {
    table: "entities",
    idColumn: "entity_id",
    columns: ["prompt", "description", "data_json"],
    scope: "book",
  },
  {
    table: "prompt_entries",
    idColumn: "prompt_id",
    columns: ["prompt", "context_json"],
    scope: "book",
  },
  {
    table: "messages",
    idColumn: "message_id",
    columns: ["body_json"],
    scope: "book",
  },
];

type TextRow = Record<string, string | null>;

function tableExists(db: DatabaseSync, name: string): boolean {
  const row = db
    .prepare(
      "SELECT 1 AS present FROM sqlite_master WHERE type='table' AND name=?",
    )
    .get(name) as unknown as { present?: number } | undefined;
  return row?.present === 1;
}

function tableColumns(db: DatabaseSync, name: string): Set<string> {
  const rows = db.prepare(`PRAGMA table_info(${name})`).all() as unknown as Array<{
    name: string;
  }>;
  return new Set(rows.map((row) => row.name));
}

function tableHasColumns(
  db: DatabaseSync,
  name: string,
  columns: readonly string[],
): boolean {
  if (!tableExists(db, name)) return false;
  const present = tableColumns(db, name);
  return columns.every((column) => present.has(column));
}

function keyColumns(target: RewriteTarget): string[] {
  return target.scope === "notebook"
    ? ["notebook_id", target.idColumn]
    : [target.idColumn];
}

function rewrittenValues(
  row: TextRow,
  columns: readonly string[],
  rewrite: MentionRewriter,
): { values: Array<string | null>; changed: boolean } {
  const values: Array<string | null> = [];
  let changed = false;
  for (const column of columns) {
    const current = row[column];
    if (typeof current !== "string") {
      values.push(current ?? null);
      continue;
    }
    const next = rewrite(current);
    values.push(next);
    if (next !== current) changed = true;
  }
  return { values, changed };
}

function rewriteTarget(
  db: DatabaseSync,
  target: RewriteTarget,
  resolve: MentionRewriterResolver,
): number {
  const keys = keyColumns(target);
  if (!tableHasColumns(db, target.table, [...keys, ...target.columns])) {
    return 0;
  }
  const rows = db
    .prepare(`SELECT ${[...keys, ...target.columns].join(", ")} FROM ${target.table}`)
    .all() as unknown as TextRow[];
  const assignments = target.columns.map((column) => `${column}=?`).join(", ");
  const where = keys.map((column) => `${column}=?`).join(" AND ");
  const update = db.prepare(
    `UPDATE ${target.table} SET ${assignments} WHERE ${where}`,
  );
  let rewritten = 0;
  for (const row of rows) {
    const rewrite = resolve(
      target.scope === "notebook" ? String(row.notebook_id) : null,
    );
    const next = rewrittenValues(row, target.columns, rewrite);
    if (!next.changed) continue;
    update.run(...next.values, ...keys.map((column) => row[column]));
    rewritten += 1;
  }
  return rewritten;
}

/**
 * Rewrite every stored grid mention in a catalog: notebook-scoped text (cells,
 * generations, plans) through the rewriter for its notebook, book-wide text
 * (entities, prompt entries, messages) through the `null` rewriter. Tables or
 * columns that a catalog lacks are skipped. Returns the number of rows changed.
 */
export function rewriteCatalogMentions(
  db: DatabaseSync,
  resolve: MentionRewriterResolver,
): number {
  let rewritten = 0;
  for (const target of REWRITE_TARGETS) {
    rewritten += rewriteTarget(db, target, resolve);
  }
  return rewritten;
}
