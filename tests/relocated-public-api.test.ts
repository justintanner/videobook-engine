import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";

import { DatabaseSync } from "@dolthub/doltlite";
import { v7 as uuidv7 } from "uuid";
import { afterEach, describe, expect, it } from "vitest";

import {
  computeArtifactStatus,
  createEngine,
  type Engine,
} from "../src/index.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function setup(initialBookName = "relocated"): Promise<{
  engine: Engine;
  root: string;
}> {
  const root = await mkdtemp(path.join(tmpdir(), "videobook-relocated-"));
  roots.push(root);
  const engine = createEngine({
    rootDir: root,
    initialBookName,
  });
  await engine.ready;
  return { engine, root };
}

function value<T>(
  result:
    | { ok: true; value: T; revision?: string }
    | { ok: false; error: { message: string } },
): T {
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("relocated artifact and file APIs", () => {
  it("renames only the display label and keeps files plus waveform identity", async () => {
    const { engine } = await setup();
    const artifact = value(await engine.artifacts.create("audio", "old track"));
    const audio = Buffer.from("fake-mp3-audio");
    value(await engine.files.write(artifact.artifactId, "original.mp3", audio));
    value(await engine.metadata.waveforms.write(artifact.artifactId, [0.1, 0.8, 0.3]));

    const renamed = value(
      await engine.artifacts.rename(artifact.artifactId, "new track"),
    );
    expect(renamed.artifactId).toBe(artifact.artifactId);
    expect(renamed.label).toBe("new track");
    expect(value(await engine.files.read(artifact.artifactId, "original.mp3"))).toEqual(
      audio,
    );
    expect(
      engine.artifacts.list().find((row) => row.artifactId === artifact.artifactId)
        ?.label,
    ).toBe("new track");
    expect(value(await engine.files.manifest(artifact.artifactId)).label).toBe(
      "new track",
    );
    expect(
      value(await engine.metadata.waveforms.read(artifact.artifactId)).peaks,
    ).toEqual([0.1, 0.8, 0.3]);
    engine.close();
  });

  it("lists artifacts newest-first by default and oldest-first on request", async () => {
    const { engine } = await setup();
    const labels = ["one", "two", "three", "four"];
    const ids: string[] = [];
    for (const label of labels) {
      await sleep(2);
      const created = value(await engine.artifacts.create("image", label));
      value(
        await engine.files.write(
          created.artifactId,
          "original.png",
          Buffer.from(label),
        ),
      );
      ids.push(created.artifactId);
    }
    expect(engine.artifacts.list().map((row) => row.artifactId)).toEqual(
      [...ids].reverse(),
    );
    expect(
      engine.artifacts.list({ sort: "newest" }).map((row) => row.artifactId),
    ).toEqual([...ids].reverse());
    expect(
      engine.artifacts.list({ sort: "oldest" }).map((row) => row.artifactId),
    ).toEqual(ids);
    engine.close();
  });

  it("copies, renames, deletes, and lists subdirectory files", async () => {
    const { engine } = await setup();
    const source = value(await engine.artifacts.create("image", "source"));
    const destination = value(await engine.artifacts.create("image", "copy"));
    value(
      await engine.files.write(source.artifactId, "original.png", "pixel-bytes"),
    );
    value(
      await engine.files.copy(
        source.artifactId,
        "original.png",
        destination.artifactId,
        "original.png",
      ),
    );
    expect(
      value(await engine.files.read(destination.artifactId, "original.png")).toString(),
    ).toBe("pixel-bytes");
    value(
      await engine.files.rename(
        destination.artifactId,
        "original.png",
        "renamed.png",
      ),
    );
    expect(
      value(await engine.files.manifest(destination.artifactId)).files.map(
        (file) => file.name,
      ),
    ).toEqual(["renamed.png"]);
    value(await engine.files.delete(destination.artifactId, "renamed.png"));
    expect(
      value(await engine.files.manifest(destination.artifactId)).files,
    ).toEqual([]);

    value(
      await engine.files.write(
        source.artifactId,
        "original_frames/0.00.jpg",
        "frame-zero",
      ),
    );
    value(
      await engine.files.write(
        source.artifactId,
        "original_frames/5.00.jpg",
        "frame-five",
      ),
    );
    expect(value(engine.files.listSubdir(source.artifactId, "original_frames"))).toEqual([
      "0.00.jpg",
      "5.00.jpg",
    ]);
    engine.close();
  });

  it("ingests workspace files, imports CAS objects, and rematerializes after evict", async () => {
    const { engine, root } = await setup();
    const artifact = value(await engine.artifacts.create("video", "frames"));
    const workspace = value(
      await engine.workspaces.resolveArtifact(artifact.artifactId),
    );
    const frameDir = path.join(workspace, "original_frames");
    await mkdir(frameDir, { recursive: true });
    await writeFile(path.join(frameDir, "0.00.jpg"), "frame-zero");
    value(await engine.files.ingestWorkspace(artifact.artifactId, ["original_frames"]));
    expect(value(engine.files.listSubdir(artifact.artifactId, "original_frames"))).toEqual([
      "0.00.jpg",
    ]);

    const scratch = path.join(root, "import-source.txt");
    await writeFile(scratch, "imported-bytes");
    const imported = await engine.files.importObject(scratch);
    expect(imported.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(imported.size).toBe(Buffer.byteLength("imported-bytes"));

    const sourcePath = path.join(root, "from-path.bin");
    await writeFile(sourcePath, "from-path");
    value(
      await engine.files.writeFromPath(
        artifact.artifactId,
        "source.bin",
        sourcePath,
      ),
    );
    expect(
      value(await engine.files.read(artifact.artifactId, "source.bin")).toString(),
    ).toBe("from-path");

    const materialized = value(
      await engine.workspaces.materialize(artifact.artifactId),
    );
    expect(materialized).toBe(workspace);
    value(await engine.workspaces.evict(artifact.artifactId));
    await expect(
      engine.files.read(artifact.artifactId, "source.bin"),
    ).resolves.toMatchObject({ ok: true });
    const restored = value(
      await engine.workspaces.materialize(artifact.artifactId),
    );
    expect(
      value(await engine.files.read(artifact.artifactId, "source.bin")).toString(),
    ).toBe("from-path");
    expect(restored).toBe(workspace);
    engine.close();
  });
});

describe("relocated metadata, entities, prompts, and messages", () => {
  it("round-trips artifact metadata revisions, book metadata, and waveforms", async () => {
    const { engine } = await setup();
    const artifact = value(await engine.artifacts.create("video", "clip"));
    const first = await engine.metadata.artifacts.write(artifact.artifactId, "caption", {
      text: "first",
    });
    expect(first.ok).toBe(true);
    if (!first.ok || !first.revision) throw new Error("missing metadata revision");
    value(
      await engine.metadata.artifacts.write(artifact.artifactId, "caption", {
        text: "second",
      }),
    );
    expect(
      value(
        await engine.metadata.artifacts.readAtRevision<{ text: string }>(
          artifact.artifactId,
          "caption",
          first.revision,
        ),
      ),
    ).toEqual({ text: "first" });
    expect(
      value(
        await engine.metadata.artifacts.read<{ text: string }>(
          artifact.artifactId,
          "caption",
        ),
      ),
    ).toEqual({ text: "second" });
    expect(
      value(await engine.metadata.artifacts.delete(artifact.artifactId, "caption")),
    ).toBe(true);

    value(await engine.metadata.book.write("theme", { mode: "dark" }));
    expect(value(await engine.metadata.book.read<{ mode: string }>("theme"))).toEqual({
      mode: "dark",
    });
    expect(value(await engine.metadata.book.delete("theme"))).toBe(true);

    value(await engine.metadata.waveforms.write(artifact.artifactId, [0, 1, 0]));
    expect(
      value(await engine.metadata.waveforms.read(artifact.artifactId)).peaks,
    ).toEqual([0, 1, 0]);
    expect(value(await engine.metadata.waveforms.delete(artifact.artifactId))).toBe(
      true,
    );
    engine.close();
  });

  it("reads and writes entities after create", async () => {
    const { engine } = await setup();
    const created = value(
      await engine.entities.create("character", "Hero", {
        description: "first",
        prompt: "a hero",
        data: { age: 32 },
      }),
    );
    expect(value(engine.entities.read(created.id))).toMatchObject({
      name: "Hero",
      description: "first",
      data: { age: 32 },
    });
    value(await engine.entities.write({ ...created, description: "updated" }));
    expect(value(engine.entities.read(created.id)).description).toBe("updated");
    engine.close();
  });

  it("records prompt history newest-first with limit and count", async () => {
    const { engine } = await setup();
    for (let index = 0; index < 5; index += 1) {
      await sleep(2);
      value(
        await engine.prompts.record({
          surface: "chat",
          prompt: `msg-${index}`,
        }),
      );
    }
    value(
      await engine.prompts.record({
        surface: "notebook",
        prompt: "other-surface",
      }),
    );
    expect(value(engine.prompts.count({ surface: "chat" }))).toBe(5);
    expect(
      value(engine.prompts.list({ surface: "chat", limit: 2 })).map(
        (entry) => entry.prompt,
      ),
    ).toEqual(["msg-4", "msg-3"]);
    expect(
      value(engine.prompts.list({ surface: "chat", limit: 5 })).map(
        (entry) => entry.prompt,
      ),
    ).toEqual(["msg-4", "msg-3", "msg-2", "msg-1", "msg-0"]);
    engine.close();
  });

  it("appends messages and lists them with role and limit filters", async () => {
    const { engine } = await setup();
    value(
      await engine.messages.append({ role: "user", body: { text: "hello" } }),
    );
    value(
      await engine.messages.append({
        role: "assistant",
        body: { text: "hi" },
      }),
    );
    value(
      await engine.messages.append({ role: "user", body: { text: "again" } }),
    );
    expect(
      value(engine.messages.list<{ text: string }>()).map(
        (message) => message.body.text,
      ),
    ).toEqual(["hello", "hi", "again"]);
    expect(
      value(engine.messages.list<{ text: string }>({ role: "user" })).map(
        (message) => message.body.text,
      ),
    ).toEqual(["hello", "again"]);
    expect(
      value(engine.messages.list<{ text: string }>({ limit: 1 })).map(
        (message) => message.body.text,
      ),
    ).toEqual(["again"]);
    engine.close();
  });
});

describe("relocated notebooks, streams, status, settings, and logs", () => {
  it("records a notebook run against an existing notebook", async () => {
    const { engine } = await setup();
    const notebook = value(await engine.notebooks.create("Runs"));
    const cell = engine.notebooks.createCell({
      type: "prompt",
      slot: { row: 0, column: 0 },
    });
    value(await engine.notebooks.insertCell(notebook.id, cell));
    const recorded = value(
      await engine.notebooks.recordRun({
        id: uuidv7(),
        notebookId: notebook.id,
        status: "completed",
        startedAt: new Date(0).toISOString(),
        completedAt: new Date(1).toISOString(),
        cellOrder: [cell.id],
        outputs: { [cell.id]: "done" },
      }),
    );
    expect(recorded.hash).toMatch(/^[0-9a-f]{32,}$/i);
    expect(
      engine.history.revisions(5).some(
        (revision) =>
          revision.hash === recorded.hash &&
          revision.operation === "record_notebook_run",
      ),
    ).toBe(true);
    engine.close();
  });

  it("lists streams and reads a stream at the registration revision", async () => {
    const { engine } = await setup();
    const artifact = value(await engine.artifacts.create("audio", "voice"));
    value(await engine.files.write(artifact.artifactId, "original.wav", "audio"));
    const objectHash = value(await engine.files.manifest(artifact.artifactId))
      .files[0]?.objectHash;
    if (!objectHash) throw new Error("missing object hash");
    const registered = await engine.streams.register({
      artifactId: artifact.artifactId,
      sourcePath: "original.wav",
      objectHash,
      streamIndex: 0,
      kind: "audio",
      timeBase: { numerator: 1, denominator: 48_000 },
      durationTicks: 48_000,
      codec: "pcm_s16le",
      audio: {
        sampleRateHz: 48_000,
        channels: 1,
        channelLayout: "mono",
      },
    });
    expect(registered.ok).toBe(true);
    if (!registered.ok || !registered.revision) {
      throw new Error("stream registration failed");
    }
    const listed = value(engine.streams.list(artifact.artifactId));
    expect(listed).toHaveLength(1);
    expect(listed[0]?.streamId).toBe(registered.value.streamId);
    expect(
      value(
        engine.streams.getAtRevision(
          registered.value.streamId,
          registered.revision,
        ),
      ).objectHash,
    ).toBe(objectHash);
    engine.close();
  });

  it("computes ready status for a character with no media files", () => {
    expect(
      computeArtifactStatus({
        kind: "character",
        fileNames: new Set(),
        primaryMediaName: null,
        hasOriginalMetadata: false,
        hasPartFile: false,
        lockData: null,
        pendingTask: null,
        generationError: null,
        artifactRow: null,
      }),
    ).toBe("ready");
    expect(
      computeArtifactStatus({
        kind: "video",
        fileNames: new Set(["original.mp4"]),
        primaryMediaName: "original.mp4",
        hasOriginalMetadata: true,
        hasPartFile: false,
        lockData: null,
        pendingTask: null,
        generationError: null,
        artifactRow: { status: "ready", meta: {} },
      }),
    ).toBe("ready");
    expect(
      computeArtifactStatus({
        kind: "video",
        fileNames: new Set(),
        primaryMediaName: null,
        hasOriginalMetadata: false,
        hasPartFile: false,
        lockData: null,
        pendingTask: {
          artifactId: uuidv7(),
          taskId: "task-1",
          taskType: "transcribe",
          workspacePath: "/tmp",
          createdAt: 1,
          meta: {},
          completing: false,
          ownerId: null,
        },
        generationError: null,
        artifactRow: null,
      }),
    ).toBe("transcribing");
  });

  it("gets, sets, and deletes runtime settings and log lines", async () => {
    const { engine } = await setup();
    expect(engine.settings.get("feature.flag")).toBeNull();
    value(engine.settings.set("feature.flag", { enabled: true }));
    expect(engine.settings.get<{ enabled: boolean }>("feature.flag")).toEqual({
      enabled: true,
    });
    expect(value(engine.settings.delete("feature.flag"))).toBe(true);
    expect(engine.settings.get("feature.flag")).toBeNull();

    value(await engine.logs.append("jobs", { event: "start" }));
    value(await engine.logs.append("jobs", { event: "done" }));
    expect(engine.logs.read("jobs")).toEqual([
      { event: "start" },
      { event: "done" },
    ]);
    expect(engine.logs.read("jobs", { limit: 1 })).toEqual([{ event: "done" }]);
    engine.close();
  });

  it("exposes initialize, schema check, and empty temporal provider lists", async () => {
    const { engine } = await setup();
    await engine.initialize();
    expect(engine.jobs.checkSchema()).toMatchObject({
      ok: true,
      currentVersion: 22,
      supportedVersion: 22,
    });
    expect(engine.temporalSearch.providers.list()).toEqual([]);
    expect(engine.temporalSearch.manifests.list()).toEqual([]);
    const reaper = engine.jobs.startReaper({ intervalMs: 60_000 });
    reaper.stop();
    engine.close();
  });
});

describe("relocated job queue, pending, failures, locks, and recovery", () => {
  it("reaps expired running jobs after the catalog is reopened", async () => {
    const { engine, root } = await setup("restart-recovery");
    const queued = [
      "process_upload",
      "semantic_index",
      "preview_render",
      "final_render",
    ].map((type) =>
      engine.jobs.queue.enqueue({
        type,
        payload: { type },
        maxAttempts: 2,
      }),
    );
    const leased = queued.map(() => engine.jobs.queue.dequeue(process.pid, -1));
    expect(leased.map((job) => job?.id)).toEqual(
      queued.map((result) => result.job.id),
    );
    expect(leased.every((job) => job?.state === "running")).toBe(true);
    engine.close();

    const reopened = createEngine({ rootDir: root });
    await reopened.ready;
    expect(await reopened.jobs.queue.reap()).toEqual({ requeued: 4, failed: 0 });
    for (const result of queued) {
      expect(reopened.jobs.queue.get(result.job.id)).toMatchObject({
        state: "queued",
        attempts: 1,
        maxAttempts: 2,
      });
    }
    reopened.close();
  });

  it("fails an expired job that has exhausted attempts", async () => {
    const { engine } = await setup();
    const enqueued = engine.jobs.queue.enqueue({
      type: "process_upload",
      payload: {},
      maxAttempts: 1,
    });
    expect(engine.jobs.queue.dequeue(process.pid, -1)?.id).toBe(enqueued.job.id);
    expect(await engine.jobs.queue.reap()).toEqual({ requeued: 0, failed: 1 });
    expect(engine.jobs.queue.get(enqueued.job.id)?.state).toBe("failed");
    engine.close();
  });

  it("heartbeats, lists, counts, looks up by external id, and aborts an artifact's jobs", async () => {
    const { engine } = await setup();
    const artifact = value(await engine.artifacts.create("image", "job-target"));
    const enqueued = engine.jobs.queue.enqueue({
      type: "generate_image",
      artifactId: artifact.artifactId,
      externalTaskId: "ext-1",
      payload: { prompt: "sky" },
    });
    const running = engine.jobs.queue.dequeue(process.pid, 30_000);
    expect(running?.id).toBe(enqueued.job.id);
    expect(
      engine.jobs.queue.heartbeat(running!.id, running!.fence, 30_000),
    ).toBe(true);
    expect(
      engine.jobs.queue.findByExternal("generate_image", "ext-1")?.id,
    ).toBe(enqueued.job.id);
    expect(engine.jobs.queue.list({ type: "generate_image" })).toHaveLength(1);
    expect(engine.jobs.queue.count({ states: ["running"] })).toBe(1);
    expect(engine.jobs.queue.listLeased().map((job) => job.id)).toEqual([
      enqueued.job.id,
    ]);
    expect(engine.jobs.queue.markCompleting(enqueued.job.id)).toBe(true);
    const aborted = await engine.jobs.queue.abortArtifact(
      artifact.artifactId,
      "Cancelled by user",
    );
    expect(aborted).toHaveLength(1);
    expect(engine.jobs.queue.get(enqueued.job.id)).toMatchObject({
      state: "aborted",
      error: { message: "Cancelled by user" },
    });
    engine.close();
  });

  it("retries a failed job then records a terminal failure", async () => {
    const { engine } = await setup();
    const enqueued = engine.jobs.queue.enqueue({
      type: "generate_image",
      payload: {},
      maxAttempts: 2,
    });
    const first = engine.jobs.queue.dequeue(process.pid, 30_000);
    expect(first).toBeTruthy();
    expect(
      await engine.jobs.queue.fail(first!.id, {
        error: { message: "provider down" },
      }),
    ).toBe(true);
    expect(engine.jobs.queue.get(enqueued.job.id)?.state).toBe("queued");
    const second = engine.jobs.queue.dequeue(process.pid, 30_000);
    expect(second).toBeTruthy();
    expect(
      await engine.jobs.queue.fail(second!.id, {
        error: { message: "provider down" },
      }),
    ).toBe(true);
    expect(engine.jobs.queue.get(enqueued.job.id)?.state).toBe("failed");
    engine.close();
  });

  it("tracks artifact work, pending provider tasks, locks, and failures", async () => {
    const { engine } = await setup();
    const artifact = value(await engine.artifacts.create("video", "provider"));
    const lease = engine.jobs.artifactWork.begin(artifact.artifactId, {
      kind: "generate",
      ownerKind: "job",
      durationMs: 60_000,
    });
    expect(lease).toBeTruthy();
    if (!lease) throw new Error("could not begin artifact work");
    expect(engine.jobs.artifactWork.begin(artifact.artifactId, {
      kind: "generate",
      ownerKind: "job",
      durationMs: 60_000,
    })).toBeNull();
    expect(engine.jobs.artifactWork.renew(artifact.artifactId, lease.ownerId, 10_000)).toBe(
      true,
    );
    expect(engine.jobs.artifactWork.markSeen(artifact.artifactId)).toBe(true);
    expect(value(engine.jobs.artifactWork.read(artifact.artifactId))).toMatchObject({
      status: "working",
      ownerId: lease.ownerId,
    });
    expect(value(engine.jobs.artifactWork.list()).length).toBeGreaterThan(0);

    const pending = value(
      await engine.jobs.pending.write(
        {
          artifactId: artifact.artifactId,
          taskId: "task-1",
          taskType: "alibaba_image",
          meta: { model: "seedream" },
        },
        lease.ownerId,
      ),
    );
    expect(pending?.inserted).toBe(true);
    expect(value(engine.jobs.pending.read(artifact.artifactId))?.taskId).toBe(
      "task-1",
    );
    expect(
      value(engine.jobs.pending.findByExternalId("task-1"))?.artifactId,
    ).toBe(artifact.artifactId);
    expect(engine.jobs.pending.getOwner(artifact.artifactId, "task-1")).toBe(
      lease.ownerId,
    );
    expect(value(engine.jobs.pending.findAll())).toHaveLength(1);
    expect(value(engine.jobs.pending.markCompleting(artifact.artifactId))).toBe(
      true,
    );
    expect(value(engine.jobs.pending.clearCompleting(artifact.artifactId))).toBe(
      true,
    );
    expect(value(engine.jobs.pending.delete(artifact.artifactId, "task-1"))).toBe(
      true,
    );

    const workspace = value(
      await engine.workspaces.resolveArtifact(artifact.artifactId),
    );
    const lock = value(
      await engine.jobs.locks.acquire(workspace, { durationMs: 60_000 }),
    );
    expect(await engine.jobs.locks.isLocked(workspace)).toBe(true);
    expect(engine.jobs.locks.get(workspace)?.ownerId).toBe(lock.ownerId);
    expect(value(engine.jobs.locks.release(workspace))).toBe(true);
    expect(await engine.jobs.locks.isLocked(workspace)).toBe(false);
    expect(engine.jobs.locks.cleanStale(workspace)).toBe(false);

    expect(engine.jobs.artifactWork.complete(artifact.artifactId, lease.ownerId)).toBe(
      true,
    );
    const failedLease = engine.jobs.artifactWork.begin(artifact.artifactId, {
      kind: "generate",
      ownerKind: "job",
      durationMs: 60_000,
    });
    expect(failedLease).toBeTruthy();
    if (!failedLease) throw new Error("could not begin failing work");
    expect(
      await engine.jobs.artifactWork.fail(artifact.artifactId, failedLease.ownerId, {
        message: "No valid characters detected in the video",
        code: "400",
      }),
    ).toBe(true);
    value(
      await engine.jobs.failures.write(artifact.artifactId, {
        message: "No valid characters detected in the video",
        failCode: "400",
        prompt: "A dancer turns toward camera",
      }),
    );
    const persisted = value(engine.jobs.failures.read(artifact.artifactId));
    expect(persisted).toMatchObject({
      message: "No valid characters detected in the video",
      failCode: "400",
      prompt: "A dancer turns toward camera",
    });
    expect(persisted?.failedAt).toBeGreaterThan(0);
    expect(value(engine.jobs.failures.findAll())).toHaveLength(1);
    expect(value(await engine.jobs.failures.clear(artifact.artifactId))).toBe(true);
    expect(value(engine.jobs.failures.read(artifact.artifactId))).toBeNull();
    engine.close();
  });

  it("restores missing artifact runtime views through recover", async () => {
    const { engine, root } = await setup();
    const artifact = value(await engine.artifacts.create("image", "recover-me"));
    const artifactId = artifact.artifactId;
    engine.close();

    const catalog = new DatabaseSync(path.join(root, "data", "videobook.db"));
    catalog.prepare("DELETE FROM runtime_artifact_views WHERE artifact_id=?").run(
      artifactId,
    );
    catalog.close();

    const reopened = createEngine({ rootDir: root });
    await reopened.ready;
    expect(value(reopened.jobs.artifactWork.read(artifactId))).toBeNull();
    value(reopened.jobs.recoverArtifact(artifactId));
    expect(value(reopened.jobs.artifactWork.read(artifactId))).toMatchObject({
      artifactId,
      status: "ready",
    });
    expect(value(reopened.jobs.recoverAll())).toEqual({ recovered: 0 });
    reopened.close();
  });
});
