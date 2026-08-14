import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createEngine, type Engine } from "../src/engine.js";
import type { NotebookDocument } from "../src/notebook/types.js";
import {
  findGenerateImageOutputCell,
  findGenerateVideoOutputCell,
  resolveNotebookCellArtifactId,
} from "../src/notebook-media-artifact.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function setup(): Promise<{ engine: Engine; notebook: NotebookDocument }> {
  const root = await mkdtemp(path.join(tmpdir(), "vb-media-artifact-"));
  roots.push(root);
  const engine = createEngine({
    dataDir: path.join(root, "data"),
    workspaceDir: path.join(root, "workspace"),
    initialBookName: "media-artifact",
  });
  await engine.ready;
  const notebook = value(await engine.notebooks.create("Main"));
  return { engine, notebook };
}

function value<T>(
  result:
    | { ok: true; value: T; revision?: string }
    | { ok: false; error: { message: string } },
): T {
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

describe("notebook media artifact resolution", () => {
  it("finds a generate_image output cell by role, then producer, then type", async () => {
    const { engine, notebook } = await setup();
    const tile = engine.notebooks.createCell({
      type: "generate_image",
      slot: { row: 0, column: 0 },
      prompt: "a kitten",
    });
    const roleOutput = engine.notebooks.createCell({
      type: "image",
      slot: { row: 1, column: 0 },
      inputs: { mediaRole: "generate-image-output" },
    });
    const producerOutput = engine.notebooks.createCell({
      type: "image",
      slot: { row: 1, column: 1 },
      inputs: { producerCellId: tile.id },
    });
    const typeOnly = engine.notebooks.createCell({
      type: "image",
      slot: { row: 1, column: 2 },
    });
    const extractOutput = engine.notebooks.createCell({
      type: "image",
      slot: { row: 2, column: 0 },
      inputs: { mediaRole: "extract-frame-output" },
    });

    const roleDocument: NotebookDocument = {
      ...notebook,
      cells: [tile, roleOutput, extractOutput],
      edges: [
        engine.notebooks.createEdge({
          source: tile.id,
          target: roleOutput.id,
          targetInput: "media",
        }),
      ],
    };
    expect(findGenerateImageOutputCell(roleDocument, tile.id)?.outputCell.id)
      .toBe(roleOutput.id);

    const producerDocument: NotebookDocument = {
      ...notebook,
      cells: [tile, producerOutput, extractOutput],
      edges: [
        engine.notebooks.createEdge({
          source: tile.id,
          target: producerOutput.id,
          targetInput: "media",
        }),
      ],
    };
    expect(findGenerateImageOutputCell(producerDocument, tile.id)?.outputCell.id)
      .toBe(producerOutput.id);

    const typeDocument: NotebookDocument = {
      ...notebook,
      cells: [tile, typeOnly, extractOutput],
      edges: [
        engine.notebooks.createEdge({
          source: tile.id,
          target: typeOnly.id,
          targetInput: "media",
        }),
      ],
    };
    expect(findGenerateImageOutputCell(typeDocument, tile.id)?.outputCell.id)
      .toBe(typeOnly.id);

    const noEdgeDocument: NotebookDocument = {
      ...notebook,
      cells: [tile, extractOutput],
      edges: [
        engine.notebooks.createEdge({
          source: extractOutput.id,
          target: tile.id,
          targetInput: "image",
        }),
      ],
    };
    expect(findGenerateImageOutputCell(noEdgeDocument, tile.id)).toBeNull();
    engine.close();
  });

  it("resolves generate_image from the output cell, then legacy inline fields", async () => {
    const { engine, notebook } = await setup();
    const outputArtifact = value(await engine.artifacts.create("image", "pair-out"));
    const inlineArtifact = value(await engine.artifacts.create("image", "legacy-inline"));
    const entityArtifact = value(await engine.artifacts.create("image", "legacy-entity"));

    const pairTile = engine.notebooks.createCell({
      type: "generate_image",
      slot: { row: 0, column: 0 },
      prompt: "pair",
      outputArtifactId: inlineArtifact.artifactId,
    });
    const pairOutput = engine.notebooks.createCell({
      type: "image",
      slot: { row: 1, column: 0 },
      outputArtifactId: outputArtifact.artifactId,
      inputs: {
        mediaRole: "generate-image-output",
        producerCellId: pairTile.id,
      },
    });
    const pairDocument: NotebookDocument = {
      ...notebook,
      cells: [pairTile, pairOutput],
      edges: [
        engine.notebooks.createEdge({
          source: pairTile.id,
          target: pairOutput.id,
          targetInput: "media",
        }),
      ],
    };
    expect(resolveNotebookCellArtifactId(pairDocument, pairTile))
      .toBe(outputArtifact.artifactId);
    expect(resolveNotebookCellArtifactId(pairDocument, pairTile))
      .not.toBe(inlineArtifact.artifactId);

    const inlineTile = engine.notebooks.createCell({
      type: "generate_image",
      slot: { row: 0, column: 1 },
      prompt: "legacy",
      outputArtifactId: inlineArtifact.artifactId,
    });
    const inlineDocument: NotebookDocument = {
      ...notebook,
      cells: [inlineTile],
      edges: [],
    };
    expect(resolveNotebookCellArtifactId(inlineDocument, inlineTile))
      .toBe(inlineArtifact.artifactId);

    const entityTile = engine.notebooks.createCell({
      type: "generate_image",
      slot: { row: 0, column: 2 },
      prompt: "entity",
      outputEntityId: entityArtifact.artifactId,
    });
    const entityDocument: NotebookDocument = {
      ...notebook,
      cells: [entityTile],
      edges: [],
    };
    expect(resolveNotebookCellArtifactId(entityDocument, entityTile))
      .toBe(entityArtifact.artifactId);

    const emptyTile = engine.notebooks.createCell({
      type: "generate_image",
      slot: { row: 0, column: 3 },
      prompt: "empty",
    });
    expect(resolveNotebookCellArtifactId(
      { ...notebook, cells: [emptyTile], edges: [] },
      emptyTile,
    )).toBeUndefined();
    engine.close();
  });

  it("keeps generate_video pair lookup and resolution on the same wrappers", async () => {
    const { engine, notebook } = await setup();
    const outputArtifact = value(await engine.artifacts.create("video", "video-out"));
    const tile = engine.notebooks.createCell({
      type: "generate_video",
      slot: { row: 0, column: 0 },
      prompt: "walk",
    });
    const output = engine.notebooks.createCell({
      type: "video",
      slot: { row: 1, column: 0 },
      outputArtifactId: outputArtifact.artifactId,
      inputs: {
        mediaRole: "generate-video-output",
        producerCellId: tile.id,
      },
    });
    const document: NotebookDocument = {
      ...notebook,
      cells: [tile, output],
      edges: [
        engine.notebooks.createEdge({
          source: tile.id,
          target: output.id,
          targetInput: "media",
        }),
      ],
    };
    expect(findGenerateVideoOutputCell(document, tile.id)?.outputCell.id)
      .toBe(output.id);
    expect(resolveNotebookCellArtifactId(document, tile))
      .toBe(outputArtifact.artifactId);
    engine.close();
  });
});
