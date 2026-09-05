import { createHash } from "node:crypto";
import type { DatabaseSync } from "@dolthub/doltlite";
import type { MigrationIssue } from "./mvp-contracts.js";

const REFERENCES = [
  ["artifact_files", "artifact_id", "artifacts", "artifact_id"],
  ["artifact_files", "object_hash", "objects", "object_hash"],
  ["artifact_metadata", "artifact_id", "artifacts", "artifact_id"],
  ["cells", "notebook_id", "notebooks", "notebook_id"],
  ["cells", "entity_id", "entities", "entity_id"],
  ["cells", "output_artifact_id", "artifacts", "artifact_id"],
  ["runs", "notebook_id", "notebooks", "notebook_id"],
  ["timeline", "book_id", "book", "book_id"],
  ["timeline_slots", "artifact_id", "artifacts", "artifact_id"],
  ["timeline_audio", "artifact_id", "artifacts", "artifact_id"],
  ["audio_waveforms", "artifact_id", "artifacts", "artifact_id"],
] as const;

export function legacyReferenceIssues(database: DatabaseSync): MigrationIssue[] {
  const issues: MigrationIssue[] = [];
  for (const [table, field, parent, parentField] of REFERENCES) {
    const missing = database.prepare(`SELECT c.${field} AS id FROM ${table} c
      LEFT JOIN ${parent} p ON p.${parentField}=c.${field}
      WHERE c.${field} IS NOT NULL AND p.${parentField} IS NULL`).all() as unknown as Array<{ id: string }>;
    for (const row of missing) issues.push(invalid(`${table}:${row.id}`, `Missing ${parent} reference from ${table}.${field}`));
  }
  for (const field of ["source_cell_id", "target_cell_id"]) {
    const missing = database.prepare(`SELECT e.edge_id FROM edges e LEFT JOIN cells c
      ON c.notebook_id=e.notebook_id AND c.cell_id=e.${field}
      WHERE c.cell_id IS NULL`).all() as unknown as Array<{ edge_id: string }>;
    for (const row of missing) issues.push(invalid(`edge:${row.edge_id}`, `Missing notebook-local ${field}`));
  }
  const files = database.prepare("SELECT artifact_id, path, object_hash FROM artifact_files").all() as unknown as Array<{
    artifact_id: string; path: string; object_hash: string;
  }>;
  for (const file of files) {
    if (!file.path || file.path.startsWith("/") || file.path.includes("\\") || file.path.includes("\0")
      || file.path.split("/").some((part) => part === "." || part === ".." || part === "")) {
      issues.push(invalid(`artifact:${file.artifact_id}`, `Invalid source file path: ${file.path}`));
    }
  }
  for (const [table, field] of [["book_metadata", "value_json"], ["artifact_metadata", "value_json"], ["entities", "data_json"],
    ["runs", "cell_order_json"], ["runs", "outputs_json"], ["prompt_entries", "context_json"], ["messages", "body_json"], ["audio_waveforms", "peaks_json"]]) {
    const rows = database.prepare(`SELECT ${field} AS value FROM ${table}`).all() as unknown as Array<{ value: string }>;
    for (const row of rows) {
      try { JSON.parse(row.value); }
      catch { issues.push(invalid(`${table}:${field}`, "Malformed JSON in legacy semantic state")); }
    }
  }
  return issues;
}

export function legacyStateSummary(database: DatabaseSync): {
  digest: string; tables: Array<{ table: string; rows: number; digest: string }>;
} {
  const names = database.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as unknown as Array<{ name: string }>;
  const tables = names.filter(({ name }) => !name.startsWith("runtime_") && !name.startsWith("sqlite_") && !name.startsWith("dolt_"))
    .map(({ name }) => {
      const rows = database.prepare(`SELECT * FROM "${name.replaceAll('"', '""')}"`).all();
      const encoded = rows.map((row) => JSON.stringify(row, (_, value: unknown) => typeof value === "bigint" ? String(value) : value)).sort();
      return { table: name, rows: rows.length, digest: digest(encoded) };
    });
  return { digest: digest(tables), tables };
}

function digest(value: unknown): string {
  return `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;
}

function invalid(resource: string, message: string): MigrationIssue {
  return { code: "INVALID_REFERENCE", severity: "error", resource, message };
}
