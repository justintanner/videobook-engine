import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createEngine, type Engine } from "../src/engine.js";
import type { AssetTagSnapshotExport, Result, EngineError } from "../src/engine-types.js";

const opened: Array<{ engine: Engine; root: string }> = [];
afterEach(async () => {
  for (const { engine, root } of opened.splice(0)) {
    engine.close();
    await rm(root, { recursive: true, force: true, maxRetries: 3 });
  }
});

function value<T>(result: Result<T, EngineError>): T {
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

const ANALYZER = { generator: "tagger", extractorVersion: "1" };

async function setup() {
  const root = await mkdtemp(path.join(tmpdir(), "vb-tag-regression-"));
  const engine = createEngine({ rootDir: root, initialBookName: "review" });
  opened.push({ engine, root });
  await engine.ready;
  const artifactId = value(await engine.artifacts.create({ kind: "video" })).artifactId;
  value(await engine.files.write(artifactId, "original.txt", "original bytes"));
  const sourceHash = createHash("sha256").update("original bytes").digest("hex");
  return { engine, artifactId, sourceHash };
}

describe("tag write serialization", () => {
  it("accepts only one competing analysis at the same generation", async () => {
    const { engine, artifactId, sourceHash } = await setup();
    const results = await Promise.all(["First", "Second"].map((label) =>
      engine.tags.automatic.replace({ artifactId, sourceHash, ...ANALYZER,
        expectedGeneration: 0, tags: [{ facet: "editing", label }] }),
    ));
    expect(results[0]?.ok).toBe(true);
    expect(results[1]).toMatchObject({ ok: false, error: { code: "STALE_REVISION" } });
    const state = value(engine.tags.read(artifactId));
    expect(state.snapshot?.generation).toBe(1);
    expect(state.effective[0]?.label).toBe("First");
  });

  it("checks capacity after earlier queued additions", async () => {
    const { engine, artifactId } = await setup();
    value(await engine.tags.addMany(artifactId, Array.from({ length: 99 }, (_, index) =>
      ({ facet: "custom", label: `tag ${index}` }),
    )));
    const results = await Promise.all(["hundred", "overflow"].map((label) =>
      engine.tags.add(artifactId, { facet: "custom", label }),
    ));
    expect(results[0]?.ok).toBe(true);
    expect(results[1]).toMatchObject({ ok: false, error: { code: "RESOURCE_EXHAUSTED" } });
    expect(value(engine.tags.read(artifactId)).manual).toHaveLength(100);
  });

  it("honors a queued add or restore after removal", async () => {
    const { engine, artifactId } = await setup();
    const tag = { facet: "editing" as const, label: "Hero" };
    value(await engine.tags.add(artifactId, tag));
    const [removed, added] = await Promise.all([
      engine.tags.remove(artifactId, tag), engine.tags.add(artifactId, tag),
    ]);
    value(removed);
    expect(value(added).manual).toHaveLength(1);
    expect(value(engine.tags.read(artifactId)).dismissed).toEqual([]);
    const results = await Promise.all([
      engine.tags.remove(artifactId, tag), engine.tags.restore(artifactId, tag),
    ]);
    results.forEach(value);
    expect(value(engine.tags.read(artifactId)).dismissed).toEqual([]);
  });

  it("makes duplicate concurrent additions and imports true no-ops", async () => {
    const { engine, artifactId } = await setup();
    const tag = { facet: "editing" as const, label: "Hero" };
    const [first, duplicate] = await Promise.all([
      engine.tags.add(artifactId, tag), engine.tags.add(artifactId, tag),
    ]);
    value(first);
    value(duplicate);
    expect(duplicate).not.toHaveProperty("revision");
    const snapshot: AssetTagSnapshotExport = {
      version: 1, artifactId, manual: [{ facet: "places", label: "Beach" }], dismissed: [],
    };
    const [imported, repeated] = await Promise.all([
      engine.tags.import(artifactId, snapshot), engine.tags.import(artifactId, snapshot),
    ]);
    expect(value(imported).importedManual).toBe(1);
    expect(value(repeated).importedManual).toBe(0);
    expect(repeated).not.toHaveProperty("revision");
  });
});

describe("consistent tag projections", () => {
  it("does not re-commit an identical Unicode snapshot in a different order", async () => {
    const { engine, artifactId, sourceHash } = await setup();
    const tags = ["Zulu", "Éclair"].map((label) => ({ facet: "places" as const, label }));
    value(await engine.tags.automatic.replace({ artifactId, sourceHash, ...ANALYZER, tags }));
    const head = engine.head;
    const repeated = await engine.tags.automatic.replace({
      artifactId, sourceHash, ...ANALYZER, tags: tags.toReversed(), expectedGeneration: 1,
    });
    expect(value(repeated).snapshot?.generation).toBe(1);
    expect(repeated).not.toHaveProperty("revision");
    expect(engine.head).toBe(head);
  });

  it("preserves duplicate requested artifacts without duplicating their rows across read chunks", async () => {
    const { engine, artifactId, sourceHash } = await setup();
    value(await engine.tags.add(artifactId, { facet: "custom", label: "Keep" }));
    value(await engine.tags.automatic.replace({ artifactId, sourceHash, ...ANALYZER,
      tags: [{ facet: "editing", label: "Wide" }] }));
    value(await engine.tags.remove(artifactId, { facet: "places", label: "Beach" }));
    const single = value(engine.tags.read(artifactId));
    const many = value(engine.tags.readMany(Array<string>(201).fill(artifactId)));
    expect(many).toHaveLength(201);
    expect(many.every((state) => JSON.stringify(state) === JSON.stringify(single))).toBe(true);
  });

  it("carries confirmed entities through query results", async () => {
    const { engine, artifactId, sourceHash } = await setup();
    const entityId = value(await engine.entities.create("character", "Ada")).id;
    value(await engine.tags.add(artifactId, { facet: "people", label: "Ada", entityId }));
    value(await engine.tags.automatic.replace({ artifactId, sourceHash, ...ANALYZER,
      tags: [{ facet: "people", label: "Ada" }, { facet: "people", label: "Lead", entityId }] }));
    expect(value(engine.tags.query()).artifacts[0]?.tags).toEqual(value(engine.tags.read(artifactId)).effective);
  });

  it("uses the same Unicode and facet order in current, historical and query results", async () => {
    const { engine, artifactId, sourceHash } = await setup();
    value(await engine.tags.addMany(artifactId, [
      { facet: "places", label: "Beach" },
      { facet: "editing", label: "\uE000" }, { facet: "editing", label: "😀" },
    ]));
    value(await engine.tags.automatic.replace({ artifactId, sourceHash, ...ANALYZER,
      tags: [{ facet: "editing", label: "Cutaway" }] }));
    const state = value(engine.tags.read(artifactId));
    expect(value(engine.tags.readAtRevision(artifactId, engine.head))).toEqual(state);
    expect(value(engine.tags.query()).artifacts[0]?.tags).toEqual(state.effective);
  });

  it("does not suggest a label from dismissed automatic evidence", async () => {
    const { engine, artifactId, sourceHash } = await setup();
    value(await engine.tags.automatic.replace({ artifactId, sourceHash, ...ANALYZER,
      tags: [{ facet: "places", label: "BEACH" }] }));
    value(await engine.tags.remove(artifactId, { facet: "places", label: "BEACH" }));
    const activeId = value(await engine.artifacts.create({ kind: "video" })).artifactId;
    value(await engine.files.write(activeId, "original.txt", "original bytes"));
    value(await engine.tags.automatic.replace({ artifactId: activeId, sourceHash, ...ANALYZER,
      tags: [{ facet: "places", label: "beach" }] }));
    expect(value(engine.tags.suggest({ prefix: "bea" }))).toEqual([
      { facet: "places", key: "beach", label: "beach", artifacts: 1 },
    ]);
  });
});

describe("validated snapshot imports", () => {
  it("deduplicates dismissals before counting and enforcing their limit", async () => {
    const { engine, artifactId } = await setup();
    const tag = { facet: "places" as const, label: "Beach" };
    const result = value(await engine.tags.import(artifactId, {
      version: 1, artifactId, manual: [], dismissed: Array(501).fill(tag),
    }));
    expect(result.importedDismissals).toBe(1);
    expect(result.state.dismissed).toHaveLength(1);
  });

  it("does not call unchanged valid automatic evidence skipped", async () => {
    const { engine, artifactId, sourceHash } = await setup();
    value(await engine.tags.automatic.replace({ artifactId, sourceHash, ...ANALYZER,
      tags: [{ facet: "places", label: "Beach" }] }));
    const snapshot = value(engine.tags.export(artifactId));
    const head = engine.head;
    const imported = await engine.tags.import(artifactId, snapshot);
    expect(value(imported)).toMatchObject({ skippedAutomatic: false, importedAutomatic: 0 });
    expect(imported).not.toHaveProperty("revision");
    expect(engine.head).toBe(head);
  });

  it.each([
    { field: "tags", changes: { tags: Array.from({ length: 13 }, (_, index) => ({ facet: "editing" as const, label: `tag ${index}` })) }, code: "RESOURCE_EXHAUSTED" },
    { field: "generator", changes: { generator: "  " }, code: "INVALID_INPUT" },
    { field: "extractorVersion", changes: { extractorVersion: "" }, code: "INVALID_INPUT" },
    { field: "analyzedAt", changes: { analyzedAt: -1 }, code: "INVALID_INPUT" },
    { field: "automatic custom facet", changes: { tags: [{ facet: "custom" as const, label: "Private" }] }, code: "INVALID_INPUT" },
  ])("rejects invalid $field without partially importing manual intent", async ({ changes, code }) => {
    const { engine, artifactId, sourceHash } = await setup();
    const head = engine.head;
    const imported = await engine.tags.import(artifactId, {
      version: 1, artifactId, manual: [{ facet: "custom", label: "Keep" }], dismissed: [],
      automatic: { sourceHash, ...ANALYZER, analyzedAt: Date.now(), tags: [], ...changes },
    });
    expect(imported).toMatchObject({ ok: false, error: { code } });
    expect(engine.head).toBe(head);
    expect(value(engine.tags.read(artifactId)).effective).toEqual([]);
  });

  it("keeps custom vocabulary manual in automatic replacements too", async () => {
    const { engine, artifactId, sourceHash } = await setup();
    expect(await engine.tags.automatic.replace({ artifactId, sourceHash, ...ANALYZER,
      tags: [{ facet: "custom", label: "Private" }] })).toMatchObject({
      ok: false, error: { code: "INVALID_INPUT" },
    });
  });
});
