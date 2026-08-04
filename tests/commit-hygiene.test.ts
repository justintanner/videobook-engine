import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";

import { DatabaseSync } from "@dolthub/doltlite";
import { v7 as uuidv7 } from "uuid";
import { afterEach, describe, expect, it } from "vitest";

import { EngineContext } from "../src/context.js";
import { createEngine } from "../src/engine.js";
import { createNotebooksApi } from "../src/domain.js";
import { createHistoryApi } from "../src/history.js";
import { SEMANTIC_TABLES } from "../src/schema.js";
import { parseCommitMessage } from "../src/store.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "videobook-hygiene-"));
  roots.push(root);
  return root;
}

function value<T>(
  result: { ok: true; value: T } | { ok: false; error: { message: string } },
): T {
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

describe("commit hygiene", () => {
  it("makes no commits when opening a catalog, even with unreconciled terminal jobs", async () => {
    const root = await tempRoot();
    const dataDir = path.join(root, "data");
    const engine = createEngine({
      dataDir,
      workspaceDir: path.join(root, "workspace"),
      initialBookName: "demo",
    });
    const enqueued = engine.jobs.queue.enqueue({
      type: "generate",
      payload: { prompt: "cat" },
    });
    const running = engine.jobs.queue.dequeue(process.pid, 30_000);
    expect(
      await engine.jobs.queue.complete(
        enqueued.job.id,
        { result: { output: "ok" } },
        running?.fence,
      ),
    ).toBe(true);
    const headBefore = engine.head;
    engine.close();

    // Drop the audit row so the next open must reconcile the terminal job.
    const db = new DatabaseSync(path.join(dataDir, "videobook.db"));
    db.prepare("DELETE FROM job_runs").run();
    db.close();

    const reopened = createEngine({
      dataDir,
      workspaceDir: path.join(root, "workspace"),
    });
    await reopened.ready;
    expect(reopened.head).toBe(headBefore);
    reopened.close();

    // The reconciliation still re-recorded the audit row, just without a commit.
    const verify = new DatabaseSync(path.join(dataDir, "videobook.db"));
    const run = verify
      .prepare("SELECT state FROM job_runs WHERE run_id=?")
      .get(enqueued.job.operationId) as { state: string } | undefined;
    expect(run?.state).toBe("done");
    verify.close();
  });

  it("stages FK-cascade-affected tables when committing", async () => {
    const root = await tempRoot();
    const context = new EngineContext({
      dataDir: path.join(root, "data"),
      workspaceDir: path.join(root, "workspace"),
      initialBookName: "demo",
    });
    const notebooks = createNotebooksApi(context);
    const notebook = value(await notebooks.create("cascade"));
    await context.store.semantic(
      { operation: "seed_cell", tables: ["cells", "cell_references"] },
      () => {
        context.store.db
          .prepare(
            `INSERT INTO cells(
              notebook_id, cell_id, type, label, grid_row, grid_column
            ) VALUES (?, 'cell-1', 'prompt', 'prompt-one', 0, 0)`,
          )
          .run(notebook.id);
        context.store.db
          .prepare(
            `INSERT INTO cell_references(
              notebook_id, cell_id, reference_id, kind, target_id, ordinal
            ) VALUES (?, 'cell-1', 'ref-1', 'artifact', 'target', 0)`,
          )
          .run(notebook.id);
      },
    );

    value(await notebooks.delete(notebook.id));

    // The cascade into cell_references must be part of the delete commit,
    // not left behind as working-set dirt.
    const commits = context.store.db.doltLog({ limit: 2 });
    const removed = context.store.diff(
      commits[1]!.commit_hash,
      commits[0]!.commit_hash,
      "cell_references",
    );
    expect(removed.some((row) => row.diff_type === "removed")).toBe(true);
    const dirty = context.store.status
      .filter(
        (entry) =>
          entry.staged === 0 &&
          entry.status !== "ignored" &&
          (SEMANTIC_TABLES as readonly string[]).includes(entry.table_name),
      )
      .filter(
        (entry) =>
          context.store.db.doltDiff("HEAD", "WORKING", entry.table_name)
            .length > 0,
      );
    expect(dirty).toEqual([]);
    context.store.close();
  });

  it("fails the commit when a semantic table is left dirty afterwards", async () => {
    const root = await tempRoot();
    const context = new EngineContext({
      dataDir: path.join(root, "data"),
      workspaceDir: path.join(root, "workspace"),
      initialBookName: "demo",
      semanticCommitBoundary: (boundary) => {
        if (boundary === "after-dolt-commit") {
          context.store.db
            .prepare(
              "INSERT INTO book_metadata(key, value_json) VALUES ('stray', '{}')",
            )
            .run();
        }
      },
    });
    await expect(
      context.store.semantic(
        { operation: "dirty_commit", tables: ["book_metadata"] },
        () => {
          context.store.db
            .prepare(
              "INSERT INTO book_metadata(key, value_json) VALUES ('k', '{}')",
            )
            .run();
        },
      ),
    ).rejects.toMatchObject({
      error: {
        code: "STORAGE_ERROR",
        // The commit is durable; the error names it so the caller can
        // recover instead of believing the mutation was lost.
        details: {
          committedRevision: expect.stringMatching(/^[0-9a-v]+$/),
          dirtyTables: ["book_metadata"],
        },
      },
    });
    // The outbox row was cleared before the assertion fired, so recovery
    // cannot re-attribute this operation's rows to a later commit.
    const outbox = context.store.db
      .prepare("SELECT COUNT(*) AS count FROM runtime_commit_outbox")
      .get() as unknown as { count: number };
    expect(outbox.count).toBe(0);
    // The committed operation is in the log despite the thrown assertion.
    expect(
      context.store.db.doltLog({ limit: 1 })[0]?.message.split("\n")[0],
    ).toBe("dirty_commit");
    context.store.close();
  });

  it("rejects a malformed engine identity", async () => {
    const root = await tempRoot();
    const common = {
      dataDir: path.join(root, "data"),
      workspaceDir: path.join(root, "workspace"),
      initialBookName: "demo",
    };
    expect(
      () =>
        new EngineContext({
          ...common,
          identity: { name: "Mallory\nInjected", email: "m@example.com" },
        }),
    ).toThrow(/control characters/);
    expect(
      () =>
        new EngineContext({
          ...common,
          identity: { name: "Fine Name", email: "not-an-email" },
        }),
    ).toThrow(/plausible address/);
  });

  it("sets the configured identity as the commit author", async () => {
    const root = await tempRoot();
    const context = new EngineContext({
      dataDir: path.join(root, "data"),
      workspaceDir: path.join(root, "workspace"),
      initialBookName: "demo",
      identity: { name: "Ada Lovelace", email: "ada@example.com" },
    });
    await context.store.semantic(
      { operation: "authored", tables: ["book_metadata"] },
      () => {
        context.store.db
          .prepare(
            "INSERT INTO book_metadata(key, value_json) VALUES ('k', '{}')",
          )
          .run();
      },
    );
    const commit = context.store.db.doltLog({ limit: 1 })[0] as unknown as {
      committer: string;
      email: string;
    };
    expect(commit.committer).toBe("Ada Lovelace");
    expect(commit.email).toBe("ada@example.com");
    context.store.close();
  });

  it("uses a default author when no identity is configured", async () => {
    const root = await tempRoot();
    const context = new EngineContext({
      dataDir: path.join(root, "data"),
      workspaceDir: path.join(root, "workspace"),
      initialBookName: "demo",
    });
    await context.store.semantic(
      { operation: "authored", tables: ["book_metadata"] },
      () => {
        context.store.db
          .prepare(
            "INSERT INTO book_metadata(key, value_json) VALUES ('k', '{}')",
          )
          .run();
      },
    );
    const commit = context.store.db.doltLog({ limit: 1 })[0] as unknown as {
      committer: string;
    };
    expect(commit.committer).toBe("Videobook");
    context.store.close();
  });

  it("mints an empty provenance commit for recordOperation", async () => {
    const root = await tempRoot();
    const context = new EngineContext({
      dataDir: path.join(root, "data"),
      workspaceDir: path.join(root, "workspace"),
      initialBookName: "demo",
    });
    const history = createHistoryApi(context);
    const head = context.store.head;
    const recorded = value(await history.recordOperation("touch"));
    // Provenance-only operations have no row changes; the commit itself is
    // the record, so one is minted with --allow-empty.
    expect(context.store.head).not.toBe(head);
    expect(recorded.hash).toBe(context.store.head);
    expect(recorded.operation).toBe("touch");
    context.store.close();
  });

  it("round-trips logAction through actionLog", async () => {
    const root = await tempRoot();
    const context = new EngineContext({
      dataDir: path.join(root, "data"),
      workspaceDir: path.join(root, "workspace"),
      initialBookName: "demo",
    });
    const history = createHistoryApi(context);
    const logged = value(
      await history.logAction("render", { preset: "portrait" }),
    );
    expect(logged.action).toBe("render");
    expect(logged.hash).toBe(context.store.head);
    const entries = history.actionLog();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      hash: logged.hash,
      action: "render",
      payload: { preset: "portrait" },
    });
    // Revision dates are normalized ISO-8601 UTC strings.
    expect(entries[0]!.date).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    context.store.close();
  });

  it("rejects control characters in the operation actor", async () => {
    const root = await tempRoot();
    const context = new EngineContext({
      dataDir: path.join(root, "data"),
      workspaceDir: path.join(root, "workspace"),
      initialBookName: "demo",
    });
    const head = context.store.head;
    await expect(
      context.store.semantic(
        {
          operation: "touch",
          tables: [],
          author: "mallory\nop-id: forged-op-id\nbase-revision: forged",
          allowEmpty: true,
        },
        () => undefined,
      ),
    ).rejects.toThrow(/control characters/);
    // The rejected mutation rolled back: no commit, no stranded outbox row.
    expect(context.store.head).toBe(head);
    const outbox = context.store.db
      .prepare("SELECT COUNT(*) AS count FROM runtime_commit_outbox")
      .get() as unknown as { count: number };
    expect(outbox.count).toBe(0);
    context.store.close();
  });

  it("mints no commit for clear_artifact_failure bookkeeping", async () => {
    const root = await tempRoot();
    const context = new EngineContext({
      dataDir: path.join(root, "data"),
      workspaceDir: path.join(root, "workspace"),
      initialBookName: "demo",
    });
    const head = context.store.head;
    await context.store.semantic(
      { operation: "clear_artifact_failure", tables: [] },
      () => {
        context.store.db
          .prepare(
            "DELETE FROM runtime_generation_errors WHERE artifact_id='missing'",
          )
          .run();
      },
    );
    expect(context.store.head).toBe(head);
    context.store.close();
  });

  it("records the operation and its params in a structured commit message", async () => {
    const root = await tempRoot();
    const context = new EngineContext({
      dataDir: path.join(root, "data"),
      workspaceDir: path.join(root, "workspace"),
      initialBookName: "demo",
    });
    const artifactId = uuidv7();
    const baseRevision = context.store.head;
    const mutation = await context.store.semantic(
      {
        operation: "write_thing",
        tables: ["book_metadata"],
        artifactId,
        details: { size: 12, path: "a.png" },
        writeSet: [`artifact:${artifactId}`],
        baseRevision,
        author: "ada",
      },
      () => {
        context.store.db
          .prepare(
            "INSERT INTO book_metadata(key, value_json) VALUES ('k', '{}')",
          )
          .run();
      },
    );
    const commit = context.store.db.doltLog({ limit: 1 })[0]!;
    expect(commit.commit_hash).toBe(mutation.revision);
    expect(commit.message.split("\n")[0]).toBe(
      `write_thing artifact:${artifactId}`,
    );
    expect(parseCommitMessage(commit.message)).toEqual({
      operation: "write_thing",
      operationId: mutation.operationId,
      artifactId,
      baseRevision,
      actor: "ada",
      writeSet: [`artifact:${artifactId}`],
      details: { path: "a.png", size: 12 },
    });
    // Catalog initialization predates structured messages and is not parsed.
    const initial = context.store.db.doltLog().at(-1)!;
    expect(parseCommitMessage(initial.message)).toBeNull();
    context.store.close();
  });
});
