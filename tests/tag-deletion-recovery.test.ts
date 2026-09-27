import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "@dolthub/doltlite";
import { afterEach, describe, expect, it } from "vitest";
import { createEngine } from "../src/engine.js";
import { ASSET_TAG_TABLES } from "../src/migrate-tags-v24.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) =>
    rm(root, { recursive: true, force: true, maxRetries: 3 })));
});

function value<T>(result: { ok: true; value: T } | { ok: false; error: { message: string } }): T {
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

async function legacyDeletion() {
  const root = await mkdtemp(join(tmpdir(), "videobook-tag-recovery-"));
  roots.push(root);
  const engine = createEngine({ rootDir: root, initialBookName: "tag-recovery" });
  await engine.ready;
  const doomed = value(await engine.artifacts.create("image", "Deleted image"));
  const survivor = value(await engine.artifacts.create("image", "Preserved image"));
  for (const artifact of [doomed, survivor]) {
    value(await engine.files.write(artifact.artifactId, "original.png", "preserved bytes"));
    const file = value(await engine.files.manifest(artifact.artifactId)).files[0]!;
    value(await engine.tags.automatic.replace({
      artifactId: artifact.artifactId,
      sourceHash: file.objectHash,
      generator: "test",
      extractorVersion: "1",
      tags: [{ facet: "places", label: "Beach" }],
    }));
    value(await engine.tags.remove(artifact.artifactId, { facet: "places", label: "Beach" }));
    value(await engine.tags.add(artifact.artifactId, { facet: "custom", label: "Keep" }));
  }
  const survivorTags = value(engine.tags.read(survivor.artifactId));
  const taggedRevision = engine.head;
  const databasePath = join(root, "data", "videobook.db");
  engine.close();
  const db = new DatabaseSync(databasePath);
  try {
    db.exec("PRAGMA foreign_keys=ON");
    db.prepare("DELETE FROM artifacts WHERE artifact_id=?").run(doomed.artifactId);
    for (const table of ["artifacts", "artifact_files"]) {
      db.prepare("SELECT dolt_add(?) AS result").get(table);
    }
    db.prepare("SELECT dolt_commit('-m', 'delete_artifact with legacy write set') AS hash").get();
    const legacyHead = db.doltLog({ limit: 1 })[0]!.commit_hash;
    for (const table of ASSET_TAG_TABLES) {
      expect(db.doltDiff("HEAD", "WORKING", table).length).toBeGreaterThan(0);
    }
    return { root, databasePath, doomed, survivor, survivorTags, taggedRevision, legacyHead };
  } finally {
    db.close();
  }
}

describe("legacy artifact tag deletion recovery", () => {
  it("records only orphan tag removals and preserves existing artifacts, tags and history", async () => {
    const fixture = await legacyDeletion();
    const engine = createEngine({ rootDir: fixture.root });
    await engine.ready;
    let repairedHead: string;
    try {
      expect(engine.artifacts.get(fixture.doomed.artifactId).ok).toBe(false);
      expect(value(engine.tags.read(fixture.survivor.artifactId))).toEqual(fixture.survivorTags);
      expect(value(await engine.files.read(fixture.survivor.artifactId, "original.png")).toString())
        .toBe("preserved bytes");
      const recovery = engine.history.revisions().filter((revision) =>
        revision.operation === "recover_deleted_artifact_tags");
      expect(recovery).toHaveLength(1);
      expect(recovery[0]?.details).toMatchObject({ artifactIds: [fixture.doomed.artifactId] });
      expect(engine.catalogIntegrity().tableRowCounts.runtime_commit_outbox).toBe(0);
      repairedHead = engine.head;
      expect(repairedHead).not.toBe(fixture.legacyHead);
    } finally {
      engine.close();
    }
    const db = new DatabaseSync(fixture.databasePath, { readOnly: true });
    try {
      expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
      for (const table of ASSET_TAG_TABLES) {
        expect(db.doltDiff("HEAD", "WORKING", table)).toEqual([]);
        expect(db.prepare(`SELECT artifact_id FROM dolt_at_${table}(?)`).all(repairedHead))
          .toEqual(Array.from({ length: table === "artifact_tags" ? 2 : 1 }, () =>
            ({ artifact_id: fixture.survivor.artifactId })));
      }
    } finally {
      db.close();
    }
    const reopened = createEngine({ rootDir: fixture.root });
    await reopened.ready;
    try {
      expect(reopened.head).toBe(repairedHead);
      value(await reopened.history.restore(fixture.taggedRevision));
      expect(reopened.artifacts.get(fixture.doomed.artifactId).ok).toBe(true);
      expect(value(reopened.tags.read(fixture.doomed.artifactId)).manual).toHaveLength(1);
    } finally {
      reopened.close();
    }
  });

  it.each(["live-removal", "live-update", "live-addition", "other-table", "staged"] as const)(
    "refuses recovery over %s changes without committing them",
    async (change) => {
      const fixture = await legacyDeletion();
      const db = new DatabaseSync(fixture.databasePath);
      try {
        if (change === "live-removal") {
          db.prepare("DELETE FROM artifact_tags WHERE artifact_id=?").run(fixture.survivor.artifactId);
        } else if (change === "live-update") {
          db.prepare("UPDATE artifact_tags SET label='Edited' WHERE artifact_id=?").run(fixture.survivor.artifactId);
        } else if (change === "live-addition") {
          db.prepare(`INSERT INTO artifact_tags(artifact_id, origin, facet, tag_key, label, created_at)
            VALUES (?, 'manual', 'custom', 'new', 'New', 1)`).run(fixture.survivor.artifactId);
        } else if (change === "other-table") {
          db.prepare("UPDATE book SET name='uncommitted'").run();
        } else {
          db.prepare("SELECT dolt_add('artifact_tags') AS result").get();
        }
      } finally {
        db.close();
      }
      expect(() => createEngine({ rootDir: fixture.root })).toThrow(/uncommitted changes/);
      const verify = new DatabaseSync(fixture.databasePath, { readOnly: true });
      try {
        expect(verify.doltLog({ limit: 1 })[0]!.commit_hash).toBe(fixture.legacyHead);
        expect(verify.prepare("SELECT COUNT(*) AS count FROM runtime_commit_outbox").get())
          .toEqual({ count: 0 });
        expect(verify.doltDiff("HEAD", "WORKING", "artifact_tag_snapshots")).not.toEqual([]);
      } finally {
        verify.close();
      }
    },
  );

  it.each([
    "before-sql-commit", "after-sql-commit", "after-table-stage", "after-dolt-commit",
    "before-outbox-delete", "before-outbox-clear-commit", "after-outbox-clear",
  ] as const)("recovers once after interruption at %s", async (boundary) => {
    const fixture = await legacyDeletion();
    expect(() => createEngine({
      rootDir: fixture.root,
      semanticCommitBoundary(current) {
        if (current === boundary) throw new Error(`interrupted ${boundary}`);
      },
    })).toThrow(`interrupted ${boundary}`);
    const engine = createEngine({ rootDir: fixture.root });
    await engine.ready;
    try {
      expect(engine.history.revisions().filter((revision) =>
        revision.operation === "recover_deleted_artifact_tags")).toHaveLength(1);
      expect(engine.catalogIntegrity().tableRowCounts.runtime_commit_outbox).toBe(0);
      expect(value(engine.tags.read(fixture.survivor.artifactId))).toEqual(fixture.survivorTags);
      expect(engine.artifacts.get(fixture.doomed.artifactId).ok).toBe(false);
    } finally {
      engine.close();
    }
  });
});
