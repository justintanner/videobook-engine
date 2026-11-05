import { mkdtemp, readFile, rm, writeFile, mkdir, symlink, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { create as tarCreate } from "tar";
import { DatabaseSync } from "@dolthub/doltlite";
import { closeCatalogDatabase } from "../src/catalog-close.js";
import { afterEach, describe, expect, it } from "vitest";
import { createEngine, type Engine } from "../src/engine.js";
import { packBookArchive, inspectBookArchive, restoreBookArchive, releaseBookSnapshot, createBookImportWorkspace, releaseBookImportWorkspace } from "../src/book-archive.js";

const engines: Engine[] = [];
const roots: string[] = [];
const snapshots: string[] = [];
const value = <T>(result: { ok: true; value: T } | { ok: false; error: { message: string } }): T => {
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
};

afterEach(async () => {
  for (const engine of engines.splice(0)) engine.close();
  await Promise.all(snapshots.splice(0).map(releaseBookSnapshot));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true, maxRetries: 3 })));
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "archive-test-"));
  roots.push(root);
  const engine = createEngine({ rootDir: join(root, "source"), initialBookName: "portable" });
  engines.push(engine);
  await engine.ready;
  const artifact = value(await engine.artifacts.create("script", "Two versions"));
  value(await engine.files.write(artifact.artifactId, "original.txt", "first version"));
  const first = engine.head;
  value(await engine.files.write(artifact.artifactId, "original.txt", "second version"));
  value(await engine.notebooks.create("Main"));
  engine.settings.set("example", { preserved: true });
  return { root, engine, artifact, first };
}

async function snapshot(engine: Engine) {
  const result = await engine.storage.snapshot();
  snapshots.push(result.rootDir);
  return result;
}

describe("portable book archives", () => {
  it("preserves identity, complete history, old media and settings while the source remains open", async () => {
    const { root, engine, artifact, first } = await fixture();
    const head = engine.head;
    const history = engine.history.revisions(100);
    const saved = await snapshot(engine);
    expect(engine.head).toBe(head);
    value(await engine.files.write(artifact.artifactId, "original.txt", "after snapshot"));
    const archive = await packBookArchive(saved.rootDir, join(root, "portable.tar.gz"));
    expect(archive.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(await inspectBookArchive(archive.path)).toEqual(saved.manifest);
    const target = join(root, "target");
    await restoreBookArchive(archive.path, target);
    const restored = createEngine({ rootDir: target });
    engines.push(restored);
    await restored.ready;
    expect(restored.book.get()).toEqual(engine.book.get());
    expect(restored.head).toBe(head);
    expect(restored.history.revisions(100)).toEqual(history);
    expect(restored.notebooks.list()).toEqual(engine.notebooks.list());
    expect(value(await restored.files.read(artifact.artifactId, "original.txt")).toString()).toBe("second version");
    expect(value(await restored.files.readAtRevision(artifact.artifactId, "original.txt", first)).toString()).toBe("first version");
    expect(restored.settings.get("example")).toEqual({ preserved: true });
    expect(value(await engine.files.read(artifact.artifactId, "original.txt")).toString()).toBe("after snapshot");
  });

  it("refuses busy books and releases the snapshot fence after failure", async () => {
    const { engine } = await fixture();
    const job = engine.jobs.queue.enqueue({ type: "unfinished", payload: {} }).job;
    await expect(engine.storage.snapshot()).rejects.toThrow("active jobs");
    await engine.jobs.queue.abort(job.id, "fixture finished");
    expect((await snapshot(engine)).manifest.book).toEqual(engine.book.get());
  });

  it("removes source catalog remotes without changing the source or history", async () => {
    const { root, engine } = await fixture();
    engine.close();
    const db = new DatabaseSync(join(root, "source", "data", "videobook.db"));
    db.prepare("SELECT dolt_remote('add', 'source', ?)").get(join(root, "private-backup"));
    closeCatalogDatabase(db, { wrote: true });
    const reopened = createEngine({ rootDir: join(root, "source") });
    engines.push(reopened);
    await reopened.ready;
    const saved = await snapshot(reopened);
    const catalog = new DatabaseSync(join(saved.rootDir, "catalog.db"), { readOnly: true });
    try {
      expect(catalog.prepare("SELECT * FROM dolt_remotes()").all()).toEqual([]);
      expect(catalog.doltLog({ limit: 1 })[0]?.commit_hash).toBe(reopened.head);
    } finally { closeCatalogDatabase(catalog); }
  });

  it("does not overwrite an existing archive or import root", async () => {
    const { root, engine } = await fixture();
    const saved = await snapshot(engine);
    const path = join(root, "archive.tar.gz");
    await packBookArchive(saved.rootDir, path);
    const original = await readFile(path);
    await expect(packBookArchive(saved.rootDir, path)).rejects.toThrow();
    expect(await readFile(path)).toEqual(original);
    const target = join(root, "existing");
    await mkdir(target);
    await writeFile(join(target, "keep"), "keep");
    await expect(restoreBookArchive(path, target)).rejects.toThrow();
    expect(await readFile(join(target, "keep"), "utf8")).toBe("keep");
  });

  it("rejects corrupted media and removes incomplete restoration", async () => {
    const { root, engine } = await fixture();
    const saved = await snapshot(engine);
    const object = saved.manifest.objects[0]!;
    await writeFile(join(saved.rootDir, "objects", object.sha256), "broken");
    await expect(packBookArchive(saved.rootDir, join(root, "checked.tar.gz"))).rejects.toThrow("checksum");
    const path = join(root, "unchecked.tar.gz");
    await tarCreate({ cwd: saved.rootDir, file: path, gzip: true }, ["manifest.json", "catalog.db", ...saved.manifest.objects.map((item) => `objects/${item.sha256}`)]);
    const target = join(root, "restored");
    await expect(restoreBookArchive(path, target)).rejects.toThrow();
    await expect(access(target)).rejects.toThrow();
  });

  it("rejects links, unexpected entries, duplicate entries and missing objects", async () => {
    const { root, engine } = await fixture();
    const saved = await snapshot(engine);
    await symlink("/etc/passwd", join(saved.rootDir, "outside"));
    for (const files of [["manifest.json", "outside"], ["manifest.json", "manifest.json"], ["manifest.json", "catalog.db"]]) {
      const path = join(root, `bad-${randomName()}.tar.gz`);
      await tarCreate({ cwd: saved.rootDir, file: path, gzip: true }, files);
      await expect(inspectBookArchive(path)).rejects.toThrow();
    }
  });

  it("rejects unsupported format versions", async () => {
    const { root, engine } = await fixture();
    const saved = await snapshot(engine);
    await writeFile(join(saved.rootDir, "manifest.json"), JSON.stringify({ ...saved.manifest, version: 2 }));
    const path = join(root, "future.tar.gz");
    await tarCreate({ cwd: saved.rootDir, file: path, gzip: true }, ["manifest.json"]);
    await expect(inspectBookArchive(path)).rejects.toThrow("Unsupported");
  });

  it("owns import staging cleanup without permitting arbitrary removal", async () => {
    const { root } = await fixture();
    const staging = await createBookImportWorkspace(join(root, "library"));
    await releaseBookImportWorkspace(staging, join(root, "library"));
    await expect(releaseBookImportWorkspace(root, root)).rejects.toThrow();
    await expect(releaseBookSnapshot(root)).rejects.toThrow();
  });

  it("cleans cancelled packing and restoration without publishing partial outputs", async () => {
    const { root, engine } = await fixture();
    const saved = await snapshot(engine);
    const archive = join(root, "portable.tar.gz");
    await packBookArchive(saved.rootDir, archive);
    const controller = new AbortController();
    controller.abort();
    await expect(packBookArchive(saved.rootDir, join(root, "cancelled.tar.gz"), { signal: controller.signal })).rejects.toThrow();
    await expect(restoreBookArchive(archive, join(root, "cancelled"), { signal: controller.signal })).rejects.toThrow();
    await expect(access(join(root, "cancelled.tar.gz"))).rejects.toThrow();
    await expect(access(join(root, "cancelled"))).rejects.toThrow();
  });
});

function randomName() { return String(Math.random()).slice(2); }
