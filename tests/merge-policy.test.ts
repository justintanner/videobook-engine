import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";

import { DatabaseSync } from "@dolthub/doltlite";
import { v7 as uuidv7 } from "uuid";
import { afterEach, describe, expect, it } from "vitest";

import { createEngine, type Engine } from "../src/engine.js";
import type { EngineError } from "../src/engine-types.js";
import {
  assertSameSchemaVersion,
  findSlugConflicts,
  mergeWithPolicy,
  reconcileSingletonFlags,
  verifyConstraintHealth,
  type MergePolicyOutcome,
  type SlugConflict,
} from "../src/merge-policy.js";
import { SEMANTIC_SCHEMA_SQL } from "../src/schema.js";
import { EngineFault } from "../src/store.js";

// These tests merge against the REAL semantic table DDL (extracted verbatim
// from SEMANTIC_SCHEMA_SQL) with UNIQUE, CHECK, and RESTRICT FK constraints
// intact — unlike the older merge tests in tests/dolt-native.test.ts, which
// use stripped-down table definitions.
//
// ve-wsu: doltlite corrupts a full engine catalog on dolt_checkout, its
// "uncommitted changes" merge guard deterministically misfires once a
// working root has >=10 tables, and dolt_checkout drops secondary UNIQUE
// index rows once the working set has three or more tables (so branch
// writes to UNIQUE-indexed tables like artifacts fail with "database disk
// image is malformed" in larger fixtures). Each test database stays well
// under the guard limit and picks branch-write tables accordingly, while
// covering every table its scenario touches. Engine-level branch/merge on
// the full catalog is the ve-mim.7 follow-up.

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

/** Extracts the real CREATE TABLE statements for the given tables. */
function realSchemaSql(tables: readonly string[]): string {
  const wanted = new Set(tables);
  return SEMANTIC_SCHEMA_SQL.split(/;\s*\n/)
    .map((statement) => statement.trim())
    .filter((statement) => {
      const match = /^CREATE TABLE IF NOT EXISTS (\w+)/.exec(statement);
      return match !== null && wanted.has(match[1]!);
    })
    .map((statement) => `${statement};`)
    .join("\n");
}

async function mergeDb(tables: readonly string[]): Promise<DatabaseSync> {
  const root = await mkdtemp(path.join(tmpdir(), "videobook-merge-policy-"));
  roots.push(root);
  const db = new DatabaseSync(path.join(root, "merge.db"));
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(realSchemaSql(tables));
  return db;
}

function commitTables(
  db: DatabaseSync,
  tables: string[],
  message: string,
): void {
  for (const table of tables) {
    db.prepare("SELECT dolt_add(?) AS result").get(table);
  }
  db.prepare("SELECT dolt_commit('-m', ?) AS hash").get(message);
}

function fork(
  db: DatabaseSync,
  branch: string,
  tables: string[],
  mutate: () => void,
): void {
  db.doltBranch(branch);
  db.doltCheckout(branch);
  mutate();
  commitTables(db, tables, branch);
  db.doltCheckout("main");
  db.doltReset("--hard");
}

function expectFault(work: () => unknown): EngineError {
  try {
    work();
  } catch (error) {
    if (error instanceof EngineFault) return error.error;
    throw error;
  }
  throw new Error("Expected an EngineFault");
}

function slugConflictsOf(error: EngineError): SlugConflict[] {
  return (error.details?.slugConflicts ?? []) as SlugConflict[];
}

async function setupEngine(initialBookSlug = "merge-book"): Promise<{
  engine: Engine;
  root: string;
  dataDir: string;
}> {
  const root = await mkdtemp(path.join(tmpdir(), "videobook-merge-engine-"));
  roots.push(root);
  const dataDir = path.join(root, "data");
  return {
    engine: createEngine({
      dataDir,
      workspaceDir: path.join(root, "workspace"),
      initialBookSlug,
    }),
    root,
    dataDir,
  };
}

function value<T>(
  result: { ok: true; value: T } | { ok: false; error: { message: string } },
): T {
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

describe("merge policy preconditions", () => {
  it("refuses a merge across different engine_schema versions", async () => {
    const db = await mergeDb(["engine_schema"]);
    db.prepare(
      "INSERT INTO engine_schema(singleton, version, created_at) VALUES (1, 18, 0)",
    ).run();
    commitTables(db, ["engine_schema"], "base v18");
    fork(db, "v19", ["engine_schema"], () => {
      db.prepare("UPDATE engine_schema SET version=19 WHERE singleton=1").run();
    });

    const direct = expectFault(() =>
      assertSameSchemaVersion(db, "HEAD", "v19"),
    );
    expect(direct.code).toBe("SCHEMA_INCOMPATIBLE");
    const error = expectFault(() => mergeWithPolicy(db, "v19"));
    expect(error.code).toBe("SCHEMA_INCOMPATIBLE");
    expect(error.message).toContain("19");
    expect(error.details).toMatchObject({
      oursVersion: 18,
      theirsVersion: 19,
    });
    // The refusal happens before any merge is attempted.
    expect(
      (db.prepare("SELECT version FROM engine_schema").get() as {
        version: number;
      }).version,
    ).toBe(18);
    db.close();
  });
});

describe("merge policy for unique artifact slugs", () => {
  it("surfaces cross-fork slug collisions as user-facing merge conflicts", async () => {
    const db = await mergeDb(["engine_schema", "artifacts"]);
    const baseArtifact = uuidv7();
    const leftArtifact = uuidv7();
    const rightArtifact = uuidv7();
    db.prepare(
      "INSERT INTO engine_schema(singleton, version, created_at) VALUES (1, 18, 0)",
    ).run();
    db.prepare(
      "INSERT INTO artifacts(artifact_id, slug, kind, created_at) VALUES (?, 'vid-base', 'video', 0)",
    ).run(baseArtifact);
    commitTables(db, ["engine_schema", "artifacts"], "base");
    for (const [branch, artifactId] of [
      ["fork-left", leftArtifact],
      ["fork-right", rightArtifact],
    ] as const) {
      fork(db, branch, ["artifacts"], () => {
        db.prepare(
          "INSERT INTO artifacts(artifact_id, slug, kind, created_at) VALUES (?, 'vid-cat', 'video', 1)",
        ).run(artifactId);
      });
    }

    const first: MergePolicyOutcome = mergeWithPolicy(db, "fork-left");
    expect(first.reconciledTranscripts).toBe(0);

    // The policy detects the collision before merging and reports it with
    // the slug and both artifact ids.
    const error = expectFault(() => mergeWithPolicy(db, "fork-right"));
    expect(error.code).toBe("MERGE_CONFLICT");
    expect(error.message).toContain("vid-cat");
    expect(slugConflictsOf(error)).toEqual([
      {
        slug: "vid-cat",
        artifactIds: [leftArtifact, rightArtifact].sort(),
      },
    ]);
    expect(findSlugConflicts(db, "HEAD", "fork-right")).toEqual(
      slugConflictsOf(error),
    );

    // doltlite's own merge-time verification is the backstop: it refuses
    // the UNIQUE violation atomically instead of committing a bad working
    // set, so no partial merge state exists either way.
    expect(() => db.doltMerge("fork-right")).toThrow(/constraint violations/);
    expect(
      db
        .prepare("SELECT artifact_id FROM artifacts ORDER BY slug")
        .all() as Array<{ artifact_id: string }>,
    ).toEqual([{ artifact_id: baseArtifact }, { artifact_id: leftArtifact }]);
    verifyConstraintHealth(db);
    db.close();
  });

  it("maps same-row edits on both forks to a row-level merge conflict", async () => {
    const db = await mergeDb(["engine_schema", "artifacts"]);
    const artifactId = uuidv7();
    db.prepare(
      "INSERT INTO engine_schema(singleton, version, created_at) VALUES (1, 18, 0)",
    ).run();
    db.prepare(
      "INSERT INTO artifacts(artifact_id, slug, kind, created_at) VALUES (?, 'vid-base', 'video', 0)",
    ).run(artifactId);
    commitTables(db, ["engine_schema", "artifacts"], "base");
    for (const [branch, slug] of [
      ["fork-left", "vid-left"],
      ["fork-right", "vid-right"],
    ] as const) {
      fork(db, branch, ["artifacts"], () => {
        db.prepare("UPDATE artifacts SET slug=? WHERE artifact_id=?").run(
          slug,
          artifactId,
        );
      });
    }

    mergeWithPolicy(db, "fork-left");
    // Each fork's slug is held by exactly one row, so this is not a slug
    // conflict; the same-row edit is Dolt's row-level conflict instead.
    expect(findSlugConflicts(db, "HEAD", "fork-right")).toEqual([]);
    const error = expectFault(() => mergeWithPolicy(db, "fork-right"));
    expect(error.code).toBe("MERGE_CONFLICT");
    expect(error.message).toContain("fork-right");
    db.close();
  });
});

describe("merge policy for RESTRICT foreign keys", () => {
  it("surfaces delete-vs-reference dangles as typed violations", async () => {
    // The dangle is built on objects/pinned_search_results rather than
    // artifacts/cells: doltlite's dolt_checkout drops secondary UNIQUE
    // index rows once the working set has three or more tables (ve-wsu),
    // so branch writes must stick to primary-key-indexed tables —
    // artifacts.slug would fail with "database disk image is malformed"
    // before the merge policy ever runs. objects and
    // pinned_search_results carry the same ON DELETE RESTRICT semantics
    // with primary keys only.
    const tables = [
      "engine_schema",
      "artifacts",
      "objects",
      "notebooks",
      "cells",
      "entities",
      "pinned_search_results",
    ];
    const db = await mergeDb(tables);
    const artifactId = uuidv7();
    const notebookId = uuidv7();
    const cellId = uuidv7();
    db.prepare(
      "INSERT INTO engine_schema(singleton, version, created_at) VALUES (1, 18, 0)",
    ).run();
    db.prepare(
      "INSERT INTO artifacts(artifact_id, slug, kind, created_at) VALUES (?, 'vid-doomed', 'video', 0)",
    ).run(artifactId);
    db.prepare(
      "INSERT INTO objects(object_hash, size_bytes, created_at) VALUES ('o-doomed', 1, 0)",
    ).run();
    db.prepare(
      "INSERT INTO notebooks(notebook_id, name, created_at) VALUES (?, 'Graph', 0)",
    ).run(notebookId);
    db.prepare(
      `INSERT INTO cells(
        notebook_id, cell_id, type, slug, grid_row, grid_column, inputs_json
      ) VALUES (?, ?, 'image', 'img-base', 0, 0, '{}')`,
    ).run(notebookId, cellId);
    commitTables(db, tables, "base");

    fork(db, "fork-delete", ["objects"], () => {
      db.prepare("DELETE FROM objects WHERE object_hash='o-doomed'").run();
    });
    // The other fork pins a search result whose object_hash RESTRICT-
    // references the object the first fork deleted.
    fork(db, "fork-reference", ["pinned_search_results"], () => {
      db.prepare(
        `INSERT INTO pinned_search_results(
          notebook_id, cell_id, result_id, artifact_id, object_hash,
          location_json, representative_json, query_json, signals_json,
          selected_revision, ordinal, created_at
        ) VALUES (?, ?, 'r1', ?, 'o-doomed', '{}', NULL, '{}', '{}', 'rev', 0, 0)`,
      ).run(notebookId, cellId, artifactId);
    });

    mergeWithPolicy(db, "fork-delete");
    expect(
      db.prepare("SELECT COUNT(*) AS count FROM objects").get() as {
        count: number;
      },
    ).toEqual({ count: 0 });

    // doltlite's merge-time constraint verification refuses the dangle and
    // rolls back; the policy maps that refusal to a typed violation error.
    const error = expectFault(() => mergeWithPolicy(db, "fork-reference"));
    expect(error.code).toBe("MERGE_VIOLATION");
    expect(error.message).toContain("constraint verification");
    expect(error.details?.branch).toBe("fork-reference");

    // The rollback leaves the working set exactly as the first merge left
    // it: object gone, no referencing row committed.
    expect(
      db
        .prepare("SELECT COUNT(*) AS count FROM pinned_search_results")
        .get() as { count: number },
    ).toEqual({ count: 0 });
    verifyConstraintHealth(db);
    db.close();
  });
});

describe("merge policy for derived singleton flags", () => {
  async function transcriptDb(): Promise<{
    db: DatabaseSync;
    artifactId: string;
    streamId: string;
  }> {
    const db = await mergeDb([
      "engine_schema",
      "artifacts",
      "objects",
      "artifact_files",
      "artifact_streams",
      "transcripts",
    ]);
    const artifactId = uuidv7();
    const streamId = uuidv7();
    db.prepare(
      "INSERT INTO engine_schema(singleton, version, created_at) VALUES (1, 18, 0)",
    ).run();
    db.prepare(
      "INSERT INTO artifacts(artifact_id, slug, kind, created_at) VALUES (?, 'vid-talk', 'video', 0)",
    ).run(artifactId);
    db.prepare(
      "INSERT INTO objects(object_hash, size_bytes, created_at) VALUES ('h-source', 1, 0), ('h-payload', 1, 0)",
    ).run();
    db.prepare(
      "INSERT INTO artifact_files(artifact_id, path, object_hash, created_at) VALUES (?, 'original.mp4', 'h-source', 0)",
    ).run(artifactId);
    db.prepare(
      `INSERT INTO artifact_streams(
        stream_id, artifact_id, source_path, object_hash, stream_index,
        kind, time_base_numerator, time_base_denominator, duration_ticks,
        codec, created_at
      ) VALUES (?, ?, 'original.mp4', 'h-source', 0, 'audio', 1, 1000, 12000, 'aac', 0)`,
    ).run(streamId, artifactId);
    db.prepare(
      `INSERT INTO transcripts(
        transcript_id, artifact_id, stream_id, object_hash, payload_hash,
        language, state, created_at
      ) VALUES ('t-base', ?, ?, 'h-source', 'h-payload', 'en', 'current', 100)`,
    ).run(artifactId, streamId);
    commitTables(
      db,
      [
        "engine_schema",
        "artifacts",
        "objects",
        "artifact_files",
        "artifact_streams",
        "transcripts",
      ],
      "base",
    );
    return { db, artifactId, streamId };
  }

  function importOnFork(
    db: DatabaseSync,
    branch: string,
    artifactId: string,
    streamId: string,
    transcriptId: string,
    createdAt: number,
  ): void {
    // Mirrors engine.transcripts.import: flip the previous current row to
    // derived, then insert the new current row.
    fork(db, branch, ["transcripts"], () => {
      db.prepare(
        `UPDATE transcripts SET state='derived'
         WHERE artifact_id=? AND stream_id=? AND object_hash='h-source'
           AND state='current'`,
      ).run(artifactId, streamId);
      db.prepare(
        `INSERT INTO transcripts(
          transcript_id, artifact_id, stream_id, object_hash, payload_hash,
          language, state, created_at
        ) VALUES (?, ?, ?, 'h-source', 'h-payload', 'en', 'current', ?)`,
      ).run(transcriptId, artifactId, streamId, createdAt);
    });
  }

  function currentTranscripts(db: DatabaseSync): string[] {
    return (
      db
        .prepare(
          "SELECT transcript_id FROM transcripts WHERE state='current' ORDER BY transcript_id",
        )
        .all() as Array<{ transcript_id: string }>
    ).map((row) => row.transcript_id);
  }

  it("reconciles concurrent current transcripts to one deterministic winner", async () => {
    const { db, artifactId, streamId } = await transcriptDb();
    importOnFork(db, "fork-a", artifactId, streamId, "t-a", 200);
    importOnFork(db, "fork-b", artifactId, streamId, "t-b", 300);

    const first = mergeWithPolicy(db, "fork-a");
    expect(first.reconciledTranscripts).toBe(0);
    expect(currentTranscripts(db)).toEqual(["t-a"]);

    // ve-wsu: a second doltMerge on this database deterministically
    // misfires doltlite's "uncommitted changes" guard once the first merge
    // has persisted the checkout-corrupted working set (reproduced
    // minimally while building this test). fork-b's row-level merge
    // outcome is therefore applied directly: both forks flipped t-base to
    // derived (already merged above) and fork-b added t-b as current, so
    // the merged state holds exactly two current rows.
    db.prepare(
      `INSERT INTO transcripts(
        transcript_id, artifact_id, stream_id, object_hash, payload_hash,
        language, state, created_at
      ) VALUES ('t-b', ?, ?, 'h-source', 'h-payload', 'en', 'current', 300)`,
    ).run(artifactId, streamId);
    expect(currentTranscripts(db)).toEqual(["t-a", "t-b"]);

    // The reconcile keeps the latest created_at.
    expect(reconcileSingletonFlags(db)).toEqual({
      transcripts: 1,
      sequences: 0,
    });
    expect(currentTranscripts(db)).toEqual(["t-b"]);

    // A transcript crowned with the same created_at loses to the lowest
    // transcript_id: the winner rule is total and deterministic.
    db.prepare(
      `INSERT INTO transcripts(
        transcript_id, artifact_id, stream_id, object_hash, payload_hash,
        language, state, created_at
      ) VALUES ('t-c', ?, ?, 'h-source', 'h-payload', 'en', 'current', 300)`,
    ).run(artifactId, streamId);
    expect(reconcileSingletonFlags(db)).toEqual({
      transcripts: 1,
      sequences: 0,
    });
    expect(currentTranscripts(db)).toEqual(["t-b"]);
    verifyConstraintHealth(db);
    db.close();
  });

  it("reconciles multiple primary sequences to the original primary", async () => {
    const db = await mergeDb(["engine_schema", "book", "sequences"]);
    const bookId = uuidv7();
    const primaryId = uuidv7();
    db.prepare(
      "INSERT INTO engine_schema(singleton, version, created_at) VALUES (1, 18, 0)",
    ).run();
    db.prepare(
      "INSERT INTO book(book_id, slug, created_at) VALUES (?, 'merge-book', 0)",
    ).run(bookId);
    const insertSequence = db.prepare(
      `INSERT INTO sequences(
        sequence_id, book_id, name, is_primary, width, height,
        pixel_aspect_numerator, pixel_aspect_denominator,
        frame_rate_numerator, frame_rate_denominator,
        audio_sample_rate_hz, audio_channel_layout, background_rgba_json,
        created_at
      ) VALUES (?, ?, ?, 1, 1920, 1080, 1, 1, 30, 1, 48000, 'stereo', '[0,0,0,255]', ?)`,
    );
    insertSequence.run(primaryId, bookId, "Main cut", 100);
    commitTables(db, ["engine_schema", "book", "sequences"], "base");

    const forkPrimary = (
      branch: string,
      sequenceId: string,
      createdAt: number,
    ): void => {
      fork(db, branch, ["sequences"], () => {
        insertSequence.run(sequenceId, bookId, `Cut ${branch}`, createdAt);
      });
    };
    forkPrimary("fork-a", uuidv7(), 200);
    const forkBPrimary = uuidv7();
    forkPrimary("fork-b", forkBPrimary, 150);

    // The merge briefly yields two primary rows; the reconcile keeps the
    // earliest-created (the original primary), deterministically.
    const first = mergeWithPolicy(db, "fork-a");
    expect(first.reconciledSequences).toBe(1);
    expect(
      db
        .prepare("SELECT sequence_id FROM sequences WHERE is_primary=1")
        .all() as Array<{ sequence_id: string }>,
    ).toEqual([{ sequence_id: primaryId }]);

    // ve-wsu: a second doltMerge misfires doltlite's "uncommitted changes"
    // guard once the first merge has persisted the checkout-corrupted
    // working set (see the transcripts reconcile test), so fork-b's
    // row-level merge outcome — one more primary row — is applied
    // directly.
    insertSequence.run(forkBPrimary, bookId, "Cut fork-b", 150);
    expect(reconcileSingletonFlags(db)).toEqual({
      transcripts: 0,
      sequences: 1,
    });
    expect(
      db
        .prepare("SELECT sequence_id FROM sequences WHERE is_primary=1")
        .all() as Array<{ sequence_id: string }>,
    ).toEqual([{ sequence_id: primaryId }]);
    verifyConstraintHealth(db);
    db.close();
  });
});

describe("engine-level merge policy behavior", () => {
  it("serializes concurrent slug dedup inside the write chain", async () => {
    const { engine } = await setupEngine();
    const [first, second] = await Promise.all([
      engine.artifacts.create({ kind: "image", name: "cat" }),
      engine.artifacts.create({ kind: "image", name: "cat" }),
    ]);
    if (!first.ok || !second.ok) {
      throw new Error(
        `concurrent create failed: ${JSON.stringify([first, second])}`,
      );
    }
    // Before the fix both creates read the slug set outside the write
    // chain and raced onto img-cat; now the second sees the first.
    expect([first.value.slug, second.value.slug].sort()).toEqual([
      "img-cat",
      "img-cat-2",
    ]);
    expect(first.value.artifactId).not.toBe(second.value.artifactId);
    engine.close();
  });

  it("reports IN_USE with every RESTRICT reference kind on delete", async () => {
    const { engine } = await setupEngine();
    const artifact = value(
      await engine.artifacts.create({ kind: "video", slug: "vid-referenced" }),
    );
    const write = await engine.files.write(
      artifact.artifactId,
      "original.mp4",
      "media",
    );
    if (!write.ok || !write.revision) throw new Error("missing write");
    const objectHash = value(
      await engine.files.manifest(artifact.artifactId),
    ).files[0]?.objectHash;
    if (!objectHash) throw new Error("missing object hash");
    const stream = value(
      await engine.streams.register({
        artifactId: artifact.artifactId,
        sourcePath: "original.mp4",
        objectHash,
        streamIndex: 0,
        kind: "audio",
        timeBase: { numerator: 1, denominator: 1_000 },
        durationTicks: 12_000,
        codec: "aac",
        audio: {
          sampleRateHz: 48_000,
          channels: 2,
          channelLayout: "stereo",
        },
      }),
    );
    const transcript = value(
      await engine.transcripts.import({
        artifactId: artifact.artifactId,
        streamId: stream.streamId,
        objectHash,
        language: "en",
        segments: [
          {
            ordinal: 0,
            range: {
              streamId: stream.streamId,
              objectHash,
              startTick: 0,
              durationTicks: 2_000,
              timeBase: stream.timeBase,
            },
            text: "hello",
            kind: "speech",
            words: [
              {
                ordinal: 0,
                startTick: 0,
                durationTicks: 2_000,
                text: "hello",
                corrected: false,
              },
            ],
          },
        ],
      }),
    );

    const refused = await engine.artifacts.delete(artifact.artifactId);
    expect(refused).toMatchObject({ ok: false, error: { code: "IN_USE" } });
    if (refused.ok) throw new Error("expected IN_USE");
    expect(refused.error.details?.references).toEqual([
      { kind: "stream", id: stream.streamId },
      { kind: "transcript", id: transcript.transcriptId },
    ]);
    engine.close();
  });

  it("resolves a single primary sequence when a merge left duplicates", async () => {
    const { engine, dataDir } = await setupEngine();
    const bookId = engine.book.get().bookId;
    const original = engine.sequences.getPrimary();
    engine.close();

    // Simulate a merge that left a second primary row: a raw write to the
    // working set, the state a post-merge reconcile would clean up.
    const db = new DatabaseSync(path.join(dataDir, "videobook.db"));
    db.prepare(
      `INSERT INTO sequences(
        sequence_id, book_id, name, is_primary, width, height,
        pixel_aspect_numerator, pixel_aspect_denominator,
        frame_rate_numerator, frame_rate_denominator,
        audio_sample_rate_hz, audio_channel_layout, background_rgba_json,
        created_at
      ) VALUES (?, ?, 'Merged cut', 1, 1920, 1080, 1, 1, 30, 1, 48000, 'stereo', '[0,0,0,255]', ?)`,
    ).run(uuidv7(), bookId, original.createdAt + 1);
    db.close();

    const reopened = createEngine({
      dataDir,
      workspaceDir: path.join(
        path.dirname(dataDir),
        "workspace",
      ),
    });
    // Resolve-on-read picks the deterministic winner (earliest created_at)
    // rather than an arbitrary duplicate.
    expect(reopened.sequences.getPrimary().sequenceId).toBe(
      original.sequenceId,
    );
    reopened.close();
  });
});
