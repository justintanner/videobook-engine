import { createHash } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";

import { DatabaseSync } from "@dolthub/doltlite";
import { v7 as uuidv7 } from "uuid";
import { afterEach, describe, expect, it } from "vitest";
import sharp from "sharp";

import {
  createEngine,
  dryRunV4Migration,
  migrateV4,
  readV4BookIdentity,
} from "../src/index.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) =>
      rm(root, { recursive: true, force: true, maxRetries: 3 })
    ),
  );
});

async function fixture(options: {
  image?: boolean;
  missingObject?: boolean;
  representative?: boolean;
  extraCells?: number;
  timed?: boolean;
  large?: boolean;
  empty?: boolean;
} = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "videobook-v4-source-"));
  roots.push(root);
  const dataDir = path.join(root, "data");
  await mkdir(dataDir, { recursive: true });
  const databasePath = path.join(dataDir, "videobook.db");
  const buildingPath = path.join(dataDir, "fixture-building.db");
  const database = new DatabaseSync(buildingPath);
  database.exec(V4_FIXTURE_SCHEMA);
  const bookId = uuidv7();
  const notebookId = uuidv7();
  const cellId = uuidv7();
  database
    .prepare("INSERT INTO engine_schema VALUES (1, 4, 1)")
    .run();
  database
    .prepare("INSERT INTO book VALUES (?, 'migration-fixture', 1)")
    .run(bookId);
  database
    .prepare("INSERT INTO notebooks VALUES (?, 'Main', '{}', 1)")
    .run(notebookId);
  database
    .prepare(
      `INSERT INTO cells VALUES (
        ?, ?, 'prompt', 'Opening', 40, 40,
        NULL, 'A lighthouse', NULL, '{}', NULL
      )`,
    )
    .run(notebookId, cellId);
  database
    .prepare("INSERT INTO timeline VALUES (?, 'square')")
    .run(bookId);
  let artifactId: string | undefined;
  let objectHash: string | undefined;
  if (options.image) {
    artifactId = uuidv7();
    const bytes = await sharp({ create: { width: 16, height: 16, channels: 3, background: "red" } }).jpeg().toBuffer();
    objectHash = createHash("sha256").update(bytes).digest("hex");
    database
      .prepare("INSERT INTO artifacts VALUES (?, 'img-lighthouse', 'image', 1)")
      .run(artifactId);
    database
      .prepare("INSERT INTO objects VALUES (?, ?, 1)")
      .run(objectHash, bytes.byteLength);
    database
      .prepare("INSERT INTO artifact_files VALUES (?, 'original.jpg', ?, 1, 1)")
      .run(artifactId, objectHash);
    database
      .prepare("INSERT INTO timeline_slots VALUES (?, ?, 0, NULL, NULL, NULL)")
      .run(uuidv7(), artifactId);
    if (!options.missingObject) {
      const objectDir = path.join(dataDir, "objects", "sha256", objectHash.slice(0, 2));
      await mkdir(objectDir, { recursive: true });
      await writeFile(path.join(objectDir, objectHash), bytes);
    }
  }
  const secondCellId = uuidv7();
  const edgeId = uuidv7();
  const entityId = uuidv7();
  const runId = uuidv7();
  const promptId = uuidv7();
  const messageId = uuidv7();
  if (options.representative) {
    database.prepare("INSERT INTO entities VALUES (?, 'scene', 'Harbor', 'description', 'entity prompt', '{}', 1)").run(entityId);
    database.prepare("UPDATE cells SET type='scene', entity_id=?, model='legacy-model' WHERE cell_id=?").run(entityId, cellId);
    database.prepare("INSERT INTO cells VALUES (?, ?, 'asset', 'Source', -100, -100, NULL, NULL, NULL, '{\"strength\":0.5}', ?)")
      .run(notebookId, secondCellId, artifactId!);
    database.prepare("INSERT INTO edges VALUES (?, ?, ?, ?, 'reference')").run(notebookId, edgeId, secondCellId, cellId);
    database.prepare("INSERT INTO runs VALUES (?, ?, 'completed', 1, 2, ?, ?, NULL)")
      .run(runId, notebookId, JSON.stringify([secondCellId, cellId]), JSON.stringify({ [secondCellId]: artifactId }));
    database.prepare("INSERT INTO prompt_entries VALUES (?, 'notebook', 'saved prompt', '{\"temperature\":0.2}', 3)").run(promptId);
    database.prepare("INSERT INTO messages VALUES (?, 'user', '{\"text\":\"saved message\"}', 4)").run(messageId);
    const operationId = uuidv7();
    const actionId = uuidv7();
    database.prepare("INSERT INTO operations VALUES (?, 'generate_image', ?, '{}', '[]', NULL, 1, 'legacy-author')").run(operationId, artifactId!);
    database.prepare(`INSERT INTO actions(action_id, operation, scope, actor, lane, phase, details_json, created_at)
      VALUES (?, 'generate_image', 'artifact', 'legacy-author', 'main', 'completed', '{}', 1)`).run(actionId);
    database.prepare("INSERT INTO action_events VALUES (?, ?, ?, 'completed', '{}', 1)").run(uuidv7(), actionId, operationId);
    database.prepare("INSERT INTO job_runs(run_id, job_type, state, artifact_id, payload_json, started_at, finished_at) VALUES (?, 'generate_image', 'done', ?, '{}', 1, 2)")
      .run(uuidv7(), artifactId!);
    database.prepare("UPDATE notebooks SET properties_json=? WHERE notebook_id=?").run(JSON.stringify({
      description: 'Original description', lifecycleState: 'published', workflowVersion: 3,
      fixture: { owner: 'migration-test' }, unknownLegacyPreference: { zoom: 0.8 },
      execution: { [secondCellId]: { status: 'completed', outputArtifactId: artifactId, runId, stale: false } },
    }), notebookId);
  }
  for (let index = 0; index < (options.extraCells ?? 0); index++) {
    database.prepare("INSERT INTO cells VALUES (?, ?, 'prompt', ?, ?, ?, NULL, ?, NULL, '{}', NULL)")
      .run(notebookId, uuidv7(), `Cell ${index}`, index * 10, index * 10, `Prompt ${index}`);
  }
  const videoId = uuidv7();
  const audioId = uuidv7();
  if (options.timed) {
    const videoPath = path.join(root, 'fixture.mp4');
    const audioPath = path.join(root, 'fixture.wav');
    await promisify(execFile)('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=blue:s=64x48:r=30',
      '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000', '-t', '2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', videoPath]);
    await promisify(execFile)('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=880:sample_rate=48000', '-t', '3', '-c:a', 'pcm_s16le', audioPath]);
    for (const [id, kind, name, filePath] of [[videoId, 'video', 'original.mp4', videoPath], [audioId, 'audio', 'original.wav', audioPath]]) {
      const bytes = await readFile(filePath!);
      const hash = createHash('sha256').update(bytes).digest('hex');
      const directory = path.join(dataDir, 'objects', 'sha256', hash.slice(0, 2));
      await mkdir(directory, { recursive: true });
      await writeFile(path.join(directory, hash), bytes);
      database.prepare('INSERT INTO artifacts VALUES (?, ?, ?, 1)').run(id!, `fixture-${kind}`, kind!);
      database.prepare('INSERT INTO objects VALUES (?, ?, 1)').run(hash, bytes.length);
      database.prepare('INSERT INTO artifact_files VALUES (?, ?, ?, 1, 1)').run(id!, name!, hash);
    }
    database.prepare('INSERT INTO timeline_slots VALUES (?, ?, 1, 50, 500, 250)').run(uuidv7(), videoId);
    database.prepare('INSERT INTO timeline_slots VALUES (?, ?, 2, NULL, NULL, NULL)').run(uuidv7(), videoId);
    database.prepare('INSERT INTO timeline_audio VALUES (?, ?, 0, 15, 30, 25, 500, 250)').run(uuidv7(), audioId);
    database.prepare('INSERT INTO timeline_audio VALUES (?, ?, 1, 30, 150, 0, 500, 1000)').run(uuidv7(), audioId);
    database.prepare('INSERT INTO audio_waveforms VALUES (?, ? )').run(audioId, '[0.1,0.2,0.3]');
  }
  if (options.large) {
    for (let index = 0; index < 1000; index++) {
      const id = uuidv7();
      database.prepare("INSERT INTO artifacts VALUES (?, ?, 'image', 1)").run(id, `large-${index}`);
      database.prepare("INSERT INTO artifact_files VALUES (?, 'original.jpg', ?, 1, 1)").run(id, objectHash!);
    }
    for (let notebook = 0; notebook < 2; notebook++) {
      const id = uuidv7();
      database.prepare("INSERT INTO notebooks VALUES (?, ?, '{}', 1)").run(id, `Large ${notebook}`);
      for (let index = 0; index < 512; index++) {
        database.prepare("INSERT INTO cells VALUES (?, ?, 'prompt', ?, ?, ?, NULL, ?, NULL, '{}', NULL)")
          .run(id, uuidv7(), `Cell ${index}`, index % 8, Math.floor(index / 8), `Prompt ${index}`);
      }
    }
  }
  if (options.empty) database.exec('DELETE FROM cells; DELETE FROM notebooks;');
  database.prepare("SELECT dolt_add('.') AS result").get();
  database.prepare("SELECT dolt_commit('-m', 'Schema v4 fixture') AS hash").get();
  database.close();
  await copyFile(buildingPath, databasePath);
  await rm(buildingPath);
  return { root, databasePath, bookId, notebookId, cellId, artifactId, objectHash, secondCellId, edgeId, entityId, runId, promptId, messageId, videoId, audioId };
}

function value<T>(
  result:
    | { ok: true; value: T }
    | { ok: false; error: { message: string } },
): T {
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

describe("schema-v4 copy-forward migration", () => {
  it("dry-runs and migrates current state without changing the source", async () => {
    const source = await fixture({ image: true });
    const destination = await mkdtemp(path.join(tmpdir(), "videobook-v5-parent-"));
    roots.push(destination);
    const destinationRoot = path.join(destination, source.bookId);
    const originalCatalog = await readFile(source.databasePath);
    expect(value(readV4BookIdentity(source.root)).bookId).toBe(source.bookId);
    const dryRun = value(dryRunV4Migration(source.root));
    expect(dryRun).toMatchObject({
      sourceSchemaVersion: 4,
      destinationSchemaVersion: 24,
      sourceBookId: source.bookId,
      artifactCount: 1,
      notebookCount: 1,
      timelineSlotCount: 1,
      objectCount: 1,
      estimatedReindexArtifacts: 1,
    });
    expect(dryRun.migrationKey).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(dryRun.issues).toEqual([
      expect.objectContaining({ code: "REINDEX_REQUIRED", severity: "warning" }),
    ]);
    const migrated = value(await migrateV4({
      sourceRoot: source.root,
      destinationRoot,
      dryRun: false,
      expectedSourceBookId: source.bookId,
      expectedSourceHead: dryRun.sourceHeadRevision,
    }));
    if (!("destinationBookId" in migrated)) throw new Error("Expected migration result");
    expect(migrated).toMatchObject({
      destinationBookId: source.bookId,
      copiedObjectCount: 1,
      reusedObjectCount: 0,
    });
    const engine = createEngine({ rootDir: destinationRoot });
    await engine.ready;
    // The legacy book and artifact slugs carry over as free-text names.
    expect(engine.book.get()).toMatchObject({
      bookId: source.bookId,
      name: "migration-fixture",
    });
    expect(value(engine.artifacts.get(source.artifactId!))).toMatchObject({
      artifactId: source.artifactId,
      label: "img-lighthouse",
      kind: "image",
    });
    expect(engine.notebooks.list()[0]?.id).toBe(source.notebookId);
    expect(value(engine.notebooks.read(source.notebookId))).toMatchObject({
      id: source.notebookId,
      cells: [{ id: source.cellId, type: "prompt", label: "Opening", prompt: "A lighthouse", slot: { row: 0, column: 0 } }],
      edges: [],
    });
    const sequence = engine.sequences.getPrimary();
    expect(sequence).toMatchObject({ width: 1080, height: 1080 });
    expect(sequence.clips).toEqual([
      expect.objectContaining({
        source: expect.objectContaining({ artifactId: source.artifactId }),
      }),
    ]);
    expect(engine.artifacts.get(migrated.reportArtifactId).ok).toBe(true);
    expect(engine.history.resolveRevision(migrated.importActionId)).not.toBeNull();
    engine.close();
    const sourceAfter = value(dryRunV4Migration(source.root));
    expect(sourceAfter.sourceHeadRevision).toBe(dryRun.sourceHeadRevision);
    expect(sourceAfter.sourceSchemaVersion).toBe(4);
    expect(sourceAfter.sourceBookId).toBe(source.bookId);
    expect(await readFile(source.databasePath)).toEqual(originalCatalog);
  });

  it("blocks migration when a referenced object is missing", async () => {
    const source = await fixture({ image: true, missingObject: true });
    const dryRun = value(dryRunV4Migration(source.root));
    expect(dryRun.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "MISSING_OBJECT", severity: "error" }),
    ]));
    const destination = await mkdtemp(path.join(tmpdir(), "videobook-v5-parent-"));
    roots.push(destination);
    const result = await migrateV4({
      sourceRoot: source.root,
      destinationRoot: path.join(destination, source.bookId),
      dryRun: false,
    });
    expect(result).toMatchObject({
      ok: false,
      error: { code: "OBJECT_UNAVAILABLE" },
    });
  });

  it("preserves notebook graphs, compatible properties, run history, prompts, messages and conversion decisions", async () => {
    const source = await fixture({ image: true, representative: true });
    const destinationRoot = `${source.root}-migrated`;
    roots.push(destinationRoot);
    const migrated = value(await migrateV4({ sourceRoot: source.root, destinationRoot, dryRun: false }));
    if (!("destinationBookId" in migrated)) throw new Error("Expected migration result");
    const engine = createEngine({ rootDir: destinationRoot });
    await engine.ready;
    try {
      const notebook = value(engine.notebooks.read(source.notebookId));
      expect(notebook).toMatchObject({
        description: 'Original description', lifecycleState: 'published', workflowVersion: 3,
        fixture: { owner: 'migration-test' },
        execution: { [source.secondCellId]: { status: 'completed', outputArtifactId: source.artifactId, runId: source.runId } },
        cells: [
          { id: source.secondCellId, type: 'image', slot: { row: 0, column: 0 }, outputArtifactId: source.artifactId, inputs: { strength: 0.5 } },
          { id: source.cellId, type: 'prompt', slot: { row: 0, column: 1 }, outputEntityId: source.entityId, prompt: 'A lighthouse', model: 'legacy-model' },
        ],
        edges: [{ id: source.edgeId, source: source.secondCellId, target: source.cellId, targetInput: 'reference' }],
      });
      const counts = engine.catalogIntegrity().tableRowCounts;
      expect(counts.runs).toBe(1);
      expect(counts.prompt_entries).toBe(1);
      expect(counts.messages).toBe(1);
      expect(counts.job_runs).toBe(0);
      expect(value(engine.prompts.list())).toEqual([{ id: source.promptId, surface: 'notebook', prompt: 'saved prompt', context: { temperature: 0.2 }, createdAt: 3 }]);
      expect(value(engine.messages.list())).toEqual([{ messageId: source.messageId, role: 'user', body: { text: 'saved message' }, createdAt: 4 }]);
      const reportBytes = value(await engine.files.read(migrated.reportArtifactId, 'migration-report.json'));
      const report = JSON.parse(reportBytes.toString());
      expect(report.conversion.notebooks[0]).toMatchObject({
        notebookId: source.notebookId, properties: { unknownLegacyPreference: { zoom: 0.8 } },
        cells: [{ cellId: source.secondCellId, legacyType: 'asset', type: 'image', x: -100, y: -100 },
          { cellId: source.cellId, legacyType: 'scene', type: 'prompt', x: 40, y: 40 }],
      });
      expect(report.legacyHistory.sourceHeadRevision).toBe(migrated.sourceHeadRevision);
      expect(report.legacyHistory.tables).toEqual(expect.arrayContaining([
        expect.objectContaining({ table: 'runs', rows: 1 }), expect.objectContaining({ table: 'messages', rows: 1 }),
        expect.objectContaining({ table: 'operations', rows: 1 }), expect.objectContaining({ table: 'actions', rows: 1 }),
        expect.objectContaining({ table: 'job_runs', rows: 1 }),
      ]));
      expect(counts.operations).toBeUndefined();
      expect(counts.actions).toBeUndefined();
    } finally { engine.close(); }
  });

  it("rejects unrepresentable notebook sizes and invalid references before creating a destination", async () => {
    const source = await fixture({ extraCells: 512 });
    expect(value(dryRunV4Migration(source.root)).issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ severity: 'error', message: expect.stringContaining('513 cells') }),
    ]));
    const database = new DatabaseSync(source.databasePath);
    database.exec('PRAGMA foreign_keys=OFF');
    database.prepare("INSERT INTO edges VALUES (?, ?, ?, ?, 'reference')").run(source.notebookId, uuidv7(), uuidv7(), source.cellId);
    database.close();
    const result = await migrateV4({ sourceRoot: source.root, destinationRoot: `${source.root}-invalid`, dryRun: false });
    expect(result).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT', details: { issues: expect.arrayContaining([
      expect.objectContaining({ message: 'Missing notebook-local source_cell_id' }),
    ]) } } });
  });

  it("changes the migration contract when uncommitted current state changes without changing row counts", async () => {
    const source = await fixture();
    const before = value(dryRunV4Migration(source.root));
    const database = new DatabaseSync(source.databasePath);
    database.prepare("UPDATE cells SET prompt='Changed prompt' WHERE cell_id=?").run(source.cellId);
    database.close();
    const after = value(dryRunV4Migration(source.root));
    expect(after.sourceHeadRevision).toBe(before.sourceHeadRevision);
    expect(after.migrationKey).not.toBe(before.migrationKey);
    expect(await migrateV4({ sourceRoot: source.root, destinationRoot: `${source.root}-stale`, dryRun: false,
      expectedMigrationKey: before.migrationKey })).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
  });

  it("recognizes a completed identical migration without adding reports or semantic rows", async () => {
    const source = await fixture({ image: true, representative: true });
    const destinationRoot = `${source.root}-idempotent`;
    roots.push(destinationRoot);
    const request = { sourceRoot: source.root, destinationRoot, dryRun: false };
    const first = value(await migrateV4(request));
    expect(value(await migrateV4(request))).toEqual(first);
    const engine = createEngine({ rootDir: destinationRoot });
    await engine.ready;
    try { expect(engine.catalogIntegrity().tableRowCounts).toMatchObject({ artifacts: 2, cells: 2, edges: 1, runs: 1 }); }
    finally { engine.close(); }
    const other = await fixture();
    expect(await migrateV4({ ...request, sourceRoot: other.root })).toMatchObject({ ok: false, error: { code: 'ALREADY_EXISTS' } });
  });

  it.each(['copy-state', 'copy-objects', 'copy-notebooks', 'copy-timeline', 'publish'] as const)(
    "cancels at %s without publishing a partial destination and retries safely", async (phase) => {
      const source = await fixture({ image: true });
      const parent = await mkdtemp(path.join(tmpdir(), 'migration-cancel-'));
      roots.push(parent);
      const destinationRoot = path.join(parent, 'book');
      await mkdir(destinationRoot);
      const controller = new AbortController();
      const result = await migrateV4({ sourceRoot: source.root, destinationRoot, dryRun: false,
        signal: controller.signal, onProgress: (progress) => { if (progress.phase === phase) controller.abort(); } });
      expect(result).toMatchObject({ ok: false, error: { code: 'CANCELLED' } });
      expect(await readdir(destinationRoot)).toEqual([]);
      expect(await readdir(parent)).toEqual(['book']);
      const retried = value(await migrateV4({ sourceRoot: source.root, destinationRoot, dryRun: false }));
      expect(retried).toMatchObject({ destinationBookId: source.bookId });
    },
  );

  it("restarts after process death before publication without duplicate rows", async () => {
    const source = await fixture({ image: true });
    const parent = await mkdtemp(path.join(tmpdir(), 'migration-killed-'));
    roots.push(parent);
    const destinationRoot = path.join(parent, 'book');
    const script = `import { migrateV4 } from ${JSON.stringify(path.resolve('src/migration.ts'))};
      await migrateV4({ sourceRoot: ${JSON.stringify(source.root)}, destinationRoot: ${JSON.stringify(destinationRoot)}, dryRun: false,
        onProgress: ({phase}) => { if (phase === 'publish') process.exit(93); } }); process.exit(1);`;
    const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += String(chunk); });
    const exitCode = await new Promise<number | null>((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
    expect(exitCode, stderr).toBe(93);
    expect(await readdir(parent)).toEqual([expect.stringMatching(/^book\.migrating-/)]);
    const request = { sourceRoot: source.root, destinationRoot, dryRun: false };
    const result = value(await migrateV4(request));
    expect(value(await migrateV4(request))).toEqual(result);
    const engine = createEngine({ rootDir: destinationRoot });
    await engine.ready;
    try { expect(engine.catalogIntegrity().tableRowCounts).toMatchObject({ artifacts: 2, notebooks: 1, cells: 1 }); }
    finally { engine.close(); }
  });

  it("rejects corrupt CAS bytes and keeps an unrelated destination untouched", async () => {
    const source = await fixture({ image: true });
    const objectPath = path.join(source.root, 'data', 'objects', 'sha256', source.objectHash!.slice(0, 2), source.objectHash!);
    const original = await readFile(objectPath);
    const corrupt = Buffer.from(original);
    corrupt[0] = corrupt[0]! ^ 255;
    await writeFile(objectPath, corrupt);
    const parent = await mkdtemp(path.join(tmpdir(), 'migration-corrupt-'));
    roots.push(parent);
    const destinationRoot = path.join(parent, 'book');
    expect(await migrateV4({ sourceRoot: source.root, destinationRoot, dryRun: false }))
      .toMatchObject({ ok: false, error: { code: 'OBJECT_UNAVAILABLE' } });
    expect(await readdir(parent)).toEqual([]);
    await writeFile(objectPath, original);
    await mkdir(destinationRoot);
    await writeFile(path.join(destinationRoot, 'keep.txt'), 'user data');
    expect(await migrateV4({ sourceRoot: source.root, destinationRoot, dryRun: false }))
      .toMatchObject({ ok: false, error: { code: 'ALREADY_EXISTS' } });
    expect(await readFile(path.join(destinationRoot, 'keep.txt'), 'utf8')).toBe('user data');
  });

  it("converts real timed media at native speed with ordered playback, overlapping audio and millisecond fades", async () => {
    const source = await fixture({ image: true, timed: true, representative: true });
    const destinationRoot = `${source.root}-timed`;
    roots.push(destinationRoot);
    const dryRun = value(dryRunV4Migration(source.root));
    expect(dryRun.issues.filter((issue) => issue.code === 'PROBE_REQUIRED')).toHaveLength(4);
    const migrated = value(await migrateV4({ sourceRoot: source.root, destinationRoot, dryRun: false, expectedMigrationKey: dryRun.migrationKey }));
    expect(migrated).toMatchObject({ destinationBookId: source.bookId, copiedObjectCount: 3 });
    const engine = createEngine({ rootDir: destinationRoot });
    await engine.ready;
    try {
      const sequence = engine.sequences.getPrimary();
      const videoTrack = sequence.tracks.find((track) => track.kind === 'video')!;
      const audioTrack = sequence.tracks.find((track) => track.kind === 'audio')!;
      const video = sequence.clips.filter((clip) => clip.trackId === videoTrack.trackId).sort((a, b) => a.timelineStartFrame - b.timelineStartFrame);
      const audio = sequence.clips.filter((clip) => clip.trackId === audioTrack.trackId).sort((a, b) => a.timelineStartFrame - b.timelineStartFrame);
      expect(video.map((clip) => [clip.source.artifactId, clip.timelineStartFrame, clip.durationFrames])).toEqual([
        [source.artifactId, 0, 90], [source.videoId, 90, 60], [source.videoId, 150, 60],
      ]);
      expect(video[1]).toMatchObject({ speed: { numerator: 1, denominator: 1 }, audio: { fadeInFrames: 15, fadeOutFrames: 8 } });
      expect(video[1]!.audio!.gainDb).toBeCloseTo(20 * Math.log10(0.5));
      expect(audio).toHaveLength(2);
      expect(audio[0]).toMatchObject({ timelineStartFrame: 15, durationFrames: 30, speed: { numerator: 1, denominator: 1 },
        source: { range: { durationTicks: 48000, timeBase: { numerator: 1, denominator: 48000 } } },
        audio: { fadeInFrames: 15, fadeOutFrames: 8, muted: false } });
      expect(audio[0]!.audio!.gainDb).toBeCloseTo(20 * Math.log10(0.25));
      expect(audio[1]).toMatchObject({ timelineStartFrame: 30, durationFrames: 150, speed: { numerator: 1, denominator: 1 },
        source: { range: { durationTicks: 144000 } }, audio: { muted: true, fadeInFrames: 15, fadeOutFrames: 30 } });
      expect(value(engine.streams.list(source.videoId))).toHaveLength(1);
      expect(value(engine.streams.list(source.audioId))).toHaveLength(1);
      expect(value(await engine.metadata.waveforms.read(source.audioId)).peaks).toEqual([0.1, 0.2, 0.3]);
      expect(engine.catalogIntegrity().tableRowCounts).toMatchObject({ cells: 2, edges: 1, sequence_clips: 5, artifact_streams: 2 });
    } finally { engine.close(); }
    expect(value(dryRunV4Migration(source.root))).toEqual(dryRun);
  }, 30_000);

  it("migrates an empty book with the canonical primary tracks and no placeholder media", async () => {
    const source = await fixture({ empty: true });
    const destinationRoot = `${source.root}-empty`;
    roots.push(destinationRoot);
    value(await migrateV4({ sourceRoot: source.root, destinationRoot, dryRun: false }));
    const engine = createEngine({ rootDir: destinationRoot });
    await engine.ready;
    try {
      expect(engine.notebooks.list()).toEqual([]);
      const sequence = engine.sequences.getPrimary();
      expect(sequence.clips).toEqual([]);
      expect(sequence.tracks.filter((track) => track.kind === 'video')).toHaveLength(2);
      expect(sequence.tracks.filter((track) => track.kind === 'audio')).toHaveLength(4);
      expect(sequence.tracks.filter((track) => track.kind === 'caption')).toHaveLength(1);
      expect(engine.catalogIntegrity().tableRowCounts.artifacts).toBe(1);
    } finally { engine.close(); }
  });

  it("rejects a destination nested in the source through a symbolic-link alias", async () => {
    const source = await fixture();
    const parent = await mkdtemp(path.join(tmpdir(), 'migration-alias-'));
    roots.push(parent);
    const alias = path.join(parent, 'alias');
    await symlink(source.root, alias, 'dir');
    expect(await migrateV4({ sourceRoot: source.root, destinationRoot: path.join(alias, 'nested'), dryRun: false }))
      .toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
    expect(await readdir(source.root)).toEqual(['data']);
  });

  it("rejects current-state changes arriving after confirmation and before publication", async () => {
    const source = await fixture();
    const parent = await mkdtemp(path.join(tmpdir(), 'migration-changed-'));
    roots.push(parent);
    const result = await migrateV4({ sourceRoot: source.root, destinationRoot: path.join(parent, 'book'), dryRun: false,
      onProgress: ({ phase }) => {
        if (phase !== 'publish') return;
        const database = new DatabaseSync(source.databasePath);
        database.prepare("UPDATE cells SET prompt='Changed after copy' WHERE cell_id=?").run(source.cellId);
        database.close();
      } });
    expect(result).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
    expect(await readdir(parent)).toEqual([]);
  });

  it("preserves a large v4 catalog and every shared content hash across full notebook grids", async () => {
    const source = await fixture({ image: true, extraCells: 511, large: true });
    const destinationRoot = `${source.root}-large`;
    roots.push(destinationRoot);
    const before = value(dryRunV4Migration(source.root));
    const migrated = value(await migrateV4({ sourceRoot: source.root, destinationRoot, dryRun: false }));
    expect(migrated).toMatchObject({ artifactCount: 1001, notebookCount: 3, copiedObjectCount: 1 });
    const engine = createEngine({ rootDir: destinationRoot });
    await engine.ready;
    try {
      expect(engine.catalogIntegrity().tableRowCounts).toMatchObject({ artifacts: 1002, artifact_files: 1002, cells: 1536, edges: 0 });
      for (const notebook of engine.notebooks.list()) {
        expect(notebook.cells).toHaveLength(512);
        expect(notebook.cells.at(-1)?.slot).toEqual({ row: 63, column: 7 });
      }
      const artifacts = engine.artifacts.list().filter((artifact) => artifact.kind === 'image');
      expect(artifacts).toHaveLength(1001);
      for (const artifact of artifacts) {
        const manifest = value(await engine.files.manifest(artifact.artifactId));
        expect(manifest.files.map((file) => file.objectHash)).toEqual([source.objectHash]);
      }
    } finally { engine.close(); }
    expect(value(dryRunV4Migration(source.root))).toEqual(before);
  }, 60_000);
});

const V4_FIXTURE_SCHEMA = await readFile(new URL("./fixtures/v4-schema.sql", import.meta.url), "utf8");
