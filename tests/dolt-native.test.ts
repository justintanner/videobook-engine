import {
  copyFile,
  mkdir,
  mkdtemp,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";

import { DatabaseSync } from "@dolthub/doltlite";
import { afterEach, describe, expect, it } from "vitest";

import { createEngine, type Engine } from "../src/engine.js";
import type { ContentStore } from "../src/engine-types.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) =>
      rm(root, { recursive: true, force: true }),
    ),
  );
});

async function setup(): Promise<{
  engine: Engine;
  root: string;
  dataDir: string;
}> {
  const root = await mkdtemp(path.join(tmpdir(), "videobook-v1-"));
  roots.push(root);
  const dataDir = path.join(root, "data");
  const engine = await createEngine({
    dataDir,
    workspaceDir: path.join(root, "workspace"),
  });
  return { engine, root, dataDir };
}

function value<T>(result: {
  ok: true;
  value: T;
} | {
  ok: false;
  error: { message: string };
}): T {
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
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
  };
}

describe("Dolt-native engine", () => {
  it("keeps semantic history and runtime state in one database", async () => {
    const { engine, dataDir } = await setup();
    const project = value(await engine.projects.create("demo"));
    const artifact = value(
      await engine.artifacts.create({
        project: project.projectId,
        kind: "image",
        slug: "img-cat",
      }),
    );
    const semanticHead = engine.head;
    const work = engine.jobs.artifactWork.begin(
      project.projectId,
      artifact.artifactId,
      {
        kind: "generate",
        ownerKind: "job",
        durationMs: 10_000,
      },
    );
    expect(work).not.toBeNull();
    expect(
      engine.settings.set("application.watermark", {
        savedHandle: "videobook",
      }).ok,
    ).toBe(true);
    expect(
      engine.settings.get<{ savedHandle: string }>(
        "application.watermark",
      ),
    ).toEqual({ savedHandle: "videobook" });
    expect(engine.head).toBe(semanticHead);

    engine.close();
    expect(
      (await readdir(dataDir)).filter((name) => name.endsWith(".db")),
    ).toEqual(["videobook.db"]);
    const db = new DatabaseSync(path.join(dataDir, "videobook.db"));
    const names = (
      db
        .prepare(
          `SELECT name FROM sqlite_master
           WHERE type='table'
             AND (name='projects' OR name='runtime_artifact_views')`,
        )
        .all() as unknown as Array<{ name: string }>
    ).map((row) => row.name);
    expect(names).toEqual(["projects", "runtime_artifact_views"]);
    const status = db.doltStatus();
    expect(
      status.some(
        (row) =>
          row.table_name === "runtime_artifact_views" &&
          row.staged === 1,
      ),
    ).toBe(false);
    db.close();
  });

  it("projects queued work into the runtime artifact view", async () => {
    const { engine } = await setup();
    const project = value(await engine.projects.create("demo"));
    const artifact = value(
      await engine.artifacts.create({
        project: project.projectId,
        kind: "image",
        slug: "img-queued",
      }),
    );

    engine.jobs.queue.enqueue(project.projectId, {
      type: "generate_image",
      artifactId: artifact.artifactId,
      payload: {},
      artifactWorkKind: "generate",
    });

    const work = value(
      engine.jobs.artifactWork.read(
        project.projectId,
        artifact.artifactId,
      ),
    );
    expect(work).toMatchObject({
      status: "pending",
      meta: { kind: "generate", queued: true },
      deadlineAt: null,
    });
    expect(
      value(
        await engine.status.get(
          artifact.artifactId,
          project.projectId,
        ),
      ),
    ).toBe("generating");
    engine.close();
  });

  it("ingests explicit workspace directories and deletes metadata natively", async () => {
    const { engine } = await setup();
    const project = value(await engine.projects.create("demo"));
    const artifact = value(
      await engine.artifacts.create({
        project: project.projectId,
        kind: "video",
        slug: "vid-render",
      }),
    );
    const frames = path.join(artifact.path, "portrait_frames");
    await mkdir(frames, { recursive: true });
    await Promise.all([
      writeFile(path.join(frames, "0.00.jpg"), "frame zero"),
      writeFile(path.join(frames, "1.00.jpg"), "frame one"),
    ]);

    value(
      await engine.files.ingestWorkspace(
        artifact.artifactId,
        ["portrait_frames"],
        project.projectId,
        "render",
      ),
    );
    expect(
      value(
        await engine.files.manifest(
          artifact.artifactId,
          project.projectId,
        ),
      ).files.map((file) => file.name),
    ).toEqual([
      "portrait_frames/0.00.jpg",
      "portrait_frames/1.00.jpg",
    ]);

    value(
      await engine.metadata.artifacts.write(
        artifact.artifactId,
        "portrait.render",
        { ready: true },
        project.projectId,
      ),
    );
    const metadataRevision = engine.head;
    expect(
      value(
        await engine.metadata.artifacts.readAtRevision<{
          ready: boolean;
        }>(
          artifact.artifactId,
          "portrait.render",
          metadataRevision,
          project.projectId,
        ),
      ),
    ).toEqual({ ready: true });
    expect(
      value(
        await engine.metadata.artifacts.delete(
          artifact.artifactId,
          "portrait.render",
          project.projectId,
        ),
      ),
    ).toBe(true);
    expect(
      (
        await engine.metadata.artifacts.read(
          artifact.artifactId,
          "portrait.render",
          project.projectId,
        )
      ).ok,
    ).toBe(false);
    engine.close();
  });

  it("reuses an exact deleted slug with a new isolated identity", async () => {
    const { engine } = await setup();
    const project = value(await engine.projects.create("demo"));
    const first = value(
      await engine.artifacts.create({
        project: project.projectId,
        kind: "video",
        slug: "vid-cat",
      }),
    );
    value(
      await engine.files.write(
        first.artifactId,
        "original.mp4",
        "old bytes",
        project.projectId,
      ),
    );
    const owner = engine.jobs.artifactWork.begin(
      project.projectId,
      first.artifactId,
      {
        kind: "upload",
        ownerKind: "job",
        durationMs: 60_000,
      },
    );
    expect(owner).not.toBeNull();

    value(
      await engine.artifacts.delete(
        first.artifactId,
        project.projectId,
      ),
    );
    expect(
      engine.artifacts.isSlugAvailable(project.projectId, "vid-cat"),
    ).toBe(true);

    const second = value(
      await engine.artifacts.create({
        project: project.projectId,
        kind: "video",
        slug: "vid-cat",
      }),
    );
    expect(second.slug).toBe("vid-cat");
    expect(second.artifactId).not.toBe(first.artifactId);
    expect(second.path).not.toBe(first.path);
    expect(
      value(
        await engine.files.manifest(
          second.artifactId,
          project.projectId,
        ),
      ).files,
    ).toEqual([]);
    expect(
      value(
        engine.jobs.failures.read(
          project.projectId,
          second.artifactId,
        ),
      ),
    ).toBeNull();
    expect(
      value(
        engine.jobs.pending.read(
          project.projectId,
          second.artifactId,
        ),
      ),
    ).toBeNull();
    engine.close();
  });

  it("serializes concurrent claims for the same active slug", async () => {
    const { engine } = await setup();
    const project = value(await engine.projects.create("demo"));
    const attempts = await Promise.all([
      engine.artifacts.create({
        project: project.projectId,
        kind: "video",
        slug: "vid-cat",
      }),
      engine.artifacts.create({
        project: project.projectId,
        kind: "video",
        slug: "vid-cat",
      }),
    ]);
    expect(attempts.filter((result) => result.ok)).toHaveLength(1);
    const failure = attempts.find((result) => !result.ok);
    expect(failure && !failure.ok ? failure.error.code : null).toBe(
      "SLUG_CONFLICT",
    );
    engine.close();
  });

  it("restores content forward without changing artifact identity", async () => {
    const { engine } = await setup();
    const project = value(await engine.projects.create("demo"));
    const artifact = value(
      await engine.artifacts.create({
        project: project.projectId,
        kind: "script",
        slug: "script-draft",
      }),
    );
    const firstWrite = await engine.files.write(
      artifact.artifactId,
      "original.md",
      "version one",
      project.projectId,
    );
    if (!firstWrite.ok || !firstWrite.revision) {
      throw new Error("First write did not create a revision");
    }
    value(
      await engine.files.write(
        artifact.artifactId,
        "original.md",
        "version two",
        project.projectId,
      ),
    );
    value(
      await engine.history.restoreArtifact(
        artifact.artifactId,
        firstWrite.revision,
        project.projectId,
      ),
    );
    expect(
      value(
        await engine.files.read(
          artifact.artifactId,
          "original.md",
          project.projectId,
        ),
      ).toString(),
    ).toBe("version one");
    expect(
      value(
        engine.artifacts.get(
          project.projectId,
          artifact.artifactId,
        ),
      ).artifactId,
    ).toBe(artifact.artifactId);
    engine.close();
  });

  it("reports the current owner when restoring a reused slug", async () => {
    const { engine } = await setup();
    const project = value(await engine.projects.create("demo"));
    const original = value(
      await engine.artifacts.create({
        project: project.projectId,
        kind: "video",
        slug: "vid-cat",
      }),
    );
    const written = await engine.files.write(
      original.artifactId,
      "original.mp4",
      "old cat",
      project.projectId,
    );
    if (!written.ok || !written.revision) {
      throw new Error("Write did not create a revision");
    }
    value(
      await engine.artifacts.delete(
        original.artifactId,
        project.projectId,
      ),
    );
    const current = value(
      await engine.artifacts.create({
        project: project.projectId,
        kind: "video",
        slug: "vid-cat",
      }),
    );
    const conflict = await engine.history.restoreArtifact(
      original.artifactId,
      written.revision,
      project.projectId,
    );
    expect(conflict.ok).toBe(false);
    if (!conflict.ok) {
      expect(conflict.error.code).toBe("SLUG_CONFLICT");
      expect(conflict.error.ownerId).toBe(current.artifactId);
    }
    value(
      await engine.history.restoreArtifact(
        original.artifactId,
        written.revision,
        project.projectId,
        "vid-cat-restored",
      ),
    );
    expect(
      value(
        engine.artifacts.get(
          project.projectId,
          original.artifactId,
        ),
      ).slug,
    ).toBe("vid-cat-restored");
    engine.close();
  });

  it("restores all user-authored project tables forward", async () => {
    const { engine } = await setup();
    const project = value(await engine.projects.create("demo"));
    const artifact = value(
      await engine.artifacts.create({
        project: project.projectId,
        kind: "script",
        slug: "script-main",
      }),
    );
    value(
      await engine.files.write(
        artifact.artifactId,
        "original.md",
        "target",
        project.projectId,
      ),
    );
    value(
      await engine.metadata.artifacts.write(
        artifact.artifactId,
        "caption",
        "target caption",
        project.projectId,
      ),
    );
    const entity = value(
      await engine.entities.create(
        "character",
        "Target Character",
        project.projectId,
      ),
    );
    value(
      await engine.notebooks.create(
        "Target Notebook",
        project.projectId,
      ),
    );
    value(
      await engine.metadata.projects.write(
        "timeline",
        {
          render: "portrait",
          slots: [{ id: "s1", slug: artifact.slug }],
          audio: [],
        },
        project.projectId,
      ),
    );
    value(
      await engine.prompts.record(project.projectId, {
        surface: "chat",
        prompt: "target prompt",
      }),
    );
    value(
      await engine.messages.append(project.projectId, {
        role: "user",
        body: { text: "target message" },
      }),
    );
    const target = engine.head;

    value(
      await engine.files.write(
        artifact.artifactId,
        "original.md",
        "later",
        project.projectId,
      ),
    );
    value(
      await engine.metadata.artifacts.write(
        artifact.artifactId,
        "caption",
        "later caption",
        project.projectId,
      ),
    );
    value(
      await engine.entities.delete(entity.id, project.projectId),
    );
    value(
      await engine.artifacts.create({
        project: project.projectId,
        kind: "image",
        slug: "img-later",
      }),
    );
    value(
      await engine.prompts.record(project.projectId, {
        surface: "chat",
        prompt: "later prompt",
      }),
    );
    value(
      await engine.messages.append(project.projectId, {
        role: "assistant",
        body: { text: "later message" },
      }),
    );

    value(
      await engine.history.restoreProject(target, project.projectId),
    );
    expect(
      value(
        await engine.files.read(
          artifact.artifactId,
          "original.md",
          project.projectId,
        ),
      ).toString(),
    ).toBe("target");
    expect(
      value(
        await engine.metadata.artifacts.read<string>(
          artifact.artifactId,
          "caption",
          project.projectId,
        ),
      ),
    ).toBe("target caption");
    expect(engine.entities.list(project.projectId)).toHaveLength(1);
    expect(engine.notebooks.list(project.projectId)).toHaveLength(1);
    expect(engine.artifacts.list(project.projectId)).toHaveLength(1);
    expect(
      value(engine.prompts.list(project.projectId)).map(
        (entry) => entry.prompt,
      ),
    ).toEqual(["target prompt"]);
    expect(
      value(
        engine.messages.list<{ text: string }>(project.projectId),
      ).map((message) => message.body.text),
    ).toEqual(["target message"]);
    expect(
      value(
        await engine.metadata.projects.read<{
          render: string;
        }>("timeline", project.projectId),
      ).render,
    ).toBe("portrait");
    engine.close();
  });

  it("copies terminal jobs into versioned audit rows", async () => {
    const { engine, dataDir } = await setup();
    const project = value(await engine.projects.create("demo"));
    const artifact = value(
      await engine.artifacts.create({
        project: project.projectId,
        kind: "image",
        slug: "img-job",
      }),
    );
    const enqueued = engine.jobs.queue.enqueue(project.projectId, {
      type: "generate",
      artifactId: artifact.artifactId,
      payload: { prompt: "cat" },
      artifactWorkKind: "generate",
    });
    const running = engine.jobs.queue.dequeue(
      project.projectId,
      process.pid,
      30_000,
    );
    expect(running?.id).toBe(enqueued.job.id);
    const before = engine.head;
    expect(
      await engine.jobs.queue.complete(
        project.projectId,
        enqueued.job.id,
        { result: { output: "ok" } },
        running?.fence,
      ),
    ).toBe(true);
    expect(engine.head).not.toBe(before);
    engine.close();

    const db = new DatabaseSync(path.join(dataDir, "videobook.db"));
    const audit = db
      .prepare(
        `SELECT state, result_json FROM job_runs WHERE run_id=?`,
      )
      .get(enqueued.job.operationId) as unknown as {
      state: string;
      result_json: string;
    };
    expect(audit.state).toBe("done");
    expect(JSON.parse(audit.result_json)).toEqual({ output: "ok" });
    db.close();
  });

  it("replays an interrupted semantic commit from the runtime outbox", async () => {
    const { engine, root, dataDir } = await setup();
    const project = value(await engine.projects.create("demo"));
    const before = engine.head;
    engine.close();

    const operationId = "crash-recovery-operation";
    const now = Date.now();
    const db = new DatabaseSync(path.join(dataDir, "videobook.db"));
    db.exec("PRAGMA foreign_keys = ON");
    db.exec("BEGIN IMMEDIATE");
    db.prepare(
      `INSERT INTO project_metadata(
        project_id, key, value_json, updated_at
      ) VALUES (?, ?, ?, ?)`,
    ).run(
      project.projectId,
      "recovery.marker",
      JSON.stringify({ recovered: true }),
      now,
    );
    db.prepare(
      `INSERT INTO operations(
        operation_id, project_id, operation, artifact_id, details_json,
        write_set_json, base_revision, created_at, author
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      operationId,
      project.projectId,
      "project_metadata_write",
      null,
      JSON.stringify({ key: "recovery.marker" }),
      JSON.stringify(["project-metadata:recovery.marker"]),
      before,
      now,
      "crash-test",
    );
    db.prepare(
      `INSERT INTO runtime_commit_outbox(
        operation_id, tables_json, message, created_at
      ) VALUES (?, ?, ?, ?)`,
    ).run(
      operationId,
      JSON.stringify(["project_metadata", "operations"]),
      "Recover interrupted semantic mutation",
      now,
    );
    db.exec("COMMIT");
    db.close();

    const recovered = await createEngine({
      dataDir,
      workspaceDir: path.join(root, "recovered-workspace"),
    });
    await recovered.ready;
    expect(recovered.head).not.toBe(before);
    expect(
      value(
        await recovered.metadata.projects.read<{
          recovered: boolean;
        }>("recovery.marker", project.projectId),
      ),
    ).toEqual({ recovered: true });
    recovered.close();

    const inspected = new DatabaseSync(
      path.join(dataDir, "videobook.db"),
    );
    const outbox = inspected
      .prepare(
        "SELECT COUNT(*) AS count FROM runtime_commit_outbox",
      )
      .get() as unknown as { count: number };
    expect(outbox.count).toBe(0);
    expect(
      inspected.doltStatus().some((entry) => entry.staged === 1),
    ).toBe(false);
    inspected.close();
  });

  it("publishes CAS objects before pushing the Dolt catalog", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "videobook-backup-"));
    roots.push(root);
    const objectRoot = path.join(root, "remote-objects");
    const catalogRoot = path.join(root, "remote-catalog");
    const objectStore = fileContentStore(objectRoot);
    const engine = await createEngine({
      dataDir: path.join(root, "data"),
      workspaceDir: path.join(root, "workspace"),
      remoteObjects: objectStore,
      objectPrefix: "videobook",
      catalogBackup: {
        name: "backup",
        url: `file://${catalogRoot}`,
      },
    });
    const project = value(await engine.projects.create("demo"));
    const artifact = value(
      await engine.artifacts.create({
        project: project.projectId,
        kind: "image",
        slug: "img-cat",
      }),
    );
    const write = await engine.files.write(
      artifact.artifactId,
      "original.png",
      "image bytes",
      project.projectId,
    );
    if (!write.ok) throw new Error(write.error.message);
    expect(engine.storage.status().state).toBe("pending");
    expect(engine.storage.status().pendingObjects).toBe(1);
    const manifest = value(
      await engine.files.manifest(
        artifact.artifactId,
        project.projectId,
      ),
    );
    const objectHash = manifest.files[0]?.objectHash;
    if (!objectHash) throw new Error("Manifest did not contain an object");
    const backup = value(await engine.storage.backup());
    expect(backup.state).toBe("backed_up");
    expect(backup.pendingObjects).toBe(0);
    await expect(
      stat(
        path.join(
          objectRoot,
          "videobook",
          objectHash.slice(0, 2),
          objectHash,
        ),
      ),
    ).resolves.toBeDefined();
    expect((await stat(catalogRoot)).size).toBeGreaterThan(0);
    engine.close();
  });

  it("bootstraps a fresh engine from a catalog snapshot and remote CAS", async () => {
    const root = await mkdtemp(
      path.join(tmpdir(), "videobook-bootstrap-"),
    );
    roots.push(root);
    const objectStore = fileContentStore(
      path.join(root, "remote-objects"),
    );
    const sourceData = path.join(root, "source-data");
    const source = await createEngine({
      dataDir: sourceData,
      workspaceDir: path.join(root, "source-workspace"),
      remoteObjects: objectStore,
      objectPrefix: "videobook",
    });
    const project = value(await source.projects.create("demo"));
    const artifact = value(
      await source.artifacts.create({
        project: project.projectId,
        kind: "video",
        slug: "vid-cat",
      }),
    );
    value(
      await source.files.write(
        artifact.artifactId,
        "original.mp4",
        "remote video bytes",
        project.projectId,
      ),
    );
    value(await source.storage.backup());
    source.close();

    const restoredData = path.join(root, "restored-data");
    await mkdir(restoredData, { recursive: true });
    await copyFile(
      path.join(sourceData, "videobook.db"),
      path.join(restoredData, "videobook.db"),
    );

    const restored = await createEngine({
      dataDir: restoredData,
      workspaceDir: path.join(root, "restored-workspace"),
      remoteObjects: objectStore,
      objectPrefix: "videobook",
    });
    await restored.ready;
    const restoredArtifact = value(
      restored.artifacts.get(project.projectId, "vid-cat"),
    );
    expect(restoredArtifact.artifactId).toBe(artifact.artifactId);
    expect(
      value(
        await restored.files.read(
          artifact.artifactId,
          "original.mp4",
          project.projectId,
        ),
      ).toString(),
    ).toBe("remote video bytes");
    restored.close();
  });
});
