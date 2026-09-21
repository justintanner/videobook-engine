import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "@dolthub/doltlite";
import { afterEach, expect, it } from "vitest";
import { createEngine, firstEmptyNotebookGridRow, notebookOccupiedSlots } from "../src/index.js";
import { CELLS_TABLE_DEFINITION } from "../src/schema.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true, maxRetries: 3 })));
});

function value<T>(result: { ok: true; value: T } | { ok: false; error: { message: string } }): T {
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

async function setup() {
  const root = await mkdtemp(join(tmpdir(), "vb-timeline-"));
  roots.push(root);
  const engine = createEngine({ rootDir: root, initialBookName: "timeline" });
  await engine.ready;
  return { root, engine };
}

it("persists one full-row timeline, rejects collisions and preserves the shared sequence on removal", async () => {
  const { engine, root } = await setup();
  const notebook = value(await engine.notebooks.create("Main"));
  const timeline = engine.notebooks.createCell({ type: "timeline", slot: { row: 1, column: 0 } });
  value(await engine.notebooks.insertCell(notebook.id, timeline));
  const sequence = engine.sequences.getPrimary();
  for (let column = 0; column < 8; column++) {
    const cell = engine.notebooks.createCell({ type: "video", slot: { row: 1, column } });
    const head = engine.head;
    expect((await engine.notebooks.insertCell(notebook.id, cell)).ok).toBe(false);
    expect(engine.head).toBe(head);
  }
  expect((await engine.notebooks.insertCell(notebook.id, engine.notebooks.createCell({
    type: "timeline", slot: { row: 2, column: 0 },
  }))).ok).toBe(false);
  expect((await engine.notebooks.moveCell(notebook.id, timeline.id, { row: 2, column: 1 })).ok).toBe(false);
  const occupied = notebookOccupiedSlots([timeline]);
  expect(occupied).toHaveLength(8);
  expect(firstEmptyNotebookGridRow([{ row: 0, column: 7 }, ...occupied])).toEqual({ row: 2, column: 0 });
  engine.close();
  const reopened = createEngine({ rootDir: root });
  await reopened.ready;
  expect(value(reopened.notebooks.read(notebook.id)).cells).toMatchObject([timeline]);
  value(await reopened.notebooks.removeCell(notebook.id, timeline.id));
  expect(reopened.sequences.getPrimary().clips).toEqual(sequence.clips);
  expect(reopened.sequences.getPrimary().sequenceId).toBe(sequence.sequenceId);
  value(await reopened.notebooks.insertCell(notebook.id, timeline));
  reopened.close();
});

it("upgrades an actual schema-25 cells constraint without losing cells, edges or history", async () => {
  const { root, engine } = await setup();
  const notebook = value(await engine.notebooks.create("Main"));
  const a = engine.notebooks.createCell({ type: "image", slot: { row: 0, column: 0 } });
  const b = engine.notebooks.createCell({ type: "generate_video", slot: { row: 1, column: 0 } });
  const edge = engine.notebooks.createEdge({ source: a.id, target: b.id, targetInput: "image" });
  value(await engine.notebooks.write({ ...notebook, cells: [a, b], edges: [edge] }));
  engine.close();
  const db = new DatabaseSync(join(root, "data", "videobook.db"));
  db.exec("PRAGMA foreign_keys=OFF");
  db.exec(`CREATE TABLE cells_old (${CELLS_TABLE_DEFINITION.replace(",'timeline'", "")})`);
  db.exec("INSERT INTO cells_old SELECT * FROM cells");
  db.exec("DROP TABLE cells");
  db.exec("ALTER TABLE cells_old RENAME TO cells");
  db.exec("UPDATE engine_schema SET version=25 WHERE singleton=1");
  for (const table of ["cells", "engine_schema"]) db.prepare("SELECT dolt_add(?)").get(table);
  db.prepare("SELECT dolt_commit('-m', 'legacy schema 25', '--author', 'Test <test@example.test>')").get();
  db.close();
  const upgraded = createEngine({ rootDir: root });
  await upgraded.ready;
  expect(value(upgraded.notebooks.read(notebook.id))).toMatchObject({ cells: [a, b], edges: [edge] });
  expect(upgraded.notebooks.cellHistory(notebook.id, a.id).length).toBeGreaterThan(0);
  value(await upgraded.notebooks.insertCell(notebook.id, upgraded.notebooks.createCell({
    type: "timeline", slot: { row: 2, column: 0 },
  })));
  const head = upgraded.head;
  upgraded.close();
  const again = createEngine({ rootDir: root });
  await again.ready;
  expect(again.head).toBe(head);
  expect(value(again.notebooks.read(notebook.id)).cells).toHaveLength(3);
  again.close();
});
