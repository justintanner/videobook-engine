import type { DatabaseSync } from "@dolthub/doltlite";

import type { MigrationIssue } from "./mvp-contracts.js";
import { NOTEBOOK_GRID_CAPACITY, NOTEBOOK_GRID_COLUMN_COUNT } from "./notebook-grid.js";
import type { NotebookCell, NotebookDocument } from "./notebook/types.js";
import { NOTEBOOK_CELL_TYPES } from "./schema.js";

interface LegacyNotebook {
  notebook_id: string;
  name: string;
  properties_json: string;
  created_at: number;
}

interface LegacyCell {
  notebook_id: string;
  cell_id: string;
  type: string;
  title: string;
  position_x: number;
  position_y: number;
  entity_id: string | null;
  prompt: string | null;
  model: string | null;
  inputs_json: string;
  output_artifact_id: string | null;
  artifact_kind: string | null;
}

interface LegacyEdge {
  notebook_id: string;
  edge_id: string;
  source_cell_id: string;
  target_cell_id: string;
  target_input: string;
}

export function legacyNotebookPlan(database: DatabaseSync): {
  documents: NotebookDocument[];
  issues: MigrationIssue[];
  decisions: Array<{ notebookId: string; properties: Record<string, unknown>; cells: Array<{
    cellId: string; legacyType: string; type: string; x: number; y: number; row: number; column: number;
  }> }>;
} {
  const notebooks = database.prepare("SELECT * FROM notebooks ORDER BY notebook_id").all() as unknown as LegacyNotebook[];
  const cells = database.prepare(`SELECT c.*, a.kind AS artifact_kind FROM cells c
    LEFT JOIN artifacts a ON a.artifact_id=c.output_artifact_id
    ORDER BY c.notebook_id, c.position_y, c.position_x, c.cell_id`).all() as unknown as LegacyCell[];
  const edges = database.prepare("SELECT * FROM edges ORDER BY notebook_id, edge_id").all() as unknown as LegacyEdge[];
  const documents: NotebookDocument[] = [];
  const issues: MigrationIssue[] = [];
  const decisions: ReturnType<typeof legacyNotebookPlan>["decisions"] = [];
  for (const notebook of notebooks) {
    try {
      const properties = objectJson(notebook.properties_json, "Notebook properties");
      const rows = cells.filter((cell) => cell.notebook_id === notebook.notebook_id);
      if (rows.length > NOTEBOOK_GRID_CAPACITY) throw new Error(`Notebook has ${rows.length} cells; the current grid supports ${NOTEBOOK_GRID_CAPACITY}`);
      const converted = rows.map((row, ordinal): NotebookCell => {
        if (!Number.isFinite(row.position_x) || !Number.isFinite(row.position_y)) throw new Error(`Invalid canvas position for ${row.cell_id}`);
        return {
          id: row.cell_id, type: currentCellType(row), label: row.title,
          slot: { row: Math.floor(ordinal / NOTEBOOK_GRID_COLUMN_COUNT), column: ordinal % NOTEBOOK_GRID_COLUMN_COUNT },
          ...(row.entity_id === null ? {} : { outputEntityId: row.entity_id }),
          ...(row.prompt === null ? {} : { prompt: row.prompt }),
          ...(row.model === null ? {} : { model: row.model }),
          inputs: objectJson(row.inputs_json, `Inputs for ${row.cell_id}`),
          ...(row.output_artifact_id === null ? {} : { outputArtifactId: row.output_artifact_id }),
        };
      });
      const notebookEdges = edges.filter((edge) => edge.notebook_id === notebook.notebook_id);
      const occupiedInputs = new Set<string>();
      for (const edge of notebookEdges) {
        const key = `${edge.target_cell_id}:${edge.target_input}`;
        if (occupiedInputs.has(key)) throw new Error(`Multiple edges target the same input: ${key}`);
        occupiedInputs.add(key);
      }
      const document: NotebookDocument = {
        ...compatibleProperties(properties),
        id: notebook.notebook_id, name: notebook.name,
        createdAt: new Date(notebook.created_at).toISOString(), cells: converted,
        edges: notebookEdges.map((edge) => ({ id: edge.edge_id, source: edge.source_cell_id,
          target: edge.target_cell_id, targetInput: edge.target_input })),
      };
      documents.push(document);
      decisions.push({ notebookId: notebook.notebook_id, properties, cells: rows.map((row, ordinal) => ({
        cellId: row.cell_id, legacyType: row.type, type: converted[ordinal]!.type,
        x: row.position_x, y: row.position_y, ...converted[ordinal]!.slot,
      })) });
    } catch (cause) {
      issues.push({ code: "INVALID_REFERENCE", severity: "error", resource: `notebook:${notebook.notebook_id}`,
        message: cause instanceof Error ? cause.message : String(cause) });
    }
  }
  return { documents, decisions, issues };
}

function currentCellType(cell: LegacyCell): NotebookCell["type"] {
  if ((NOTEBOOK_CELL_TYPES as readonly string[]).includes(cell.type)) return cell.type as NotebookCell["type"];
  if (cell.type === "scene") return "prompt";
  if (cell.type === "asset") {
    if (cell.artifact_kind === "image" || cell.artifact_kind === "video" || cell.artifact_kind === "audio") return cell.artifact_kind;
    if (cell.artifact_kind === "final") return "video";
    if (cell.artifact_kind === "character") return "character";
    if (cell.artifact_kind === "script" || cell.artifact_kind === "prompt" || cell.artifact_kind === "scene") return "prompt";
  }
  throw new Error(`Cannot represent legacy cell ${cell.cell_id} of type ${cell.type} without a supported source`);
}

function objectJson(json: string, label: string): Record<string, unknown> {
  const value: unknown = JSON.parse(json);
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function compatibleProperties(properties: Record<string, unknown>): Partial<NotebookDocument> {
  const result: Record<string, unknown> = {};
  for (const key of ["description", "lifecycleState", "analysisRevision"]) {
    if (properties[key] === undefined) continue;
    if (typeof properties[key] !== "string") throw new Error(`Notebook ${key} must be a string`);
    result[key] = properties[key];
  }
  if (properties.workflowVersion !== undefined) {
    if (!Number.isSafeInteger(properties.workflowVersion)) throw new Error("Notebook workflowVersion must be an integer");
    result.workflowVersion = properties.workflowVersion;
  }
  for (const key of ["fixture", "execution"]) {
    if (properties[key] === undefined) continue;
    if (!properties[key] || typeof properties[key] !== "object" || Array.isArray(properties[key])) throw new Error(`Notebook ${key} must be an object`);
    result[key] = properties[key];
  }
  for (const key of ["generationPlans", "notebookRunPlans"]) {
    if (properties[key] === undefined) continue;
    if (!Array.isArray(properties[key])) throw new Error(`Notebook ${key} must be an array`);
    result[key] = properties[key];
  }
  return result as Partial<NotebookDocument>;
}
