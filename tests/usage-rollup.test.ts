import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "@dolthub/doltlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createEngine } from "../src/engine.js";
import type { Engine } from "../src/engine.js";
import type { UsageInput, UsageRollupTotals, UsageTotals } from "../src/usage.js";

const roots: string[] = [];
const engines: Engine[] = [];
afterEach(async () => {
  for (const engine of engines.splice(0)) engine.close();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true, maxRetries: 3 })));
});

async function setup() {
  const root = await mkdtemp(join(tmpdir(), "vb-usage-rollup-"));
  roots.push(root);
  const engine = createEngine({ rootDir: root, initialBookName: "usage-rollup-test", durableWrites: false });
  engines.push(engine);
  await engine.ready;
  return { root, engine };
}

async function reopen(engine: Engine, root: string) {
  engine.close();
  engines.splice(engines.indexOf(engine), 1);
  const reopened = createEngine({ rootDir: root, durableWrites: false });
  engines.push(reopened);
  await reopened.ready;
  return reopened;
}

function usage(id: string, patch: Partial<UsageInput> = {}): UsageInput {
  return { id, provider: "test", model: "image", activity: "images", ...patch };
}

function write(engine: Engine, input: UsageInput) {
  const result = engine.usage.record(input);
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

const NEW_FIELDS_NULL = {
  estimateUsd: null, estimateSource: null, estimateRateAsOf: null, actualBasis: null, cacheWriteTokens: null,
  listUsd: null, notebookId: null, cellId: null, jobId: null, runId: null,
};

const ZERO_TOTALS: UsageRollupTotals = {
  count: 0, inputTokens: 0, outputTokens: 0, cachedTokens: 0, missingTokens: 0,
  reportedUsd: 0, estimatedUsd: 0, unpriced: 0, pendingCount: 0, pendingUsd: 0,
  actualUsd: 0, estimateUsd: 0, settledEstimateUsd: 0, pendingEstimateUsd: 0, unsettled: 0, unestimated: 0,
};

// The exact table engine 5.7.1 creates, and body_json exactly as it wrote one.
const V5_7_1_TABLE = `
  DROP TABLE runtime_usage;
  CREATE TABLE runtime_usage (
    id TEXT PRIMARY KEY,
    provider TEXT NOT NULL,
    external_id TEXT,
    activity TEXT NOT NULL,
    model TEXT NOT NULL,
    status TEXT NOT NULL,
    basis TEXT NOT NULL,
    input_tokens BIGINT,
    output_tokens BIGINT,
    cached_tokens BIGINT,
    token_based INTEGER NOT NULL,
    cost_nanos BIGINT,
    body_json TEXT NOT NULL,
    created_at BIGINT NOT NULL,
    updated_at BIGINT NOT NULL
  );
  CREATE UNIQUE INDEX runtime_usage_external ON runtime_usage(provider, external_id);
  CREATE INDEX runtime_usage_recent ON runtime_usage(created_at, id);
`;

function v5_7_1Body(id: string, patch: Record<string, unknown>) {
  return {
    activity: "chat", artifactId: null, basis: "reported", cachedTokens: 10, costUsd: 0.02, createdAt: 1000,
    externalId: null, id, inputTokens: 100, model: "gpt", operation: "chat", outputTokens: 20, pricingVersion: "apicity-0.25.0:2026-10-01",
    provider: "openai", rateSource: "https://example.test/rates", status: "completed", tokenBased: true, unit: "tokens", units: 120,
    updatedAt: 2000, warnings: [], ...patch,
  };
}

function insertV5_7_1Row(db: DatabaseSync, body: ReturnType<typeof v5_7_1Body>) {
  db.prepare(`INSERT INTO runtime_usage
    (id, provider, external_id, activity, model, status, basis, input_tokens, output_tokens, cached_tokens, token_based, cost_nanos, body_json, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    body.id, body.provider, body.externalId, body.activity, body.model, body.status, body.basis, body.inputTokens, body.outputTokens, body.cachedTokens,
    body.tokenBased ? 1 : 0, body.costUsd === null ? null : Math.round(body.costUsd * 1e9), JSON.stringify(body), body.createdAt, body.updatedAt,
  );
}

async function catalogFromV5_7_1(rows: Array<ReturnType<typeof v5_7_1Body>>) {
  const { engine, root } = await setup();
  engine.close();
  engines.splice(engines.indexOf(engine), 1);
  const db = new DatabaseSync(join(root, "data", "videobook.db"));
  try {
    db.exec(V5_7_1_TABLE);
    for (const row of rows) insertV5_7_1Row(db, row);
    return { root, head: db.doltHashOf("HEAD") };
  } finally {
    db.close();
  }
}

describe("usage rows written before the estimate fields", () => {
  it("upgrades a 5.7.1 table in place and reads its rows back with null new fields", async () => {
    const settled = v5_7_1Body("settled", {});
    const remote = v5_7_1Body("remote", { status: "pending", basis: "estimated", costUsd: 0.5, externalId: "task-1", inputTokens: null, outputTokens: null, cachedTokens: null, tokenBased: false, unit: null, units: null });
    const { root, head } = await catalogFromV5_7_1([settled, remote]);

    const engine = createEngine({ rootDir: root, durableWrites: false });
    engines.push(engine);
    await engine.ready;

    expect(engine.usage.read("settled")).toEqual({ ...settled, ...NEW_FIELDS_NULL });
    expect(engine.usage.find("openai", "task-1")).toEqual({ ...remote, ...NEW_FIELDS_NULL });
    expect(engine.usage.recent().map((entry) => entry.estimateUsd)).toEqual([null, null]);
    expect(engine.usage.summary().totals).toMatchObject({ count: 2, reportedUsd: 0.02, pendingCount: 1, pendingUsd: 0.5 });
    expect(engine.usage.rollup({ runId: "any" }).totals).toEqual(ZERO_TOTALS);
    expect(engine.usage.rollup().totals).toMatchObject({ count: 2, unestimated: 2, estimateUsd: 0 });
    expect(engine.usage.rollup().runs).toEqual([]);
    engine.close();
    engines.splice(engines.indexOf(engine), 1);

    const db = new DatabaseSync(join(root, "data", "videobook.db"));
    try {
      const stored = db.prepare("SELECT body_json, updated_at, estimate_nanos, run_id, cell_id, job_id FROM runtime_usage WHERE id='settled'").get() as Record<string, unknown>;
      expect(stored).toEqual({ body_json: JSON.stringify(settled), updated_at: 2000, estimate_nanos: null, run_id: null, cell_id: null, job_id: null });
      const indexes = (db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='runtime_usage' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as Array<{ name: string }>).map((row) => row.name);
      expect(indexes).toEqual(["runtime_usage_cell", "runtime_usage_external", "runtime_usage_job", "runtime_usage_recent", "runtime_usage_run"]);
      expect(db.doltHashOf("HEAD")).toBe(head);
      expect(db.doltStatus()).toEqual([]);
      expect((db.prepare("SELECT version FROM engine_schema").get() as { version: number }).version).toBe(28);
    } finally {
      db.close();
    }
  });

  it("recovers an interrupted 5.7.1 row and settles a remote one after the upgrade", async () => {
    const interrupted = v5_7_1Body("interrupted", { status: "pending", basis: "estimated", costUsd: 0.3 });
    const remote = v5_7_1Body("remote", { status: "pending", basis: "estimated", costUsd: 0.5, externalId: "task-1" });
    const { root } = await catalogFromV5_7_1([interrupted, remote]);
    const engine = createEngine({ rootDir: root, durableWrites: false });
    engines.push(engine);
    await engine.ready;

    expect(engine.usage.read("interrupted")).toMatchObject({ status: "uncertain", basis: "unknown", costUsd: null, ...NEW_FIELDS_NULL });
    const existing = engine.usage.find("openai", "task-1")!;
    write(engine, { ...existing, status: "completed", basis: "reported", costUsd: 0.45, actualBasis: "stated" });
    expect(engine.usage.read("remote")).toMatchObject({ status: "completed", costUsd: 0.45, actualBasis: "stated", estimateUsd: null, createdAt: 1000 });
  });

  it("gives a fresh catalog and an upgraded one the same usage table", async () => {
    const { engine, root } = await setup();
    engine.close();
    engines.splice(engines.indexOf(engine), 1);
    const shape = (dir: string) => {
      const db = new DatabaseSync(join(dir, "data", "videobook.db"));
      try {
        return (db.prepare("SELECT sql FROM sqlite_master WHERE tbl_name='runtime_usage' AND sql IS NOT NULL ORDER BY name").all() as Array<{ sql: string }>).map((row) => row.sql.replace(/\s+/gu, " ").replace(/ IF NOT EXISTS/u, ""));
      } finally {
        db.close();
      }
    };
    const fresh = shape(root);
    const upgraded = await catalogFromV5_7_1([]);
    const opened = createEngine({ rootDir: upgraded.root, durableWrites: false });
    await opened.ready;
    opened.close();
    expect(shape(upgraded.root)).toEqual(fresh);
  });
});

describe("estimate beside actual", () => {
  const quoted = { status: "pending", estimateUsd: 0.4, estimateSource: "table", estimateRateAsOf: "2026-11-01" } as const;

  it("keeps the estimate when a later patch writes the actual", async () => {
    const { engine } = await setup();
    write(engine, usage("call", { ...quoted, runId: "run" }));
    expect(engine.usage.read("call")).toMatchObject({ status: "pending", basis: "unknown", costUsd: null, estimateUsd: 0.4, actualBasis: null });

    write(engine, usage("call", { status: "completed", basis: "reported", costUsd: 0.38, listUsd: 0.5, actualBasis: "stated", inputTokens: 100, cachedTokens: 10, cacheWriteTokens: 20 }));

    expect(engine.usage.read("call")).toMatchObject({
      status: "completed", basis: "reported", costUsd: 0.38, listUsd: 0.5, actualBasis: "stated", cacheWriteTokens: 20,
      estimateUsd: 0.4, estimateSource: "table", estimateRateAsOf: "2026-11-01", runId: "run",
    });
  });

  it("does not let a patch clear or replace a set estimate, including a free one of zero", async () => {
    const { engine } = await setup();
    write(engine, usage("call", quoted));
    const held = { estimateUsd: 0.4, estimateSource: "table", estimateRateAsOf: "2026-11-01" };
    write(engine, usage("call", { status: "completed", estimateUsd: null, estimateSource: null, estimateRateAsOf: null }));
    expect(engine.usage.read("call")).toMatchObject(held);
    write(engine, usage("call", { status: "completed", estimateUsd: undefined, estimateSource: undefined }));
    expect(engine.usage.read("call")).toMatchObject(held);
    write(engine, usage("call", { status: "completed", estimateUsd: 9, estimateSource: "other", estimateRateAsOf: "2020-01-01" }));
    expect(engine.usage.read("call")).toMatchObject(held);

    write(engine, usage("free", { status: "pending", estimateUsd: 0 }));
    write(engine, usage("free", { status: "completed", basis: "free", estimateUsd: 5, estimateSource: "late" }));
    expect(engine.usage.read("free")).toMatchObject({ estimateUsd: 0, estimateSource: null, costUsd: 0 });
  });

  it("lets an actual refine, but not be cleared by a patch with nothing new", async () => {
    const { engine } = await setup();
    write(engine, usage("call", { status: "completed", basis: "estimated", costUsd: 0.1, actualBasis: "usage-only", cacheWriteTokens: 5, listUsd: 0.2 }));
    write(engine, usage("call", { actualBasis: null, cacheWriteTokens: null, listUsd: null }));
    write(engine, usage("call", { actualBasis: undefined, cacheWriteTokens: undefined, listUsd: undefined }));
    expect(engine.usage.read("call")).toMatchObject({ actualBasis: "usage-only", cacheWriteTokens: 5, listUsd: 0.2 });
    write(engine, usage("call", { actualBasis: "derived", cacheWriteTokens: 6, listUsd: 0.3 }));
    expect(engine.usage.read("call")).toMatchObject({ actualBasis: "derived", cacheWriteTokens: 6, listUsd: 0.3 });
  });

  it("accepts a first estimate on a row that had none", async () => {
    const { engine } = await setup();
    write(engine, usage("call", { status: "pending", estimateSource: "unavailable" }));
    write(engine, usage("call", { status: "pending", estimateUsd: 0.1, estimateSource: "table" }));
    expect(engine.usage.read("call")).toMatchObject({ estimateUsd: 0.1, estimateSource: "table" });
    expect(engine.usage.rollup().totals).toMatchObject({ estimateUsd: 0.1, unestimated: 0 });

    write(engine, usage("late", { status: "pending", estimateSource: "unavailable", estimateRateAsOf: "2020-01-01" }));
    write(engine, usage("late", { status: "pending", estimateUsd: 0.2 }));
    expect(engine.usage.read("late")).toMatchObject({ estimateUsd: 0.2, estimateSource: null, estimateRateAsOf: null });
    write(engine, usage("source-only", { status: "pending", estimateSource: "unavailable" }));
    write(engine, usage("source-only", { status: "completed" }));
    expect(engine.usage.read("source-only")).toMatchObject({ estimateUsd: null, estimateSource: "unavailable" });
  });

  it("keeps the estimate and attribution of a row merged into its external ID", async () => {
    const { engine } = await setup();
    write(engine, usage("poller", { status: "pending", externalId: "task" }));
    write(engine, usage("caller", { ...quoted, runId: "run", cellId: "cell", jobId: "job", notebookId: "notebook" }));

    write(engine, usage("caller", { externalId: "task", status: "completed", basis: "reported", costUsd: 0.38, actualBasis: "stated", estimateUsd: 9, estimateSource: "late" }));

    expect(engine.usage.read("caller")).toBeNull();
    expect(engine.usage.read("poller")).toMatchObject({
      externalId: "task", costUsd: 0.38, actualBasis: "stated", estimateUsd: 0.4, estimateSource: "table",
      runId: "run", cellId: "cell", jobId: "job", notebookId: "notebook",
    });
    expect(engine.usage.rollup({ runId: "run" }).totals).toMatchObject({ count: 1, reportedUsd: 0.38, estimateUsd: 0.4 });
  });

  it("absorbs a pending row into the settled row that holds its external ID, leaving no stray row", async () => {
    const { engine, root } = await setup();
    write(engine, usage("settled", { externalId: "task", status: "completed", basis: "reported", costUsd: 0.2, rateSource: "stated", actualBasis: "stated", warnings: ["kept"], inputTokens: 7 }));
    write(engine, usage("retry", { status: "pending", basis: "estimated", costUsd: 0.4, estimateUsd: 0.4, estimateSource: "table", estimateRateAsOf: "2026-11-01", runId: "run", cellId: "cell" }));

    const merged = write(engine, usage("retry", { externalId: "task", status: "pending", basis: "estimated", costUsd: 0.4, rateSource: "table", warnings: ["stale"], inputTokens: 9, jobId: "job", actualBasis: "none" }));

    const settled = {
      id: "settled", externalId: "task", status: "completed", basis: "reported", costUsd: 0.2, rateSource: "stated", actualBasis: "stated", warnings: ["kept"], inputTokens: 7,
      estimateUsd: 0.4, estimateSource: "table", estimateRateAsOf: "2026-11-01", runId: "run", cellId: "cell", jobId: "job",
    };
    expect(merged).toMatchObject(settled);
    expect(engine.usage.read("settled")).toMatchObject(settled);
    expect(engine.usage.read("retry")).toBeNull();
    expect(engine.usage.rollup({ runId: "run" }).totals).toMatchObject({ count: 1, actualUsd: 0.2, estimateUsd: 0.4, settledEstimateUsd: 0.4, pendingCount: 0, pendingEstimateUsd: 0, pendingUsd: 0, unsettled: 0 });

    const reopened = await reopen(engine, root);
    expect(reopened.usage.summary().totals).toMatchObject({ count: 1, pendingCount: 0, unpriced: 0 });
    expect(reopened.usage.read("settled")).toMatchObject(settled);
  });

  it("keeps the settled row's own quote and attribution over those of a row it absorbs", async () => {
    const { engine } = await setup();
    write(engine, usage("settled", { externalId: "task", status: "completed", basis: "estimated", costUsd: 0.2, actualBasis: "derived", estimateUsd: 0.25, estimateSource: "first", runId: "first-run" }));
    write(engine, usage("retry", { status: "pending", estimateUsd: 0.9, estimateSource: "second", runId: "second-run" }));
    write(engine, usage("retry", { externalId: "task", status: "pending", estimateUsd: 0.8 }));
    expect(engine.usage.read("settled")).toMatchObject({ status: "completed", costUsd: 0.2, actualBasis: "derived", estimateUsd: 0.25, estimateSource: "first", runId: "first-run" });
    expect(engine.usage.read("retry")).toBeNull();
  });

  it("takes the stronger figure when a pending write absorbs a row that already has one", async () => {
    const { engine } = await setup();
    write(engine, usage("settled", { externalId: "task", status: "completed", basis: "estimated", costUsd: 0.2, actualBasis: "derived" }));
    write(engine, usage("stated", { status: "completed", basis: "reported", costUsd: 0.3, actualBasis: "stated", listUsd: 0.4 }));
    write(engine, usage("stated", { externalId: "task", status: "pending" }));
    expect(engine.usage.read("settled")).toMatchObject({ status: "completed", basis: "reported", costUsd: 0.3, actualBasis: "stated", listUsd: 0.4 });
    expect(engine.usage.read("stated")).toBeNull();
  });

  it("still ignores a stale pending write with nothing to absorb", async () => {
    const { engine } = await setup();
    const settled = write(engine, usage("settled", { externalId: "task", status: "completed", basis: "reported", costUsd: 0.2 }));
    expect(write(engine, usage("settled", { status: "pending", estimateUsd: 0.9, runId: "run", costUsd: 9 }))).toEqual(settled);
    expect(write(engine, usage("settled", { externalId: "task", status: "pending", estimateUsd: 0.9 }))).toEqual(settled);
    expect(write(engine, usage("new-id", { externalId: "task", status: "pending", estimateUsd: 0.9 }))).toEqual(settled);
    expect(engine.usage.read("settled")).toEqual(settled);
    expect(engine.usage.read("new-id")).toBeNull();
    expect(engine.usage.summary().totals.count).toBe(1);
  });

  it("never overwrites a reported cost, and keeps its actual basis and list price with it", async () => {
    const { engine } = await setup();
    write(engine, usage("call", { status: "completed", basis: "reported", costUsd: 0.2, rateSource: "stated", actualBasis: "stated", listUsd: 0.3 }));
    write(engine, usage("call", { status: "completed", basis: "estimated", costUsd: 9, rateSource: "table", actualBasis: "derived", listUsd: 8 }));
    write(engine, usage("call", { status: "uncertain", basis: "unknown", actualBasis: "none" }));
    write(engine, usage("call", { basis: "reported", costUsd: null, actualBasis: "derived" }));
    expect(engine.usage.read("call")).toMatchObject({ basis: "reported", costUsd: 0.2, rateSource: "stated", actualBasis: "stated", listUsd: 0.3 });

    write(engine, usage("call", { status: "completed", basis: "reported", costUsd: 0.25, actualBasis: "stated" }));
    expect(engine.usage.read("call")).toMatchObject({ basis: "reported", costUsd: 0.25, listUsd: 0.3 });

    write(engine, usage("absorbed", { status: "completed", basis: "reported", costUsd: 0.7, actualBasis: "stated" }));
    write(engine, usage("kept", { status: "pending", externalId: "task", basis: "estimated", costUsd: 0.1 }));
    write(engine, usage("absorbed", { externalId: "task", status: "completed", basis: "estimated", costUsd: 0.1, actualBasis: "derived" }));
    expect(engine.usage.read("absorbed")).toBeNull();
    expect(engine.usage.read("kept")).toMatchObject({ basis: "reported", costUsd: 0.7, actualBasis: "stated" });
  });

  it("holds a stated figure against a spread patch with a weaker label", async () => {
    const { engine } = await setup();
    write(engine, usage("call", { status: "completed", basis: "reported", costUsd: 0.38, rateSource: "stated", actualBasis: "stated", listUsd: 0.5, estimateUsd: 0.4 }));
    write(engine, { ...engine.usage.read("call")!, actualBasis: "none" });
    write(engine, { ...engine.usage.read("call")!, actualBasis: "derived", listUsd: 99, rateSource: "table" });
    write(engine, { ...engine.usage.read("call")!, basis: "free" });
    write(engine, { ...engine.usage.read("call")!, status: "uncertain", basis: "unknown", warnings: ["Provider usage unavailable"] });
    expect(engine.usage.read("call")).toMatchObject({ status: "uncertain", basis: "reported", costUsd: 0.38, rateSource: "stated", actualBasis: "stated", listUsd: 0.5, estimateUsd: 0.4 });

    write(engine, { ...engine.usage.read("call")!, status: "completed", costUsd: 0.39, listUsd: 0.6 });
    expect(engine.usage.read("call")).toMatchObject({ status: "completed", basis: "reported", costUsd: 0.39, actualBasis: "stated", listUsd: 0.6 });
  });

  it("holds a derived figure against a stale snapshot, and lets an equal or stronger one replace it", async () => {
    const { engine } = await setup();
    write(engine, usage("call", { status: "pending", basis: "estimated", costUsd: 0.4, estimateUsd: 0.4 }));
    const snapshot = engine.usage.read("call")!;
    write(engine, { ...snapshot, status: "completed", costUsd: 0.1, actualBasis: "derived" });

    write(engine, { ...snapshot, status: "completed" });
    expect(engine.usage.read("call")).toMatchObject({ status: "completed", basis: "estimated", costUsd: 0.1, actualBasis: "derived", estimateUsd: 0.4 });
    write(engine, { ...snapshot, status: "uncertain", basis: "unknown", warnings: ["Provider usage unavailable"] });
    expect(engine.usage.read("call")).toMatchObject({ status: "uncertain", basis: "estimated", costUsd: 0.1, actualBasis: "derived" });

    write(engine, usage("call", { status: "completed", basis: "estimated", costUsd: 0.12, actualBasis: "derived" }));
    expect(engine.usage.read("call")).toMatchObject({ costUsd: 0.12, actualBasis: "derived" });
    write(engine, usage("call", { basis: "reported", costUsd: 0.2, actualBasis: "stated" }));
    expect(engine.usage.read("call")).toMatchObject({ basis: "reported", costUsd: 0.2, actualBasis: "stated" });
    write(engine, usage("call", { basis: "estimated", costUsd: 0.1, actualBasis: "derived" }));
    expect(engine.usage.read("call")).toMatchObject({ basis: "reported", costUsd: 0.2, actualBasis: "stated" });
  });

  it("clears an old label when an unlabelled reported figure replaces what it described", async () => {
    const { engine } = await setup();
    write(engine, usage("derived", { status: "completed", basis: "estimated", costUsd: 0.1, actualBasis: "derived" }));
    write(engine, usage("derived", { basis: "reported", costUsd: 0.2 }));
    expect(engine.usage.read("derived")).toMatchObject({ basis: "reported", costUsd: 0.2, actualBasis: null });
    write(engine, usage("usage-only", { status: "completed", tokenBased: true, inputTokens: 5, actualBasis: "usage-only" }));
    write(engine, usage("usage-only", { basis: "reported", costUsd: 0.3 }));
    expect(engine.usage.read("usage-only")).toMatchObject({ basis: "reported", costUsd: 0.3, actualBasis: null });
  });

  it("does not let a reported row with no figure win a merge", async () => {
    const { engine } = await setup();
    write(engine, usage("empty", { status: "completed", basis: "reported", costUsd: null }));
    write(engine, usage("kept", { status: "pending", externalId: "task", basis: "estimated", costUsd: 0.1 }));
    write(engine, usage("empty", { externalId: "task", status: "completed", basis: "estimated", costUsd: 0.2, actualBasis: "derived" }));
    expect(engine.usage.read("kept")).toMatchObject({ basis: "estimated", costUsd: 0.2, actualBasis: "derived" });
  });

  it("does not check cache writes against input tokens, so a provider's shape cannot lose an actual", async () => {
    const { engine } = await setup();
    write(engine, usage("raw", { status: "pending", estimateUsd: 0.04 }));
    write(engine, usage("raw", { status: "completed", basis: "reported", costUsd: 0.05, actualBasis: "stated", inputTokens: 3, outputTokens: 50, cacheWriteTokens: 1200 }));
    expect(engine.usage.read("raw")).toMatchObject({ status: "completed", costUsd: 0.05, inputTokens: 3, cacheWriteTokens: 1200, estimateUsd: 0.04 });
    write(engine, usage("raw", { inputTokens: 0 }));
    expect(engine.usage.read("raw")).toMatchObject({ inputTokens: 0, cacheWriteTokens: 1200, costUsd: 0.05 });
  });

  it("does not store a stated or derived label with no figure behind it, and keeps a usage-only one", async () => {
    const { engine } = await setup();
    write(engine, usage("call", { status: "completed", basis: "unknown", costUsd: 0.1, actualBasis: "derived", estimateUsd: 0.2 }));
    expect(engine.usage.read("call")).toMatchObject({ costUsd: null, actualBasis: null, estimateUsd: 0.2 });
    write(engine, usage("no-figure", { status: "completed", basis: "estimated", actualBasis: "stated" }));
    expect(engine.usage.read("no-figure")).toMatchObject({ costUsd: null, actualBasis: null });

    write(engine, usage("tokens", { status: "completed", tokenBased: true, inputTokens: 5, outputTokens: 5, actualBasis: "usage-only" }));
    expect(engine.usage.read("tokens")).toMatchObject({ basis: "unknown", costUsd: null, actualBasis: "usage-only" });
  });

  it("carries the estimate and attribution through restart recovery, reopen and restore", async () => {
    const { engine, root } = await setup();
    await engine.notebooks.create("Main");
    const before = engine.history.revisions(1)[0]!.hash;
    const commits = engine.history.revisions(100).length;
    write(engine, usage("interrupted", { ...quoted, runId: "run", cellId: "cell", jobId: "job", notebookId: "notebook" }));
    write(engine, usage("settled", { status: "completed", basis: "estimated", costUsd: 0.1, actualBasis: "derived", estimateUsd: 0.2, runId: "run" }));
    expect(engine.history.revisions(100)).toHaveLength(commits);
    expect((await engine.history.restore(before)).ok).toBe(true);
    expect(engine.usage.rollup({ runId: "run" }).totals.count).toBe(2);

    const reopened = await reopen(engine, root);

    expect(reopened.usage.read("interrupted")).toMatchObject({ status: "uncertain", basis: "unknown", estimateUsd: 0.4, estimateSource: "table", runId: "run", cellId: "cell", jobId: "job", notebookId: "notebook" });
    expect(reopened.usage.read("settled")).toMatchObject({ actualBasis: "derived", costUsd: 0.1, estimateUsd: 0.2 });
    expect(reopened.usage.rollup({ runId: "run" }).totals).toMatchObject({ count: 2, estimatedUsd: 0.1, estimateUsd: 0.6, pendingCount: 0, pendingEstimateUsd: 0, unpriced: 1, unsettled: 1 });
  });

  it("does not move attribution once set, and fills it when it was missing", async () => {
    const { engine } = await setup();
    write(engine, usage("call", { status: "pending", runId: "first" }));
    write(engine, usage("call", { status: "pending", runId: "second", cellId: "cell", jobId: null }));
    write(engine, usage("call", { status: "completed", runId: null, cellId: undefined, jobId: "job" }));
    expect(engine.usage.read("call")).toMatchObject({ runId: "first", cellId: "cell", jobId: "job" });
    expect(engine.usage.rollup({ runId: "second" }).totals.count).toBe(0);
    expect(engine.usage.rollup({ runId: "first" }).totals.count).toBe(1);
    expect(engine.usage.rollup({ cellId: "cell" }).totals.count).toBe(1);
    expect(engine.usage.rollup({ jobId: "job" }).totals.count).toBe(1);
  });

  it("rejects invalid new fields and leaves the row as it was", async () => {
    const { engine } = await setup();
    write(engine, usage("call", quoted));
    const invalid: Array<Partial<UsageInput>> = [
      { estimateUsd: -1 }, { estimateUsd: Number.NaN }, { estimateUsd: Number.POSITIVE_INFINITY }, { estimateUsd: 1e10 },
      { listUsd: -1 }, { listUsd: 1e10 }, { cacheWriteTokens: -1 }, { cacheWriteTokens: 1.5 },
      { actualBasis: "guessed" as never }, { runId: "" }, { cellId: " " }, { jobId: "x".repeat(501) }, { notebookId: 7 as never },
      { estimateSource: "" }, { estimateRateAsOf: 20261101 as never },
    ];
    for (const patch of invalid) {
      const fresh = engine.usage.record(usage(`fresh-${invalid.indexOf(patch)}`, patch));
      expect(fresh.ok, JSON.stringify(patch)).toBe(false);
    }
    expect(engine.usage.record(usage("call", { status: "completed", cacheWriteTokens: -1 })).ok).toBe(false);
    expect(engine.usage.read("call")).toMatchObject({ status: "pending", cacheWriteTokens: null });
    expect(engine.usage.summary().totals.count).toBe(1);
  });
});

describe("usage rollup", () => {
  async function threeCallRun() {
    const { engine, root } = await setup();
    const quote = (estimateUsd: number) => ({ status: "pending", estimateUsd, estimateSource: "table", estimateRateAsOf: "2026-11-01", notebookId: "notebook", runId: "run" }) as const;
    write(engine, usage("stated", { ...quote(0.2), cellId: "cell-a", jobId: "job-a" }));
    write(engine, usage("derived", { ...quote(0.12), cellId: "cell-a", jobId: "job-a", activity: "chat", model: "gpt", tokenBased: true }));
    write(engine, usage("pending", { ...quote(0.4), cellId: "cell-b", jobId: "job-b", externalId: "task" }));
    write(engine, usage("stated", { status: "completed", basis: "reported", costUsd: 0.25, actualBasis: "stated" }));
    write(engine, usage("derived", { status: "completed", activity: "chat", model: "gpt", basis: "estimated", costUsd: 0.1, actualBasis: "derived", inputTokens: 100, outputTokens: 20, cachedTokens: 30, cacheWriteTokens: 40 }));
    return { engine, root };
  }

  it("pins a run of one stated, one derived and one pending call", async () => {
    const { engine } = await threeCallRun();

    const rollup = engine.usage.rollup({ runId: "run" });

    expect(rollup.totals).toEqual({
      count: 3, inputTokens: 100, outputTokens: 20, cachedTokens: 30, missingTokens: 0,
      reportedUsd: 0.25, estimatedUsd: 0.1, unpriced: 0, pendingCount: 1, pendingUsd: 0,
      actualUsd: 0.35, estimateUsd: 0.72, settledEstimateUsd: 0.32, pendingEstimateUsd: 0.4, unsettled: 1, unestimated: 0,
    });
    expect(rollup.currency).toBe("USD");
    expect(rollup.runs).toEqual([{ id: "run", ...rollup.totals }]);
    expect(rollup.cells.map(({ id, count, actualUsd, estimateUsd, unsettled }) => ({ id, count, actualUsd, estimateUsd, unsettled }))).toEqual([
      { id: "cell-a", count: 2, actualUsd: 0.35, estimateUsd: 0.32, unsettled: 0 },
      { id: "cell-b", count: 1, actualUsd: 0, estimateUsd: 0.4, unsettled: 1 },
    ]);
    expect(rollup.jobs.map(({ id, count, pendingEstimateUsd }) => ({ id, count, pendingEstimateUsd }))).toEqual([
      { id: "job-a", count: 2, pendingEstimateUsd: 0 },
      { id: "job-b", count: 1, pendingEstimateUsd: 0.4 },
    ]);
  });

  it("stops being partial when the last call settles, and keeps the estimate for comparison", async () => {
    const { engine } = await threeCallRun();
    write(engine, usage("pending", { externalId: "task", status: "completed", basis: "reported", costUsd: 0.5, actualBasis: "stated" }));
    expect(engine.usage.rollup({ runId: "run" }).totals).toMatchObject({
      count: 3, reportedUsd: 0.75, estimatedUsd: 0.1, actualUsd: 0.85, estimateUsd: 0.72, settledEstimateUsd: 0.72, pendingCount: 0, pendingEstimateUsd: 0, unsettled: 0,
    });
  });

  it("does not count a quote that settled with nothing behind it as an actual", async () => {
    const { engine } = await setup();
    const quote = { status: "pending", basis: "estimated", costUsd: 0.5, estimateUsd: 0.5, runId: "run" } as const;
    write(engine, usage("quote-only", quote));
    write(engine, { ...engine.usage.read("quote-only")!, status: "completed" });
    expect(engine.usage.rollup({ runId: "run" }).totals).toMatchObject({
      count: 1, estimatedUsd: 0.5, unpriced: 0, actualUsd: 0, estimateUsd: 0.5, settledEstimateUsd: 0, unsettled: 1,
    });

    for (const actualBasis of ["none", "usage-only"] as const) {
      write(engine, usage(actualBasis, { ...quote, runId: "labelled" }));
      write(engine, { ...engine.usage.read(actualBasis)!, status: "completed", actualBasis });
    }
    expect(engine.usage.rollup({ runId: "labelled" }).totals).toMatchObject({ count: 2, estimatedUsd: 1, actualUsd: 0, settledEstimateUsd: 0, unsettled: 2 });

    write(engine, { ...engine.usage.read("quote-only")!, costUsd: 0.4, actualBasis: "derived" });
    expect(engine.usage.rollup({ runId: "run" }).totals).toMatchObject({
      estimatedUsd: 0.4, actualUsd: 0.4, estimateUsd: 0.5, settledEstimateUsd: 0.5, unsettled: 0,
    });
  });

  it("counts an unlabelled token-priced row as actual, and a free row as settled", async () => {
    const { engine } = await setup();
    write(engine, usage("older", { status: "completed", basis: "estimated", costUsd: 0.1, tokenBased: true, inputTokens: 10, outputTokens: 2, runId: "run" }));
    write(engine, usage("free", { status: "completed", basis: "free", estimateUsd: 0, runId: "run" }));
    expect(engine.usage.rollup({ runId: "run" }).totals).toMatchObject({ count: 2, actualUsd: 0.1, settledEstimateUsd: 0, unsettled: 0, unestimated: 1 });
  });

  it("compares a retried cell's estimate only over the rows behind its actual", async () => {
    const { engine } = await setup();
    write(engine, usage("failed", { status: "failed", estimateUsd: 0.4, cellId: "cell" }));
    write(engine, usage("retry", { status: "completed", basis: "reported", costUsd: 0.38, actualBasis: "stated", estimateUsd: 0.4, cellId: "cell" }));
    expect(engine.usage.rollup({ cellId: "cell" }).totals).toMatchObject({ actualUsd: 0.38, estimateUsd: 0.8, settledEstimateUsd: 0.4, pendingEstimateUsd: 0, unpriced: 1, unsettled: 1 });
  });

  it("uses the same totals rules as the book summary", async () => {
    const { engine } = await threeCallRun();
    write(engine, usage("failed", { runId: "run", status: "failed", basis: "estimated", costUsd: 0.2 }));
    write(engine, usage("uncertain-priced", { runId: "run", status: "uncertain", basis: "estimated", costUsd: 0.05, inputTokens: 1, outputTokens: 1 }));
    write(engine, usage("cancelled-unlabelled", { runId: "run", status: "cancelled", basis: "estimated", costUsd: 0.07, actualBasis: "derived" }));
    write(engine, usage("usage-only", { runId: "run", status: "completed", tokenBased: true, inputTokens: 5, actualBasis: "usage-only" }));
    write(engine, usage("legacy-pending", { runId: "run", status: "pending", basis: "estimated", costUsd: 2 }));
    const { totals } = engine.usage.rollup({ runId: "run" });
    const { totals: book } = engine.usage.summary();

    const shared = Object.keys(book) as Array<keyof UsageTotals>;
    for (const key of shared) expect(totals[key], key).toBeCloseTo(book[key], 9);
    expect(totals).toMatchObject({ count: 8, pendingCount: 2, pendingUsd: 2, unpriced: 3, missingTokens: 1, unestimated: 5, unsettled: 6 });
    expect(totals.actualUsd).toBeCloseTo(0.4, 9);
  });

  it("sums in nanos, so thirty small rows do not drift", async () => {
    const { engine } = await setup();
    for (let i = 0; i < 30; i++) write(engine, usage(String(i), { status: "completed", basis: "estimated", costUsd: 0.1, actualBasis: "derived", estimateUsd: 0.1, runId: "run" }));
    expect(engine.usage.rollup({ runId: "run" }).totals).toMatchObject({ actualUsd: 3, estimatedUsd: 3, estimateUsd: 3 });
    write(engine, usage("reported", { status: "completed", basis: "reported", costUsd: 0.1, runId: "pair" }));
    write(engine, usage("estimated", { status: "completed", basis: "estimated", costUsd: 0.2, actualBasis: "derived", runId: "pair" }));
    expect(engine.usage.rollup({ runId: "pair" }).totals.actualUsd).toBe(0.3);
  });

  it("filters by run, cell and job, alone or together, and keeps unattributed rows in the book total only", async () => {
    const { engine } = await threeCallRun();
    write(engine, usage("rerun", { status: "completed", basis: "estimated", costUsd: 0.3, actualBasis: "derived", estimateUsd: 0.3, runId: "later", cellId: "cell-a", jobId: "job-c" }));
    write(engine, usage("chat", { status: "completed", basis: "estimated", costUsd: 0.01, actualBasis: "derived", activity: "chat", model: "gpt" }));

    const cell = engine.usage.rollup({ cellId: "cell-a" });
    expect(cell.totals).toMatchObject({ count: 3, actualUsd: 0.65, estimateUsd: 0.62 });
    expect(cell.runs.map(({ id, count }) => ({ id, count }))).toEqual([{ id: "later", count: 1 }, { id: "run", count: 2 }]);
    expect(cell.cells.map(({ id }) => id)).toEqual(["cell-a"]);
    expect(engine.usage.rollup({ runId: "run", cellId: "cell-a" }).totals).toMatchObject({ count: 2, actualUsd: 0.35, estimateUsd: 0.32 });
    expect(engine.usage.rollup({ jobId: "job-b" }).totals).toMatchObject({ count: 1, pendingEstimateUsd: 0.4, unsettled: 1 });
    expect(engine.usage.rollup({ runId: "missing" })).toEqual({ currency: "USD", totals: ZERO_TOTALS, runs: [], cells: [], jobs: [] });

    const book = engine.usage.rollup();
    expect(book.totals).toMatchObject({ count: 5, unestimated: 1 });
    expect(book.totals.actualUsd).toBeCloseTo(0.66, 9);
    expect(book.runs.map(({ id }) => id)).toEqual(["later", "run"]);
    expect(book.cells.reduce((sum, group) => sum + group.count, 0)).toBe(4);
    expect(book.jobs.map(({ id }) => id)).toEqual(["job-a", "job-b", "job-c"]);
  });

  it("refuses a filter that would silently widen to the whole book", async () => {
    const { engine } = await threeCallRun();
    expect(() => engine.usage.rollup({ runId: undefined })).toThrow(/Invalid usage rollup filter runId/u);
    expect(() => engine.usage.rollup({ cellId: "" })).toThrow(/Invalid usage rollup filter cellId/u);
    expect(() => engine.usage.rollup({ jobId: null as never })).toThrow(/Invalid usage rollup filter jobId/u);
    expect(() => engine.usage.rollup({ notebookId: "notebook" } as never)).toThrow(/Invalid usage rollup filter notebookId/u);
    expect(() => engine.usage.rollup({ constructor: "x" } as never)).toThrow(/Invalid usage rollup filter constructor/u);
  });

  it("binds filter values as data", async () => {
    const { engine } = await threeCallRun();
    expect(engine.usage.rollup({ runId: "run' OR '1'='1" }).totals.count).toBe(0);
  });

  it("runs every filtered query through the index on the column it filters on", async () => {
    const { engine } = await threeCallRun();
    const { db } = (engine as unknown as { context: { store: { db: DatabaseSync } } }).context.store;
    const prepare = vi.spyOn(db, "prepare");
    for (const [filter, column, index] of [
      [{ runId: "x" }, "run_id", "runtime_usage_run"],
      [{ cellId: "x" }, "cell_id", "runtime_usage_cell"],
      [{ jobId: "x" }, "job_id", "runtime_usage_job"],
    ] as const) {
      prepare.mockClear();
      engine.usage.rollup(filter);
      const statements = prepare.mock.calls.map(([sql]) => sql as string);
      expect(statements).toHaveLength(4);
      for (const sql of statements) {
        const plan = db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all("x") as Array<{ detail: string }>;
        expect(plan.map((row) => row.detail).join("\n"), sql).toContain(`USING INDEX ${index} (${column}=?)`);
      }
    }
    prepare.mockRestore();
  });
});
