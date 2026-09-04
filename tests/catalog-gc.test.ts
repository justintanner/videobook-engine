import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { performance } from "node:perf_hooks";

import { afterEach, describe, expect, it } from "vitest";

import { createEngine, type Engine } from "../src/index.js";
import type { CatalogGcConfig, CatalogIntegritySnapshot } from "../src/engine-types.js";

const roots: string[] = [];
const engines: Engine[] = [];
const CHURN_WRITES = 2_000;
const REOPEN_BUDGET_MS = 200;
const SIZE_BOUND_BYTES = 16 * 1024 * 1024;

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

function value<T>(
  result: { ok: true; value: T } | { ok: false; error: { message: string } },
): T {
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

async function setup(
  name = "catalog-gc",
  catalogGc?: CatalogGcConfig,
): Promise<{ engine: Engine; root: string; dataDir: string }> {
  const root = await mkdtemp(path.join(tmpdir(), "videobook-catalog-gc-"));
  roots.push(root);
  const dataDir = path.join(root, "data");
  const engine = createEngine({
    dataDir,
    workspaceDir: path.join(root, "workspace"),
    initialBookName: name,
    ...(catalogGc ? { catalogGc } : {}),
  });
  engines.push(engine);
  return { engine, root, dataDir };
}

function reopen(
  dataDir: string,
  workspaceDir: string,
  catalogGc?: CatalogGcConfig,
): { engine: Engine; openMs: number } {
  const t0 = performance.now();
  const engine = createEngine({
    dataDir,
    workspaceDir,
    ...(catalogGc ? { catalogGc } : {}),
  });
  engines.push(engine);
  return { engine, openMs: performance.now() - t0 };
}

function catalogPath(dataDir: string): string {
  return path.join(dataDir, "videobook.db");
}

async function catalogBytes(dataDir: string): Promise<number> {
  return (await stat(catalogPath(dataDir))).size;
}

function churnRuntimeJobs(engine: Engine, writes = CHURN_WRITES): void {
  for (let index = 0; index < writes; index += 1) {
    engine.jobs.queue.enqueue({
      type: "catalog-gc-churn",
      payload: { index },
      maxAttempts: 3,
    });
    const leased = engine.jobs.queue.dequeue(1, 30_000);
    if (!leased) continue;
    engine.jobs.queue.heartbeat(leased.id, leased.fence, 30_000);
  }
}

function stripVolatile(snapshot: CatalogIntegritySnapshot): CatalogIntegritySnapshot {
  return snapshot;
}

describe("catalog dolt_gc", () => {
  it(
    "keeps a churned catalog size-bounded and reopening under 200 ms",
    { timeout: 60_000 },
    async () => {
      const { engine, dataDir, root } = await setup();
      churnRuntimeJobs(engine);
      engine.close();
      expect(engine.lastCatalogGc?.trigger).toBe("close");
      expect(await catalogBytes(dataDir)).toBeLessThan(SIZE_BOUND_BYTES);

      const { engine: again, openMs } = reopen(
        dataDir,
        path.join(root, "workspace"),
      );
      expect(openMs).toBeLessThan(REOPEN_BUDGET_MS);
      expect(await catalogBytes(dataDir)).toBeLessThan(SIZE_BOUND_BYTES);
      again.close();
    },
  );

  it(
    "leaves head, history, book, artifacts, notebooks, status, and row counts identical",
    { timeout: 60_000 },
    async () => {
      const { engine, dataDir, root } = await setup("integrity");
      value(
        await engine.artifacts.create({ kind: "video", label: "clip" }),
      );
      value(await engine.notebooks.create("Main"));
      churnRuntimeJobs(engine, 200);

      const before = stripVolatile(engine.catalogIntegrity());
      const head = engine.head;
      const report = engine.gcCatalog();
      expect(engine.head).toBe(head);
      expect(report.trigger).toBe("manual");
      expect(stripVolatile(engine.catalogIntegrity())).toEqual(before);

      engine.close();
      const { engine: again } = reopen(dataDir, path.join(root, "workspace"), {
        onClose: false,
      });
      expect(again.head).toBe(head);
      expect(stripVolatile(again.catalogIntegrity())).toEqual(before);
      again.close();
    },
  );

  it("does not mint a commit or dirty the semantic worktree", async () => {
    const { engine, dataDir, root } = await setup("clean-gc");
    value(
      await engine.artifacts.create({ kind: "image", label: "still" }),
    );
    const head = engine.head;
    const before = engine.catalogIntegrity();
    const report = engine.gcCatalog();
    expect(report.summary).toMatch(/chunks/i);
    expect(engine.head).toBe(head);
    expect(engine.catalogIntegrity()).toEqual(before);

    engine.close();
    const { engine: again } = reopen(dataDir, path.join(root, "workspace"), {
      onClose: false,
    });
    expect(again.head).toBe(head);
    expect(again.catalogIntegrity()).toEqual(before);
    value(
      await again.artifacts.create({ kind: "audio", label: "after-gc" }),
    );
    again.close();
  });

  it("GCs a bloated catalog at open before preparing statements", async () => {
    const { engine, dataDir, root } = await setup("open-gc", { onClose: false });
    churnRuntimeJobs(engine, 400);
    expect(engine.lastCatalogGc).toBeUndefined();
    engine.close();
    expect(engine.lastCatalogGc).toBeUndefined();

    const { engine: again } = reopen(dataDir, path.join(root, "workspace"), {
      bytesThreshold: 1,
      onClose: false,
    });
    expect(again.lastCatalogGc?.trigger).toBe("open");
    expect(again.lastCatalogGc?.summary).toMatch(/chunks/i);
    again.close();
  });
});
