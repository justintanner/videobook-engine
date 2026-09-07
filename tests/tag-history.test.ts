import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";

import { DatabaseSync } from "@dolthub/doltlite";
import { afterEach, describe, expect, it } from "vitest";

import { createEngine, type Engine } from "../src/engine.js";
import type { ArtifactKind } from "../src/engine-types.js";
import { ASSET_TAG_TABLES } from "../src/migrate-tags-v24.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true, maxRetries: 3 })),
  );
});

async function setup(
  name = "history",
): Promise<{ engine: Engine; root: string }> {
  const root = await mkdtemp(path.join(tmpdir(), "vb-tag-history-"));
  roots.push(root);
  const engine = createEngine({ rootDir: root, initialBookName: name });
  await engine.ready;
  return { engine, root };
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
  contents = `${label} bytes`,
  kind: ArtifactKind = "video",
): Promise<{ artifactId: string; hash: string }> {
  const artifact = value(await engine.artifacts.create({ kind, label }));
  value(
    await engine.files.write(artifact.artifactId, "original.txt", contents),
  );
  return {
    artifactId: artifact.artifactId,
    hash: createHash("sha256").update(contents).digest("hex"),
  };
}

function identities(tags: Array<{ facet: string; key: string }>): string[] {
  return tags.map((tag) => `${tag.facet}:${tag.key}`).sort();
}

describe("tag state through history", () => {
  it("restores the tag state a revision recorded", async () => {
    const { engine } = await setup();
    const { artifactId, hash } = await asset(engine, "clip");
    value(
      await engine.tags.automatic.replace({
        artifactId,
        sourceHash: hash,
        ...ANALYZER,
        tags: [{ facet: "places", label: "Beach" }],
      }),
    );
    const tagged = value(
      await engine.tags.add(artifactId, { facet: "editing", label: "Hero" }),
    );
    expect(tagged.effective).toHaveLength(2);
    const revision = engine.head;

    value(
      await engine.tags.remove(artifactId, { facet: "editing", label: "Hero" }),
    );
    value(
      await engine.tags.add(artifactId, { facet: "custom", label: "Later" }),
    );
    expect(identities(value(engine.tags.read(artifactId)).effective)).toEqual([
      "custom:later",
      "places:beach",
    ]);

    // Reading the old revision does not change the live catalog.
    const historical = value(engine.tags.readAtRevision(artifactId, revision));
    expect(identities(historical.effective)).toEqual([
      "editing:hero",
      "places:beach",
    ]);
    expect(historical.dismissed).toEqual([]);
    expect(identities(value(engine.tags.read(artifactId)).effective)).toEqual([
      "custom:later",
      "places:beach",
    ]);

    // An explicit restore may rewind manual edits.
    value(await engine.history.restore(revision));
    const restored = value(engine.tags.read(artifactId));
    expect(identities(restored.effective)).toEqual([
      "editing:hero",
      "places:beach",
    ]);
    expect(restored.dismissed).toEqual([]);
    expect(restored.snapshot?.generation).toBe(1);
    engine.close();
  });

  it("yields an empty tag snapshot for history predating the tag schema", async () => {
    const { engine, root } = await setup();
    const { artifactId } = await asset(engine, "old");
    engine.close();

    // Rewind the catalog to a schema-24 shape and commit it, the way an
    // engine that never knew about tags would have left it.
    const db = new DatabaseSync(path.join(root, "data", "videobook.db"));
    for (const table of ASSET_TAG_TABLES) db.exec(`DROP TABLE ${table}`);
    db.prepare("UPDATE engine_schema SET version=24 WHERE singleton=1").run();
    for (const table of [...ASSET_TAG_TABLES, "engine_schema"]) {
      db.prepare("SELECT dolt_add(?) AS result").get(table);
    }
    db.prepare(
      "SELECT dolt_commit('-m', 'pre-tag revision', '--author', 'Videobook <videobook@localhost>') AS hash",
    ).get();
    const preTagRevision = db.doltLog({ limit: 1 })[0]!.commit_hash;
    db.close();

    const upgraded = createEngine({ rootDir: root });
    await upgraded.ready;
    value(
      await upgraded.tags.add(artifactId, { facet: "editing", label: "Now" }),
    );
    const historical = value(
      upgraded.tags.readAtRevision(artifactId, preTagRevision),
    );
    expect(historical).toEqual({
      artifactId,
      effective: [],
      manual: [],
      automatic: [],
      dismissed: [],
    });
    // The pre-tag revision is refused as a restore target rather than
    // silently downgrading the catalog.
    expect(failure(await upgraded.history.restore(preTagRevision)).code).toBe(
      "SCHEMA_INCOMPATIBLE",
    );
    expect(value(upgraded.tags.read(artifactId)).effective).toHaveLength(1);
    upgraded.close();
  });

  it("keeps manual intent when the source is replaced in place", async () => {
    const { engine } = await setup();
    const { artifactId, hash } = await asset(engine, "source");
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
      await engine.tags.add(artifactId, { facet: "editing", label: "Hero" }),
    );
    value(
      await engine.tags.remove(artifactId, { facet: "people", label: "Ada" }),
    );

    const replacement = "replaced bytes";
    value(await engine.files.write(artifactId, "original.txt", replacement));
    const afterReplace = value(engine.tags.read(artifactId));
    expect(identities(afterReplace.effective)).toEqual(["editing:hero"]);
    expect(afterReplace.snapshot?.stale).toBe(true);
    expect(identities(afterReplace.dismissed)).toEqual(["people:ada"]);

    // Fresh analysis of the new bytes makes automatic output effective
    // again, and the dismissal still holds.
    value(
      await engine.tags.automatic.replace({
        artifactId,
        sourceHash: createHash("sha256").update(replacement).digest("hex"),
        ...ANALYZER,
        tags: [
          { facet: "places", label: "Pier" },
          { facet: "people", label: "Ada" },
        ],
      }),
    );
    const refreshed = value(engine.tags.read(artifactId));
    expect(identities(refreshed.effective)).toEqual([
      "editing:hero",
      "places:pier",
    ]);
    expect(refreshed.snapshot?.stale).toBe(false);
    engine.close();
  });

  it("drops tag rows when the artifact is deleted", async () => {
    const { engine, root } = await setup();
    const { artifactId, hash } = await asset(engine, "doomed");
    value(
      await engine.tags.automatic.replace({
        artifactId,
        sourceHash: hash,
        ...ANALYZER,
        tags: [{ facet: "places", label: "Beach" }],
      }),
    );
    value(
      await engine.tags.remove(artifactId, { facet: "places", label: "Beach" }),
    );
    value(await engine.artifacts.delete(artifactId));

    const db = new DatabaseSync(path.join(root, "data", "videobook.db"));
    for (const table of ASSET_TAG_TABLES) {
      expect(
        db.prepare(`SELECT COUNT(*) AS total FROM ${table}`).get(),
      ).toEqual({ total: 0 });
    }
    db.close();
    expect(failure(engine.tags.read(artifactId)).code).toBe("NOT_FOUND");
    engine.close();
  });
});

describe("tag snapshot transfer", () => {
  it("copies manual intent and valid automatic evidence to a duplicate", async () => {
    const { engine } = await setup();
    const source = await asset(engine, "source", "identical bytes");
    const duplicate = await asset(engine, "duplicate", "identical bytes");
    expect(duplicate.hash).toBe(source.hash);

    value(
      await engine.tags.automatic.replace({
        artifactId: source.artifactId,
        sourceHash: source.hash,
        ...ANALYZER,
        tags: [
          { facet: "places", label: "Beach" },
          { facet: "people", label: "Ada" },
        ],
      }),
    );
    value(
      await engine.tags.addMany(source.artifactId, [
        { facet: "editing", label: "Hero" },
        { facet: "custom", label: "Favourite" },
      ]),
    );
    value(
      await engine.tags.remove(source.artifactId, {
        facet: "people",
        label: "Ada",
      }),
    );

    const snapshot = value(engine.tags.export(source.artifactId));
    expect(snapshot.manual.map((tag) => tag.label).sort()).toEqual([
      "Favourite",
      "Hero",
    ]);
    expect(snapshot.dismissed).toEqual([{ facet: "people", label: "Ada" }]);
    expect(snapshot.automatic?.sourceHash).toBe(source.hash);

    const imported = value(
      await engine.tags.import(duplicate.artifactId, snapshot),
    );
    expect(imported.skippedAutomatic).toBe(false);
    expect(imported.importedManual).toBe(2);
    expect(imported.importedDismissals).toBe(1);
    expect(identities(imported.state.effective)).toEqual(
      identities(value(engine.tags.read(source.artifactId)).effective),
    );
    expect(imported.state.snapshot?.generation).toBe(1);

    // The copy edits independently.
    value(
      await engine.tags.add(duplicate.artifactId, {
        facet: "custom",
        label: "Copy only",
      }),
    );
    expect(
      identities(value(engine.tags.read(duplicate.artifactId)).effective),
    ).toContain("custom:copy only");
    expect(
      identities(value(engine.tags.read(source.artifactId)).effective),
    ).not.toContain("custom:copy only");

    // Re-importing the same snapshot changes nothing and mints no commit.
    const head = engine.head;
    const again = value(
      await engine.tags.import(duplicate.artifactId, snapshot),
    );
    expect(again.importedManual).toBe(0);
    expect(engine.head).toBe(head);
    engine.close();
  });

  it("refuses to hand automatic evidence to a derivative", async () => {
    const { engine } = await setup();
    const source = await asset(engine, "source", "original bytes");
    const derivative = await asset(engine, "derivative", "edited bytes");
    value(
      await engine.tags.automatic.replace({
        artifactId: source.artifactId,
        sourceHash: source.hash,
        ...ANALYZER,
        tags: [{ facet: "places", label: "Beach" }],
      }),
    );
    value(
      await engine.tags.add(source.artifactId, {
        facet: "editing",
        label: "Hero",
      }),
    );

    const imported = value(
      await engine.tags.import(
        derivative.artifactId,
        value(engine.tags.export(source.artifactId)),
      ),
    );
    expect(imported.skippedAutomatic).toBe(true);
    expect(imported.importedAutomatic).toBe(0);
    expect(identities(imported.state.effective)).toEqual(["editing:hero"]);
    expect(imported.state.snapshot).toBeUndefined();
    engine.close();
  });

  it("carries tags across engines with destination-local identities", async () => {
    const { engine: source } = await setup("source-book");
    const { engine: destination } = await setup("destination-book");
    const contents = "shared bytes";
    const here = await asset(source, "here", contents);
    const there = await asset(destination, "there", contents);
    const entity = value(await source.entities.create("character", "Ada"));

    value(
      await source.tags.automatic.replace({
        artifactId: here.artifactId,
        sourceHash: here.hash,
        ...ANALYZER,
        tags: [{ facet: "places", label: "Beach" }],
      }),
    );
    value(
      await source.tags.add(here.artifactId, {
        facet: "people",
        label: "Ada",
        entityId: entity.id,
      }),
    );

    const snapshot = value(source.tags.export(here.artifactId));
    expect(snapshot.manual[0]?.entityId).toBe(entity.id);
    const imported = value(
      await destination.tags.import(there.artifactId, snapshot),
    );
    expect(identities(imported.state.effective)).toEqual([
      "people:ada",
      "places:beach",
    ]);
    // The source book's entity does not exist here, so the reference is
    // dropped rather than dangling.
    expect(imported.state.manual[0]?.entityId).toBeUndefined();
    expect(imported.state.snapshot?.sourceHash).toBe(here.hash);

    expect(
      failure(
        await destination.tags.import(there.artifactId, {
          ...snapshot,
          version: 99,
        }),
      ).code,
    ).toBe("INVALID_INPUT");
    source.close();
    destination.close();
  });
});
