import {
  copyFile,
  mkdir,
  mkdtemp,
  readdir,
  rm,
  stat,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";

import { DatabaseSync } from "@dolthub/doltlite";
import { afterEach, describe, expect, it } from "vitest";

import { createEngine, type Engine } from "../src/engine.js";
import type { ContentStore } from "../src/engine-types.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map(removeRoot));
});

async function setup(initialBookSlug = "demo"): Promise<{
  engine: Engine;
  root: string;
  dataDir: string;
}> {
  const root = await mkdtemp(path.join(tmpdir(), "videobook-v2-"));
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
  result:
    | { ok: true; value: T }
    | { ok: false; error: { message: string } },
): T {
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

async function removeRoot(root: string): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      await rm(root, { recursive: true, force: true, maxRetries: 1 });
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  throw lastError;
}

describe("single-book Dolt engine", () => {
  it("initializes exactly one book and reopens it without initialization input", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "videobook-book-"));
    roots.push(root);
    const dataDir = path.join(root, "data");
    const workspaceDir = path.join(root, "workspace");

    expect(() =>
      createEngine({ dataDir, workspaceDir }),
    ).toThrow("initialBookSlug is required");

    const engine = createEngine({
      dataDir,
      workspaceDir,
      initialBookSlug: "My First Book",
    });
    const first = engine.book.get();
    expect(first.slug).toBe("my-first-book");
    expect(first.bookId).toMatch(/^[0-9a-f-]{36}$/);
    value(await engine.book.rename("Renamed Book"));
    engine.close();

    const catalog = new DatabaseSync(path.join(dataDir, "videobook.db"));
    const bookColumns = (
      catalog.prepare("PRAGMA table_info(book)").all() as Array<{ name: string }>
    ).map((column) => column.name);
    expect(bookColumns).toEqual(["singleton", "book_id", "slug"]);
    catalog.close();

    const reopened = createEngine({ dataDir, workspaceDir });
    expect(reopened.book.get()).toEqual({
      bookId: first.bookId,
      slug: "renamed-book",
    });
    reopened.close();

    const suppliedAgain = createEngine({
      dataDir,
      workspaceDir,
      initialBookSlug: "ignored-on-reopen",
    });
    expect(suppliedAgain.book.get().slug).toBe("renamed-book");
    suppliedAgain.close();
  });

  it("rejects older catalog schemas instead of migrating projects", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "videobook-old-schema-"));
    roots.push(root);
    const dataDir = path.join(root, "data");
    await mkdir(dataDir, { recursive: true });
    const db = new DatabaseSync(path.join(dataDir, "videobook.db"));
    db.exec(
      `CREATE TABLE engine_schema (
        singleton INTEGER PRIMARY KEY,
        version INTEGER NOT NULL,
        created_at INTEGER NOT NULL
      );
      INSERT INTO engine_schema(singleton, version, created_at)
      VALUES (1, 2, 0);`,
    );
    db.close();

    expect(() =>
      createEngine({
        dataDir,
        workspaceDir: path.join(root, "workspace"),
      }),
    ).toThrow("Database schema 2 is not supported");
  });

  it("keeps semantic history and runtime state in one database without projects", async () => {
    const { engine, dataDir } = await setup();
    const artifact = value(
      await engine.artifacts.create({ kind: "image", slug: "img-cat" }),
    );
    expect((await stat(artifact.path)).isDirectory()).toBe(true);
    const semanticHead = engine.head;
    expect(
      engine.jobs.artifactWork.begin(artifact.artifactId, {
        kind: "generate",
        ownerKind: "job",
        durationMs: 10_000,
      }),
    ).not.toBeNull();
    expect(engine.settings.set("application.watermark", { enabled: true }).ok).toBe(
      true,
    );
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
           WHERE type='table' AND name IN ('book', 'projects', 'runtime_artifact_views')
           ORDER BY name`,
        )
        .all() as Array<{ name: string }>
    ).map((row) => row.name);
    expect(names).toEqual(["book", "runtime_artifact_views"]);
    expect(
      db.doltStatus().some(
        (row) => row.table_name === "runtime_artifact_views" && row.staged === 1,
      ),
    ).toBe(false);
    db.close();
  });

  it("projects queued work into an artifact runtime view", async () => {
    const { engine } = await setup();
    const artifact = value(
      await engine.artifacts.create({ kind: "image", slug: "img-queued" }),
    );
    const enqueued = engine.jobs.queue.enqueue({
      type: "generate_image",
      artifactId: artifact.artifactId,
      payload: {},
      artifactWorkKind: "generate",
    });
    expect(enqueued.inserted).toBe(true);
    expect(value(engine.jobs.artifactWork.read(artifact.artifactId))).toMatchObject({
      status: "pending",
      meta: { kind: "generate", queued: true },
      deadlineAt: null,
    });
    expect(value(await engine.status.get(artifact.artifactId))).toBe("generating");
    engine.close();
  });

  it("reuses a deleted slug with an isolated identity", async () => {
    const { engine } = await setup();
    const first = value(
      await engine.artifacts.create({ kind: "video", slug: "vid-cat" }),
    );
    value(await engine.files.write(first.artifactId, "original.mp4", "old bytes"));
    value(await engine.artifacts.delete(first.artifactId));
    expect(engine.artifacts.isSlugAvailable("vid-cat")).toBe(true);

    const second = value(
      await engine.artifacts.create({ kind: "video", slug: "vid-cat" }),
    );
    expect(second.artifactId).not.toBe(first.artifactId);
    expect(second.path).not.toBe(first.path);
    expect(value(await engine.files.manifest(second.artifactId)).files).toEqual([]);
    engine.close();
  });

  it("restores artifact content forward without changing its identity", async () => {
    const { engine } = await setup();
    const artifact = value(
      await engine.artifacts.create({ kind: "script", slug: "script-draft" }),
    );
    const first = await engine.files.write(
      artifact.artifactId,
      "original.md",
      "version one",
    );
    if (!first.ok || !first.revision) throw new Error("missing first revision");
    value(await engine.files.write(artifact.artifactId, "original.md", "version two"));

    value(await engine.history.restoreArtifact(artifact.artifactId, first.revision));
    expect(
      value(await engine.files.read(artifact.artifactId, "original.md")).toString(),
    ).toBe("version one");
    expect(value(engine.artifacts.get(artifact.artifactId)).artifactId).toBe(
      artifact.artifactId,
    );
    engine.close();
  });

  it("reports the current owner when restoring a reused artifact slug", async () => {
    const { engine } = await setup();
    const original = value(
      await engine.artifacts.create({ kind: "video", slug: "vid-cat" }),
    );
    const written = await engine.files.write(
      original.artifactId,
      "original.mp4",
      "old cat",
    );
    if (!written.ok || !written.revision) throw new Error("missing write revision");
    value(await engine.artifacts.delete(original.artifactId));
    const current = value(
      await engine.artifacts.create({ kind: "video", slug: "vid-cat" }),
    );

    const conflict = await engine.history.restoreArtifact(
      original.artifactId,
      written.revision,
    );
    expect(conflict).toMatchObject({ ok: false, error: { code: "SLUG_CONFLICT" } });
    if (!conflict.ok) expect(conflict.error.ownerId).toBe(current.artifactId);

    value(
      await engine.history.restoreArtifact(
        original.artifactId,
        written.revision,
        "vid-cat-restored",
      ),
    );
    expect(value(engine.artifacts.get(original.artifactId)).slug).toBe(
      "vid-cat-restored",
    );
    engine.close();
  });

  it("restores all book-authored state forward", async () => {
    const { engine } = await setup();
    const artifact = value(
      await engine.artifacts.create({ kind: "script", slug: "script-main" }),
    );
    value(await engine.files.write(artifact.artifactId, "original.md", "target"));
    value(
      await engine.metadata.artifacts.write(
        artifact.artifactId,
        "caption",
        "target caption",
      ),
    );
    const entity = value(await engine.entities.create("character", "Target Character"));
    value(await engine.notebooks.create("Target Notebook"));
    value(
      await engine.metadata.book.write("timeline", {
        render: "portrait",
        slots: [{ id: "s1", slug: artifact.slug }],
        audio: [],
      }),
    );
    value(await engine.prompts.record({ surface: "chat", prompt: "target prompt" }));
    value(await engine.messages.append({ role: "user", body: { text: "target message" } }));
    const target = engine.head;

    value(await engine.book.rename("later-book"));
    value(await engine.files.write(artifact.artifactId, "original.md", "later"));
    value(await engine.metadata.artifacts.write(artifact.artifactId, "caption", "later"));
    value(await engine.entities.delete(entity.id));
    value(await engine.artifacts.create({ kind: "image", slug: "img-later" }));
    value(await engine.prompts.record({ surface: "chat", prompt: "later prompt" }));
    value(await engine.messages.append({ role: "assistant", body: { text: "later message" } }));

    value(await engine.history.restore(target));
    expect(engine.book.get().slug).toBe("demo");
    expect(
      value(await engine.files.read(artifact.artifactId, "original.md")).toString(),
    ).toBe("target");
    expect(
      value(await engine.metadata.artifacts.read<string>(artifact.artifactId, "caption")),
    ).toBe("target caption");
    expect(engine.entities.list()).toHaveLength(1);
    expect(engine.notebooks.list()).toHaveLength(1);
    expect(engine.artifacts.list()).toHaveLength(1);
    expect(value(engine.prompts.list()).map((entry) => entry.prompt)).toEqual([
      "target prompt",
    ]);
    expect(value(engine.messages.list<{ text: string }>()).map((message) => message.body.text)).toEqual([
      "target message",
    ]);
    expect(value(await engine.metadata.book.read<{ render: string }>("timeline")).render).toBe(
      "portrait",
    );
    engine.close();
  });

  it("records generic action graph entries and detects stale write sets", async () => {
    const { engine } = await setup();
    const artifact = value(
      await engine.artifacts.create({ kind: "image", slug: "img-action" }),
    );
    const base = engine.head;
    const action = value(
      await engine.history.recordAction({
        operation: "generate_image",
        scope: "artifact",
        targetArtifactId: artifact.artifactId,
        inputArtifactIds: [artifact.artifactId],
        outputArtifactIds: [artifact.artifactId],
        writeSet: [`artifact:${artifact.artifactId}`],
        details: { prompt: "cat" },
      }),
    );
    expect(action.action.operation).toBe("generate_image");
    expect(action.action.inputArtifacts[0]?.id).toBe(artifact.artifactId);
    expect(value(engine.history.action(action.action.id)).events).toHaveLength(1);
    expect(value(engine.history.actions()).actions).toHaveLength(1);

    value(await engine.history.recordOperation("touch", artifact.artifactId));
    const conflict = await engine.history.recordAction({
      operation: "stale_action",
      baseRevision: base,
      writeSet: [`artifact:${artifact.artifactId}`],
    });
    expect(conflict).toMatchObject({ ok: false, error: { code: "ACTION_CONFLICT" } });
    engine.close();
  });

  it("copies terminal jobs into versioned audit rows", async () => {
    const { engine, dataDir } = await setup();
    const artifact = value(
      await engine.artifacts.create({ kind: "image", slug: "img-job" }),
    );
    const enqueued = engine.jobs.queue.enqueue({
      type: "generate",
      artifactId: artifact.artifactId,
      payload: { prompt: "cat" },
      artifactWorkKind: "generate",
    });
    const running = engine.jobs.queue.dequeue(process.pid, 30_000);
    expect(running?.id).toBe(enqueued.job.id);
    expect(
      await engine.jobs.queue.complete(
        enqueued.job.id,
        { result: { output: "ok" } },
        running?.fence,
      ),
    ).toBe(true);
    engine.close();

    const db = new DatabaseSync(path.join(dataDir, "videobook.db"));
    const audit = db
      .prepare("SELECT state, result_json FROM job_runs WHERE run_id=?")
      .get(enqueued.job.operationId) as { state: string; result_json: string };
    expect(audit.state).toBe("done");
    expect(JSON.parse(audit.result_json)).toEqual({ output: "ok" });
    db.close();
  });

  it("publishes CAS objects before backing up the catalog", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "videobook-backup-"));
    roots.push(root);
    const objectRoot = path.join(root, "remote-objects");
    const catalogRoot = path.join(root, "remote-catalog");
    const engine = createEngine({
      dataDir: path.join(root, "data"),
      workspaceDir: path.join(root, "workspace"),
      initialBookSlug: "backup",
      remoteObjects: fileContentStore(objectRoot),
      objectPrefix: "videobook",
      catalogBackup: { name: "backup", url: `file://${catalogRoot}` },
    });
    const artifact = value(
      await engine.artifacts.create({ kind: "image", slug: "img-cat" }),
    );
    value(await engine.files.write(artifact.artifactId, "original.png", "image bytes"));
    const manifest = value(await engine.files.manifest(artifact.artifactId));
    const objectHash = manifest.files[0]?.objectHash;
    if (!objectHash) throw new Error("Manifest did not contain an object");
    expect(value(await engine.storage.backup()).state).toBe("backed_up");
    await expect(
      stat(path.join(objectRoot, "videobook", objectHash.slice(0, 2), objectHash)),
    ).resolves.toBeDefined();
    engine.close();
  });

  it("bootstraps an existing catalog snapshot without a new initial slug", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "videobook-bootstrap-"));
    roots.push(root);
    const objectStore = fileContentStore(path.join(root, "remote-objects"));
    const sourceData = path.join(root, "source-data");
    const source = createEngine({
      dataDir: sourceData,
      workspaceDir: path.join(root, "source-workspace"),
      initialBookSlug: "source",
      remoteObjects: objectStore,
      objectPrefix: "videobook",
    });
    const artifact = value(
      await source.artifacts.create({ kind: "video", slug: "vid-cat" }),
    );
    value(await source.files.write(artifact.artifactId, "original.mp4", "remote bytes"));
    value(await source.storage.backup());
    source.close();

    const restoredData = path.join(root, "restored-data");
    await mkdir(restoredData, { recursive: true });
    await copyFile(
      path.join(sourceData, "videobook.db"),
      path.join(restoredData, "videobook.db"),
    );
    const restored = createEngine({
      dataDir: restoredData,
      workspaceDir: path.join(root, "restored-workspace"),
      remoteObjects: objectStore,
      objectPrefix: "videobook",
    });
    await restored.ready;
    expect(value(restored.artifacts.get("vid-cat")).artifactId).toBe(
      artifact.artifactId,
    );
    expect(
      value(await restored.files.read(artifact.artifactId, "original.mp4")).toString(),
    ).toBe("remote bytes");
    restored.close();
  });
});
