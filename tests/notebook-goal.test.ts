import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "@dolthub/doltlite";
import { afterEach, expect, it } from "vitest";
import { createEngine } from "../src/index.js";
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
  const root = await mkdtemp(join(tmpdir(), "vb-goal-"));
  roots.push(root);
  const engine = createEngine({ rootDir: root, initialBookName: "goal" });
  await engine.ready;
  return { root, engine };
}

const plan = {
  goalId: "0199a6f0-0000-7000-8000-000000000001",
  revision: 1,
  plan: { title: "Rainy commute", shots: [{ title: "Umbrella", prompt: "He rides through the rain.", durationSeconds: 10 }] },
};

it("saves a plan in an inert goal cell that cannot execute or connect", async () => {
  const { engine, root } = await setup();
  const notebook = value(await engine.notebooks.create("Main"));
  const goal = engine.notebooks.createCell({
    type: "goal", label: "Rainy commute", prompt: "A rainy commute, three 10s clips",
    slot: { row: 0, column: 2 }, inputs: plan,
  });
  value(await engine.notebooks.insertCell(notebook.id, goal));
  const image = engine.notebooks.createCell({ type: "image", slot: { row: 0, column: 0 } });
  value(await engine.notebooks.insertCell(notebook.id, image));
  const head = engine.head;
  expect((await engine.notebooks.insertCell(notebook.id, engine.notebooks.createCell({
    type: "goal", tool: "video_goal", slot: { row: 1, column: 0 },
  }))).ok).toBe(false);
  const current = value(engine.notebooks.read(notebook.id));
  for (const edge of [
    engine.notebooks.createEdge({ source: image.id, target: goal.id, targetInput: "input" }),
    engine.notebooks.createEdge({ source: goal.id, target: image.id, targetInput: "input" }),
  ]) {
    expect((await engine.notebooks.write({ ...current, edges: [edge] })).ok).toBe(false);
  }
  expect(engine.head).toBe(head);
  engine.close();
  const reopened = createEngine({ rootDir: root });
  await reopened.ready;
  expect(value(reopened.notebooks.read(notebook.id)).cells).toMatchObject([
    { id: image.id, type: "image" },
    { id: goal.id, type: "goal", label: "Rainy commute", prompt: "A rainy commute, three 10s clips", inputs: plan },
  ]);
  reopened.close();
});

it("upgrades an actual schema-26 cells constraint without losing cells, edges or history", async () => {
  const { root, engine } = await setup();
  const notebook = value(await engine.notebooks.create("Main"));
  const a = engine.notebooks.createCell({ type: "image", slot: { row: 0, column: 0 } });
  const b = engine.notebooks.createCell({ type: "generate_video", slot: { row: 1, column: 0 } });
  const timeline = engine.notebooks.createCell({ type: "timeline", slot: { row: 2, column: 0 } });
  const edge = engine.notebooks.createEdge({ source: a.id, target: b.id, targetInput: "image" });
  value(await engine.notebooks.write({ ...notebook, cells: [a, b, timeline], edges: [edge] }));
  engine.close();
  const db = new DatabaseSync(join(root, "data", "videobook.db"));
  db.exec("PRAGMA foreign_keys=OFF");
  db.exec(`CREATE TABLE cells_old (${CELLS_TABLE_DEFINITION.replace(",'goal'", "")})`);
  db.exec("INSERT INTO cells_old SELECT * FROM cells");
  db.exec("DROP TABLE cells");
  db.exec("ALTER TABLE cells_old RENAME TO cells");
  db.exec("UPDATE engine_schema SET version=26 WHERE singleton=1");
  for (const table of ["cells", "engine_schema"]) db.prepare("SELECT dolt_add(?)").get(table);
  db.prepare("SELECT dolt_commit('-m', 'legacy schema 26', '--author', 'Test <test@example.test>')").get();
  db.close();
  const upgraded = createEngine({ rootDir: root });
  await upgraded.ready;
  expect(value(upgraded.notebooks.read(notebook.id))).toMatchObject({ cells: [a, b, timeline], edges: [edge] });
  expect(upgraded.notebooks.cellHistory(notebook.id, a.id).length).toBeGreaterThan(0);
  value(await upgraded.notebooks.insertCell(notebook.id, upgraded.notebooks.createCell({
    type: "goal", slot: { row: 0, column: 1 }, inputs: plan,
  })));
  const head = upgraded.head;
  upgraded.close();
  const again = createEngine({ rootDir: root });
  await again.ready;
  expect(again.head).toBe(head);
  expect(value(again.notebooks.read(notebook.id)).cells).toHaveLength(4);
  again.close();
});
