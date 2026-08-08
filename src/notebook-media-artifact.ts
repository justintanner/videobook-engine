import type {
  NotebookCell,
  NotebookDocument,
  NotebookEdge,
} from "./notebook/types.js";

type NotebookGraph = Pick<NotebookDocument, "cells" | "edges">;

export function findGenerateVideoOutputCell(
  document: NotebookGraph,
  generateVideoCellId: string,
): { outputCell: NotebookCell; outputEdge: NotebookEdge } | null {
  for (const edge of document.edges) {
    if (edge.source !== generateVideoCellId || edge.targetInput !== "media") {
      continue;
    }
    const outputCell = document.cells.find((cell) => cell.id === edge.target);
    if (
      outputCell?.type === "video"
      && outputCell.inputs?.mediaRole === "generate-video-output"
    ) {
      return { outputCell, outputEdge: edge };
    }
    if (
      outputCell?.type === "video"
      && outputCell.inputs?.producerCellId === generateVideoCellId
    ) {
      return { outputCell, outputEdge: edge };
    }
  }
  for (const edge of document.edges) {
    if (edge.source !== generateVideoCellId || edge.targetInput !== "media") {
      continue;
    }
    const outputCell = document.cells.find((cell) => cell.id === edge.target);
    if (outputCell?.type === "video") {
      return { outputCell, outputEdge: edge };
    }
  }
  return null;
}

/**
 * Resolve media artifact for a notebook cell.
 * generate_video prefers a dedicated output video cell, then falls back to
 * legacy inline outputArtifactId.
 */
export function resolveGeneratedVideoArtifact(
  document: NotebookGraph,
  cell: NotebookCell,
): string | undefined {
  if (cell.type === "generate_video") {
    const output = findGenerateVideoOutputCell(document, cell.id);
    if (typeof output?.outputCell.outputArtifactId === "string") {
      return output.outputCell.outputArtifactId;
    }
  }
  if (typeof cell.outputArtifactId === "string") return cell.outputArtifactId;
  if (typeof cell.outputEntityId === "string") return cell.outputEntityId;
  return undefined;
}

/** Resolve any cell's media artifact, with generate_video output-cell support. */
export function resolveNotebookCellArtifactId(
  document: NotebookGraph,
  cell: NotebookCell,
): string | undefined {
  return resolveGeneratedVideoArtifact(document, cell);
}
