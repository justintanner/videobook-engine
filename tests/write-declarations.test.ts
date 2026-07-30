import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";

import { DatabaseSync } from "@dolthub/doltlite";
import { v7 as uuidv7 } from "uuid";
import { afterEach, describe, expect, it } from "vitest";

import { createArtifactsApi } from "../src/artifacts.js";
import { createBookApi } from "../src/books.js";
import { createMessagesApi, createPromptsApi } from "../src/communications.js";
import { EngineContext } from "../src/context.js";
import { createEntitiesApi, createNotebooksApi } from "../src/domain.js";
import { createEditsApi } from "../src/edits.js";
import { createEngine } from "../src/engine.js";
import { createFilesApi } from "../src/files.js";
import { createHistoryApi } from "../src/history.js";
import { MVP_CONTRACT_VERSION, type EditIntent } from "../src/index.js";
import { createMetadataApi } from "../src/metadata.js";
import { SEMANTIC_TABLES } from "../src/schema.js";
import { createSequencesApi } from "../src/sequences.js";
import { createStorageApi } from "../src/storage.js";
import { createStreamsApi } from "../src/streams.js";
import { createTranscriptsApi } from "../src/transcripts.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "videobook-declarations-"));
  roots.push(root);
  return root;
}

function value<T>(
  result: { ok: true; value: T } | { ok: false; error: { message: string } },
): T {
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

describe("declared write sets", () => {
  it("faults the next open when a write leaves an undeclared table dirty", async () => {
    const root = await tempRoot();
    const dataDir = path.join(root, "data");
    const workspaceDir = path.join(root, "workspace");
    const context = new EngineContext({
      dataDir,
      workspaceDir,
      initialBookSlug: "demo",
    });
    // Deliberately under-declared: the mutation also writes entities.
    await context.store.semantic(
      { operation: "under_declared", tables: ["book_metadata"] },
      (_operationId, now) => {
        context.store.db
          .prepare(
            "INSERT INTO book_metadata(key, value_json) VALUES ('k', '{}')",
          )
          .run();
        context.store.db
          .prepare(
            `INSERT INTO entities(entity_id, type, name, created_at)
             VALUES (?, 'character', 'stray', ?)`,
          )
          .run(uuidv7(), now);
      },
    );
    context.store.close();

    expect(() => createEngine({ dataDir, workspaceDir })).toThrow(
      /not attributed to any operation: entities/,
    );
  });

  it("recovers legacy outbox rows by probing the full allowlist", async () => {
    const root = await tempRoot();
    const dataDir = path.join(root, "data");
    const workspaceDir = path.join(root, "workspace");
    const engine = createEngine({
      dataDir,
      workspaceDir,
      initialBookSlug: "demo",
    });
    await engine.ready;
    const headBefore = engine.head;
    engine.close();

    // A crash window from a pre-declaration engine: the SQL transaction
    // (mutation + outbox row) committed, the dolt commit never happened.
    // Legacy rows carried no table names.
    const db = new DatabaseSync(path.join(dataDir, "videobook.db"));
    const dirtyOp = uuidv7();
    const emptyOp = uuidv7();
    db.exec("BEGIN IMMEDIATE");
    db.prepare(
      "INSERT INTO book_metadata(key, value_json) VALUES ('legacy', '\"v\"')",
    ).run();
    const insertOutbox = db.prepare(
      `INSERT INTO runtime_commit_outbox(
        operation_id, tables_json, message, created_at
      ) VALUES (?, ?, ?, ?)`,
    );
    insertOutbox.run(dirtyOp, "[]", `legacy_write\n\nop-id: ${dirtyOp}`, 1);
    insertOutbox.run(
      emptyOp,
      '["allow-empty"]',
      `legacy_marker\n\nop-id: ${emptyOp}`,
      2,
    );
    db.exec("COMMIT");
    db.close();

    const reopened = createEngine({ dataDir, workspaceDir });
    await reopened.ready;
    expect(reopened.head).not.toBe(headBefore);
    const revisions = reopened.history.revisions(3);
    expect(revisions.map((revision) => revision.operation)).toEqual(
      expect.arrayContaining(["legacy_write", "legacy_marker"]),
    );
    expect(value(await reopened.metadata.book.read("legacy"))).toBe("v");
    reopened.close();

    const verify = new DatabaseSync(path.join(dataDir, "videobook.db"));
    const outbox = verify
      .prepare("SELECT COUNT(*) AS count FROM runtime_commit_outbox")
      .get() as unknown as { count: number };
    expect(outbox.count).toBe(0);
    verify.close();
  });

  it("declares the complete write set for every public write operation", async () => {
    const root = await tempRoot();
    const violations: string[] = [];
    let context: EngineContext;
    // After every dolt commit, sweep the whole catalog at row level. Any
    // dirty semantic table here means the operation that just committed
    // under-declared its write set.
    const sweep = (boundary: string): void => {
      if (boundary !== "after-dolt-commit") return;
      for (const table of SEMANTIC_TABLES) {
        const dirty = context.store.db
          .prepare(
            `SELECT 1 AS present FROM dolt_diff_${table}
             WHERE to_commit = 'WORKING' LIMIT 1`,
          )
          .get();
        if (dirty) violations.push(table);
      }
    };
    context = new EngineContext({
      dataDir: path.join(root, "data"),
      workspaceDir: path.join(root, "workspace"),
      initialBookSlug: "demo",
      semanticCommitBoundary: sweep,
    });
    const clean = async (
      label: string,
      run: () => Promise<unknown> | unknown,
    ) => {
      await run();
      if (violations.length > 0) {
        throw new Error(
          `${label} left undeclared dirty tables: ${violations.join(", ")}`,
        );
      }
    };

    const book = createBookApi(context);
    const artifacts = createArtifactsApi(context);
    const files = createFilesApi(context);
    const metadata = createMetadataApi(context);
    const entities = createEntitiesApi(context);
    const notebooks = createNotebooksApi(context);
    const prompts = createPromptsApi(context);
    const messages = createMessagesApi(context);
    const history = createHistoryApi(context);
    const streams = createStreamsApi(context);
    const transcripts = createTranscriptsApi(context);
    const sequences = createSequencesApi(context);
    const edits = createEditsApi(context);
    const storage = createStorageApi(context);

    await clean("book.rename", async () => value(await book.rename("demo-2")));

    const video = value(await artifacts.create({ kind: "video", name: "v" }));
    if (violations.length > 0) {
      throw new Error(`artifacts.create: ${violations.join(", ")}`);
    }
    const scratch = value(
      await artifacts.create({ kind: "script", name: "s" }),
    );
    await clean("artifacts.rename", async () =>
      value(await artifacts.rename(scratch.artifactId, "s2")),
    );

    await clean("files.write", async () =>
      value(await files.write(video.artifactId, "original.mp4", "payload")),
    );
    const sourcePath = path.join(root, "source.txt");
    await writeFile(sourcePath, "from path");
    await clean("files.writeFromPath", async () =>
      value(
        await files.writeFromPath(scratch.artifactId, "source.txt", sourcePath),
      ),
    );
    await clean("files.copy", async () =>
      value(
        await files.copy(
          scratch.artifactId,
          "source.txt",
          scratch.artifactId,
          "copy.txt",
        ),
      ),
    );
    await clean("files.rename", async () =>
      value(await files.rename(scratch.artifactId, "copy.txt", "renamed.txt")),
    );
    await clean("files.delete", async () =>
      value(await files.delete(scratch.artifactId, "renamed.txt")),
    );
    const generated = path.join(
      context.artifactPath(scratch.artifactId),
      "generated",
    );
    await mkdir(generated, { recursive: true });
    await writeFile(path.join(generated, "result.txt"), "generated");
    await clean("files.ingestWorkspace", async () =>
      value(await files.ingestWorkspace(scratch.artifactId, ["generated"])),
    );

    await clean("metadata.artifacts.write", async () =>
      value(await metadata.artifacts.write(video.artifactId, "key", { a: 1 })),
    );
    await clean("metadata.artifacts.delete", async () =>
      value(await metadata.artifacts.delete(video.artifactId, "key")),
    );
    await clean("metadata.book.write", async () =>
      value(await metadata.book.write("key", true)),
    );
    await clean("metadata.book.delete", async () =>
      value(await metadata.book.delete("key")),
    );
    await clean("metadata.waveforms.write", async () =>
      value(await metadata.waveforms.write(video.artifactId, [0, 1, 0])),
    );
    await clean("metadata.waveforms.delete", async () =>
      value(await metadata.waveforms.delete(video.artifactId)),
    );

    const entity = value(
      await entities.create("character", "Hero", { description: "d" }),
    );
    if (violations.length > 0) {
      throw new Error(`entities.create: ${violations.join(", ")}`);
    }
    await clean("entities.write", async () =>
      value(await entities.write({ ...entity, description: "d2" })),
    );

    const notebook = value(await notebooks.create("nb"));
    const cell = notebooks.createCell({
      type: "prompt",
      slug: "prompt-one",
      slot: { row: 0, column: 0 },
    });
    await clean("notebooks.insertCell", async () =>
      value(await notebooks.insertCell(notebook.id, cell)),
    );
    await clean("notebooks.updateCell", async () =>
      value(await notebooks.updateCell(notebook.id, { ...cell, prompt: "p" })),
    );
    await clean("notebooks.moveCell", async () =>
      value(
        await notebooks.moveCell(notebook.id, cell.id, { row: 1, column: 0 }),
      ),
    );
    const fullNotebook = value(notebooks.read(notebook.id));
    await clean("notebooks.write", async () =>
      value(await notebooks.write({ ...fullNotebook, description: "full" })),
    );
    await clean("notebooks.recordRun", async () =>
      value(
        await notebooks.recordRun({
          id: uuidv7(),
          notebookId: notebook.id,
          status: "completed",
          startedAt: new Date(0).toISOString(),
          completedAt: new Date(1).toISOString(),
          cellOrder: [cell.id],
          outputs: {},
        }),
      ),
    );
    await clean("notebooks.removeCell", async () =>
      value(await notebooks.removeCell(notebook.id, cell.id)),
    );
    await clean("notebooks.delete", async () =>
      value(await notebooks.delete(notebook.id)),
    );
    await clean("entities.delete", async () =>
      value(await entities.delete(entity.id)),
    );

    await clean("prompts.record", async () =>
      value(await prompts.record({ surface: "test", prompt: "p" })),
    );
    await clean("messages.append", async () =>
      value(await messages.append({ role: "user", body: { text: "m" } })),
    );

    const objectHash = value(await files.manifest(video.artifactId)).files[0]!
      .objectHash;
    const stream = value(
      await streams.register({
        artifactId: video.artifactId,
        sourcePath: "original.mp4",
        objectHash,
        streamIndex: 0,
        kind: "video",
        timeBase: { numerator: 1, denominator: 1_000 },
        durationTicks: 60_000,
        codec: "h264",
        video: {
          width: 1920,
          height: 1080,
          rotationDegrees: 0,
          pixelAspect: { numerator: 1, denominator: 1 },
          nominalFrameRate: { numerator: 30, denominator: 1 },
        },
      }),
    );
    if (violations.length > 0) {
      throw new Error(`streams.register: ${violations.join(", ")}`);
    }

    const transcript = value(
      await transcripts.import({
        artifactId: video.artifactId,
        streamId: stream.streamId,
        objectHash,
        language: "en",
        provider: "test",
        segments: [
          {
            ordinal: 0,
            range: {
              streamId: stream.streamId,
              objectHash,
              startTick: 0,
              durationTicks: 1_000,
              timeBase: stream.timeBase,
            },
            text: "hello",
            kind: "speech",
            words: [
              {
                ordinal: 0,
                startTick: 0,
                durationTicks: 1_000,
                text: "hello",
                corrected: false,
              },
            ],
          },
        ],
      }),
    );
    if (violations.length > 0) {
      throw new Error(`transcripts.import: ${violations.join(", ")}`);
    }
    const revised = value(
      await transcripts.revise({
        sourceTranscriptId: transcript.transcriptId,
        segments: transcript.segments.map((segment) => ({
          ordinal: segment.ordinal,
          range: segment.range,
          text: `${segment.text}!`,
          kind: segment.kind,
          words: segment.words.map((word) => ({
            ordinal: word.ordinal,
            startTick: word.startTick,
            durationTicks: word.durationTicks,
            text: word.text,
            corrected: word.corrected,
          })),
        })),
      }),
    );
    await clean("transcripts.delete", async () =>
      value(await transcripts.delete(revised.transcriptId)),
    );

    const sequence = value(
      await sequences.create({
        name: "cut",
        width: 1920,
        height: 1080,
        frameRate: { numerator: 30, denominator: 1 },
      }),
    );
    await clean("sequences.rename", async () =>
      value(await sequences.rename(sequence.sequenceId, "cut-2")),
    );
    await clean("sequences.updateCanvas", async () =>
      value(
        await sequences.updateCanvas(sequence.sequenceId, {
          width: 1080,
          height: 1920,
        }),
      ),
    );
    const withTrack = value(
      await sequences.addTrack(sequence.sequenceId, {
        kind: "video",
        name: "overlay",
      }),
    );
    const track = withTrack.tracks.at(-1)!;
    await clean("sequences.updateTrack", async () =>
      value(await sequences.updateTrack(track.trackId, { name: "o2" })),
    );
    await clean("sequences.moveTrack", async () =>
      value(await sequences.moveTrack(track.trackId, 0)),
    );
    await clean("sequences.removeTrack", async () =>
      value(await sequences.removeTrack(track.trackId)),
    );
    await clean("sequences.delete", async () =>
      value(await sequences.delete(sequence.sequenceId)),
    );

    const primary = sequences.getPrimary();
    const videoTrack = primary.tracks.find((item) => item.kind === "video")!;
    const intent: EditIntent = {
      intentVersion: MVP_CONTRACT_VERSION,
      commandId: "declaration-test",
      sequenceId: primary.sequenceId,
      baseRevision: primary.revision,
      actor: "test",
      sourceSurface: "system",
      confirmationPolicy: "risk-based",
      operations: [
        {
          kind: "insert-clip",
          clipId: uuidv7(),
          placement: {
            trackId: videoTrack.trackId,
            timelineStartFrame: 0,
            durationFrames: 30,
            source: {
              kind: "timed",
              artifactId: stream.artifactId,
              range: {
                streamId: stream.streamId,
                objectHash: stream.objectHash,
                startTick: 0,
                durationTicks: 1_000,
                timeBase: stream.timeBase,
              },
            },
            speed: { numerator: 1, denominator: 1 },
            reverse: false,
            audioPolicy: "preserve-pitch",
          },
          mode: "overwrite",
        },
      ],
    };
    const preview = value(edits.preview(intent));
    const committed = value(await edits.commit(intent, preview.previewHash));
    if (violations.length > 0) {
      throw new Error(`edits.commit: ${violations.join(", ")}`);
    }
    await clean("edits.restore", async () =>
      value(
        await edits.restore({
          targetActionId: committed.actionId,
          actor: "test",
          sourceSurface: "system",
          baseRevision: context.store.head,
        }),
      ),
    );

    await clean("history.recordOperation", async () =>
      value(
        await history.recordOperation("checkpoint", video.artifactId, {
          done: true,
        }),
      ),
    );
    await clean("history.logAction", async () =>
      value(await history.logAction("declaration-test", { done: true })),
    );
    // Restore a stream-less artifact: artifact_streams rows RESTRICT the
    // artifact_files reload for artifacts with registered streams.
    const fileRevision = context.store.head;
    value(await files.write(scratch.artifactId, "source.txt", "payload-2"));
    await clean("history.restoreArtifact", async () =>
      value(await history.restoreArtifact(scratch.artifactId, fileRevision)),
    );
    const target = history.revisions(3).at(-1)!;
    await clean("history.restore", async () =>
      value(await history.restore(target.hash)),
    );

    const disposable = value(
      await artifacts.create({ kind: "script", name: "gone" }),
    );
    value(await files.write(disposable.artifactId, "a.txt", "bytes"));
    const disposableHash = value(await files.manifest(disposable.artifactId))
      .files[0]!.objectHash;
    await clean("artifacts.delete", async () =>
      value(await artifacts.delete(disposable.artifactId)),
    );
    await clean("storage.deleteObject", async () =>
      value(await storage.deleteObject(disposableHash)),
    );

    context.store.close();
    expect(violations).toEqual([]);
  });
});
