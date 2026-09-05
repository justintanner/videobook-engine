import { spawn } from "node:child_process";
import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterEach, expect, it } from "vitest";
import { v7 as uuidv7 } from "uuid";
import { createEngine, MVP_CONTRACT_VERSION, type EditIntent, type SemanticCommitBoundary } from "../src/index.js";
import { EngineContext } from "../src/context.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true, maxRetries: 3 })));
});

function value<T>(result: { ok: true; value: T } | { ok: false; error: { message: string } }): T {
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

interface BoundaryEvent { boundary: SemanticCommitBoundary; occurrence: number }
interface CrashInput {
  rootDir: string;
  edit?: EditIntent;
  crash?: BoundaryEvent;
  recoveryOnly?: boolean;
  interveningWrite?: SemanticCommitBoundary;
}

async function runChild(input: CrashInput) {
  const script = `
    import { writeSync } from 'node:fs';
    import { createEngine } from ${JSON.stringify(path.resolve("src/index.ts"))};
    const input = JSON.parse(process.argv[1]);
    const counts = new Map();
    const engine = createEngine({ rootDir: input.rootDir, semanticCommitBoundary(boundary) {
      const occurrence = (counts.get(boundary) ?? 0) + 1;
      counts.set(boundary, occurrence);
      writeSync(1, JSON.stringify({ boundary, occurrence }) + '\\n');
      if (input.interveningWrite === boundary && occurrence === 1) throw new Error('simulated response failure');
      if (input.crash?.boundary === boundary && input.crash.occurrence === occurrence) process.kill(process.pid, 'SIGKILL');
    }});
    await engine.ready;
    if (!input.recoveryOnly) {
      const result = input.edit
        ? await engine.edits.commit(input.edit, engine.edits.preview(input.edit).value.previewHash)
        : await engine.history.recordOperation('crash-provenance');
      if (input.interveningWrite) {
        if (result.ok) throw new Error('Expected simulated response failure');
        const later = await engine.history.recordOperation('later-provenance');
        if (!later.ok) throw new Error(JSON.stringify(later.error));
        process.kill(process.pid, 'SIGKILL');
      }
      if (!result.ok) throw new Error(JSON.stringify(result.error));
    }
    engine.close();
  `;
  const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script, JSON.stringify(input)], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += String(chunk); });
  child.stderr.on("data", (chunk) => { stderr += String(chunk); });
  const timeout = setTimeout(() => child.kill("SIGKILL"), 20_000);
  try {
    const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) => resolve({ code, signal }));
    });
    return { ...result, stderr, events: stdout.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as BoundaryEvent) };
  } finally { clearTimeout(timeout); }
}

async function fixture() {
  const parent = await mkdtemp(path.join(tmpdir(), "videobook-semantic-kill-"));
  roots.push(parent);
  const rootDir = path.join(parent, "source");
  const engine = createEngine({ rootDir, initialBookName: "semantic-kill" });
  await engine.ready;
  const artifact = value(await engine.artifacts.create("video", "source"));
  value(await engine.files.write(artifact.artifactId, "original.mp4", "source"));
  const file = value(await engine.files.manifest(artifact.artifactId)).files[0]!;
  const stream = value(await engine.streams.register({
    artifactId: artifact.artifactId, sourcePath: file.name, objectHash: file.objectHash,
    streamIndex: 0, kind: "video", timeBase: { numerator: 1, denominator: 1000 }, durationTicks: 60_000,
    codec: "h264", video: { width: 640, height: 480, rotationDegrees: 0, pixelAspect: { numerator: 1, denominator: 1 } },
  }));
  const sequence = engine.sequences.getPrimary();
  const track = sequence.tracks.find((item) => item.kind === "video")!;
  const clipIds = Array.from({ length: 3 }, () => uuidv7());
  const edit: EditIntent = {
    intentVersion: MVP_CONTRACT_VERSION, commandId: "crash-edit", sequenceId: sequence.sequenceId,
    baseRevision: sequence.revision, actor: "test", sourceSurface: "ui", confirmationPolicy: "risk-based",
    operations: Array.from({ length: 3 }, (_, index) => ({
      kind: "insert-clip", clipId: clipIds[index]!, mode: "overwrite", placement: {
        trackId: track.trackId, timelineStartFrame: index * 30, durationFrames: 30,
        source: { kind: "timed", artifactId: artifact.artifactId, range: {
          streamId: stream.streamId, objectHash: file.objectHash, startTick: index * 1000,
          durationTicks: 1000, timeBase: stream.timeBase,
        } }, speed: { numerator: 1, denominator: 1 }, reverse: false, audioPolicy: "preserve-pitch",
      },
    })),
  };
  edit.operations.push({ kind: "set-clip-transform", clipId: clipIds[0]!, transform: {
    fit: "fit", positionX: 0, positionY: 0, scaleX: 1, scaleY: 1,
    anchorX: 0.5, anchorY: 0.5, rotationDegrees: 0, cropTop: 0, cropRight: 0,
    cropBottom: 0, cropLeft: 0, opacity: 0.7, blendMode: "normal",
  } });
  const head = engine.head;
  engine.close();
  return { parent, rootDir, edit, head };
}

it.each(["edit", "provenance"] as const)("recovers real SIGKILL at every %s transaction boundary", async (kind) => {
  const source = await fixture();
  const traceRoot = path.join(source.parent, "trace");
  await cp(source.rootDir, traceRoot, { recursive: true });
  const edit = kind === "edit" ? source.edit : undefined;
  const trace = await runChild({ rootDir: traceRoot, edit });
  expect(trace.code, trace.stderr).toBe(0);
  const expected: SemanticCommitBoundary[] = [
    "after-semantic-mutation", "before-sql-commit", "after-sql-commit",
    ...(kind === "edit" ? ["after-table-stage" as const] : []),
    "before-dolt-commit", "after-dolt-commit", "before-outbox-delete", "before-outbox-clear-commit", "after-outbox-clear",
  ];
  expect([...new Set(trace.events.map((event) => event.boundary))]).toEqual(expected);
  if (kind === "edit") expect(trace.events.filter((event) => event.boundary === "after-table-stage").length).toBeGreaterThan(1);
  for (const [index, crash] of trace.events.entries()) {
    const rootDir = path.join(source.parent, `crash-${index}`);
    await cp(source.rootDir, rootDir, { recursive: true });
    const result = await runChild({ rootDir, edit, crash });
    expect(result.signal, `${JSON.stringify(crash)} ${result.stderr}`).toBe("SIGKILL");
    expect(result.events.at(-1)).toEqual(crash);
    if (crash.boundary === "after-sql-commit") await verifyInterruptedRecovery(rootDir, kind);
    const beforeCommit = ["after-semantic-mutation", "before-sql-commit"].includes(crash.boundary);
    const engine = createEngine({ rootDir });
    await engine.ready;
    try {
      expect(engine.sequences.getPrimary().clips).toHaveLength(kind === "edit" && !beforeCommit ? 3 : 0);
      const operation = kind === "edit" ? "commit_edit" : "crash-provenance";
      const revisions = engine.history.revisions(100).filter((revision) => revision.operation === operation);
      expect(revisions, JSON.stringify(crash)).toHaveLength(beforeCommit ? 0 : 1);
      expect(engine.head === source.head).toBe(beforeCommit);
      if (kind === "edit" && !beforeCommit) {
        const actionId = revisions[0]!.details?.actionId;
        expect(typeof actionId).toBe("string");
        expect(value(engine.edits.get(String(actionId))).operations).toHaveLength(4);
        expect(engine.sequences.getPrimary().clips[0]!.transform?.opacity).toBe(0.7);
      }
      const integrity = engine.catalogIntegrity();
      expect(integrity.doltStatus.filter((entry) => entry.staged === 1)).toEqual([]);
      expect(integrity.tableRowCounts.runtime_commit_outbox).toBe(0);
      value(await engine.history.recordOperation("after-crash"));
      expect(engine.history.revisions(100).filter((revision) => revision.operation === operation)).toHaveLength(beforeCommit ? 0 : 1);
    } finally { engine.close(); }
    const context = new EngineContext({ rootDir });
    try {
      expect(context.store.db.prepare("SELECT COUNT(*) AS count FROM runtime_commit_outbox").get()).toMatchObject({ count: 0 });
      expect(context.store.status.filter((entry) => entry.staged === 1)).toEqual([]);
    } finally { context.store.close(); }
  }
}, 90_000);

async function verifyInterruptedRecovery(pendingRoot: string, kind: "edit" | "provenance") {
  const traceRoot = `${pendingRoot}-recovery-trace`;
  await cp(pendingRoot, traceRoot, { recursive: true });
  const trace = await runChild({ rootDir: traceRoot, recoveryOnly: true });
  expect(trace.code, trace.stderr).toBe(0);
  expect(trace.events.map((event) => event.boundary)).toContain("after-dolt-commit");
  for (const [index, crash] of trace.events.entries()) {
    const rootDir = `${pendingRoot}-recovery-${index}`;
    await cp(pendingRoot, rootDir, { recursive: true });
    const result = await runChild({ rootDir, recoveryOnly: true, crash });
    expect(result.signal, `${JSON.stringify(crash)} ${result.stderr}`).toBe("SIGKILL");
    expect(result.events.at(-1)).toEqual(crash);
    const engine = createEngine({ rootDir });
    await engine.ready;
    try {
      expect(engine.sequences.getPrimary().clips).toHaveLength(kind === "edit" ? 3 : 0);
      expect(engine.history.revisions(100).filter((revision) => revision.operation === (kind === "edit" ? "commit_edit" : "crash-provenance"))).toHaveLength(1);
      const integrity = engine.catalogIntegrity();
      expect(integrity.doltStatus.filter((entry) => entry.staged === 1)).toEqual([]);
      expect(integrity.tableRowCounts.runtime_commit_outbox).toBe(0);
    } finally { engine.close(); }
    const context = new EngineContext({ rootDir });
    try {
      expect(context.store.db.prepare("SELECT COUNT(*) AS count FROM runtime_commit_outbox").get()).toMatchObject({ count: 0 });
    } finally { context.store.close(); }
  }
}

it.each(["after-sql-commit", "after-dolt-commit"] as const)("preserves provenance order after a failed %s response and later write", async (interveningWrite) => {
  const source = await fixture();
  const result = await runChild({ rootDir: source.rootDir, interveningWrite });
  expect(result.signal, result.stderr).toBe("SIGKILL");
  expect(result.events.at(-1)).toMatchObject({ boundary: "after-outbox-clear" });
  const engine = createEngine({ rootDir: source.rootDir });
  await engine.ready;
  try {
    const revisions = engine.history.revisions(100);
    expect(revisions.filter((revision) => revision.operation === "crash-provenance")).toHaveLength(1);
    expect(revisions.filter((revision) => revision.operation === "later-provenance")).toHaveLength(1);
    expect(revisions[0]!.operation).toBe("later-provenance");
    expect(engine.catalogIntegrity().tableRowCounts.runtime_commit_outbox).toBe(0);
  } finally { engine.close(); }
});
