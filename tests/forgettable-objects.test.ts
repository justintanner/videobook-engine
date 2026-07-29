import { copyFile, mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";

import { DatabaseSync } from "@dolthub/doltlite";
import { afterEach, describe, expect, it } from "vitest";

import { createEngine, type Engine } from "../src/index.js";
import type { ContentStore } from "../src/engine-types.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

function value<T>(
  result:
    | { ok: true; value: T }
    | { ok: false; error: { message: string } },
): T {
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

async function setup(
  slug = "forgettable",
  remoteObjects?: ContentStore,
): Promise<{ engine: Engine; root: string; dataDir: string }> {
  const root = await mkdtemp(path.join(tmpdir(), "videobook-forget-"));
  roots.push(root);
  const dataDir = path.join(root, "data");
  const engine = createEngine({
    dataDir,
    workspaceDir: path.join(root, "workspace"),
    initialBookSlug: slug,
    ...(remoteObjects ? { remoteObjects } : {}),
  });
  return { engine, root, dataDir };
}

function fileContentStore(root: string): ContentStore {
  return {
    async head(key) {
      try {
        const info = await stat(path.join(root, key));
        return { exists: true, size: info.size };
      } catch {
        return { exists: false };
      }
    },
    async uploadFile(key, sourcePath) {
      const destination = path.join(root, key);
      await mkdir(path.dirname(destination), { recursive: true });
      await copyFile(sourcePath, destination);
    },
    async downloadFile(key, destinationPath) {
      await mkdir(path.dirname(destinationPath), { recursive: true });
      await copyFile(path.join(root, key), destinationPath);
    },
    async delete(key) {
      await rm(path.join(root, key), { force: true });
    },
  };
}

async function localObjectExists(
  dataDir: string,
  hash: string,
): Promise<boolean> {
  try {
    await stat(
      path.join(dataDir, "objects", "sha256", hash.slice(0, 2), hash),
    );
    return true;
  } catch {
    return false;
  }
}

function tombstoneRow(
  dataDir: string,
  hash: string,
): { size_bytes: number; forgotten_at: number | null } | undefined {
  const db = new DatabaseSync(path.join(dataDir, "videobook.db"));
  try {
    return db
      .prepare(
        `SELECT size_bytes, forgotten_at FROM objects WHERE object_hash=?`,
      )
      .get(hash) as
      | { size_bytes: number; forgotten_at: number | null }
      | undefined;
  } finally {
    db.close();
  }
}

async function writeOriginal(
  engine: Engine,
  artifactId: string,
  content: string,
): Promise<{ hash: string; revision: string }> {
  const result = await engine.files.write(
    artifactId,
    "original.mp4",
    content,
  );
  if (!result.ok) throw new Error(result.error.message);
  const manifest = value(await engine.files.manifest(artifactId));
  const hash = manifest.files[0]?.objectHash;
  if (!hash || !result.revision) {
    throw new Error("Written file is missing its object hash or revision");
  }
  return { hash, revision: result.revision };
}

describe("forgettable objects", () => {
  it("deletes an unreferenced object and keeps a tombstone row", async () => {
    const { engine, dataDir } = await setup();
    const artifact = value(
      await engine.artifacts.create({ kind: "video", slug: "interview" }),
    );
    const first = await writeOriginal(engine, artifact.artifactId, "v1");
    const second = await writeOriginal(engine, artifact.artifactId, "v2-two");
    expect(second.hash).not.toBe(first.hash);

    const deleted = value(await engine.storage.deleteObject(first.hash));
    expect(deleted).toMatchObject({
      hash: first.hash,
      sizeBytes: 2,
      deletedLocal: true,
      deletedRemote: false,
      severedReferences: [],
    });
    expect(await localObjectExists(dataDir, first.hash)).toBe(false);
    expect(await localObjectExists(dataDir, second.hash)).toBe(true);

    // Deleting again reports the tombstone as gone, not a crash.
    expect(await engine.storage.deleteObject(first.hash)).toMatchObject({
      ok: false,
      error: { code: "NOT_FOUND" },
    });
    expect(
      await engine.storage.deleteObject("0".repeat(64)),
    ).toMatchObject({ ok: false, error: { code: "NOT_FOUND" } });

    // Current content still reads; the old revision is a tombstone read.
    expect(
      value(await engine.files.read(artifact.artifactId, "original.mp4"))
        .toString(),
    ).toBe("v2-two");
    expect(
      await engine.files.readAtRevision(
        artifact.artifactId,
        "original.mp4",
        first.revision,
      ),
    ).toMatchObject({ ok: false, error: { code: "OBJECT_UNAVAILABLE" } });
    engine.close();

    const tombstone = tombstoneRow(dataDir, first.hash);
    expect(tombstone?.size_bytes).toBe(2);
    expect(tombstone?.forgotten_at).not.toBeNull();
  });

  it("refuses to delete a referenced object unless forced", async () => {
    const { engine, dataDir } = await setup();
    const artifact = value(
      await engine.artifacts.create({ kind: "video", slug: "takedown" }),
    );
    const { hash } = await writeOriginal(engine, artifact.artifactId, "clip");

    const refused = await engine.storage.deleteObject(hash);
    expect(refused).toMatchObject({ ok: false, error: { code: "IN_USE" } });
    if (refused.ok) throw new Error("Expected IN_USE");
    expect(refused.error.details?.references).toEqual([
      {
        table: "artifact_files",
        id: `${artifact.artifactId}:original.mp4`,
      },
    ]);
    expect(await localObjectExists(dataDir, hash)).toBe(true);

    const forced = value(
      await engine.storage.deleteObject(hash, { force: true }),
    );
    expect(forced.deletedLocal).toBe(true);
    expect(forced.severedReferences).toHaveLength(1);
    expect(
      await engine.files.read(artifact.artifactId, "original.mp4"),
    ).toMatchObject({ ok: false, error: { code: "OBJECT_UNAVAILABLE" } });
    engine.close();

    const tombstone = tombstoneRow(dataDir, hash);
    expect(tombstone?.size_bytes).toBe(4);
    expect(tombstone?.forgotten_at).not.toBeNull();
  });

  it("collects only objects unreferenced at HEAD", async () => {
    const { engine, dataDir } = await setup();
    const keep = value(
      await engine.artifacts.create({ kind: "video", slug: "keep" }),
    );
    const drop = value(
      await engine.artifacts.create({ kind: "video", slug: "drop" }),
    );
    const replaced = await writeOriginal(engine, keep.artifactId, "old");
    const current = await writeOriginal(engine, keep.artifactId, "current");
    const orphaned = await writeOriginal(engine, drop.artifactId, "orphan");
    value(await engine.artifacts.delete(drop.artifactId));

    const dryRun = value(await engine.storage.gc({ dryRun: true }));
    expect(dryRun.dryRun).toBe(true);
    expect(dryRun.collected.map((object) => object.hash).sort()).toEqual(
      [replaced.hash, orphaned.hash].sort(),
    );
    expect(dryRun.reclaimedBytes).toBe(3 + 6);
    expect(dryRun.referencedObjects).toBe(1);
    expect(await localObjectExists(dataDir, replaced.hash)).toBe(true);
    expect(await localObjectExists(dataDir, orphaned.hash)).toBe(true);

    const swept = value(await engine.storage.gc({ doltGc: true }));
    expect(swept.collected.map((object) => object.hash).sort()).toEqual(
      [replaced.hash, orphaned.hash].sort(),
    );
    expect(swept.doltGc).toMatch(/chunks/);
    expect(await localObjectExists(dataDir, replaced.hash)).toBe(false);
    expect(await localObjectExists(dataDir, orphaned.hash)).toBe(false);
    expect(await localObjectExists(dataDir, current.hash)).toBe(true);
    expect(
      value(await engine.files.read(keep.artifactId, "original.mp4"))
        .toString(),
    ).toBe("current");

    // A second sweep finds nothing: collected rows are tombstones now.
    expect(value(await engine.storage.gc()).collected).toEqual([]);

    // The revision that still names the collected object is a tombstone read.
    expect(
      await engine.files.readAtRevision(
        keep.artifactId,
        "original.mp4",
        replaced.revision,
      ),
    ).toMatchObject({ ok: false, error: { code: "OBJECT_UNAVAILABLE" } });
    engine.close();

    expect(tombstoneRow(dataDir, replaced.hash)?.forgotten_at).not.toBeNull();
    expect(tombstoneRow(dataDir, orphaned.hash)?.forgotten_at).not.toBeNull();
    expect(tombstoneRow(dataDir, current.hash)?.forgotten_at).toBeNull();
  });

  it("restores an old revision whose object was collected as a tombstone", async () => {
    const { engine } = await setup();
    const artifact = value(
      await engine.artifacts.create({ kind: "video", slug: "rewind" }),
    );
    const first = await writeOriginal(engine, artifact.artifactId, "past");
    await writeOriginal(engine, artifact.artifactId, "present");
    value(await engine.storage.gc());

    // Restoring the pre-GC revision relinks the tombstone: the forward
    // commit stands, but the bytes are gone and surface OBJECT_UNAVAILABLE.
    const restored = await engine.history.restoreArtifact(
      artifact.artifactId,
      first.revision,
    );
    expect(restored).toMatchObject({
      ok: false,
      error: { code: "OBJECT_UNAVAILABLE" },
    });
    expect(
      await engine.files.read(artifact.artifactId, "original.mp4"),
    ).toMatchObject({ ok: false, error: { code: "OBJECT_UNAVAILABLE" } });
    engine.close();
  });

  it("unpublishes remote objects and keeps backup consistent", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "videobook-remote-"));
    roots.push(root);
    const remote = fileContentStore(path.join(root, "remote-objects"));
    const { engine } = await setup("forgettable-remote", remote);
    const artifact = value(
      await engine.artifacts.create({ kind: "video", slug: "published" }),
    );
    const { hash } = await writeOriginal(engine, artifact.artifactId, "sync");
    expect(value(await engine.storage.backup()).state).toBe("backed_up");
    const key = `superlzy-media/videobook/sha256/${hash.slice(0, 2)}/${hash}`;
    expect((await remote.head(key)).exists).toBe(true);

    value(await engine.artifacts.delete(artifact.artifactId));
    const swept = value(await engine.storage.gc({ remote: true }));
    expect(swept.collected.map((object) => object.hash)).toEqual([hash]);
    expect((await remote.head(key)).exists).toBe(false);

    // The tombstone is excluded from the pending set, so backup settles.
    expect(value(await engine.storage.backup()).state).toBe("backed_up");
    expect(engine.storage.status().pendingObjects).toBe(0);
    engine.close();
  });

  it("moves transcript text behind a forgettable CAS payload", async () => {
    const { engine, dataDir } = await setup();
    const artifact = value(
      await engine.artifacts.create({ kind: "video", slug: "talk" }),
    );
    const { hash } = await writeOriginal(
      engine,
      artifact.artifactId,
      "media",
    );
    const stream = value(
      await engine.streams.register({
        artifactId: artifact.artifactId,
        sourcePath: "original.mp4",
        objectHash: hash,
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
        objectHash: hash,
        language: "en",
        segments: [
          {
            ordinal: 0,
            range: {
              streamId: stream.streamId,
              objectHash: hash,
              startTick: 0,
              durationTicks: 2_000,
              timeBase: stream.timeBase,
            },
            speaker: "A",
            text: "Forget this utterance",
            kind: "speech",
            words: [
              {
                ordinal: 0,
                startTick: 0,
                durationTicks: 1_000,
                text: "Forget",
                corrected: false,
              },
              {
                ordinal: 1,
                startTick: 1_000,
                durationTicks: 1_000,
                text: "this",
                corrected: true,
              },
            ],
          },
        ],
      }),
    );

    // Text round-trips through the CAS payload, not the versioned tables.
    expect(transcript.payloadHash).toMatch(/^[a-f0-9]{64}$/);
    expect(await localObjectExists(dataDir, transcript.payloadHash)).toBe(
      true,
    );
    const reread = value(await engine.transcripts.get(transcript.transcriptId));
    expect(reread).toEqual(transcript);
    expect(reread.segments[0]?.text).toBe("Forget this utterance");
    expect(reread.segments[0]?.words.map((word) => word.text)).toEqual([
      "Forget",
      "this",
    ]);
    expect(
      value(
        await engine.transcripts.getAtRevision(
          transcript.transcriptId,
          transcript.revision,
        ),
      ),
    ).toEqual(transcript);

    // The payload hash is a HEAD reference, so GC keeps it while the
    // transcript exists.
    expect(value(await engine.storage.gc()).collected).toEqual([]);

    value(await engine.transcripts.delete(transcript.transcriptId));
    expect(await engine.transcripts.get(transcript.transcriptId)).toMatchObject(
      { ok: false, error: { code: "NOT_FOUND" } },
    );
    const swept = value(await engine.storage.gc());
    expect(swept.collected.map((object) => object.hash)).toEqual([
      transcript.payloadHash,
    ]);

    // History keeps the structural rows, but the text is forgotten.
    expect(
      await engine.transcripts.getAtRevision(
        transcript.transcriptId,
        transcript.revision,
      ),
    ).toMatchObject({ ok: false, error: { code: "OBJECT_UNAVAILABLE" } });
    engine.close();

    const db = new DatabaseSync(path.join(dataDir, "videobook.db"));
    try {
      const segmentColumns = (
        db.prepare("PRAGMA table_info(transcript_segments)").all() as Array<{
          name: string;
        }>
      ).map((column) => column.name);
      expect(segmentColumns).not.toContain("text");
      const historical = db
        .prepare(
          `SELECT COUNT(*) AS count
           FROM dolt_at_transcript_segments(?)`,
        )
        .get(transcript.revision) as { count: number };
      expect(historical.count).toBe(1);
    } finally {
      db.close();
    }
    expect(tombstoneRow(dataDir, transcript.payloadHash)?.forgotten_at)
      .not.toBeNull();
  });
});
