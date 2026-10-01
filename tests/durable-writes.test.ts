import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createEngine, type Engine } from "../src/index.js";
import { DoltStore } from "../src/store.js";

const roots: string[] = [];
const engines: Engine[] = [];

afterEach(async () => {
  for (const engine of engines.splice(0)) {
    try {
      engine.close();
    } catch {
      // already closed
    }
  }
  await Promise.all(
    roots.splice(0).map((root) =>
      rm(root, { recursive: true, force: true, maxRetries: 5 }),
    ),
  );
});

function synchronousMode(store: DoltStore): number {
  const row = store.db
    .prepare("PRAGMA synchronous")
    .get() as { synchronous: number };
  store.close();
  return row.synchronous;
}

function openStore(dir: string, durableWrites?: boolean): DoltStore {
  return new DoltStore({
    dataDir: path.join(dir, "data"),
    workspaceDir: path.join(dir, "workspaces"),
    initialBook: { bookId: "01900000-0000-7000-8000-00000000000f", name: "durable" },
    ...(durableWrites === undefined ? {} : { durableWrites }),
  });
}

describe("durableWrites", () => {
  it("keeps synchronous = FULL by default", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "engine-durable-full-"));
    roots.push(dir);
    expect(synchronousMode(openStore(dir))).toBe(2);
  });

  it("relaxes the catalog to synchronous = NORMAL when disabled", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "engine-durable-normal-"));
    roots.push(dir);
    expect(synchronousMode(openStore(dir, false))).toBe(1);
  });

  it("still commits and reads back writes with durability relaxed", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "engine-durable-writes-"));
    roots.push(dir);
    const engine = createEngine({
      rootDir: dir,
      initialBookName: "relaxed",
      durableWrites: false,
    });
    engines.push(engine);
    const created = await engine.notebooks.create("Main");
    if (!created.ok) throw new Error(created.error.message);
    const reopened = createEngine({ rootDir: dir, durableWrites: false });
    engines.push(reopened);
    expect(reopened.notebooks.list().map((notebook) => notebook.name))
      .toContain("Main");
  });
});
