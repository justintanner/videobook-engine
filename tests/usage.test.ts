import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createEngine } from "../src/engine.js";
import type { Engine } from "../src/engine.js";
import type { UsageInput } from "../src/usage.js";

const roots: string[] = [];
const engines: Engine[] = [];
afterEach(async () => {
  for (const engine of engines.splice(0)) engine.close();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true, maxRetries: 3 })));
});

async function setup() {
  const root = await mkdtemp(join(tmpdir(), "vb-usage-"));
  roots.push(root);
  const engine = createEngine({ rootDir: root, initialBookName: "usage-test", durableWrites: false });
  engines.push(engine);
  await engine.ready;
  return { root, engine };
}

function usage(id: string, patch: Partial<UsageInput> = {}): UsageInput {
  return { id, provider: "test", model: "image", activity: "images", status: "completed", basis: "estimated", costUsd: 0.000001234, ...patch };
}

describe("book usage ledger", () => {
  it("deduplicates IDs and external IDs, upgrades estimates, and rejects stale pending updates", async () => {
    const { engine } = await setup();
    expect(engine.usage.record(usage("one", { externalId: "remote" })).ok).toBe(true);
    engine.usage.record(usage("two", { status: "pending" }));
    engine.usage.record(usage("two", { externalId: "remote", basis: "reported", costUsd: 0.02 }));
    engine.usage.record(usage("one", { status: "pending", costUsd: 99 }));
    expect(engine.usage.summary().totals).toMatchObject({ count: 1, reportedUsd: 0.02, estimatedUsd: 0, pendingCount: 0 });
    expect(engine.usage.find("test", "remote")?.id).toBe("one");
    expect(engine.usage.read("two")).toBeNull();
  });

  it("sums every entry and separates pending, unknown, cached, and small measured costs", async () => {
    const { engine } = await setup();
    await Promise.all(Array.from({ length: 30 }, (_, i) => Promise.resolve(engine.usage.record(usage(String(i))))));
    engine.usage.record(usage("tokens", { tokenBased: true, inputTokens: 100, outputTokens: 20, cachedTokens: 40, costUsd: null, basis: "unknown" }));
    engine.usage.record(usage("pending", { status: "pending", costUsd: 2 }));
    engine.usage.record(usage("missing", { tokenBased: true, basis: "unknown", status: "uncertain" }));
    const { totals } = engine.usage.summary();
    expect(totals).toMatchObject({ count: 33, inputTokens: 100, outputTokens: 20, cachedTokens: 40, pendingCount: 1, pendingUsd: 2, unpriced: 2, missingTokens: 1 });
    expect(totals.estimatedUsd).toBeCloseTo(0.000001234 * 30, 12);
    expect(engine.usage.recent()).toHaveLength(20);
    expect(engine.usage.record(usage("invalid", { inputTokens: -1 })).ok).toBe(false);
    expect(engine.usage.summary().totals.count).toBe(33);
  });

  it("persists independently of asset deletion, semantic restore, and book reopening", async () => {
    const { engine, root } = await setup();
    await engine.notebooks.create("Main");
    const before = engine.history.revisions(1)[0]!.hash;
    const artifact = await engine.artifacts.create("image", "example");
    if (!artifact.ok) throw new Error(artifact.error.message);
    engine.usage.record(usage("spent", { artifactId: artifact.value.artifactId }));
    const trackedSince = engine.usage.summary().trackedSince;
    expect((await engine.artifacts.delete(artifact.value.artifactId)).ok).toBe(true);
    expect((await engine.history.restore(before)).ok).toBe(true);
    expect(engine.usage.summary().totals.count).toBe(1);
    engine.close();
    engines.splice(engines.indexOf(engine), 1);
    const reopened = createEngine({ rootDir: root, durableWrites: false });
    engines.push(reopened);
    await reopened.ready;
    expect(reopened.usage.summary().trackedSince).toBe(trackedSince);
    expect(reopened.usage.summary().totals.count).toBe(1);
    const other = await setup();
    expect(other.engine.usage.summary().totals.count).toBe(0);
  });

  it("includes billable tokens from cancelled requests while preserving unknown failed charges", async () => {
    const { engine } = await setup();
    engine.usage.record(usage("cancelled", { status: "cancelled", tokenBased: true, inputTokens: 100, outputTokens: 10, costUsd: 0.1 }));
    engine.usage.record(usage("failed", { status: "failed", costUsd: 0.2 }));
    expect(engine.usage.summary().totals).toMatchObject({ estimatedUsd: 0.1, unpriced: 1, inputTokens: 100, outputTokens: 10 });
  });
});
