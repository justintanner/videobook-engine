import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createEngine, type Engine } from "../src/engine.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function setup(): Promise<{ engine: Engine; root: string }> {
  const root = await mkdtemp(path.join(tmpdir(), "vb-notebook-history-"));
  roots.push(root);
  return {
    engine: createEngine({
      dataDir: path.join(root, "data"),
      workspaceDir: path.join(root, "workspace"),
      initialBookName: "history-demo",
    }),
    root,
  };
}

function value<T>(
  result:
    | { ok: true; value: T; revision?: string }
    | { ok: false; error: { message: string } },
): T {
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

describe("notebook write attribution + history reads", () => {
  it("threads operation/details/artifactId into dolt commits", async () => {
    const { engine } = await setup();
    const artifact = value(await engine.artifacts.create("image", "gen"));
    const notebook = value(await engine.notebooks.create("Attributed"));
    const cell = engine.notebooks.createCell({
      type: "prompt",
      slot: { row: 0, column: 0 },
      prompt: "first",
    });
    value(
      await engine.notebooks.write(
        { ...notebook, cells: [cell], edges: [] },
        {
          operation: "run_notebook_cell",
          details: { cellId: cell.id, runId: "run-1", tool: "generate_image" },
          artifactId: artifact.artifactId,
        },
      ),
    );

    const revisions = engine.history.revisions(5);
    const attributed = revisions.find((revision) =>
      revision.operation === "run_notebook_cell");
    expect(attributed).toBeDefined();
    expect(attributed?.artifactId).toBe(artifact.artifactId);
    expect(attributed?.details).toMatchObject({
      notebookId: notebook.id,
      cellId: cell.id,
      runId: "run-1",
      tool: "generate_image",
    });

    const artifactRevisions = engine.history.artifact(artifact.artifactId, 5);
    expect(artifactRevisions.some((revision) =>
      revision.operation === "run_notebook_cell")).toBe(true);
    engine.close();
  });

  it("returns distinct cell and execution history versions with attribution", async () => {
    const { engine } = await setup();
    const firstArtifact = value(await engine.artifacts.create("image", "v1"));
    const secondArtifact = value(await engine.artifacts.create("image", "v2"));
    const notebook = value(await engine.notebooks.create("History"));
    const cell = engine.notebooks.createCell({
      type: "image",
      slot: { row: 0, column: 0 },
      prompt: "prompt-a",
      outputArtifactId: firstArtifact.artifactId,
    });

    value(
      await engine.notebooks.write(
        {
          ...notebook,
          cells: [cell],
          edges: [],
          execution: {
            [cell.id]: {
              status: "completed",
              runId: "run-a",
              fingerprint: "fp-a",
              outputArtifactId: firstArtifact.artifactId,
            },
          },
        },
        {
          operation: "complete_notebook_provider_output",
          details: { cellId: cell.id, runId: "run-a" },
          artifactId: firstArtifact.artifactId,
        },
      ),
    );

    value(
      await engine.notebooks.write(
        {
          ...notebook,
          cells: [
            {
              ...cell,
              prompt: "prompt-b",
              outputArtifactId: secondArtifact.artifactId,
              inputs: { resolvedPrompt: "prompt-b", providerArtifactId: secondArtifact.artifactId },
            },
          ],
          edges: [],
          execution: {
            [cell.id]: {
              status: "completed",
              runId: "run-b",
              fingerprint: "fp-b",
              outputArtifactId: secondArtifact.artifactId,
              providerArtifactId: secondArtifact.artifactId,
            },
          },
        },
        {
          operation: "complete_notebook_provider_output",
          details: { cellId: cell.id, runId: "run-b" },
          artifactId: secondArtifact.artifactId,
        },
      ),
    );

    const cellVersions = engine.notebooks.cellHistory(notebook.id, cell.id, {
      limit: 10,
    });
    expect(cellVersions.length).toBeGreaterThanOrEqual(2);
    const prompts = cellVersions.map((entry) => entry.cell.prompt);
    expect(prompts).toContain("prompt-a");
    expect(prompts).toContain("prompt-b");
    expect(
      cellVersions.some((entry) =>
        entry.operation === "complete_notebook_provider_output"
        && entry.artifactId === secondArtifact.artifactId),
    ).toBe(true);

    const executionVersions = engine.notebooks.executionHistory(
      notebook.id,
      cell.id,
      { limit: 10 },
    );
    expect(executionVersions.length).toBeGreaterThanOrEqual(2);
    const runIds = executionVersions.map((entry) => entry.execution.runId);
    expect(runIds).toContain("run-a");
    expect(runIds).toContain("run-b");

    const from = cellVersions[cellVersions.length - 1]!;
    const to = cellVersions[0]!;
    const diff = engine.history.diff(from.commitHash, to.commitHash, "cells");
    expect(Array.isArray(diff)).toBe(true);
    expect(diff.length).toBeGreaterThanOrEqual(1);
    engine.close();
  });
});
