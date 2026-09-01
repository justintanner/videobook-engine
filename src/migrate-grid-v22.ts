import type { DatabaseSync } from "@dolthub/doltlite";

import { SCHEMA_VERSION } from "./catalog-metadata.js";
import type { NotebookGridSlot } from "./notebook/types.js";
import {
  NOTEBOOK_GRID_COLUMN_COUNT,
  NOTEBOOK_GRID_ROW_COUNT,
  notebookGridAddress,
} from "./notebook-grid.js";
import { CELLS_TABLE_DEFINITION } from "./schema.js";

const V22_ADDRESS_SOURCE = "[a-z](?:1[0-3]|[1-9])";
const V22_MENTION_PATTERN = new RegExp(
  `@(${V22_ADDRESS_SOURCE})(?![\\w-])`,
  "giu",
);
const V22_ADDRESS_PATTERN = new RegExp(`^${V22_ADDRESS_SOURCE}$`, "iu");

interface CellRow {
  notebook_id: string;
  cell_id: string;
  grid_row: number;
  grid_column: number;
  prompt: string | null;
  label: string | null;
  inputs_json: string;
}

interface V22GridMigrationResult {
  relocated: number;
  rewritten: number;
}

function slotKey(slot: NotebookGridSlot): string {
  return `${slot.row}:${slot.column}`;
}

export function parseV22GridAddress(
  value: string,
): NotebookGridSlot | undefined {
  const address = value.trim().replace(/^@/u, "").toLowerCase();
  if (!V22_ADDRESS_PATTERN.test(address)) return undefined;
  return {
    row: address.charCodeAt(0) - 97,
    column: Number(address.slice(1)) - 1,
  };
}

function firstFreeV23Slot(
  occupied: ReadonlySet<string>,
  startRow = 0,
): NotebookGridSlot {
  for (let row = startRow; row < NOTEBOOK_GRID_ROW_COUNT; row += 1) {
    for (let column = 0; column < NOTEBOOK_GRID_COLUMN_COUNT; column += 1) {
      if (!occupied.has(slotKey({ row, column }))) {
        return { row, column };
      }
    }
  }
  for (let row = 0; row < startRow; row += 1) {
    for (let column = 0; column < NOTEBOOK_GRID_COLUMN_COUNT; column += 1) {
      if (!occupied.has(slotKey({ row, column }))) {
        return { row, column };
      }
    }
  }
  throw new Error("Cannot migrate: the 8x64 notebook grid is full");
}

export function relocateV22Slots(
  slots: readonly NotebookGridSlot[],
): Map<string, NotebookGridSlot> {
  const relocated = new Map<string, NotebookGridSlot>();
  const kept: NotebookGridSlot[] = [];
  const overflow: NotebookGridSlot[] = [];
  for (const slot of slots) {
    if (
      slot.column >= 0
      && slot.column < NOTEBOOK_GRID_COLUMN_COUNT
      && slot.row >= 0
      && slot.row < NOTEBOOK_GRID_ROW_COUNT
    ) {
      kept.push(slot);
    } else {
      overflow.push(slot);
    }
  }
  overflow.sort((left, right) =>
    left.row - right.row
    || left.column - right.column
  );
  const occupied = new Set(kept.map(slotKey));
  for (const slot of kept) relocated.set(slotKey(slot), slot);
  for (const slot of overflow) {
    const next = firstFreeV23Slot(occupied, Math.max(0, slot.row));
    occupied.add(slotKey(next));
    relocated.set(slotKey(slot), next);
  }
  return relocated;
}

export function rewriteV22Mentions(
  text: string,
  slotMap: ReadonlyMap<string, NotebookGridSlot>,
): string {
  return text.replace(V22_MENTION_PATTERN, (raw, address: string) => {
    const parsed = parseV22GridAddress(address);
    if (!parsed) return raw;
    const mapped = slotMap.get(slotKey(parsed));
    if (mapped) return `@${notebookGridAddress(mapped)}`;
    if (
      parsed.column >= 0
      && parsed.column < NOTEBOOK_GRID_COLUMN_COUNT
      && parsed.row >= 0
      && parsed.row < NOTEBOOK_GRID_ROW_COUNT
    ) {
      return `@${notebookGridAddress(parsed)}`;
    }
    return raw;
  });
}

function mergeNotebookMaps(
  maps: ReadonlyMap<string, Map<string, NotebookGridSlot>>,
): Map<string, NotebookGridSlot> {
  const merged = new Map<string, NotebookGridSlot>();
  const conflict = new Set<string>();
  for (const map of maps.values()) {
    for (const [key, slot] of map) {
      if (conflict.has(key)) continue;
      const existing = merged.get(key);
      if (!existing) {
        merged.set(key, slot);
        continue;
      }
      if (existing.row !== slot.row || existing.column !== slot.column) {
        merged.delete(key);
        conflict.add(key);
      }
    }
  }
  return merged;
}

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

function rebuildCellsTable(db: DatabaseSync): void {
  db.exec("PRAGMA foreign_keys=OFF");
  db.exec("DROP TABLE IF EXISTS cells_v23");
  db.exec(`CREATE TABLE cells_v23 (${CELLS_TABLE_DEFINITION})`);
  db.exec("INSERT INTO cells_v23 SELECT * FROM cells");
  db.exec("DROP TABLE cells");
  db.exec("ALTER TABLE cells_v23 RENAME TO cells");
  db.exec(
    "CREATE INDEX IF NOT EXISTS cells_output_entity ON cells(output_entity_id)",
  );
  db.exec(
    `CREATE INDEX IF NOT EXISTS cells_grid
     ON cells(notebook_id, grid_row, grid_column, cell_id)`,
  );
  db.exec(
    `CREATE INDEX IF NOT EXISTS cells_output_artifact
     ON cells(output_artifact_id)`,
  );
  db.exec("PRAGMA foreign_keys=ON");
}

export function applyV22NotebookGridMigration(
  db: DatabaseSync,
): V22GridMigrationResult {
  const cells = db
    .prepare(
      `SELECT notebook_id, cell_id, grid_row, grid_column, prompt, label, inputs_json
       FROM cells`,
    )
    .all() as unknown as CellRow[];

  const byNotebook = new Map<string, CellRow[]>();
  for (const cell of cells) {
    const rows = byNotebook.get(cell.notebook_id) ?? [];
    rows.push(cell);
    byNotebook.set(cell.notebook_id, rows);
  }

  const maps = new Map<string, Map<string, NotebookGridSlot>>();
  const nextByCell = new Map<string, NotebookGridSlot>();
  let relocated = 0;
  for (const [notebookId, rows] of byNotebook) {
    const map = relocateV22Slots(
      rows.map((row) => ({ row: row.grid_row, column: row.grid_column })),
    );
    maps.set(notebookId, map);
    for (const row of rows) {
      const next = map.get(slotKey({
        row: row.grid_row,
        column: row.grid_column,
      }));
      if (!next) continue;
      nextByCell.set(`${row.notebook_id}:${row.cell_id}`, next);
      if (next.row !== row.grid_row || next.column !== row.grid_column) {
        relocated += 1;
      }
    }
  }

  const updateSlot = db.prepare(
    `UPDATE cells SET grid_row=?, grid_column=?
     WHERE notebook_id=? AND cell_id=?`,
  );
  for (const cell of cells) {
    const next = nextByCell.get(`${cell.notebook_id}:${cell.cell_id}`);
    if (!next) continue;
    if (next.row === cell.grid_row && next.column === cell.grid_column) continue;
    updateSlot.run(next.row, next.column, cell.notebook_id, cell.cell_id);
  }

  let rewritten = 0;
  const updateText = db.prepare(
    `UPDATE cells SET prompt=?, label=?, inputs_json=?
     WHERE notebook_id=? AND cell_id=?`,
  );
  for (const cell of cells) {
    const map = maps.get(cell.notebook_id);
    if (!map) continue;
    const prompt = typeof cell.prompt === "string"
      ? rewriteV22Mentions(cell.prompt, map)
      : cell.prompt;
    const label = typeof cell.label === "string"
      ? rewriteV22Mentions(cell.label, map)
      : cell.label;
    const inputs = rewriteV22Mentions(cell.inputs_json, map);
    if (
      prompt === cell.prompt
      && label === cell.label
      && inputs === cell.inputs_json
    ) continue;
    updateText.run(prompt, label, inputs, cell.notebook_id, cell.cell_id);
    rewritten += 1;
  }

  const bookMap = mergeNotebookMaps(maps);
  rewritten += rewriteAttachedText(db, maps, bookMap);

  rebuildCellsTable(db);
  db.prepare("UPDATE engine_schema SET version=? WHERE singleton=1")
    .run(SCHEMA_VERSION);
  return { relocated, rewritten };
}

function rewriteAttachedText(
  db: DatabaseSync,
  maps: ReadonlyMap<string, Map<string, NotebookGridSlot>>,
  bookMap: ReadonlyMap<string, NotebookGridSlot>,
): number {
  let rewritten = 0;

  const rewriteByNotebook = (
    table: string,
    idColumn: string,
    columns: readonly string[],
  ): void => {
    if (!tableHasColumns(db, table, ["notebook_id", idColumn, ...columns])) {
      return;
    }
    const select = db.prepare(
      `SELECT notebook_id, ${idColumn} AS row_id, ${columns.join(", ")} FROM ${table}`,
    );
    const rows = select.all() as unknown as Array<Record<string, string | null>>;
    for (const row of rows) {
      const map = maps.get(String(row.notebook_id)) ?? bookMap;
      const values: Array<string | null> = [];
      let changed = false;
      for (const column of columns) {
        const current = row[column];
        if (typeof current !== "string") {
          values.push(current ?? null);
          continue;
        }
        const next = rewriteV22Mentions(current, map);
        values.push(next);
        if (next !== current) changed = true;
      }
      if (!changed) continue;
      const assignments = columns.map((column) => `${column}=?`).join(", ");
      db.prepare(
        `UPDATE ${table} SET ${assignments} WHERE notebook_id=? AND ${idColumn}=?`,
      ).run(...values, row.notebook_id, row.row_id);
      rewritten += 1;
    }
  };

  rewriteByNotebook("generations", "generation_id", ["prompt", "resolved_prompt"]);
  rewriteByNotebook("notebook_generation_plans", "plan_id", ["plan_json"]);
  rewriteByNotebook(
    "notebook_run_plans",
    "plan_id",
    ["plan_json", "outputs_json"],
  );

  if (tableHasColumns(db, "entities", [
    "entity_id",
    "prompt",
    "description",
    "data_json",
  ])) {
    const rows = db
      .prepare("SELECT entity_id, prompt, description, data_json FROM entities")
      .all() as unknown as Array<{
        entity_id: string;
        prompt: string | null;
        description: string | null;
        data_json: string;
      }>;
    const update = db.prepare(
      `UPDATE entities SET prompt=?, description=?, data_json=? WHERE entity_id=?`,
    );
    for (const row of rows) {
      const prompt = typeof row.prompt === "string"
        ? rewriteV22Mentions(row.prompt, bookMap)
        : row.prompt;
      const description = typeof row.description === "string"
        ? rewriteV22Mentions(row.description, bookMap)
        : row.description;
      const dataJson = rewriteV22Mentions(row.data_json, bookMap);
      if (
        prompt === row.prompt
        && description === row.description
        && dataJson === row.data_json
      ) continue;
      update.run(prompt, description, dataJson, row.entity_id);
      rewritten += 1;
    }
  }

  if (tableHasColumns(db, "prompt_entries", [
    "prompt_id",
    "prompt",
    "context_json",
  ])) {
    const rows = db
      .prepare("SELECT prompt_id, prompt, context_json FROM prompt_entries")
      .all() as unknown as Array<{
        prompt_id: string;
        prompt: string;
        context_json: string;
      }>;
    const update = db.prepare(
      "UPDATE prompt_entries SET prompt=?, context_json=? WHERE prompt_id=?",
    );
    for (const row of rows) {
      const prompt = rewriteV22Mentions(row.prompt, bookMap);
      const context = rewriteV22Mentions(row.context_json, bookMap);
      if (prompt === row.prompt && context === row.context_json) continue;
      update.run(prompt, context, row.prompt_id);
      rewritten += 1;
    }
  }

  if (tableHasColumns(db, "messages", ["message_id", "body_json"])) {
    const rows = db
      .prepare("SELECT message_id, body_json FROM messages")
      .all() as unknown as Array<{ message_id: string; body_json: string }>;
    const update = db.prepare(
      "UPDATE messages SET body_json=? WHERE message_id=?",
    );
    for (const row of rows) {
      const next = rewriteV22Mentions(row.body_json, bookMap);
      if (next === row.body_json) continue;
      update.run(next, row.message_id);
      rewritten += 1;
    }
  }

  return rewritten;
}
