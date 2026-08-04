import { describe, expect, it } from "vitest";

import {
  isDestructiveEditOperation,
  notebookCellTableRows,
  type EditOperation,
  type NotebookCell,
} from "../src/index.js";

describe("shared catalog boundary helpers", () => {
  it("projects the canonical cells table schema in order", () => {
    const cell: NotebookCell = {
      id: "cell-1",
      type: "analyze",
      label: "analyze-source",
      slot: { row: 2, column: -3 },
      provider: "kie",
      inputs: { source: "vid-demo" },
    };

    expect(notebookCellTableRows("notebook-1", cell)).toEqual([
      { column: "notebook_id", type: "TEXT", value: "notebook-1" },
      { column: "cell_id", type: "TEXT", value: "cell-1" },
      { column: "type", type: "TEXT", value: "analyze" },
      { column: "label", type: "TEXT", value: "analyze-source" },
      { column: "grid_row", type: "INTEGER", value: 2 },
      { column: "grid_column", type: "INTEGER", value: -3 },
      { column: "output_entity_id", type: "TEXT", value: null },
      { column: "prompt", type: "TEXT", value: null },
      { column: "provider", type: "TEXT", value: "kie" },
      { column: "model", type: "TEXT", value: null },
      { column: "operation", type: "TEXT", value: null },
      { column: "tool", type: "TEXT", value: null },
      {
        column: "inputs_json",
        type: "TEXT",
        value: "{\"source\":\"vid-demo\"}",
      },
      { column: "output_artifact_id", type: "TEXT", value: null },
    ]);
  });

  it("owns the destructive edit policy", () => {
    expect(isDestructiveEditOperation({
      kind: "remove-range",
    } as EditOperation)).toBe(true);
    expect(isDestructiveEditOperation({
      kind: "batch-replace-range",
    } as EditOperation)).toBe(true);
    expect(isDestructiveEditOperation({
      kind: "insert-clip",
      mode: "overwrite",
    } as EditOperation)).toBe(true);
    expect(isDestructiveEditOperation({
      kind: "insert-clip",
      mode: "insert",
    } as EditOperation)).toBe(false);
    expect(isDestructiveEditOperation({
      kind: "move-clip",
    } as EditOperation)).toBe(false);
  });
});
