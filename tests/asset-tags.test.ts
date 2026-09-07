import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";

import { DatabaseSync } from "@dolthub/doltlite";
import { afterEach, describe, expect, it } from "vitest";

import { SCHEMA_VERSION } from "../src/catalog-metadata.js";
import { createEngine, type Engine } from "../src/engine.js";
import {
  AUTOMATIC_TAGS_PER_SNAPSHOT_MAX,
  MANUAL_TAGS_PER_ARTIFACT_MAX,
  normalizeTagLabel,
  tagCanonicalKey,
  tagIdentity,
} from "../src/tag-values.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true, maxRetries: 3 })),
  );
});

async function setup(): Promise<{ engine: Engine; root: string }> {
  const root = await mkdtemp(path.join(tmpdir(), "vb-asset-tags-"));
  roots.push(root);
  const engine = createEngine({
    rootDir: root,
    initialBookName: "tags-demo",
  });
  await engine.ready;
  return { engine, root };
}

function value<T>(
  result:
    | { ok: true; value: T; revision?: string }
    | { ok: false; error: { message: string; code?: string } },
): T {
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

function failure<T>(
  result:
    | { ok: true; value: T }
    | { ok: false; error: { code: string; message: string } },
): { code: string; message: string } {
  if (result.ok) throw new Error("expected a failure");
  return result.error;
}

async function artifactWithFile(
  engine: Engine,
  root: string,
  contents: string,
  kind: "video" | "image" | "script" = "video",
): Promise<{ artifactId: string; hash: string }> {
  const artifact = value(await engine.artifacts.create({ kind, label: "clip" }));
  value(await engine.files.write(artifact.artifactId, "original.txt", contents));
  return {
    artifactId: artifact.artifactId,
    hash: createHash("sha256").update(contents).digest("hex"),
  };
}

const ANALYZER = {
  generator: "videobook-tagger",
  model: "claude-opus-5",
  extractorVersion: "tags-2026.09/policy-1",
};

describe("tag normalization", () => {
  it("normalizes NFKC, whitespace and case into a stable key", () => {
    expect(normalizeTagLabel("  Beach   Sunset \n")).toBe("Beach Sunset");
    expect(normalizeTagLabel("ﬁlm")).toBe("film");
    expect(tagCanonicalKey(" Wide  Shot ")).toBe("wide shot");
    expect(tagCanonicalKey("CAFÉ")).toBe(tagCanonicalKey("café"));
    expect(tagIdentity("people", "ada")).not.toBe(tagIdentity("places", "ada"));
  });

  it("rejects empty, control-character and oversized labels", () => {
    const bell = String.fromCharCode(7);
    expect(() => normalizeTagLabel("   ")).toThrow(/required/u);
    expect(() => normalizeTagLabel(`bad${bell}tag`)).toThrow(/control/u);
    expect(() => normalizeTagLabel("x".repeat(65))).toThrow(/at most 64/u);
    expect(normalizeTagLabel("x".repeat(64))).toHaveLength(64);
  });
});

describe("engine.tags manual assignments", () => {
  it("tags every artifact kind by artifact id and dedupes chips", async () => {
    const { engine } = await setup();
    for (const kind of [
      "video",
      "image",
      "audio",
      "script",
      "character",
      "prompt",
      "scene",
      "final",
    ] as const) {
      const artifact = value(await engine.artifacts.create({ kind }));
      const state = value(
        await engine.tags.addMany(artifact.artifactId, [
          { facet: "editing", label: "B Roll" },
          { facet: "editing", label: "b  roll" },
          { facet: "people", label: "b roll" },
        ]),
      );
      expect(
        state.manual.map((tag) => tagIdentity(tag.facet, tag.key)),
      ).toEqual(["editing:b roll", "people:b roll"]);
      expect(state.effective).toHaveLength(2);
      expect(state.manual[0]?.label).toBe("B Roll");
    }
    engine.close();
  });

  it("keeps the same word in different facets distinct", async () => {
    const { engine } = await setup();
    const artifact = value(await engine.artifacts.create({ kind: "video" }));
    value(
      await engine.tags.addMany(artifact.artifactId, [
        { facet: "people", label: "Wells" },
        { facet: "places", label: "Wells" },
      ]),
    );
    const state = value(engine.tags.read(artifact.artifactId));
    expect(state.effective.map((tag) => tag.facet)).toEqual([
      "people",
      "places",
    ]);
    value(
      await engine.tags.remove(artifact.artifactId, {
        facet: "people",
        label: "wells",
      }),
    );
    const after = value(engine.tags.read(artifact.artifactId));
    expect(after.effective.map((tag) => tag.facet)).toEqual(["places"]);
    engine.close();
  });

  it("rejects invalid input and enforces the manual ceiling", async () => {
    const { engine } = await setup();
    const artifact = value(await engine.artifacts.create({ kind: "video" }));
    expect(
      failure(
        await engine.tags.add(artifact.artifactId, {
          facet: "editing",
          label: "  ",
        }),
      ).code,
    ).toBe("INVALID_INPUT");
    expect(
      failure(
        await engine.tags.add(artifact.artifactId, {
          facet: "made-up" as "editing",
          label: "x",
        }),
      ).code,
    ).toBe("INVALID_INPUT");
    expect(
      failure(
        await engine.tags.add("not-an-artifact", {
          facet: "editing",
          label: "x",
        }),
      ).code,
    ).toBe("NOT_FOUND");

    const many = Array.from(
      { length: MANUAL_TAGS_PER_ARTIFACT_MAX },
      (_unused, index) => ({ facet: "custom" as const, label: `tag ${index}` }),
    );
    value(await engine.tags.addMany(artifact.artifactId, many));
    const overflow = failure(
      await engine.tags.add(artifact.artifactId, {
        facet: "custom",
        label: "one too many",
      }),
    );
    expect(overflow.code).toBe("RESOURCE_EXHAUSTED");
    expect(value(engine.tags.read(artifact.artifactId)).manual).toHaveLength(
      MANUAL_TAGS_PER_ARTIFACT_MAX,
    );
    engine.close();
  });

  it("does not mint a commit for a duplicate or no-op write", async () => {
    const { engine } = await setup();
    const artifact = value(await engine.artifacts.create({ kind: "video" }));
    const first = await engine.tags.add(artifact.artifactId, {
      facet: "editing",
      label: "Cutaway",
    });
    expect(first.ok).toBe(true);
    const head = engine.head;
    const repeat = await engine.tags.add(artifact.artifactId, {
      facet: "editing",
      label: "Cutaway",
    });
    expect(repeat.ok).toBe(true);
    expect(engine.head).toBe(head);
    const restoreNothing = await engine.tags.restore(artifact.artifactId, {
      facet: "editing",
      label: "never dismissed",
    });
    expect(restoreNothing.ok).toBe(true);
    expect(engine.head).toBe(head);
    engine.close();
  });

  it("carries a confirmed entity reference and keeps that entity alive", async () => {
    const { engine } = await setup();
    const artifact = value(await engine.artifacts.create({ kind: "video" }));
    const entity = value(
      await engine.entities.create("character", "Ada"),
    );
    expect(
      failure(
        await engine.tags.add(artifact.artifactId, {
          facet: "people",
          label: "Ghost",
          entityId: "01890000-0000-7000-8000-000000000000",
        }),
      ).code,
    ).toBe("NOT_FOUND");
    const state = value(
      await engine.tags.add(artifact.artifactId, {
        facet: "people",
        label: "Ada",
        entityId: entity.id,
      }),
    );
    expect(state.manual[0]?.entityId).toBe(entity.id);
    const blocked = failure(await engine.entities.delete(entity.id));
    expect(blocked.code).toBe("IN_USE");
    value(
      await engine.tags.remove(artifact.artifactId, {
        facet: "people",
        label: "Ada",
      }),
    );
    expect((await engine.entities.delete(entity.id)).ok).toBe(true);
    engine.close();
  });
});

describe("engine.tags automatic snapshots", () => {
  it("replaces only the automatic set and never touches manual intent", async () => {
    const { engine, root } = await setup();
    const { artifactId, hash } = await artifactWithFile(engine, root, "first");
    value(
      await engine.tags.add(artifactId, { facet: "editing", label: "Hero" }),
    );
    value(
      await engine.tags.automatic.replace({
        artifactId,
        sourceHash: hash,
        ...ANALYZER,
        tags: [
          { facet: "places", label: "Beach" },
          { facet: "editing", label: "Hero" },
        ],
      }),
    );
    const state = value(engine.tags.read(artifactId));
    expect(state.effective.map((tag) => `${tag.origin}:${tag.key}`)).toEqual([
      "manual:hero",
      "automatic:beach",
    ]);
    expect(state.snapshot?.generation).toBe(1);
    expect(state.snapshot?.tagCount).toBe(2);
    expect(state.snapshot?.stale).toBe(false);

    value(
      await engine.tags.automatic.replace({
        artifactId,
        sourceHash: hash,
        ...ANALYZER,
        tags: [{ facet: "places", label: "Pier" }],
      }),
    );
    const replaced = value(engine.tags.read(artifactId));
    expect(replaced.automatic.map((tag) => tag.key)).toEqual(["pier"]);
    expect(replaced.manual.map((tag) => tag.key)).toEqual(["hero"]);
    expect(replaced.snapshot?.generation).toBe(2);
    engine.close();
  });

  it("distinguishes an empty successful analysis from no analysis", async () => {
    const { engine, root } = await setup();
    const { artifactId, hash } = await artifactWithFile(engine, root, "empty");
    expect(value(engine.tags.automatic.snapshot(artifactId))).toBeUndefined();
    expect(value(engine.tags.read(artifactId)).snapshot).toBeUndefined();
    value(
      await engine.tags.automatic.replace({
        artifactId,
        sourceHash: hash,
        ...ANALYZER,
        tags: [],
      }),
    );
    const snapshot = value(engine.tags.automatic.snapshot(artifactId));
    expect(snapshot?.tagCount).toBe(0);
    expect(snapshot?.generation).toBe(1);
    expect(value(engine.tags.read(artifactId)).automatic).toEqual([]);
    engine.close();
  });

  it("fences stale results and rejects oversized snapshots", async () => {
    const { engine, root } = await setup();
    const { artifactId, hash } = await artifactWithFile(engine, root, "fenced");
    value(
      await engine.tags.automatic.replace({
        artifactId,
        sourceHash: hash,
        ...ANALYZER,
        expectedGeneration: 0,
        tags: [{ facet: "editing", label: "Wide" }],
      }),
    );
    const stale = failure(
      await engine.tags.automatic.replace({
        artifactId,
        sourceHash: hash,
        ...ANALYZER,
        expectedGeneration: 0,
        tags: [{ facet: "editing", label: "Close" }],
      }),
    );
    expect(stale.code).toBe("STALE_REVISION");
    expect(value(engine.tags.read(artifactId)).automatic[0]?.key).toBe("wide");

    expect(
      failure(
        await engine.tags.automatic.replace({
          artifactId,
          sourceHash: "not-a-hash",
          ...ANALYZER,
          tags: [],
        }),
      ).code,
    ).toBe("INVALID_INPUT");
    expect(
      failure(
        await engine.tags.automatic.replace({
          artifactId,
          sourceHash: hash,
          ...ANALYZER,
          tags: Array.from(
            { length: AUTOMATIC_TAGS_PER_SNAPSHOT_MAX + 1 },
            (_unused, index) => ({
              facet: "editing" as const,
              label: `auto ${index}`,
            }),
          ),
        }),
      ).code,
    ).toBe("RESOURCE_EXHAUSTED");
    engine.close();
  });

  it("does not mint a commit when analysis repeats itself", async () => {
    const { engine, root } = await setup();
    const { artifactId, hash } = await artifactWithFile(engine, root, "repeat");
    const request = {
      artifactId,
      sourceHash: hash,
      ...ANALYZER,
      tags: [{ facet: "places" as const, label: "Harbour" }],
    };
    value(await engine.tags.automatic.replace(request));
    const head = engine.head;
    value(await engine.tags.automatic.replace(request));
    expect(engine.head).toBe(head);
    expect(value(engine.tags.automatic.snapshot(artifactId))?.generation).toBe(
      1,
    );
    engine.close();
  });
});

describe("engine.tags dismissals", () => {
  it("suppresses an automatic tag durably until it is restored", async () => {
    const { engine, root } = await setup();
    const { artifactId, hash } = await artifactWithFile(
      engine,
      root,
      "dismiss",
    );
    value(
      await engine.tags.automatic.replace({
        artifactId,
        sourceHash: hash,
        ...ANALYZER,
        tags: [
          { facet: "places", label: "Beach" },
          { facet: "people", label: "Ada" },
        ],
      }),
    );
    value(
      await engine.tags.remove(artifactId, { facet: "places", label: "beach" }),
    );
    const dismissed = value(engine.tags.read(artifactId));
    expect(dismissed.effective.map((tag) => tag.key)).toEqual(["ada"]);
    expect(dismissed.dismissed.map((tag) => tag.key)).toEqual(["beach"]);
    expect(
      dismissed.automatic.find((tag) => tag.key === "beach")?.dismissed,
    ).toBe(true);

    // Re-analysis cannot resurrect a dismissed identity.
    value(
      await engine.tags.automatic.replace({
        artifactId,
        sourceHash: hash,
        ...ANALYZER,
        tags: [
          { facet: "places", label: "Beach" },
          { facet: "places", label: "Pier" },
        ],
      }),
    );
    const reanalyzed = value(engine.tags.read(artifactId));
    expect(reanalyzed.effective.map((tag) => tag.key)).toEqual(["pier"]);

    value(
      await engine.tags.restore(artifactId, {
        facet: "places",
        label: "Beach",
      }),
    );
    const restored = value(engine.tags.read(artifactId));
    expect(restored.effective.map((tag) => tag.key).sort()).toEqual([
      "beach",
      "pier",
    ]);
    expect(restored.dismissed).toEqual([]);
    engine.close();
  });

  it("clears the suppression when the user adds the tag back explicitly", async () => {
    const { engine, root } = await setup();
    const { artifactId, hash } = await artifactWithFile(engine, root, "readd");
    value(
      await engine.tags.automatic.replace({
        artifactId,
        sourceHash: hash,
        ...ANALYZER,
        tags: [{ facet: "editing", label: "Cutaway" }],
      }),
    );
    value(
      await engine.tags.remove(artifactId, {
        facet: "editing",
        label: "Cutaway",
      }),
    );
    const state = value(
      await engine.tags.add(artifactId, {
        facet: "editing",
        label: "Cutaway",
      }),
    );
    expect(state.dismissed).toEqual([]);
    expect(state.effective.map((tag) => tag.origin)).toEqual(["manual"]);
    engine.close();
  });
});

describe("asset tag persistence", () => {
  it("survives reopen, batches reads, and cascades with the artifact", async () => {
    const { engine, root } = await setup();
    const first = await artifactWithFile(engine, root, "alpha");
    const second = await artifactWithFile(engine, root, "beta");
    value(
      await engine.tags.add(first.artifactId, {
        facet: "editing",
        label: "Insert",
      }),
    );
    value(
      await engine.tags.automatic.replace({
        artifactId: second.artifactId,
        sourceHash: second.hash,
        ...ANALYZER,
        tags: [{ facet: "people", label: "Ada" }],
      }),
    );
    engine.close();

    const reopened = createEngine({ rootDir: root });
    await reopened.ready;
    const states = value(
      reopened.tags.readMany([first.artifactId, second.artifactId]),
    );
    expect(
      states.map((state) => state.effective.map((tag) => tag.key)),
    ).toEqual([["insert"], ["ada"]]);
    expect(states[1]?.snapshot?.generator).toBe(ANALYZER.generator);

    value(await reopened.artifacts.delete(first.artifactId));
    const db = new DatabaseSync(path.join(root, "data", "videobook.db"));
    expect(
      db
        .prepare(
          "SELECT COUNT(*) AS total FROM artifact_tags WHERE artifact_id=?",
        )
        .get(first.artifactId),
    ).toEqual({ total: 0 });
    expect(db.prepare("SELECT version FROM engine_schema").get()).toEqual({
      version: SCHEMA_VERSION,
    });
    db.close();
    reopened.close();
  });

  it("marks automatic tags stale once the analyzed content is gone", async () => {
    const { engine, root } = await setup();
    const { artifactId, hash } = await artifactWithFile(engine, root, "source");
    value(
      await engine.tags.add(artifactId, { facet: "custom", label: "Keep" }),
    );
    value(
      await engine.tags.automatic.replace({
        artifactId,
        sourceHash: hash,
        ...ANALYZER,
        tags: [{ facet: "places", label: "Beach" }],
      }),
    );
    expect(value(engine.tags.read(artifactId)).effective).toHaveLength(2);

    value(
      await engine.files.write(artifactId, "original.txt", "replaced content"),
    );

    const state = value(engine.tags.read(artifactId));
    expect(state.snapshot?.stale).toBe(true);
    expect(state.automatic[0]?.stale).toBe(true);
    expect(state.effective.map((tag) => tag.key)).toEqual(["keep"]);
    engine.close();
  });
});
