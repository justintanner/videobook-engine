import { existsSync, statSync } from "node:fs";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";

import { DatabaseSync, type StatementSync } from "@dolthub/doltlite";
import { afterEach, describe, expect, it } from "vitest";

import { closeCatalogDatabase } from "../src/catalog-close.js";
import { isCatalogCompacted } from "../src/catalog-gc-state.js";
import type { EngineContext } from "../src/context.js";
import { createEngine, type Engine } from "../src/engine.js";

setFlagsFromString("--expose-gc");
const collectGarbage = runInNewContext("gc") as () => void;
setFlagsFromString("--no-expose-gc");

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "vb-catalog-close-"));
  roots.push(root);
  return root;
}

function value<T>(
  result:
    | { ok: true; value: T; revision?: string }
    | { ok: false; error: { message: string } },
): T {
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

function storeOf(engine: Engine): EngineContext["store"] {
  return (engine as unknown as { context: EngineContext }).context.store;
}

function catalogOf(engine: Engine): DatabaseSync {
  return storeOf(engine).db;
}

/**
 * Keep one statement alive across a close, which is what defers the native
 * close. It lives in this frame, not the test's, so no stale register of a
 * suspended async function can keep it reachable after release().
 */
function holdStatement(db: DatabaseSync): {
  release(): void;
  finalized(): boolean;
} {
  let statement: StatementSync | undefined = db.prepare(
    "SELECT name FROM sqlite_schema LIMIT 1",
  );
  statement.all();
  const weak = new WeakRef(statement);
  return {
    release: () => {
      statement = undefined;
    },
    finalized: () => weak.deref() === undefined,
  };
}

/** N-API defers the destructor that finalizes a statement to an immediate. */
async function finalizeUnreachableStatements(): Promise<void> {
  for (let pass = 0; pass < 3; pass += 1) {
    collectGarbage();
    await new Promise((resolve) => setImmediate(resolve));
  }
}

/**
 * Removes what is in the directory but not the directory, which must exist for
 * a late close to be able to create a file in it.
 */
async function emptyDirectory(directory: string): Promise<void> {
  for (const name of await readdir(directory)) {
    await rm(path.join(directory, name), { recursive: true, force: true });
  }
  expect(await readdir(directory)).toEqual([]);
}

/** Open, prepare, close, remove, force a GC: what is left in the directory? */
async function filesLeftAfterRemoval(
  directory: string,
  db: DatabaseSync,
  close: () => void,
): Promise<string[]> {
  const held = holdStatement(db);
  close();
  await emptyDirectory(directory);
  held.release();
  await finalizeUnreachableStatements();
  expect(held.finalized()).toBe(true);
  return readdir(directory);
}

function seedCatalog(databasePath: string): DatabaseSync {
  const db = new DatabaseSync(databasePath);
  db.exec("CREATE TABLE seeds (id INTEGER PRIMARY KEY)");
  db.exec("INSERT INTO seeds VALUES (1)");
  db.doltCommit("seed");
  return db;
}

function fingerprint(file: string): string {
  const stat = statSync(file, { bigint: true });
  return [stat.size, stat.mtimeNs].join(":");
}

describe("a closed catalog connection", () => {
  // If this stops holding after a DoltLite change, finalization or the deferred
  // close changed upstream and closeCatalogDatabase may no longer be needed.
  it("recreates the lock file when closed natively with a live statement", async () => {
    const root = await tempRoot();
    const db = seedCatalog(path.join(root, "videobook.db"));

    expect(await filesLeftAfterRemoval(root, db, () => db.close())).toEqual([
      ".videobook.db-lock",
    ]);
  });

  it("leaves nothing behind when closed with closeCatalogDatabase", async () => {
    const root = await tempRoot();
    const db = seedCatalog(path.join(root, "videobook.db"));

    expect(
      await filesLeftAfterRemoval(root, db, () => closeCatalogDatabase(db)),
    ).toEqual([]);
  });

  it("leaves nothing behind with uncommitted working changes", async () => {
    const root = await tempRoot();
    const db = seedCatalog(path.join(root, "videobook.db"));
    db.exec("INSERT INTO seeds VALUES (2)");

    expect(
      await filesLeftAfterRemoval(root, db, () => closeCatalogDatabase(db)),
    ).toEqual([]);
  });

  it("does not change the catalog file after close returns", async () => {
    const root = await tempRoot();
    const databasePath = path.join(root, "videobook.db");
    const db = seedCatalog(databasePath);
    const held = holdStatement(db);

    closeCatalogDatabase(db);
    const closed = fingerprint(databasePath);
    held.release();
    await finalizeUnreachableStatements();

    expect(held.finalized()).toBe(true);
    expect(fingerprint(databasePath)).toBe(closed);
  });

  it("does not create a catalog that has gone missing", async () => {
    const root = await tempRoot();
    const databasePath = path.join(root, "videobook.db");
    const db = seedCatalog(databasePath);
    await rm(databasePath);

    closeCatalogDatabase(db);

    expect(db.isOpen).toBe(false);
    expect(existsSync(databasePath)).toBe(false);
  });

  // A deferred close would otherwise hold the write lock until collection.
  it("rolls back an open transaction before a live statement can defer it", async () => {
    const root = await tempRoot();
    const databasePath = path.join(root, "videobook.db");
    const db = seedCatalog(databasePath);
    const held = holdStatement(db);
    db.exec("BEGIN IMMEDIATE");
    db.exec("INSERT INTO seeds VALUES (2)");

    closeCatalogDatabase(db);

    expect(db.isOpen).toBe(false);
    const reopened = new DatabaseSync(databasePath);
    reopened.exec("PRAGMA busy_timeout = 0");
    reopened.exec("INSERT INTO seeds VALUES (3)");
    expect(reopened.prepare("SELECT id FROM seeds ORDER BY id").all()).toEqual([
      { id: 1 },
      { id: 3 },
    ]);
    closeCatalogDatabase(reopened);
    held.release();
  });

  it("closes an in-memory connection and tolerates a second close", () => {
    const db = new DatabaseSync(":memory:");

    closeCatalogDatabase(db);
    closeCatalogDatabase(db);

    expect(db.isOpen).toBe(false);
  });
});

describe("engine.close", () => {
  async function setup(catalogGc?: { onClose: boolean }): Promise<{
    engine: Engine;
    open: () => Engine;
    dataDir: string;
  }> {
    const root = await tempRoot();
    const dataDir = path.join(root, "data");
    const workspaceDir = path.join(root, "workspace");
    const engine = createEngine({
      dataDir,
      workspaceDir,
      initialBookName: "close-demo",
      ...(catalogGc ? { catalogGc } : {}),
    });
    await engine.ready;
    return {
      engine,
      open: () =>
        createEngine({
          dataDir,
          workspaceDir,
          ...(catalogGc ? { catalogGc } : {}),
        }),
      dataDir,
    };
  }

  // The shape of the CI failure on tests/generations.test.ts. Open used to commit
  // a bare root here, and close-time GC then had nothing to remove.
  it("leaves nothing behind after a reopened session with no writes", async () => {
    const { engine, open, dataDir } = await setup();
    value(await engine.notebooks.create("written before the reopen"));
    engine.close();
    const reopened = open();
    await reopened.ready;

    expect(
      await filesLeftAfterRemoval(dataDir, catalogOf(reopened), () =>
        reopened.close(),
      ),
    ).toEqual([]);
  });

  it("leaves nothing behind after writes compacted at close", async () => {
    const { engine, dataDir } = await setup();
    value(await engine.notebooks.create("compacted at close"));

    expect(
      await filesLeftAfterRemoval(dataDir, catalogOf(engine), () =>
        engine.close(),
      ),
    ).toEqual([]);
  });

  it("leaves nothing behind after a runtime write with close-time GC disabled", async () => {
    const { engine, dataDir } = await setup({ onClose: false });
    catalogOf(engine)
      .prepare(
        "INSERT INTO runtime_meta(key, value_json, updated_at) VALUES ('close-demo', '1', 1)",
      )
      .run();

    expect(
      await filesLeftAfterRemoval(dataDir, catalogOf(engine), () =>
        engine.close(),
      ),
    ).toEqual([]);
  });

  // The store is content-addressed, so deleting the row returns to chunks it
  // already holds: that commit adds none, and a peer reads it as a marker.
  it("leaves nothing behind after a last commit that added no chunks", async () => {
    const { engine, dataDir } = await setup({ onClose: false });
    const db = catalogOf(engine);
    db.exec(
      "INSERT INTO runtime_meta(key, value_json, updated_at) VALUES ('close-demo', '1', 1)",
    );
    db.exec("DELETE FROM runtime_meta WHERE key='close-demo'");

    expect(
      await filesLeftAfterRemoval(dataDir, db, () => engine.close()),
    ).toEqual([]);
  });

  it("leaves nothing behind after a zero-row write on a compacted catalog", async () => {
    const { engine, open, dataDir } = await setup();
    value(await engine.notebooks.create("compacted at close"));
    engine.close();
    const reopened = open();
    await reopened.ready;
    const store = storeOf(reopened);
    store.runtime(() => {
      store.db.exec("DELETE FROM runtime_jobs");
    });

    expect(
      await filesLeftAfterRemoval(dataDir, store.db, () => reopened.close()),
    ).toEqual([]);
  });

  it("does not write at close after a compaction or without a commit", async () => {
    const { engine, open, dataDir } = await setup();
    value(await engine.notebooks.create("compacted at close"));
    engine.close();
    const reopened = open();
    await reopened.ready;
    reopened.close();

    const catalog = new DatabaseSync(path.join(dataDir, "videobook.db"), {
      readOnly: true,
    });
    expect(
      catalog
        .prepare("SELECT key FROM runtime_meta WHERE key='clean_close'")
        .all(),
    ).toEqual([]);
    catalog.close();
  });

  it("leaves a compacted catalog byte-identical after a session with no writes", async () => {
    const { engine, open, dataDir } = await setup();
    const databasePath = path.join(dataDir, "videobook.db");
    value(await engine.notebooks.create("compacted at close"));
    engine.close();
    await finalizeUnreachableStatements();
    const closed = fingerprint(databasePath);

    const reopened = open();
    await reopened.ready;
    const held = holdStatement(catalogOf(reopened));
    reopened.close();
    held.release();
    await finalizeUnreachableStatements();

    expect(held.finalized()).toBe(true);
    expect(fingerprint(databasePath)).toBe(closed);
  });

  it("keeps the compaction record valid through the deferred close", async () => {
    const { engine, open, dataDir } = await setup();
    const databasePath = path.join(dataDir, "videobook.db");
    value(await engine.notebooks.create("compacted at close"));
    engine.close();
    expect(isCatalogCompacted(databasePath)).toBe(true);
    const reopened = open();
    await reopened.ready;
    const held = holdStatement(catalogOf(reopened));

    reopened.close();
    expect(isCatalogCompacted(databasePath)).toBe(true);
    held.release();
    await finalizeUnreachableStatements();

    expect(held.finalized()).toBe(true);
    expect(isCatalogCompacted(databasePath)).toBe(true);
  });

  it("is not disturbed by a deferred close from an earlier session", async () => {
    const { engine, open } = await setup({ onClose: false });
    value(await engine.notebooks.create("first session"));
    const held = holdStatement(catalogOf(engine));
    engine.close();

    const reopened = open();
    await reopened.ready;
    value(await reopened.notebooks.create("written before the deferred close"));
    held.release();
    await finalizeUnreachableStatements();
    expect(held.finalized()).toBe(true);
    value(await reopened.notebooks.create("written after the deferred close"));
    reopened.close();

    const verified = open();
    await verified.ready;
    expect(verified.notebooks.list().map((notebook) => notebook.name)).toEqual([
      "first session",
      "written before the deferred close",
      "written after the deferred close",
    ]);
    verified.close();
  });
});
