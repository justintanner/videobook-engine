import type { DatabaseSync } from "@dolthub/doltlite";
import { CELLS_TABLE_DEFINITION } from "./schema.js";

export function applyTimelineMigration(db: DatabaseSync): void {
  db.exec(`CREATE TABLE cells_next (${CELLS_TABLE_DEFINITION})`);
  db.exec("INSERT INTO cells_next SELECT * FROM cells");
  db.exec("DROP TABLE cells");
  db.exec("ALTER TABLE cells_next RENAME TO cells");
  db.exec("CREATE INDEX cells_output_entity ON cells(output_entity_id)");
  db.exec("CREATE INDEX cells_grid ON cells(notebook_id, grid_row, grid_column, cell_id)");
  db.exec("CREATE INDEX cells_output_artifact ON cells(output_artifact_id)");
  db.exec("UPDATE engine_schema SET version=26 WHERE singleton=1");
}
