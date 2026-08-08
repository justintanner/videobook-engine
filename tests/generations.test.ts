import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";

import { DatabaseSync } from "@dolthub/doltlite";
import { afterEach, describe, expect, it } from "vitest";

import { createEngine, type Engine } from "../src/engine.js";
import type { NotebookCell, NotebookDocument } from "../src/notebook/types.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function setup(): Promise<{
  engine: Engine;
  root: string;
  dataDir: string;
}> {
  const root = await mkdtemp(path.join(tmpdir(), "vb-generations-"));
  roots.push(root);
  const dataDir = path.join(root, "data");
  return {
    engine: createEngine({
      dataDir,
      workspaceDir: path.join(root, "workspace"),
      initialBookName: "generations-demo",
    }),
    root,
    dataDir,
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

async function createCellFixture(
  engine: Engine,
): Promise<{ notebook: NotebookDocument; cell: NotebookCell }> {
  const notebook = value(await engine.notebooks.create("Generations"));
  const cell = engine.notebooks.createCell({
    type: "generate_video",
    slot: { row: 0, column: 0 },
    prompt: "a cat dances",
  });
  value(await engine.notebooks.insertCell(notebook.id, cell));
  return { notebook, cell };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("engine.generations", () => {
  it("records a generation with an attributable record_generation commit", async () => {
    const { engine } = await setup();
    const { notebook, cell } = await createCellFixture(engine);
    const payload = value(
      await engine.artifacts.create({ kind: "script", label: "payload" }),
    );

    const recorded = value(
      await engine.generations.record({
        notebookId: notebook.id,
        cellId: cell.id,
        tool: "generate_video",
        provider: "apicity",
        model: "kling-2.1",
        prompt: "a cat dances",
        resolvedPrompt: "a cat dances, cinematic",
        providerArtifactId: payload.artifactId,
      }),
    );
    expect(recorded.status).toBe("dispatched");
    expect(recorded.tool).toBe("generate_video");
    expect(recorded.model).toBe("kling-2.1");
    expect(recorded.providerArtifactId).toBe(payload.artifactId);
    expect(recorded.createdAt).toBe(recorded.updatedAt);

    const revisions = engine.history.revisions(5);
    const commit = revisions.find(
      (revision) => revision.operation === "record_generation",
    );
    expect(commit).toBeDefined();
    expect(commit?.artifactId).toBe(payload.artifactId);
    expect(commit?.details).toMatchObject({
      generationId: recorded.generationId,
      notebookId: notebook.id,
      cellId: cell.id,
      tool: "generate_video",
      status: "dispatched",
    });
    engine.close();
  });

  it("updates a generation through its lifecycle transitions", async () => {
    const { engine } = await setup();
    const { notebook, cell } = await createCellFixture(engine);
    const output = value(
      await engine.artifacts.create({ kind: "video", label: "out" }),
    );
    const recorded = value(
      await engine.generations.record({
        notebookId: notebook.id,
        cellId: cell.id,
        tool: "generate_video",
        runId: "run-1",
      }),
    );

    const awaiting = value(
      await engine.generations.update(recorded.generationId, {
        status: "awaiting_provider",
      }),
    );
    expect(awaiting.status).toBe("awaiting_provider");
    expect(awaiting.runId).toBe("run-1");
    expect(awaiting.updatedAt).toBeGreaterThanOrEqual(recorded.updatedAt);

    const completed = value(
      await engine.generations.update(recorded.generationId, {
        status: "completed",
        outputArtifactId: output.artifactId,
      }),
    );
    expect(completed.status).toBe("completed");
    expect(completed.outputArtifactId).toBe(output.artifactId);
    expect(completed.createdAt).toBe(recorded.createdAt);

    const revisions = engine.history.revisions(10);
    const byOperation = (operation: string) =>
      revisions.find((revision) => revision.operation === operation);
    expect(byOperation("update_generation")?.details).toMatchObject({
      generationId: recorded.generationId,
      status: "awaiting_provider",
    });
    expect(byOperation("complete_generation")?.artifactId).toBe(
      output.artifactId,
    );
    engine.close();
  });

  it("fails a generation with an error and supports clearing it", async () => {
    const { engine } = await setup();
    const { notebook, cell } = await createCellFixture(engine);
    const recorded = value(
      await engine.generations.record({
        notebookId: notebook.id,
        cellId: cell.id,
        tool: "generate_image",
        model: "sdxl",
      }),
    );

    const failed = value(
      await engine.generations.update(recorded.generationId, {
        status: "failed",
        error: "provider timeout",
      }),
    );
    expect(failed.status).toBe("failed");
    expect(failed.error).toBe("provider timeout");
    expect(failed.model).toBe("sdxl");

    const revisions = engine.history.revisions(10);
    const commit = revisions.find(
      (revision) => revision.operation === "fail_generation",
    );
    expect(commit?.details).toMatchObject({
      generationId: recorded.generationId,
      status: "failed",
    });

    const retried = value(
      await engine.generations.update(recorded.generationId, {
        status: "dispatched",
        error: null,
      }),
    );
    expect(retried.status).toBe("dispatched");
    expect(retried).not.toHaveProperty("error");
    engine.close();
  });

  it("lists generations for a cell newest-first with a limit", async () => {
    const { engine } = await setup();
    const { notebook, cell } = await createCellFixture(engine);
    const other = engine.notebooks.createCell({
      type: "generate_image",
      slot: { row: 1, column: 0 },
    });
    value(await engine.notebooks.insertCell(notebook.id, other));

    const ids: string[] = [];
    for (const attempt of ["first", "second", "third"]) {
      const recorded = value(
        await engine.generations.record({
          notebookId: notebook.id,
          cellId: cell.id,
          tool: "generate_video",
          prompt: attempt,
        }),
      );
      ids.push(recorded.generationId);
      await sleep(5);
    }
    value(
      await engine.generations.record({
        notebookId: notebook.id,
        cellId: other.id,
        tool: "generate_image",
      }),
    );

    const listed = value(
      engine.generations.listForCell(notebook.id, cell.id),
    );
    expect(listed.map((generation) => generation.generationId)).toEqual([
      ids[2],
      ids[1],
      ids[0],
    ]);
    expect(listed.map((generation) => generation.prompt)).toEqual([
      "third",
      "second",
      "first",
    ]);

    const limited = value(
      engine.generations.listForCell(notebook.id, cell.id, { limit: 2 }),
    );
    expect(limited.map((generation) => generation.generationId)).toEqual([
      ids[2],
      ids[1],
    ]);
    engine.close();
  });

  it("reads a generation by id and rejects unknown ids", async () => {
    const { engine } = await setup();
    const { notebook, cell } = await createCellFixture(engine);
    const recorded = value(
      await engine.generations.record({
        notebookId: notebook.id,
        cellId: cell.id,
        tool: "generate_audio",
      }),
    );

    const read = value(engine.generations.read(recorded.generationId));
    expect(read).toEqual(recorded);

    const missing = engine.generations.read(
      "018f0000-0000-7000-8000-000000000000",
    );
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.error.code).toBe("NOT_FOUND");

    const missingCell = await engine.generations.record({
      notebookId: notebook.id,
      cellId: "018f0000-0000-7000-8000-000000000001",
      tool: "generate_video",
    });
    expect(missingCell.ok).toBe(false);
    if (!missingCell.ok) expect(missingCell.error.code).toBe("NOT_FOUND");

    const badStatus = await engine.generations.record({
      notebookId: notebook.id,
      cellId: cell.id,
      tool: "generate_video",
      status: "queued" as never,
    });
    expect(badStatus.ok).toBe(false);
    if (!badStatus.ok) expect(badStatus.error.code).toBe("INVALID_INPUT");

    const noTool = await engine.generations.record({
      notebookId: notebook.id,
      cellId: cell.id,
      tool: " ",
    });
    expect(noTool.ok).toBe(false);
    if (!noTool.ok) expect(noTool.error.code).toBe("INVALID_INPUT");

    const missingUpdate = await engine.generations.update(
      "018f0000-0000-7000-8000-000000000002",
      { status: "completed" },
    );
    expect(missingUpdate.ok).toBe(false);
    if (!missingUpdate.ok) expect(missingUpdate.error.code).toBe("NOT_FOUND");
    engine.close();
  });

  it("yields the per-attempt transition timeline from dolt_history_generations", async () => {
    const { engine, dataDir } = await setup();
    const { notebook, cell } = await createCellFixture(engine);
    const output = value(
      await engine.artifacts.create({ kind: "video", label: "out" }),
    );
    const recorded = value(
      await engine.generations.record({
        notebookId: notebook.id,
        cellId: cell.id,
        tool: "generate_video",
        runId: "run-9",
      }),
    );
    value(
      await engine.generations.update(recorded.generationId, {
        status: "awaiting_provider",
      }),
    );
    value(
      await engine.generations.update(recorded.generationId, {
        status: "completed",
        outputArtifactId: output.artifactId,
      }),
    );
    engine.close();

    const db = new DatabaseSync(path.join(dataDir, "videobook.db"));
    type HistoryRow = {
      generation_id: string;
      status: string;
      output_artifact_id: string | null;
      commit_hash: string;
    };
    let rows: HistoryRow[];
    try {
      rows = db
        .prepare(
          `SELECT generation_id, status, output_artifact_id, commit_hash
           FROM dolt_history_generations
           WHERE generation_id=?`,
        )
        .all(recorded.generationId) as unknown as HistoryRow[];
    } catch {
      rows = (db.doltHistoryOf("generations") as unknown as HistoryRow[])
        .filter((row) => row.generation_id === recorded.generationId);
    }
    expect(rows).toHaveLength(3);
    expect(new Set(rows.map((row) => row.commit_hash)).size).toBe(3);

    const operationByHash = new Map(
      db
        .doltLog()
        .map((commit) => [
          commit.commit_hash,
          commit.message.split("\n")[0]!.split(" artifact:")[0]!,
        ]),
    );
    const transitions = rows.map((row) => ({
      status: row.status,
      operation: operationByHash.get(row.commit_hash),
    }));
    expect(transitions).toEqual(
      expect.arrayContaining([
        { status: "dispatched", operation: "record_generation" },
        { status: "awaiting_provider", operation: "update_generation" },
        { status: "completed", operation: "complete_generation" },
      ]),
    );

    const completedRow = rows.find((row) => row.status === "completed");
    expect(completedRow?.output_artifact_id).toBe(output.artifactId);
    const dispatchedRow = rows.find((row) => row.status === "dispatched");
    expect(dispatchedRow?.output_artifact_id).toBeNull();
    db.close();
  });
});
