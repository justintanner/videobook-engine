import type { DatabaseSync } from "@dolthub/doltlite";
import { rebuildCellsTable } from "./migrate-cells-table.js";

export function applyGoalCellMigration(db: DatabaseSync): void {
  rebuildCellsTable(db, 27);
}
