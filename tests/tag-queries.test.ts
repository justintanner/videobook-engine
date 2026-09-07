import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { EngineContext } from "../src/context.js";
import { createEngine, type Engine } from "../src/engine.js";
import type { ArtifactKind, TagFilter } from "../src/engine-types.js";
import { createArtifactsApi } from "../src/artifacts.js";
import { createTagsApi } from "../src/tags.js";
import { tagIdentity } from "../src/tag-values.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true, maxRetries: 3 })),
  );
});

async function setup(): Promise<Engine> {
  const root = await mkdtemp(path.join(tmpdir(), "vb-tag-queries-"));
  roots.push(root);
  const engine = createEngine({ rootDir: root, initialBookName: "queries" });
  await engine.ready;
  return engine;
}

function value<T>(
  result: { ok: true; value: T } | { ok: false; error: { message: string } },
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

const ANALYZER = {
  generator: "videobook-tagger",
  extractorVersion: "tags-2026.09/policy-1",
};

async function asset(
  engine: Engine,
  label: string,
  kind: ArtifactKind = "video",
): Promise<{ artifactId: string; hash: string }> {
  const artifact = value(await engine.artifacts.create({ kind, label }));
  const contents = `${label} bytes`;
  value(
    await engine.files.write(artifact.artifactId, "original.txt", contents),
  );
  return {
    artifactId: artifact.artifactId,
    hash: createHash("sha256").update(contents).digest("hex"),
  };
}

function keys(page: { artifacts: Array<{ tags: Array<{ key: string }> }> }) {
  return page.artifacts.map((entry) => entry.tags.map((tag) => tag.key));
}

function labels(engine: Engine, filter: TagFilter = {}): string[] {
  return value(engine.tags.query(filter)).artifacts.map(
    (entry) => entry.artifact.label ?? "",
  );
}

describe("engine.tags.query", () => {
  it("matches all and any on facet-qualified identities", async () => {
    const engine = await setup();
    const interview = await asset(engine, "interview");
    const studio = await asset(engine, "studio");
    const street = await asset(engine, "street");
    value(
      await engine.tags.addMany(interview.artifactId, [
        { facet: "people", label: "Interviewee" },
        { facet: "places", label: "Studio" },
        { facet: "editing", label: "Close Up" },
      ]),
    );
    value(
      await engine.tags.addMany(studio.artifactId, [
        { facet: "places", label: "Studio" },
        { facet: "editing", label: "Wide" },
      ]),
    );
    value(
      await engine.tags.addMany(street.artifactId, [
        { facet: "people", label: "Studio" },
      ]),
    );

    expect(
      labels(engine, {
        all: [
          { facet: "people", label: "interviewee" },
          { facet: "places", label: "STUDIO" },
          { facet: "editing", label: "close up" },
        ],
      }),
    ).toEqual(["interview"]);
    expect(
      labels(engine, { all: [{ facet: "places", label: "Studio" }] }),
    ).toEqual(["interview", "studio"]);
    // The same word in another facet is a different identity.
    expect(
      labels(engine, { all: [{ facet: "people", label: "Studio" }] }),
    ).toEqual(["street"]);
    expect(
      labels(engine, {
        any: [
          { facet: "editing", label: "Wide" },
          { facet: "people", label: "Interviewee" },
        ],
      }),
    ).toEqual(["interview", "studio"]);
    expect(
      labels(engine, {
        all: [{ facet: "places", label: "Studio" }],
        any: [{ facet: "editing", label: "Wide" }],
      }),
    ).toEqual(["studio"]);
    engine.close();
  });

  it("keeps an empty filter equivalent to listing every artifact", async () => {
    const engine = await setup();
    await asset(engine, "one");
    await asset(engine, "two", "image");
    const page = value(engine.tags.query());
    expect(page.total).toBe(2);
    expect(page.artifacts.map((entry) => entry.artifact.artifactId)).toEqual(
      engine.artifacts
        .list({ sort: "oldest" })
        .map((artifact) => artifact.artifactId),
    );
    expect(keys(page)).toEqual([[], []]);
    engine.close();
  });

  it("constrains matches by artifact kind", async () => {
    const engine = await setup();
    const clip = await asset(engine, "clip", "video");
    const still = await asset(engine, "still", "image");
    for (const artifact of [clip, still]) {
      value(
        await engine.tags.add(artifact.artifactId, {
          facet: "editing",
          label: "Insert",
        }),
      );
    }
    expect(
      labels(engine, {
        all: [{ facet: "editing", label: "Insert" }],
        kinds: ["image"],
      }),
    ).toEqual(["still"]);
    expect(
      value(
        engine.tags.facets({
          all: [{ facet: "editing", label: "Insert" }],
          kinds: ["image"],
        }),
      ),
    ).toEqual([
      { facet: "editing", key: "insert", label: "Insert", artifacts: 1 },
    ]);
    engine.close();
  });

  it("excludes dismissed and stale automatic tags from every read", async () => {
    const engine = await setup();
    const kept = await asset(engine, "kept");
    const dismissed = await asset(engine, "dismissed");
    const stale = await asset(engine, "stale");
    for (const artifact of [kept, dismissed, stale]) {
      value(
        await engine.tags.automatic.replace({
          artifactId: artifact.artifactId,
          sourceHash: artifact.hash,
          ...ANALYZER,
          tags: [{ facet: "places", label: "Beach" }],
        }),
      );
    }
    value(
      await engine.tags.remove(dismissed.artifactId, {
        facet: "places",
        label: "Beach",
      }),
    );
    value(
      await engine.files.write(stale.artifactId, "original.txt", "new bytes"),
    );

    expect(
      labels(engine, { all: [{ facet: "places", label: "Beach" }] }),
    ).toEqual(["kept"]);
    expect(value(engine.tags.facets())).toEqual([
      { facet: "places", key: "beach", label: "Beach", artifacts: 1 },
    ]);
    // A manual tag on the stale artifact still matches: only the automatic
    // evidence went stale.
    value(
      await engine.tags.add(stale.artifactId, {
        facet: "places",
        label: "Beach",
      }),
    );
    expect(
      labels(engine, { all: [{ facet: "places", label: "Beach" }] }),
    ).toEqual(["kept", "stale"]);
    engine.close();
  });

  it("reports the same effective tags as engine.tags.read", async () => {
    const engine = await setup();
    const mixed = await asset(engine, "mixed");
    value(
      await engine.tags.automatic.replace({
        artifactId: mixed.artifactId,
        sourceHash: mixed.hash,
        ...ANALYZER,
        tags: [
          { facet: "places", label: "Pier" },
          { facet: "editing", label: "Cutaway" },
          { facet: "people", label: "Ada" },
        ],
      }),
    );
    value(
      await engine.tags.addMany(mixed.artifactId, [
        { facet: "editing", label: "CUTAWAY" },
        { facet: "custom", label: "Favourite" },
      ]),
    );
    value(
      await engine.tags.remove(mixed.artifactId, {
        facet: "people",
        label: "Ada",
      }),
    );

    const read = value(engine.tags.read(mixed.artifactId));
    const queried = value(engine.tags.query()).artifacts[0];
    expect(
      queried?.tags
        .map((tag) => `${tag.origin}:${tagIdentity(tag.facet, tag.key)}`)
        .sort(),
    ).toEqual(
      read.effective
        .map((tag) => `${tag.origin}:${tagIdentity(tag.facet, tag.key)}`)
        .sort(),
    );
    // The manual spelling wins the shared identity.
    expect(queried?.tags.find((tag) => tag.key === "cutaway")).toMatchObject({
      label: "CUTAWAY",
      origin: "manual",
    });
    engine.close();
  });

  it("pages deterministically with stable totals", async () => {
    const engine = await setup();
    const created: string[] = [];
    for (let index = 0; index < 7; index += 1) {
      const artifact = await asset(engine, `asset-${index}`);
      created.push(artifact.artifactId);
      value(
        await engine.tags.add(artifact.artifactId, {
          facet: "editing",
          label: "Selects",
        }),
      );
    }
    const filter: TagFilter = { all: [{ facet: "editing", label: "Selects" }] };
    const seen: string[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const page = value(
        engine.tags.query(filter, { limit: 3, ...(cursor ? { cursor } : {}) }),
      );
      expect(page.total).toBe(7);
      seen.push(...page.artifacts.map((entry) => entry.artifact.artifactId));
      cursor = page.nextCursor;
      pages += 1;
    } while (cursor !== undefined);
    expect(pages).toBe(3);
    expect(seen).toEqual(created);
    expect(new Set(seen).size).toBe(7);
    expect(failure(engine.tags.query({}, { limit: 0 })).code).toBe(
      "INVALID_INPUT",
    );
    expect(failure(engine.tags.query({}, { cursor: "!!" })).code).toBe(
      "INVALID_INPUT",
    );
    engine.close();
  });

  it("hands a composing search the full candidate set, unpaged", async () => {
    const engine = await setup();
    for (let index = 0; index < 4; index += 1) {
      const artifact = await asset(engine, `candidate-${index}`);
      value(
        await engine.tags.add(artifact.artifactId, {
          facet: "editing",
          label: "Selects",
        }),
      );
    }
    const candidates = value(
      engine.tags.candidates({ all: [{ facet: "editing", label: "selects" }] }),
    );
    expect(candidates).toHaveLength(4);
    expect(value(engine.tags.query({}, { limit: 2 })).artifacts).toHaveLength(
      2,
    );
    engine.close();
  });
});

describe("engine.tags facets and autocomplete", () => {
  it("counts distinct artifacts across every page, not assignment rows", async () => {
    const engine = await setup();
    for (let index = 0; index < 5; index += 1) {
      const artifact = await asset(engine, `beach-${index}`);
      value(
        await engine.tags.addMany(artifact.artifactId, [
          { facet: "places", label: "Beach" },
          { facet: "editing", label: "Wide" },
        ]),
      );
    }
    const solo = await asset(engine, "solo");
    value(
      await engine.tags.add(solo.artifactId, {
        facet: "places",
        label: "Beach",
      }),
    );

    const facets = value(engine.tags.facets());
    expect(facets).toEqual([
      { facet: "places", key: "beach", label: "Beach", artifacts: 6 },
      { facet: "editing", key: "wide", label: "Wide", artifacts: 5 },
    ]);
    // A page of 1 does not shrink the counts.
    expect(value(engine.tags.query({}, { limit: 1 })).artifacts).toHaveLength(
      1,
    );
    expect(value(engine.tags.facets({}, { limit: 1 }))).toEqual([facets[0]]);
    engine.close();
  });

  it("suggests known values by prefix and facet with the manual label", async () => {
    const engine = await setup();
    const clip = await asset(engine, "clip");
    value(
      await engine.tags.automatic.replace({
        artifactId: clip.artifactId,
        sourceHash: clip.hash,
        ...ANALYZER,
        tags: [
          { facet: "places", label: "beach house" },
          { facet: "places", label: "Bermuda" },
          { facet: "people", label: "Beatrice" },
        ],
      }),
    );
    value(
      await engine.tags.add(clip.artifactId, {
        facet: "places",
        label: "Beach House",
      }),
    );

    expect(
      value(engine.tags.suggest({ prefix: "Be" })).map((entry) => entry.key),
    ).toEqual(["beatrice", "beach house", "bermuda"]);
    expect(
      value(engine.tags.suggest({ prefix: " be ", facet: "places" })).map(
        (entry) => entry.key,
      ),
    ).toEqual(["beach house", "bermuda"]);
    expect(value(engine.tags.suggest({ prefix: "beach" }))[0]?.label).toBe(
      "Beach House",
    );
    expect(value(engine.tags.suggest({ prefix: "zz" }))).toEqual([]);
    // Wildcards in a prefix are literal, not patterns.
    expect(value(engine.tags.suggest({ prefix: "%" }))).toEqual([]);
    engine.close();
  });

  it("drops suggestions once their only evidence is dismissed", async () => {
    const engine = await setup();
    const clip = await asset(engine, "clip");
    value(
      await engine.tags.automatic.replace({
        artifactId: clip.artifactId,
        sourceHash: clip.hash,
        ...ANALYZER,
        tags: [{ facet: "places", label: "Harbour" }],
      }),
    );
    expect(value(engine.tags.suggest({ prefix: "har" }))).toHaveLength(1);
    value(
      await engine.tags.remove(clip.artifactId, {
        facet: "places",
        label: "Harbour",
      }),
    );
    expect(value(engine.tags.suggest({ prefix: "har" }))).toEqual([]);
    engine.close();
  });
});

describe("tag query cost", () => {
  it("costs the same fixed number of statements as the catalog grows", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "vb-tag-cost-"));
    roots.push(root);
    const context = new EngineContext({
      dataDir: path.join(root, "data"),
      workspaceDir: path.join(root, "workspace"),
      initialBookName: "cost",
    });
    const tags = createTagsApi(context);
    const artifacts = createArtifactsApi(context);
    const filter: TagFilter = { all: [{ facet: "editing", label: "Selects" }] };

    // Instrument the real statement path: no stubbing, every call still
    // runs against the catalog.
    const db = context.store.db;
    const prepare = db.prepare.bind(db);
    let statements = 0;
    const count = <T>(work: () => T): number => {
      statements = 0;
      Object.defineProperty(db, "prepare", {
        value: (sql: string) => {
          statements += 1;
          return prepare(sql);
        },
        configurable: true,
        writable: true,
      });
      try {
        work();
        return statements;
      } finally {
        Reflect.deleteProperty(db, "prepare");
      }
    };

    const measure = (): [number, number, number] => [
      count(() => value(tags.query(filter))),
      count(() => value(tags.candidates(filter))),
      count(() => value(tags.facets(filter))),
    ];

    const grow = async (count: number): Promise<void> => {
      for (let index = 0; index < count; index += 1) {
        const artifact = value(
          await artifacts.create({ kind: "video", label: `cost-${index}` }),
        );
        value(
          await tags.add(artifact.artifactId, {
            facet: "editing",
            label: "Selects",
          }),
        );
      }
    };

    await grow(5);
    const small = measure();
    await grow(45);
    const large = measure();
    expect(value(tags.query(filter)).total).toBe(50);
    // query: page + total + page tags = 3; candidates: 1; facets: counts +
    // preferred labels = 2. Unchanged by a ten-fold larger catalog.
    expect(small).toEqual([3, 1, 2]);
    expect(large).toEqual(small);
    context.close();
  });
});
