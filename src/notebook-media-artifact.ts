import type {
  NotebookCell,
  NotebookDocument,
  NotebookEdge,
} from "./notebook/types.js";

type NotebookGraph = Pick<NotebookDocument, "cells" | "edges">;

type GenerationOutputType = "video" | "image";

function findGenerationOutputCell(
  document: NotebookGraph,
  producerCellId: string,
  outputType: GenerationOutputType,
  mediaRole: string,
): { outputCell: NotebookCell; outputEdge: NotebookEdge } | null {
  for (const edge of document.edges) {
    if (edge.source !== producerCellId || edge.targetInput !== "media") {
      continue;
    }
    const outputCell = document.cells.find((cell) => cell.id === edge.target);
    if (
      outputCell?.type === outputType
      && outputCell.inputs?.mediaRole === mediaRole
    ) {
      return { outputCell, outputEdge: edge };
    }
    if (
      outputCell?.type === outputType
      && outputCell.inputs?.producerCellId === producerCellId
    ) {
      return { outputCell, outputEdge: edge };
    }
  }
  for (const edge of document.edges) {
    if (edge.source !== producerCellId || edge.targetInput !== "media") {
      continue;
    }
    const outputCell = document.cells.find((cell) => cell.id === edge.target);
    if (outputCell?.type === outputType) {
      return { outputCell, outputEdge: edge };
    }
  }
  return null;
}

export function findGenerateVideoOutputCell(
  document: NotebookGraph,
  generateVideoCellId: string,
): { outputCell: NotebookCell; outputEdge: NotebookEdge } | null {
  return findGenerationOutputCell(
    document,
    generateVideoCellId,
    "video",
    "generate-video-output",
  );
}

export function findGenerateImageOutputCell(
  document: NotebookGraph,
  generateImageCellId: string,
): { outputCell: NotebookCell; outputEdge: NotebookEdge } | null {
  return findGenerationOutputCell(
    document,
    generateImageCellId,
    "image",
    "generate-image-output",
  );
}

function inlineCellArtifactId(cell: NotebookCell): string | undefined {
  if (typeof cell.outputArtifactId === "string") return cell.outputArtifactId;
  if (typeof cell.outputEntityId === "string") return cell.outputEntityId;
  return undefined;
}

function outputCellArtifactId(
  document: NotebookGraph,
  cell: NotebookCell,
): string | undefined {
  const output = cell.type === "generate_video"
    ? findGenerateVideoOutputCell(document, cell.id)
    : cell.type === "generate_image"
      ? findGenerateImageOutputCell(document, cell.id)
      : null;
  if (typeof output?.outputCell.outputArtifactId === "string") {
    return output.outputCell.outputArtifactId;
  }
  return undefined;
}

/**
 * Resolve media artifact for a notebook cell.
 * generate_video / generate_image prefer a dedicated output cell, then fall
 * back to legacy inline outputArtifactId / outputEntityId.
 */
export function resolveNotebookCellArtifactId(
  document: NotebookGraph,
  cell: NotebookCell,
): string | undefined {
  return outputCellArtifactId(document, cell) ?? inlineCellArtifactId(cell);
}

export function resolveGeneratedVideoArtifact(
  document: NotebookGraph,
  cell: NotebookCell,
): string | undefined {
  return resolveNotebookCellArtifactId(document, cell);
}
