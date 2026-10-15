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
  const root = await mkdtemp(join(tmpdir(), "vb-post-"));
  roots.push(root);
  const engine = createEngine({ rootDir: root, initialBookName: "posts" });
  await engine.ready;
  return { root, engine };
}

it("persists inert publication cells and preserves runtime receipts through undo", async () => {
  const { engine, root } = await setup();
  const notebook = value(await engine.notebooks.create("Main"));
  const source = engine.notebooks.createCell({ type: "video", slot: { row: 0, column: 0 } });
  value(await engine.notebooks.insertCell(notebook.id, source));
  const before = engine.head;
  const post = engine.notebooks.createCell({
    type: "post", slot: { row: 0, column: 1 }, label: "Manual post",
    inputs: { version: 1, platform: "tiktok", sourceCellId: source.id },
  });
  const edge = engine.notebooks.createEdge({ source: source.id, target: post.id, targetInput: "post" });
  const document = { ...notebook, cells: [source, post], edges: [edge] };
  value(await engine.notebooks.write(document));
  value(engine.settings.set(`application.post.${post.id}`, { url: "https://example.com/post/1" }));
  const head = engine.head;
  for (const invalid of [
    { ...post, tool: "post" },
    { ...post, operation: "publish" },
  ]) {
    expect((await engine.notebooks.write({ ...document, cells: [source, invalid] })).ok).toBe(false);
  }
  for (const invalid of [
    { ...edge, targetInput: "image" },
    { ...edge, source: post.id, target: source.id },
  ]) {
    expect((await engine.notebooks.write({ ...document, edges: [invalid] })).ok).toBe(false);
  }
  expect(engine.head).toBe(head);
  value(await engine.history.restore(before));
  expect(engine.settings.get(`application.post.${post.id}`)).toEqual({ url: "https://example.com/post/1" });
  value(await engine.history.restore(head));
  engine.close();
  const reopened = createEngine({ rootDir: root });
  await reopened.ready;
  expect(value(reopened.notebooks.read(notebook.id))).toMatchObject({ cells: [source, post], edges: [edge] });
  reopened.close();
});

it("upgrades a schema-27 cell constraint without changing legacy X cells or their history", async () => {
  const { root, engine } = await setup();
  const notebook = value(await engine.notebooks.create("Main"));
  const source = engine.notebooks.createCell({ type: "video", slot: { row: 0, column: 0 } });
  const legacy = engine.notebooks.createCell({
    type: "video", slot: { row: 0, column: 1 },
    inputs: { sourceOperation: "post_to_x", sourceCellId: source.id, tweetId: "123" },
  });
  const edge = engine.notebooks.createEdge({ source: source.id, target: legacy.id, targetInput: "post" });
  value(await engine.notebooks.write({ ...notebook, cells: [source, legacy], edges: [edge] }));
  engine.close();
  const db = new DatabaseSync(join(root, "data", "videobook.db"));
  db.exec("PRAGMA foreign_keys=OFF");
  db.exec(`CREATE TABLE cells_old (${CELLS_TABLE_DEFINITION.replace(",'post'", "")})`);
  db.exec("INSERT INTO cells_old SELECT * FROM cells");
  db.exec("DROP TABLE cells");
  db.exec("ALTER TABLE cells_old RENAME TO cells");
  db.exec("UPDATE engine_schema SET version=27 WHERE singleton=1");
  for (const table of ["cells", "engine_schema"]) db.prepare("SELECT dolt_add(?)").get(table);
  db.prepare("SELECT dolt_commit('-m', 'legacy schema 27', '--author', 'Test <test@example.test>')").get();
  db.close();
  const upgraded = createEngine({ rootDir: root });
  await upgraded.ready;
  expect(value(upgraded.notebooks.read(notebook.id))).toMatchObject({ cells: [source, legacy], edges: [edge] });
  expect(upgraded.notebooks.cellHistory(notebook.id, legacy.id).length).toBeGreaterThan(0);
  value(await upgraded.notebooks.write({ ...notebook, cells: [source, { ...legacy, type: "post" }], edges: [edge] }));
  const head = upgraded.head;
  upgraded.close();
  const reopened = createEngine({ rootDir: root });
  await reopened.ready;
  expect(reopened.head).toBe(head);
  expect(value(reopened.notebooks.read(notebook.id)).cells[1]?.type).toBe("post");
  reopened.close();
});


it("retains publication media pinned by runtime receipts after semantic undo", async () => {
  const { engine } = await setup();
  const before = engine.head;
  const artifact = value(await engine.artifacts.create("video", "Publication"));
  value(await engine.files.write(artifact.artifactId, "clip.mp4", Buffer.from("published bytes")));
  const revision = engine.head;
  const file = value(await engine.files.manifest(artifact.artifactId)).files[0]!;
  value(engine.settings.set("application.post.receipt", { media: { objectHash: file.objectHash } }));
  value(await engine.history.restore(before));
  const removed = await engine.storage.deleteObject(file.objectHash);
  expect(removed.ok).toBe(false);
  expect(value(await engine.files.readAtRevision(artifact.artifactId, "clip.mp4", revision)).toString()).toBe("published bytes");
  engine.close();
});
