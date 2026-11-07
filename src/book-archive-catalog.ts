import { fork } from "node:child_process";
import { DatabaseSync } from "@dolthub/doltlite";
import type { BookArchiveManifest } from "./book-archive.js";
import type { EngineError } from "./engine-types.js";
import { closeCatalogDatabase } from "./catalog-close.js";
import { EngineFault } from "./store.js";

type CatalogRequest = { operation: "scrub"; path: string }
  | { operation: "validate"; path: string; manifest: BookArchiveManifest };
type CatalogResponse = { ok: true } | { ok: false; error: EngineError };
const WORKER_ARGUMENT = "--videobook-book-catalog";

export function runBookCatalog(request: CatalogRequest): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = fork(new URL(import.meta.url), [WORKER_ARGUMENT], {
      execArgv: import.meta.url.endsWith(".ts") ? ["--import", import.meta.resolve("tsx")] : [],
      stdio: ["ignore", "ignore", "ignore", "ipc"], serialization: "advanced",
    });
    let response: CatalogResponse | undefined;
    child.once("message", (message: CatalogResponse) => { response = message; });
    child.once("error", reject);
    child.once("close", (code, signal) => {
      if (response && !response.ok) reject(new EngineFault(response.error));
      else if (code !== 0 || !response) reject(new EngineFault({ code: "STORAGE_ERROR", message: `Book catalog worker exited without completing (${code ?? signal})` }));
      else resolve();
    });
    child.send(request);
  });
}

function invalid(message: string): never {
  throw new EngineFault({ code: "MANIFEST_INCOMPATIBLE", message });
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

if (process.send && process.argv[2] === WORKER_ARGUMENT) {
  process.once("message", (request: CatalogRequest) => {
    let response: CatalogResponse;
    try {
      if (request.operation === "scrub") scrubSnapshot(request.path);
      else validateCatalog(request.path, request.manifest);
      response = { ok: true };
    } catch (error) {
      response = { ok: false, error: error instanceof EngineFault ? error.error
        : { code: "STORAGE_ERROR", message: error instanceof Error ? error.message : "Book catalog operation failed" } };
    }
    process.send?.(response, () => process.disconnect?.());
  });
}
