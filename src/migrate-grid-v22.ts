import type { DatabaseSync } from "@dolthub/doltlite";

import { SCHEMA_VERSION } from "./catalog-metadata.js";
import type { NotebookGridSlot } from "./notebook/types.js";
import {
  NOTEBOOK_GRID_COLUMN_COUNT,
  NOTEBOOK_GRID_ROW_COUNT,
  notebookGridAddress,
} from "./notebook-grid.js";
import { rewriteCatalogMentions } from "./migrate-grid-text.js";
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

function firstFreeSlot(
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
    const next = firstFreeSlot(occupied, Math.max(0, slot.row));
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

function rebuildCellsTable(db: DatabaseSync): void {
  db.exec("PRAGMA foreign_keys=OFF");
  db.exec("DROP TABLE IF EXISTS cells_next");
  db.exec(`CREATE TABLE cells_next (${CELLS_TABLE_DEFINITION})`);
  db.exec("INSERT INTO cells_next SELECT * FROM cells");
  db.exec("DROP TABLE cells");
  db.exec("ALTER TABLE cells_next RENAME TO cells");
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
      "SELECT notebook_id, cell_id, grid_row, grid_column FROM cells",
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

  const bookMap = mergeNotebookMaps(maps);
  const rewritten = rewriteCatalogMentions(db, (notebookId) => {
    const map = notebookId === null
      ? bookMap
      : (maps.get(notebookId) ?? bookMap);
    return (text) => rewriteV22Mentions(text, map);
  });

  rebuildCellsTable(db);
  db.prepare("UPDATE engine_schema SET version=? WHERE singleton=1")
    .run(SCHEMA_VERSION);
  return { relocated, rewritten };
}
