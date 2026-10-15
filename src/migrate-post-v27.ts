import type { DatabaseSync } from "@dolthub/doltlite";
import { rebuildCellsTable } from "./migrate-cells-table.js";

export function applyPostCellMigration(db: DatabaseSync): void {
  rebuildCellsTable(db, 28);
}
