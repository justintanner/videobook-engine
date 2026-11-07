import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { copyFile, link, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { create as tarCreate, list as tarList, extract as tarExtract } from "tar";
import { DatabaseSync } from "@dolthub/doltlite";
import type { Book } from "./engine-types.js";
import type { EngineContext } from "./context.js";
import { EngineFault } from "./store.js";
import { closeCatalogDatabase } from "./catalog-close.js";
import { SCHEMA_VERSION } from "./schema.js";
import { isUuidV7 } from "./ids.js";
import { pipeline } from "node:stream/promises";
import { normalizeBookSlug } from "./book-slug.js";

export const BOOK_AUTOMATION_PAUSED_KEY = "application.automation_paused.v1";
const SNAPSHOT_PREFIX = "videobook-snapshot-";
const HASH = /^[a-f0-9]{64}$/;
const MANIFEST_LIMIT = 8 * 1024 * 1024;

export interface BookArchiveManifest {
  format: "videobook-book";
  version: 1;
  schemaVersion: number;
  engineVersion: string;
  createdAt: string;
  book: Book;
  head: string;
  catalog: { sha256: string; size: number };
  objects: Array<{ sha256: string; size: number }>;
}

export interface BookSnapshot {
  rootDir: string;
  manifest: BookArchiveManifest;
}

export interface BookArchiveResult {
  path: string;
  sha256: string;
  size: number;
  manifest: BookArchiveManifest;
}

function invalid(message: string): never {
  throw new EngineFault({ code: "MANIFEST_INCOMPATIBLE", message });
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return invalid("Invalid book archive manifest");
  return value as Record<string, unknown>;
}

function digest(value: unknown): { sha256: string; size: number } {
  const item = record(value);
  if (typeof item.sha256 !== "string" || !HASH.test(item.sha256)
    || typeof item.size !== "number" || !Number.isSafeInteger(item.size) || item.size < 0) {
    return invalid("Invalid archive file checksum or size");
  }
  return { sha256: item.sha256, size: item.size };
}

function parseManifest(input: unknown): BookArchiveManifest {
  const value = record(input);
  if (value.format !== "videobook-book" || value.version !== 1 || value.schemaVersion !== SCHEMA_VERSION) {
    throw new EngineFault({ code: "SCHEMA_INCOMPATIBLE", message: `Unsupported book archive format/schema; expected format 1, schema ${SCHEMA_VERSION}` });
  }
  const book = record(value.book);
  if (typeof book.bookId !== "string" || !isUuidV7(book.bookId)
    || typeof book.name !== "string" || normalizeBookSlug(book.name) !== book.name
    || typeof book.createdAt !== "number" || !Number.isSafeInteger(book.createdAt)
    || typeof value.head !== "string" || !/^[a-z0-9]{32,64}$/.test(value.head)
    || typeof value.engineVersion !== "string" || typeof value.createdAt !== "string"
    || !Number.isFinite(Date.parse(value.createdAt)) || !Array.isArray(value.objects)) {
    return invalid("Invalid archive book identity or revision");
  }
  const objects = value.objects.map(digest);
  if (new Set(objects.map((item) => item.sha256)).size !== objects.length) return invalid("Duplicate archive object");
  return {
    format: "videobook-book", version: 1, schemaVersion: SCHEMA_VERSION,
    engineVersion: value.engineVersion, createdAt: value.createdAt,
    book: { bookId: book.bookId, name: book.name, createdAt: book.createdAt },
    head: value.head, catalog: digest(value.catalog), objects,
  };
}

async function fileDigest(path: string): Promise<{ sha256: string; size: number }> {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink()) return invalid(`Archive entry must be a regular file: ${basename(path)}`);
  const hash = createHash("sha256");
  let size = 0;
  for await (const chunk of createReadStream(path)) {
    hash.update(chunk as Buffer);
    size += (chunk as Buffer).length;
  }
  return { sha256: hash.digest("hex"), size };
}

async function verifyFile(path: string, expected: { sha256: string; size: number }): Promise<void> {
  const actual = await fileDigest(path);
  if (actual.size !== expected.size || actual.sha256 !== expected.sha256) invalid(`Archive checksum mismatch: ${basename(path)}`);
}

function assertIdle(context: EngineContext): void {
  const active = context.store.db.prepare("SELECT id, type FROM runtime_jobs WHERE state IN ('queued','running','completing') LIMIT 1").get() as { id: number; type: string } | undefined;
  const pending = context.store.db.prepare("SELECT artifact_id, task_type FROM runtime_pending_tasks LIMIT 1").get() as { artifact_id: string; task_type: string } | undefined;
  const lease = context.store.db.prepare("SELECT resource_key, pid, expires_at FROM runtime_resource_leases WHERE revoked_at IS NULL AND expires_at > ? LIMIT 1").get(Date.now()) as { resource_key: string; pid: number | null; expires_at: number } | undefined;
  const reason = active ? `job ${active.id} (${active.type})`
    : pending ? `provider task ${pending.task_type} for ${pending.artifact_id}`
      : lease ? `media lease ${lease.resource_key} (pid ${lease.pid}, expires ${new Date(lease.expires_at).toISOString()})` : null;
  if (reason) throw new EngineFault({ code: "IN_USE", message: `Book has active jobs, provider tasks or media work: ${reason}; wait until it is idle before exporting` });
}

function scrubSnapshot(path: string): void {
  const db = new DatabaseSync(path);
  try {
    for (const row of db.prepare("SELECT * FROM dolt_remotes()").all()) {
      db.prepare("SELECT dolt_remote('remove', ?)").get((row as { name: string }).name);
    }
    db.exec("DELETE FROM runtime_object_publications; DELETE FROM runtime_workspace_entries");
  } finally {
    closeCatalogDatabase(db, { wrote: true });
  }
}

export async function createBookSnapshot(context: EngineContext, options: { ownerPid?: number } = {}): Promise<BookSnapshot> {
  return context.store.snapshot(async () => {
    assertIdle(context);
    await cleanupBookSnapshots();
    const rootDir = await mkdtemp(join(tmpdir(), SNAPSHOT_PREFIX));
    try {
      await writeFile(join(rootDir, "owner.json"), JSON.stringify({ pid: options.ownerPid ?? process.pid }));
      const book = context.book();
      const head = context.store.head;
      const objects = context.store.db.prepare("SELECT object_hash, size_bytes FROM objects WHERE forgotten_at IS NULL ORDER BY object_hash").all() as unknown as Array<{ object_hash: string; size_bytes: number }>;
      await mkdir(join(rootDir, "objects"));
      for (const object of objects) {
        const source = await context.objects.ensureLocalPath(object.object_hash);
        const destination = join(rootDir, "objects", object.object_hash);
        try { await link(source, destination); }
        catch { await copyFile(source, destination); }
      }
      const catalogPath = join(rootDir, "catalog.db");
      assertIdle(context);
      context.store.db.exec(`VACUUM INTO '${catalogPath.replaceAll("\\", "/").replaceAll("'", "''")}'`);
      scrubSnapshot(catalogPath);
      const enginePackage = createRequire(import.meta.url)("../package.json") as { version: string };
      const manifest: BookArchiveManifest = {
        format: "videobook-book", version: 1, schemaVersion: SCHEMA_VERSION,
        engineVersion: enginePackage.version, createdAt: new Date().toISOString(), book, head,
        catalog: await fileDigest(catalogPath),
        objects: objects.map((object) => ({ sha256: object.object_hash, size: object.size_bytes })),
      };
      await writeFile(join(rootDir, "manifest.json"), JSON.stringify(manifest), { flag: "wx" });
      return { rootDir, manifest };
    } catch (error) {
      await rm(rootDir, { recursive: true, force: true });
      throw error;
    }
  });
}

export async function releaseBookSnapshot(rootDir: string): Promise<void> {
  if (!basename(rootDir).startsWith(SNAPSHOT_PREFIX)) {
    throw new EngineFault({ code: "INVALID_INPUT", message: "Not an engine snapshot directory" });
  }
  try {
    const directory = await lstat(rootDir);
    if (!directory.isDirectory() || directory.isSymbolicLink()) throw new Error("Invalid snapshot directory");
    const owner = JSON.parse(await readFile(join(rootDir, "owner.json"), "utf8")) as { pid?: unknown };
    if (typeof owner.pid !== "number" || !Number.isSafeInteger(owner.pid) || owner.pid <= 0) throw new Error("Invalid snapshot owner");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  await rm(rootDir, { recursive: true, force: true, maxRetries: 3 });
}

export async function packBookArchive(rootDir: string, outputPath: string, options: { signal?: AbortSignal } = {}): Promise<BookArchiveResult> {
  options.signal?.throwIfAborted();
  const manifest = parseManifest(JSON.parse(await readFile(join(rootDir, "manifest.json"), "utf8")));
  await verifyFile(join(rootDir, "catalog.db"), manifest.catalog);
  for (const object of manifest.objects) await verifyFile(join(rootDir, "objects", object.sha256), object);
  const path = resolve(outputPath);
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await pipeline(tarCreate({ cwd: rootDir, gzip: true, portable: true, noMtime: true, noPax: true, jobs: 2 },
      ["manifest.json", "catalog.db", ...manifest.objects.map((object) => `objects/${object.sha256}`)]),
    createWriteStream(temporary, { flags: "wx" }), { signal: options.signal });
    const result = { path, ...await fileDigest(temporary), manifest };
    await link(temporary, path);
    return result;
  } finally {
    await rm(temporary, { force: true });
  }
}

function expectedEntries(manifest: BookArchiveManifest): Map<string, number> {
  return new Map([
    ["catalog.db", manifest.catalog.size],
    ...manifest.objects.map((object): [string, number] => [`objects/${object.sha256}`, object.size]),
  ]);
}

export async function inspectBookArchive(path: string): Promise<BookArchiveManifest> {
  const entries = new Map<string, number>();
  const chunks: Buffer[] = [];
  let problem = "";
  let manifestSize = 0;
  await tarList({ file: path, strict: true, onReadEntry(entry) {
    if (entry.type !== "File" || !/^(manifest\.json|catalog\.db|objects\/[a-f0-9]{64})$/.test(entry.path)
      || entries.has(entry.path) || !Number.isSafeInteger(entry.size) || entry.size < 0) {
      problem = `Unsafe or duplicate archive entry: ${entry.path}`;
    }
    entries.set(entry.path, entry.size);
    if (entry.path === "manifest.json") {
      entry.on("data", (chunk: Buffer) => {
        manifestSize += chunk.length;
        if (manifestSize <= MANIFEST_LIMIT) chunks.push(chunk);
      });
    } else entry.resume();
  } });
  if (problem) invalid(problem);
  if (!entries.has("manifest.json") || manifestSize > MANIFEST_LIMIT) invalid("Missing or oversized archive manifest");
  const manifest = parseManifest(JSON.parse(Buffer.concat(chunks).toString("utf8")));
  entries.delete("manifest.json");
  const expected = expectedEntries(manifest);
  if (entries.size !== expected.size || [...expected].some(([name, size]) => entries.get(name) !== size)) {
    invalid("Archive inventory does not match its manifest");
  }
  return manifest;
}

function validateCatalog(path: string, manifest: BookArchiveManifest): void {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const schema = db.prepare("SELECT version FROM engine_schema WHERE singleton=1").get() as { version: number };
    const book = db.prepare("SELECT book_id, name, created_at FROM book").get() as { book_id: string; name: string; created_at: number };
    if (schema?.version !== manifest.schemaVersion || book?.book_id !== manifest.book.bookId
      || book.name !== manifest.book.name || book.created_at !== manifest.book.createdAt
      || db.doltLog({ limit: 1 })[0]?.commit_hash !== manifest.head) invalid("Catalog identity, revision or schema does not match the archive");
    if (db.prepare("PRAGMA integrity_check").all().some((row) => Object.values(row)[0] !== "ok")
      || db.prepare("PRAGMA foreign_key_check").all().length > 0) invalid("Archive catalog failed integrity checks");
    const objects = db.prepare("SELECT object_hash, size_bytes FROM objects WHERE forgotten_at IS NULL ORDER BY object_hash").all() as unknown as Array<{ object_hash: string; size_bytes: number }>;
    const inventory = new Map(manifest.objects.map((object) => [object.sha256, object.size]));
    if (objects.length !== inventory.size || objects.some((object) => inventory.get(object.object_hash) !== object.size_bytes)) invalid("Catalog object inventory does not match the archive");
    if (db.prepare("SELECT id FROM runtime_jobs WHERE state IN ('queued','running','completing') LIMIT 1").get()
      || db.prepare("SELECT artifact_id FROM runtime_pending_tasks LIMIT 1").get()) invalid("Archive contains active work");
  } finally { closeCatalogDatabase(db); }
}

export async function restoreBookArchive(archivePath: string, rootDir: string, options: { signal?: AbortSignal } = {}): Promise<BookArchiveManifest> {
  const manifest = await inspectBookArchive(archivePath);
  options.signal?.throwIfAborted();
  await mkdir(rootDir, { recursive: false });
  try {
    const expected = expectedEntries(manifest);
    expected.set("manifest.json", -1);
    const seen = new Set<string>();
    let problem = "";
    await pipeline(createReadStream(archivePath), tarExtract({ cwd: rootDir, strict: true, preserveOwner: false, noChmod: true,
      filter(path, entry) {
        const size = expected.get(path);
        if (!("type" in entry) || entry.type !== "File" || size === undefined || seen.has(path)
          || (size === -1 ? entry.size > MANIFEST_LIMIT : entry.size !== size)) {
          problem = `Unsafe or changed archive entry: ${path}`;
          return false;
        }
        seen.add(path);
        return true;
      },
    }), { signal: options.signal });
    if (problem || seen.size !== expected.size) invalid(problem || "Incomplete archive");
    const extracted = parseManifest(JSON.parse(await readFile(join(rootDir, "manifest.json"), "utf8")));
    if (JSON.stringify(extracted) !== JSON.stringify(manifest)) invalid("Archive changed during import");
    const catalog = join(rootDir, "catalog.db");
    await verifyFile(catalog, manifest.catalog);
    validateCatalog(catalog, manifest);
    for (const object of manifest.objects) {
      const source = join(rootDir, "objects", object.sha256);
      await verifyFile(source, object);
      const directory = join(rootDir, "data", "objects", "sha256", object.sha256.slice(0, 2));
      await mkdir(directory, { recursive: true });
      await rename(source, join(directory, object.sha256));
    }
    await mkdir(join(rootDir, "data"), { recursive: true });
    await rename(catalog, join(rootDir, "data", "videobook.db"));
    await rm(join(rootDir, "objects"), { recursive: true, force: true });
    await rm(join(rootDir, "manifest.json"));
    return manifest;
  } catch (error) {
    await rm(rootDir, { recursive: true, force: true, maxRetries: 3 });
    throw error;
  }
}

export async function createBookImportWorkspace(libraryDir: string, ownerPid = process.pid): Promise<string> {
  await mkdir(libraryDir, { recursive: true });
  const parent = await mkdtemp(join(libraryDir, ".importing-"));
  await writeFile(join(parent, "owner.json"), JSON.stringify({ pid: ownerPid }));
  return join(parent, "book");
}

export async function cleanupBookImportWorkspaces(libraryDir: string): Promise<void> {
  await cleanupOwnedDirectories(libraryDir, ".importing-");
}

export async function cleanupBookSnapshots(): Promise<void> {
  await cleanupOwnedDirectories(tmpdir(), SNAPSHOT_PREFIX);
}

async function cleanupOwnedDirectories(directory: string, prefix: string): Promise<void> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith(prefix)) continue;
    const parent = join(directory, entry.name);
    let pid: unknown;
    try { pid = (JSON.parse(await readFile(join(parent, "owner.json"), "utf8")) as { pid?: unknown }).pid; }
    catch { continue; }
    if (typeof pid !== "number" || !Number.isSafeInteger(pid) || pid <= 0) continue;
    try { process.kill(pid, 0); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") await rm(parent, { recursive: true, force: true, maxRetries: 3 });
    }
  }
}

export async function releaseBookImportWorkspace(rootDir: string, libraryDir: string): Promise<void> {
  const parent = dirname(resolve(rootDir));
  if (basename(rootDir) !== "book" || dirname(parent) !== resolve(libraryDir) || !basename(parent).startsWith(".importing-")) {
    throw new EngineFault({ code: "INVALID_INPUT", message: "Not an engine import workspace" });
  }
  await rm(parent, { recursive: true, force: true, maxRetries: 3 });
}
