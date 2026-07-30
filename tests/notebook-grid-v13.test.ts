import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";

import { DatabaseSync } from "@dolthub/doltlite";
import { v7 as uuidv7 } from "uuid";
import { afterEach, describe, expect, it } from "vitest";

import {
  CELLS_TABLE_COLUMNS,
  NOTEBOOK_CELL_SLUG_PREFIXES,
  NOTEBOOK_CELL_TYPES,
  SCHEMA_VERSION,
  createEngine,
} from "../src/index.js";
import type { NotebookCell } from "../src/index.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true, maxRetries: 3 })),
  );
});

function value<T>(
  result: { ok: true; value: T } | { ok: false; error: { message: string } },
): T {
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

async function setup() {
  const root = await mkdtemp(path.join(tmpdir(), "videobook-grid-v13-"));
  roots.push(root);
  const engine = createEngine({
    rootDir: root,
    initialBookSlug: "grid-v13",
  });
  await engine.ready;
  return { root, engine };
}

function rewriteCellsAsSchema18(database: DatabaseSync): void {
  const columns = CELLS_TABLE_COLUMNS.join(", ");
  database.exec("PRAGMA foreign_keys = OFF");
  database.exec("BEGIN IMMEDIATE");
  try {
    database.exec(`
      CREATE TABLE cells_schema_18 (
        notebook_id TEXT NOT NULL
          REFERENCES notebooks(notebook_id) ON DELETE CASCADE,
        cell_id TEXT NOT NULL,
        type TEXT NOT NULL CHECK (
          type IN (
            'audio','image','video','extract_audio','split_video',
            'prompt','character',
            'analyze','analysis','generate_video','generate_image',
            'generate_audio','concat','splice'
          )
        ),
        slug TEXT NOT NULL CHECK (
          slug GLOB '[a-z0-9]*'
          AND slug NOT GLOB '*[^a-z0-9-]*'
          AND slug NOT GLOB '*--*'
          AND slug NOT LIKE '-%'
          AND slug NOT LIKE '%-'
          AND instr(slug, '-') > 0
        ),
        grid_row INTEGER NOT NULL CHECK (grid_row >= 0),
        grid_column INTEGER NOT NULL,
        output_entity_id TEXT
          REFERENCES entities(entity_id) ON DELETE RESTRICT,
        prompt TEXT,
        provider TEXT,
        model TEXT,
        operation TEXT,
        tool TEXT,
        inputs_json TEXT NOT NULL DEFAULT '{}',
        output_artifact_id TEXT
          REFERENCES artifacts(artifact_id) ON DELETE RESTRICT,
        PRIMARY KEY(notebook_id, cell_id),
        UNIQUE(notebook_id, slug),
        CHECK (
          (type = 'audio' AND slug LIKE 'aud-%')
          OR (type = 'image' AND slug LIKE 'img-%')
          OR (type = 'video' AND slug LIKE 'vid-%')
          OR (type = 'extract_audio' AND slug LIKE 'extract-audio-%')
          OR (type = 'split_video' AND slug LIKE 'split-video-%')
          OR (type = 'prompt' AND slug LIKE 'prompt-%')
          OR (type = 'character' AND slug LIKE 'char-%')
          OR (type = 'analyze' AND slug LIKE 'analyze-%')
          OR (type = 'analysis' AND slug LIKE 'analysis-%')
          OR (type = 'generate_video' AND slug LIKE 'generate-video-%')
          OR (type = 'generate_image' AND slug LIKE 'generate-image-%')
          OR (type = 'generate_audio' AND slug LIKE 'generate-audio-%')
          OR (type = 'concat' AND slug LIKE 'concat-%')
          OR (type = 'splice' AND slug LIKE 'splice-%')
        )
      );
      INSERT INTO cells_schema_18(${columns})
        SELECT ${columns} FROM cells;
      DROP TABLE cells;
      ALTER TABLE cells_schema_18 RENAME TO cells;
      CREATE INDEX cells_output_entity ON cells(output_entity_id);
      CREATE INDEX cells_grid
        ON cells(notebook_id, grid_row, grid_column, cell_id);
      CREATE INDEX cells_output_artifact ON cells(output_artifact_id);
      UPDATE engine_schema SET version=18 WHERE singleton=1;
      COMMIT;
    `);
  } catch (error) {
    if (database.inTransaction) database.exec("ROLLBACK");
    throw error;
  } finally {
    database.exec("PRAGMA foreign_keys = ON");
  }
}

describe("centered notebook grid schema v13", () => {
  it("exports signed cell slots and the fifteen explicit cell types", () => {
    expect(NOTEBOOK_CELL_TYPES).toEqual([
      "audio",
      "image",
      "video",
      "extract_audio",
      "extract_frame",
      "split_video",
      "prompt",
      "character",
      "analyze",
      "analysis",
      "generate_video",
      "generate_image",
      "generate_audio",
      "concat",
      "splice",
    ]);
    expect(CELLS_TABLE_COLUMNS).toEqual([
      "notebook_id",
      "cell_id",
      "type",
      "slug",
      "grid_row",
      "grid_column",
      "output_entity_id",
      "prompt",
      "provider",
      "model",
      "operation",
      "tool",
      "inputs_json",
      "output_artifact_id",
    ]);
    expect(SCHEMA_VERSION).toBe(19);
  });

  it("round-trips every cell type at arbitrary signed columns", async () => {
    const { root, engine } = await setup();
    const notebook = value(await engine.notebooks.create("Workflow"));
    const cells = NOTEBOOK_CELL_TYPES.map((type, index) =>
      engine.notebooks.createCell({
        type,
        slug: `${NOTEBOOK_CELL_SLUG_PREFIXES[type]}-cell`,
        slot: {
          row: index === 0 ? 0 : index * 7,
          column: index === 0 ? 0 : index % 2 === 0 ? index * 11 : index * -11,
        },
        prompt: type === "analyze" ? "Analyze scenes" : undefined,
        provider: type === "analyze" ? "kie" : undefined,
        model: type === "analyze" ? "gemini-3.5-flash" : undefined,
        operation: type === "analyze" ? "analyze_source" : undefined,
        tool: type === "analyze" ? "kie_gemini_analysis" : undefined,
        inputs: { ordinal: index },
      }),
    );
    value(
      await engine.notebooks.write({
        ...notebook,
        cells,
        edges: [],
      }),
    );
    const reloaded = value(engine.notebooks.read(notebook.id));
    expect("grid" in reloaded).toBe(false);
    expect(reloaded.cells.map((cell) => cell.type).sort()).toEqual(
      [...NOTEBOOK_CELL_TYPES].sort(),
    );
    expect(reloaded.cells.find((cell) => cell.type === "audio")).toMatchObject({
      slug: "aud-cell",
      slot: { row: 0, column: 0 },
    });
    expect(
      reloaded.cells.find((cell) => cell.type === "analyze")?.slot,
    ).toEqual({
      row: 56,
      column: 88,
    });
    expect(
      reloaded.cells.find((cell) => cell.type === "analyze"),
    ).toMatchObject({
      provider: "kie",
      model: "gemini-3.5-flash",
      operation: "analyze_source",
      tool: "kie_gemini_analysis",
      prompt: "Analyze scenes",
    });

    engine.close();
    const database = new DatabaseSync(path.join(root, "data", "videobook.db"), {
      readOnly: true,
    });
    const raw = database
      .prepare(
        `SELECT ${CELLS_TABLE_COLUMNS.join(", ")}
         FROM cells WHERE notebook_id=? AND type='analyze'`,
      )
      .get(notebook.id) as Record<string, unknown>;
    expect(Object.keys(raw)).toHaveLength(14);
    expect(raw.grid_row).toBeGreaterThan(0);
    expect(raw.grid_column).toBe(88);
    expect(raw.provider).toBe("kie");
    database.close();
  });

  it("enforces the explicit cell types in the semantic table", async () => {
    const { root, engine } = await setup();
    const notebook = value(await engine.notebooks.create("Constraint"));
    engine.close();
    const database = new DatabaseSync(path.join(root, "data", "videobook.db"));
    expect(() =>
      database
        .prepare(
          `INSERT INTO cells(
          notebook_id, cell_id, type, slug, grid_row, grid_column, inputs_json
        ) VALUES (?, 'removed-split', 'split', 'split-removed', 0, 0, '{}')`,
        )
        .run(notebook.id),
    ).toThrow();
    database.close();
  });

  it("enforces typed notebook-unique slugs and output entity references", async () => {
    const { root, engine } = await setup();
    const notebook = value(await engine.notebooks.create("Slugs"));
    const entity = value(await engine.entities.create("character", "Boat"));
    const image = engine.notebooks.createCell({
      type: "image",
      slug: "img-boat",
      slot: { row: 0, column: 0 },
      outputEntityId: entity.id,
    });
    value(
      await engine.notebooks.write({
        ...notebook,
        cells: [image],
        edges: [],
      }),
    );
    expect(value(engine.notebooks.read(notebook.id)).cells[0]).toMatchObject({
      slug: "img-boat",
      outputEntityId: entity.id,
    });

    const duplicate = await engine.notebooks.write({
      ...notebook,
      cells: [
        image,
        {
          ...image,
          id: uuidv7(),
          slot: { row: 0, column: 1 },
        },
      ],
      edges: [],
    });
    expect(duplicate).toMatchObject({
      ok: false,
      error: { message: "Duplicate cell slug: img-boat" },
    });

    const invalid = await engine.notebooks.write({
      ...notebook,
      cells: [{ ...image, slug: "video-boat" }],
      edges: [],
    });
    expect(invalid).toMatchObject({
      ok: false,
      error: { message: "Invalid image cell slug: video-boat" },
    });

    engine.close();
    const database = new DatabaseSync(path.join(root, "data", "videobook.db"), {
      readOnly: true,
    });
    expect(
      database
        .prepare("SELECT slug, output_entity_id FROM cells WHERE cell_id=?")
        .get(image.id),
    ).toMatchObject({
      slug: "img-boat",
      output_entity_id: entity.id,
    });
    database.close();
  });

  it("allows only one edge per named target input", async () => {
    const { engine } = await setup();
    const notebook = value(await engine.notebooks.create("Inputs"));
    const first = engine.notebooks.createCell({
      type: "video",
      slug: "vid-first",
      slot: { row: 0, column: 0 },
    });
    const second = engine.notebooks.createCell({
      type: "video",
      slug: "vid-second",
      slot: { row: 0, column: 1 },
    });
    const target = engine.notebooks.createCell({
      type: "analyze",
      slug: "analyze-target",
      slot: { row: 1, column: 0 },
    });
    const duplicateInput = await engine.notebooks.write({
      ...notebook,
      cells: [first, second, target],
      edges: [
        engine.notebooks.createEdge({
          source: first.id,
          target: target.id,
          targetInput: "source",
        }),
        engine.notebooks.createEdge({
          source: second.id,
          target: target.id,
          targetInput: "source",
        }),
      ],
    });
    expect(duplicateInput).toMatchObject({
      ok: false,
      error: {
        message: `Duplicate target input: ${target.id} source`,
      },
    });
    engine.close();
  });

  it("round-trips notebook workflow state through normalized tables", async () => {
    const { root, engine } = await setup();
    const notebook = value(await engine.notebooks.create("Workflow state"));
    const cell = engine.notebooks.createCell({
      type: "analyze",
      slug: "analyze-source",
      slot: { row: 0, column: 0 },
    });
    value(
      await engine.notebooks.write({
        ...notebook,
        description: "Catalog-owned workflow",
        lifecycleState: "running",
        workflowVersion: 3,
        analysisRevision: "rev-analysis",
        audioSpine: {
          artifactId: "artifact-audio",
          streamId: "stream-audio",
          objectHash: "sha256:audio",
          sourcePath: "audio.wav",
          sequenceId: "sequence-main",
          sequenceRevision: "rev-sequence",
          trackId: "track-audio",
          clipId: "clip-audio",
        },
        currentSelection: {
          transcriptId: "transcript-current",
          startWordId: "word-a",
          endWordId: "word-b",
        },
        fixture: { version: 1, owner: "integration" },
        execution: {
          [cell.id]: {
            fingerprint: "fingerprint-1",
            status: "completed",
            runId: "run-1",
            stale: true,
            fixtureBaseline: true,
          },
        },
        generationPlans: [
          {
            planId: "generation-plan-1",
            cellId: cell.id,
            status: "approved",
            plan: { provider: "kie" },
            createdAt: "2026-07-29T00:00:00.000Z",
            updatedAt: "2026-07-29T00:01:00.000Z",
          },
        ],
        notebookRunPlans: [
          {
            planId: "run-plan-1",
            status: "approved",
            plan: { order: [cell.id] },
            paidCellIds: [cell.id],
            cellDefinitionFingerprints: { [cell.id]: "fingerprint-1" },
            knownCostUsd: 1.25,
            unknownCostCount: 0,
            createdAt: "2026-07-29T00:00:00.000Z",
            updatedAt: "2026-07-29T00:01:00.000Z",
          },
        ],
        transcriptEdits: [
          {
            actionId: "edit-1",
            kind: "remove_words",
            startWordId: "word-a",
            endWordId: "word-b",
          },
        ],
        transcriptAttachments: [
          {
            id: "attachment-1",
            transcriptId: "transcript-current",
          },
        ],
        cells: [cell],
        edges: [],
      }),
    );

    const reloaded = value(engine.notebooks.read(notebook.id));
    expect(reloaded).toMatchObject({
      description: "Catalog-owned workflow",
      lifecycleState: "running",
      workflowVersion: 3,
      analysisRevision: "rev-analysis",
      audioSpine: { artifactId: "artifact-audio" },
      currentSelection: { transcriptId: "transcript-current" },
      fixture: { version: 1, owner: "integration" },
      execution: {
        [cell.id]: {
          fingerprint: "fingerprint-1",
          stale: true,
          fixtureBaseline: true,
        },
      },
      generationPlans: [{ planId: "generation-plan-1", cellId: cell.id }],
      notebookRunPlans: [{ planId: "run-plan-1", knownCostUsd: 1.25 }],
      transcriptEdits: [{ actionId: "edit-1", kind: "remove_words" }],
      transcriptAttachments: [{ id: "attachment-1" }],
    });

    value(
      await engine.notebooks.write({
        ...reloaded,
        description: undefined,
        lifecycleState: undefined,
        workflowVersion: undefined,
        analysisRevision: undefined,
        audioSpine: undefined,
        currentSelection: undefined,
        fixture: undefined,
        execution: {},
        generationPlans: [],
        notebookRunPlans: [],
        transcriptEdits: [],
        transcriptAttachments: [],
      }),
    );
    const cleared = value(engine.notebooks.read(notebook.id));
    expect(cleared).not.toHaveProperty("description");
    expect(cleared).not.toHaveProperty("audioSpine");
    expect(cleared.execution).toEqual({});
    expect(cleared.generationPlans).toEqual([]);
    expect(cleared.notebookRunPlans).toEqual([]);
    expect(cleared.transcriptEdits).toEqual([]);
    expect(cleared.transcriptAttachments).toEqual([]);
    engine.close();

    const database = new DatabaseSync(path.join(root, "data", "videobook.db"));
    for (const table of [
      "notebook_fields",
      "notebook_cell_executions",
      "notebook_generation_plans",
      "notebook_run_plans",
      "notebook_transcript_edits",
      "notebook_transcript_attachments",
    ]) {
      expect(
        database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get(),
      ).toEqual({ count: 0 });
    }
    database.close();
  });

  it.each([11, 12, 17])(
    "rejects schema-v%s catalogs without migration",
    async (version) => {
      const { root, engine } = await setup();
      engine.close();
      const database = new DatabaseSync(
        path.join(root, "data", "videobook.db"),
      );
      database
        .prepare("UPDATE engine_schema SET version=? WHERE singleton=1")
        .run(version);
      database.close();

      expect(() => createEngine({ rootDir: root })).toThrow(
        `Database schema ${version} is not supported by engine schema 19`,
      );
    },
  );

  it("upgrades schema 18 cells without losing notebook graph state", async () => {
    const { root, engine } = await setup();
    const notebook = value(await engine.notebooks.create("Upgrade"));
    const source = engine.notebooks.createCell({
      type: "video",
      slug: "vid-source",
      slot: { row: 0, column: 0 },
    });
    const analysis = engine.notebooks.createCell({
      type: "analysis",
      slug: "analysis-result",
      slot: { row: 1, column: 0 },
    });
    const edge = engine.notebooks.createEdge({
      source: source.id,
      target: analysis.id,
      targetInput: "input",
    });
    value(await engine.notebooks.write({
      ...notebook,
      cells: [source, analysis],
      edges: [edge],
      execution: {
        [source.id]: {
          status: "completed",
          fingerprint: "source-fingerprint",
        },
      },
    }));
    engine.close();

    const database = new DatabaseSync(
      path.join(root, "data", "videobook.db"),
    );
    rewriteCellsAsSchema18(database);
    database.close();

    const upgraded = createEngine({ rootDir: root });
    await upgraded.ready;
    const reloaded = value(upgraded.notebooks.read(notebook.id));
    expect(reloaded.cells).toMatchObject([
      { id: source.id, type: "video", slug: "vid-source" },
      { id: analysis.id, type: "analysis", slug: "analysis-result" },
    ]);
    expect(reloaded.edges).toEqual([edge]);
    expect(reloaded.execution?.[source.id]).toMatchObject({
      status: "completed",
      fingerprint: "source-fingerprint",
    });

    const extractFrame = upgraded.notebooks.createCell({
      type: "extract_frame",
      slug: "extract-frame-source",
      slot: { row: 2, column: 0 },
    });
    value(await upgraded.notebooks.write({
      ...reloaded,
      cells: [...reloaded.cells, extractFrame],
    }));
    expect(value(upgraded.notebooks.read(notebook.id)).cells).toContainEqual(
      expect.objectContaining(extractFrame),
    );
    upgraded.close();

    const verified = new DatabaseSync(
      path.join(root, "data", "videobook.db"),
      { readOnly: true },
    );
    expect(
      (verified
        .prepare("SELECT version FROM engine_schema WHERE singleton=1")
        .get() as { version: number }).version,
    ).toBe(19);
    expect(verified.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    verified.close();
  });

  it("rejects duplicate, negative-row, and fractional slots without horizontal edges", async () => {
    const { engine } = await setup();
    const notebook = value(await engine.notebooks.create("Validation"));
    const first = engine.notebooks.createCell({
      type: "prompt",
      slug: "prompt-first",
      slot: { row: 0, column: 0 },
    });
    const duplicate = engine.notebooks.createCell({
      type: "image",
      slug: "img-duplicate",
      slot: { row: 0, column: 0 },
    });
    const duplicated = await engine.notebooks.write({
      ...notebook,
      cells: [first, duplicate],
      edges: [],
    });
    expect(duplicated.ok).toBe(false);
    if (!duplicated.ok) {
      expect(duplicated.error.message).toContain("Duplicate cell slot");
    }

    const fractional = await engine.notebooks.write({
      ...notebook,
      cells: [{ ...first, slot: { row: 0.5, column: 0 } }],
      edges: [],
    });
    expect(fractional.ok).toBe(false);

    const negativeRow = await engine.notebooks.write({
      ...notebook,
      cells: [{ ...first, slot: { row: -1, column: 0 } }],
      edges: [],
    });
    expect(negativeRow.ok).toBe(false);

    const fractionalColumn = await engine.notebooks.write({
      ...notebook,
      cells: [{ ...first, slot: { row: 0, column: -1.5 } }],
      edges: [],
    });
    expect(fractionalColumn.ok).toBe(false);

    const left = await engine.notebooks.write({
      ...notebook,
      cells: [{ ...first, slot: { row: 12_345, column: -67_890 } }],
      edges: [],
    });
    expect(left.ok).toBe(true);
    expect(value(engine.notebooks.read(notebook.id)).cells[0]?.slot).toEqual({
      row: 12_345,
      column: -67_890,
    });

    const wide = await engine.notebooks.write({
      ...notebook,
      cells: [{ ...first, slot: { row: 12_345, column: 67_890 } }],
      edges: [],
    });
    expect(wide.ok).toBe(true);
    expect(value(engine.notebooks.read(notebook.id)).cells[0]?.slot).toEqual({
      row: 12_345,
      column: 67_890,
    });

    const removedType = {
      ...first,
      type: "split",
      slot: { row: 0, column: 1 },
    } as unknown as NotebookCell;
    const removed = await engine.notebooks.write({
      ...notebook,
      cells: [removedType],
      edges: [],
    });
    expect(removed).toMatchObject({
      ok: false,
      error: { message: "Invalid cell type: split" },
    });
    engine.close();
  });

  it("persists occupied-slot swaps atomically", async () => {
    const { engine } = await setup();
    const notebook = value(await engine.notebooks.create("Swap"));
    const first = engine.notebooks.createCell({
      type: "prompt",
      slug: "prompt-first",
      slot: { row: 0, column: 0 },
    });
    const second = engine.notebooks.createCell({
      type: "image",
      slug: "img-second",
      slot: { row: 0, column: 1 },
    });
    value(
      await engine.notebooks.write({
        ...notebook,
        cells: [first, second],
        edges: [],
      }),
    );
    const current = value(engine.notebooks.read(notebook.id));
    value(
      await engine.notebooks.write({
        ...current,
        cells: current.cells.map((cell) => ({
          ...cell,
          slot:
            cell.id === first.id
              ? { row: 0, column: 1 }
              : { row: 0, column: 0 },
        })),
      }),
    );
    const swapped = value(engine.notebooks.read(notebook.id));
    expect(swapped.cells.find((cell) => cell.id === first.id)?.slot).toEqual({
      row: 0,
      column: 1,
    });
    expect(swapped.cells.find((cell) => cell.id === second.id)?.slot).toEqual({
      row: 0,
      column: 0,
    });
    engine.close();
  });

  it("persists downward moves beyond the temporary evacuation band atomically", async () => {
    const { engine } = await setup();
    const notebook = value(await engine.notebooks.create("Downward move"));
    const first = engine.notebooks.createCell({
      type: "prompt",
      slug: "prompt-first",
      slot: { row: 0, column: 0 },
    });
    const second = engine.notebooks.createCell({
      type: "image",
      slug: "img-second",
      slot: { row: 1, column: 0 },
    });
    value(
      await engine.notebooks.write({
        ...notebook,
        cells: [first, second],
        edges: [],
      }),
    );

    const moved = value(engine.notebooks.read(notebook.id));
    value(
      await engine.notebooks.write({
        ...moved,
        cells: moved.cells.map((cell) => ({
          ...cell,
          slot: {
            row: cell.id === first.id ? 3 : 4,
            column: 0,
          },
        })),
      }),
    );
    expect(value(engine.notebooks.read(notebook.id)).cells).toMatchObject([
      { id: first.id, slot: { row: 3, column: 0 } },
      { id: second.id, slot: { row: 4, column: 0 } },
    ]);

    const duplicate = await engine.notebooks.write({
      ...value(engine.notebooks.read(notebook.id)),
      cells: [
        { ...first, slot: { row: 5, column: 0 } },
        { ...second, slot: { row: 5, column: 0 } },
      ],
    });
    expect(duplicate).toMatchObject({
      ok: false,
      error: { message: "Duplicate cell slot: 5:0" },
    });
    expect(value(engine.notebooks.read(notebook.id)).cells).toMatchObject([
      { id: first.id, slot: { row: 3, column: 0 } },
      { id: second.id, slot: { row: 4, column: 0 } },
    ]);
    engine.close();
  });

  it("rejects unsupported engine schemas", async () => {
    const { root, engine } = await setup();
    engine.close();
    const database = new DatabaseSync(path.join(root, "data", "videobook.db"));
    database
      .prepare("UPDATE engine_schema SET version=10 WHERE singleton=1")
      .run();
    database.close();

    expect(() => createEngine({ rootDir: root })).toThrow(
      "Database schema 10 is not supported by engine schema 19",
    );
  });

  it("swaps slugs between surviving cells in one write", async () => {
    const { engine } = await setup();
    const notebook = value(await engine.notebooks.create("Swap"));
    const alpha = engine.notebooks.createCell({
      type: "audio",
      slug: "aud-alpha",
      slot: { row: 0, column: 0 },
    });
    const beta = engine.notebooks.createCell({
      type: "audio",
      slug: "aud-beta",
      slot: { row: 1, column: 0 },
    });
    value(
      await engine.notebooks.write({
        ...notebook,
        cells: [alpha, beta],
        edges: [],
      }),
    );

    // Swapping two live slugs is a valid document; the write must not trip
    // the per-notebook slug UNIQUE mid-upsert.
    value(
      await engine.notebooks.write({
        ...notebook,
        cells: [
          { ...alpha, slug: "aud-beta" },
          { ...beta, slug: "aud-alpha" },
        ],
        edges: [],
      }),
    );
    const reloaded = value(engine.notebooks.read(notebook.id));
    expect(reloaded.cells.map((cell) => [cell.id, cell.slug]).sort()).toEqual(
      [
        [alpha.id, "aud-beta"],
        [beta.id, "aud-alpha"],
      ].sort(),
    );
    engine.close();
  });
});
