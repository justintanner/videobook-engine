import type { NotebookCell } from "./notebook/types.js";

export const SCHEMA_VERSION = 19;

export const CELLS_TABLE_SCHEMA = [
  { column: "notebook_id", type: "TEXT" },
  { column: "cell_id", type: "TEXT" },
  { column: "type", type: "TEXT" },
  { column: "slug", type: "TEXT" },
  { column: "grid_row", type: "INTEGER" },
  { column: "grid_column", type: "INTEGER" },
  { column: "output_entity_id", type: "TEXT" },
  { column: "prompt", type: "TEXT" },
  { column: "provider", type: "TEXT" },
  { column: "model", type: "TEXT" },
  { column: "operation", type: "TEXT" },
  { column: "tool", type: "TEXT" },
  { column: "inputs_json", type: "TEXT" },
  { column: "output_artifact_id", type: "TEXT" },
] as const;

export type CellTableColumn = (typeof CELLS_TABLE_SCHEMA)[number]["column"];
export type CellTableColumnType =
  (typeof CELLS_TABLE_SCHEMA)[number]["type"];
export const CELLS_TABLE_COLUMNS: readonly CellTableColumn[] =
  CELLS_TABLE_SCHEMA.map(({ column }) => column);
export type CellTableValue = number | string | null;

export interface CellTableRow {
  column: CellTableColumn;
  type: CellTableColumnType;
  value: CellTableValue;
}

export function notebookCellTableRows(
  notebookId: string,
  cell: NotebookCell,
): CellTableRow[] {
  const values: Record<CellTableColumn, CellTableValue> = {
    notebook_id: notebookId,
    cell_id: cell.id,
    type: cell.type,
    slug: cell.slug,
    grid_row: cell.slot.row,
    grid_column: cell.slot.column,
    output_entity_id: cell.outputEntityId ?? null,
    prompt: cell.prompt ?? null,
    provider: cell.provider ?? null,
    model: cell.model ?? null,
    operation: cell.operation ?? null,
    tool: cell.tool ?? null,
    inputs_json: JSON.stringify(cell.inputs ?? {}),
    output_artifact_id: cell.outputArtifactId ?? null,
  };
  return CELLS_TABLE_SCHEMA.map(({ column, type }) => ({
    column,
    type,
    value: values[column],
  }));
}
