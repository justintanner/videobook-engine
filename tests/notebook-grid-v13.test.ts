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
    roots.splice(0).map((root) =>
      rm(root, { recursive: true, force: true, maxRetries: 3 })
    ),
  );
});

function value<T>(
  result:
    | { ok: true; value: T }
    | { ok: false; error: { message: string } },
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

describe("centered notebook grid schema v13", () => {
  it("exports signed cell slots and the fourteen explicit cell types", () => {
    expect(NOTEBOOK_CELL_TYPES).toEqual([
      "audio",
      "image",
      "video",
      "extract_audio",
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
    expect(SCHEMA_VERSION).toBe(14);
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
      })
    );
    value(await engine.notebooks.write({
      ...notebook,
      cells,
      edges: [],
    }));
    const reloaded = value(engine.notebooks.read(notebook.id));
    expect("grid" in reloaded).toBe(false);
    expect(reloaded.cells.map((cell) => cell.type).sort()).toEqual(
      [...NOTEBOOK_CELL_TYPES].sort(),
    );
    expect(reloaded.cells.find((cell) => cell.type === "audio")).toMatchObject({
      slug: "aud-cell",
      slot: { row: 0, column: 0 },
    });
    expect(reloaded.cells.find((cell) => cell.type === "analyze")?.slot).toEqual({
      row: 49,
      column: -77,
    });
    expect(reloaded.cells.find((cell) => cell.type === "analyze")).toMatchObject({
      provider: "kie",
      model: "gemini-3.5-flash",
      operation: "analyze_source",
      tool: "kie_gemini_analysis",
      prompt: "Analyze scenes",
    });

    engine.close();
    const database = new DatabaseSync(
      path.join(root, "data", "videobook.db"),
      { readOnly: true },
    );
    const raw = database
      .prepare(
        `SELECT ${CELLS_TABLE_COLUMNS.join(", ")}
         FROM cells WHERE notebook_id=? AND type='analyze'`,
      )
      .get(notebook.id) as Record<string, unknown>;
    expect(Object.keys(raw)).toHaveLength(14);
    expect(raw.grid_row).toBeGreaterThan(0);
    expect(raw.grid_column).toBe(-77);
    expect(raw.provider).toBe("kie");
    database.close();
  });

  it("enforces the explicit cell types in the semantic table", async () => {
    const { root, engine } = await setup();
    const notebook = value(await engine.notebooks.create("Constraint"));
    engine.close();
    const database = new DatabaseSync(
      path.join(root, "data", "videobook.db"),
    );
    expect(() =>
      database.prepare(
        `INSERT INTO cells(
          notebook_id, cell_id, type, slug, grid_row, grid_column, inputs_json
        ) VALUES (?, 'removed-split', 'split', 'split-removed', 0, 0, '{}')`,
      ).run(notebook.id)
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
    value(await engine.notebooks.write({
      ...notebook,
      cells: [image],
      edges: [],
    }));
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
    const database = new DatabaseSync(
      path.join(root, "data", "videobook.db"),
      { readOnly: true },
    );
    expect(
      database.prepare(
        "SELECT slug, output_entity_id FROM cells WHERE cell_id=?",
      ).get(image.id),
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

  it.each([11, 12])("rejects schema-v%s catalogs without migration", async (version) => {
    const { root, engine } = await setup();
    engine.close();
    const database = new DatabaseSync(
      path.join(root, "data", "videobook.db"),
    );
    database
      .prepare("UPDATE engine_schema SET version=? WHERE singleton=1")
      .run(version);
    database.close();

    expect(() => createEngine({ rootDir: root }))
      .toThrow(`Database schema ${version} is not supported by engine schema 14`);
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
    value(await engine.notebooks.write({
      ...notebook,
      cells: [first, second],
      edges: [],
    }));
    const current = value(engine.notebooks.read(notebook.id));
    value(await engine.notebooks.write({
      ...current,
      cells: current.cells.map((cell) => ({
        ...cell,
        slot: cell.id === first.id
          ? { row: 0, column: 1 }
          : { row: 0, column: 0 },
      })),
    }));
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
    value(await engine.notebooks.write({
      ...notebook,
      cells: [first, second],
      edges: [],
    }));

    const moved = value(engine.notebooks.read(notebook.id));
    value(await engine.notebooks.write({
      ...moved,
      cells: moved.cells.map((cell) => ({
        ...cell,
        slot: {
          row: cell.id === first.id ? 3 : 4,
          column: 0,
        },
      })),
    }));
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
      "Database schema 10 is not supported by engine schema 14",
    );
  });
});
