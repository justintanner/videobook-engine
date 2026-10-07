import type { DatabaseSync } from "@dolthub/doltlite";
import { rebuildCellsTable } from "./migrate-cells-table.js";

export function applyTimelineMigration(db: DatabaseSync): void {
  rebuildCellsTable(db, 26);
}
