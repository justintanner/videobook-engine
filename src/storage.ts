import type {
  CollectGarbageOptions,
  CollectGarbageResult,
  CollectedObject,
  DeleteObjectOptions,
  DeleteObjectResult,
  EngineError,
  ObjectReference,
  Result,
  StorageStatus,
} from "./engine-types.js";
import { ok } from "./engine-types.js";
import { EngineContext, resultOf } from "./context.js";
import { canonicalJson, EngineFault, parseJson } from "./store.js";

interface PendingObjectRow {
  object_hash: string;
  size_bytes: number;
}

export function createStorageApi(context: EngineContext) {
  return {
    status: (): StorageStatus => storageStatus(context),
    backup: (): Promise<Result<StorageStatus, EngineError>> =>
      backup(context),
    deleteObject: (
      hash: string,
      options?: DeleteObjectOptions,
    ): Promise<Result<DeleteObjectResult, EngineError>> =>
      deleteObject(context, hash, options),
    gc: (
      options?: CollectGarbageOptions,
    ): Promise<Result<CollectGarbageResult, EngineError>> =>
      collectGarbage(context, options),
  };
}

function storageStatus(context: EngineContext): StorageStatus {
  const configured = Boolean(
    context.config.remoteObjects || context.config.catalogBackup,
  );
  const head = context.store.head;
  if (!configured) {
    return { state: "unconfigured", head, pendingObjects: 0 };
  }
  const pendingObjects = countPendingObjects(context);
  const lastHead = runtimeValue<string | null>(
    context,
    "last_backup_head",
    null,
  );
  const recordedState = runtimeValue<
    StorageStatus["state"] | null
  >(context, "backup_state", null);
  const lastError = runtimeValue<string | null>(
    context,
    "backup_error",
    null,
  );
  const state =
    recordedState === "offline" || recordedState === "diverged"
      ? recordedState
      : pendingObjects > 0 || lastHead !== head
        ? "pending"
        : "backed_up";
  return {
    state,
    head,
    pendingObjects,
    ...(lastError ? { lastError } : {}),
  };
}

async function backup(
  context: EngineContext,
): Promise<Result<StorageStatus, EngineError>> {
  return resultOf(async () => {
    if (!context.config.remoteObjects && !context.config.catalogBackup) {
      return ok(storageStatus(context));
    }
    setBackupState(context, "pending", null);
    try {
      if (context.config.remoteObjects) {
        const pending = pendingObjects(context);
        for (const object of pending) {
          await context.objects.publish(
            object.object_hash,
            object.size_bytes,
          );
          context.store.runtime((now) => {
            context.store.db
              .prepare(
                `INSERT INTO runtime_object_publications(
                  object_hash, published_at
                ) VALUES (?, ?)
                ON CONFLICT(object_hash) DO UPDATE SET
                  published_at=excluded.published_at`,
              )
              .run(object.object_hash, now);
          });
        }
      }
      if (context.config.catalogBackup) {
        context.store.push(context.config.catalogBackup.name);
      }
      setRuntimeValue(
        context,
        "last_backup_head",
        context.store.head,
      );
      setBackupState(context, "backed_up", null);
      return ok(storageStatus(context));
    } catch (error) {
      const message =
        error instanceof Error ? error.message : String(error);
      // doltlite reports a rejected push as "push failed (not a
      // fast-forward?)"; keep the detection tolerant of other phrasings.
      const diverged = /diverg|fast-forward|fetch first/i.test(message);
      const state = diverged ? "diverged" : "offline";
      setBackupState(context, state, message);
      return {
        ok: false,
        error: {
          code: state === "diverged" ? "DIVERGED" : "OFFLINE",
          message: diverged
            ? `${message} — the upstream catalog has moved ahead. A live ` +
              "engine never pulls; run the dedicated merge-back flow " +
              "(mergeBack in src/fork.ts) on a healthy upstream catalog " +
              "copy to integrate this fork's commits, then back up again."
            : message,
        },
      };
    }
  });
}

/**
 * Explicitly deletes one content object.
 *
 * The default refuses to delete an object still referenced at HEAD
 * (`IN_USE`). With `force`, the object is forgotten anyway — the takedown
 * path. Forgetting is recorded as a semantic commit that sets
 * `objects.forgotten_at`: the versioned row stays as the tombstone
 * (hash + size + forgotten timestamp) for every historical row that named
 * the object, backup never tries to publish it again, and later reads of
 * those rows surface OBJECT_UNAVAILABLE instead of the bytes. Run this and
 * `gc` only while no imports are in flight.
 */
async function deleteObject(
  context: EngineContext,
  hash: string,
  options: DeleteObjectOptions = {},
): Promise<Result<DeleteObjectResult, EngineError>> {
  return resultOf(async () => {
    const row = context.store.db
      .prepare(
        `SELECT object_hash, size_bytes FROM objects
         WHERE object_hash=? AND forgotten_at IS NULL`,
      )
      .get(hash) as unknown as PendingObjectRow | undefined;
    if (!row) {
      throw new EngineFault({
        code: "NOT_FOUND",
        message: `Object not found: ${hash}`,
      });
    }
    const references = objectReferences(context, hash);
    if (references.length > 0 && !options.force) {
      throw new EngineFault({
        code: "IN_USE",
        message:
          `Object ${hash} is referenced at HEAD by `
          + `${references.length} row(s)`,
        details: { references },
      });
    }
    const mutation = await context.store.semantic(
      {
        operation: "delete_object",
        details: {
          hash: row.object_hash,
          sizeBytes: row.size_bytes,
          forced: options.force === true,
          severedReferences: options.force ? references : [],
        },
        writeSet: [`object:${row.object_hash}`],
      },
      (_operationId, now) => {
        context.store.db
          .prepare(
            "UPDATE objects SET forgotten_at=? WHERE object_hash=?",
          )
          .run(now, row.object_hash);
      },
    );
    const deletedLocal = await context.objects.deleteLocal(hash);
    let deletedRemote = false;
    if (options.remote) {
      deletedRemote = await context.objects.unpublish(hash);
      if (deletedRemote) clearPublication(context, hash);
    }
    return ok(
      {
        hash: row.object_hash,
        sizeBytes: row.size_bytes,
        deletedLocal,
        deletedRemote,
        severedReferences: options.force ? references : [],
      },
      mutation.revision,
    );
  });
}

/**
 * Sweeps content objects that nothing references at HEAD.
 *
 * A hash is referenced when a HEAD row of a semantic table names it in a
 * first-class `object_hash`/`payload_hash` column
 * (`artifact_files`, `artifact_streams`, `pinned_search_results`,
 * `sequence_clips`, `transcripts`) or inside a `cell_references` snapshot.
 * Everything else — objects whose referencing rows were deleted by later
 * commits, and stray local files that never got an `objects` row — is
 * collected. Collection is recorded as one semantic commit that sets
 * `objects.forgotten_at` on every collected row: rows stay as tombstones,
 * old revisions still know the hash and size, and their reads surface
 * OBJECT_UNAVAILABLE.
 *
 * HEAD is the commit the engine last wrote; historical revisions are not
 * consulted, which is exactly what makes restoring an old revision after GC
 * a tombstone read. Run GC only while no imports are in flight.
 */
async function collectGarbage(
  context: EngineContext,
  options: CollectGarbageOptions = {},
): Promise<Result<CollectGarbageResult, EngineError>> {
  return resultOf(async () => {
    const dryRun = options.dryRun ?? false;
    const referenced = referencedHashes(context);
    const rows = context.store.db
      .prepare(
        `SELECT object_hash, size_bytes FROM objects
         ORDER BY created_at, object_hash`,
      )
      .all() as unknown as PendingObjectRow[];
    const known = new Set(rows.map((row) => row.object_hash));
    const forgotten = forgottenHashes(context);
    const collectable: CollectedObject[] = [];
    for (const row of rows) {
      if (referenced.has(row.object_hash) || forgotten.has(row.object_hash)) {
        continue;
      }
      collectable.push({ hash: row.object_hash, sizeBytes: row.size_bytes });
    }
    // Stray local files (for example leftovers from an interrupted import)
    // have no objects row and therefore no HEAD reference by definition.
    const localHashes = await context.objects.listLocal();
    const stray = localHashes.filter((hash) => !known.has(hash));
    const reclaimedBytes = collectable.reduce(
      (total, object) => total + object.sizeBytes,
      0,
    );
    if (dryRun) {
      const report: CollectGarbageResult = {
        dryRun,
        scannedObjects: rows.length,
        referencedObjects: referenced.size,
        collected: collectable,
        reclaimedBytes,
      };
      return report;
    }
    let revision: string | undefined;
    if (collectable.length > 0) {
      const mutation = await context.store.semantic(
        {
          operation: "gc_objects",
          details: {
            hashes: collectable.map((object) => object.hash),
            reclaimedBytes,
          },
          writeSet: collectable.map((object) => `object:${object.hash}`),
        },
        (_operationId, now) => {
          const markForgotten = context.store.db.prepare(
            `UPDATE objects SET forgotten_at=?
             WHERE object_hash=? AND forgotten_at IS NULL`,
          );
          for (const object of collectable) {
            markForgotten.run(now, object.hash);
          }
        },
      );
      revision = mutation.revision;
    }
    // Delete the bytes for everything collectable, plus any leftover local
    // files for objects already forgotten (for example after an interrupted
    // deleteObject).
    const deleteHashes = new Set([
      ...collectable.map((object) => object.hash),
      ...[...forgotten].filter((hash) => localHashes.includes(hash)),
    ]);
    for (const hash of deleteHashes) {
      await context.objects.deleteLocal(hash);
      if (options.remote && isPublished(context, hash)) {
        if (await context.objects.unpublish(hash)) {
          clearPublication(context, hash);
        }
      }
    }
    for (const hash of stray) {
      await context.objects.deleteLocal(hash);
    }
    let doltGcSummary: string | undefined;
    if (options.doltGc) {
      doltGcSummary = context.store.doltGc();
    }
    const report: CollectGarbageResult = {
      dryRun,
      scannedObjects: rows.length,
      referencedObjects: referenced.size,
      collected: collectable,
      reclaimedBytes,
      ...(doltGcSummary !== undefined ? { doltGc: doltGcSummary } : {}),
    };
    return ok(report, revision);
  });
}

function forgottenHashes(context: EngineContext): Set<string> {
  const rows = context.store.db
    .prepare(
      "SELECT object_hash AS hash FROM objects WHERE forgotten_at IS NOT NULL",
    )
    .all() as unknown as Array<{ hash: string }>;
  return new Set(rows.map((row) => row.hash));
}

/**
 * Every hash referenced at HEAD. This is the precise GC root set; keep it
 * in sync with the object-hash columns declared in src/schema.ts.
 */
function referencedHashes(context: EngineContext): Set<string> {
  const hashes = new Set<string>();
  const queries = [
    "SELECT object_hash AS hash FROM artifact_files",
    "SELECT object_hash AS hash FROM artifact_streams",
    "SELECT object_hash AS hash FROM pinned_search_results",
    "SELECT object_hash AS hash FROM sequence_clips",
    "SELECT object_hash AS hash FROM transcripts",
    "SELECT payload_hash AS hash FROM transcripts",
  ];
  for (const query of queries) {
    const rows = context.store.db
      .prepare(query)
      .all() as unknown as Array<{ hash: string }>;
    for (const row of rows) hashes.add(row.hash);
  }
  // Notebook cell reference snapshots embed source object hashes inside
  // JSON rather than a first-class column; honor them as loose roots.
  const snapshots = context.store.db
    .prepare("SELECT snapshot_json AS snapshot FROM cell_references")
    .all() as unknown as Array<{ snapshot: string }>;
  for (const row of snapshots) {
    for (const hash of snapshotHashes(row.snapshot)) hashes.add(hash);
  }
  return hashes;
}

function snapshotHashes(snapshotJson: string): string[] {
  const snapshot = parseJson<unknown>(snapshotJson, null);
  const hashes: string[] = [];
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
    } else if (value !== null && typeof value === "object") {
      for (const [key, item] of Object.entries(value)) {
        if (
          key === "objectHash"
          && typeof item === "string"
          && /^[a-f0-9]{64}$/.test(item)
        ) {
          hashes.push(item);
        } else {
          visit(item);
        }
      }
    }
  };
  visit(snapshot);
  return hashes;
}

/** All HEAD rows referencing one object, for deleteObject's IN_USE report. */
function objectReferences(
  context: EngineContext,
  hash: string,
): ObjectReference[] {
  const references: ObjectReference[] = [];
  const collect = (
    table: string,
    query: string,
    ...params: string[]
  ): void => {
    const rows = context.store.db
      .prepare(query)
      .all(...params) as unknown as Array<{ id: string }>;
    for (const row of rows) references.push({ table, id: row.id });
  };
  collect(
    "artifact_files",
    `SELECT artifact_id || ':' || path AS id
     FROM artifact_files WHERE object_hash=?`,
    hash,
  );
  collect(
    "artifact_streams",
    "SELECT stream_id AS id FROM artifact_streams WHERE object_hash=?",
    hash,
  );
  collect(
    "pinned_search_results",
    `SELECT notebook_id || ':' || cell_id || ':' || result_id AS id
     FROM pinned_search_results WHERE object_hash=?`,
    hash,
  );
  collect(
    "sequence_clips",
    "SELECT clip_id AS id FROM sequence_clips WHERE object_hash=?",
    hash,
  );
  collect(
    "transcripts",
    `SELECT transcript_id AS id FROM transcripts
     WHERE object_hash=? OR payload_hash=?`,
    hash,
    hash,
  );
  const snapshots = context.store.db
    .prepare(
      `SELECT notebook_id || ':' || cell_id || ':' || reference_id AS id,
              snapshot_json AS snapshot
       FROM cell_references`,
    )
    .all() as unknown as Array<{ id: string; snapshot: string }>;
  for (const row of snapshots) {
    if (snapshotHashes(row.snapshot).includes(hash)) {
      references.push({ table: "cell_references", id: row.id });
    }
  }
  return references;
}

function isPublished(context: EngineContext, hash: string): boolean {
  return Boolean(
    context.store.db
      .prepare(
        `SELECT 1 AS present FROM runtime_object_publications
         WHERE object_hash=?`,
      )
      .get(hash),
  );
}

function clearPublication(context: EngineContext, hash: string): void {
  context.store.runtime(() => {
    context.store.db
      .prepare(
        "DELETE FROM runtime_object_publications WHERE object_hash=?",
      )
      .run(hash);
  });
}

function pendingObjects(context: EngineContext): PendingObjectRow[] {
  if (!context.config.remoteObjects) return [];
  // Forgotten objects are tombstones: their bytes are gone on purpose, so
  // backup must neither publish them nor report them as pending.
  return context.store.db
    .prepare(
      `SELECT o.object_hash, o.size_bytes
       FROM objects o
       LEFT JOIN runtime_object_publications p
         ON p.object_hash=o.object_hash
       WHERE p.object_hash IS NULL AND o.forgotten_at IS NULL
       ORDER BY o.created_at, o.object_hash`,
    )
    .all() as unknown as PendingObjectRow[];
}

function countPendingObjects(context: EngineContext): number {
  if (!context.config.remoteObjects) return 0;
  const row = context.store.db
    .prepare(
      `SELECT COUNT(*) AS count
       FROM objects o
       LEFT JOIN runtime_object_publications p
         ON p.object_hash=o.object_hash
       WHERE p.object_hash IS NULL AND o.forgotten_at IS NULL`,
    )
    .get() as unknown as { count: number };
  return row.count;
}

function runtimeValue<T>(
  context: EngineContext,
  key: string,
  fallback: T,
): T {
  const row = context.store.db
    .prepare("SELECT value_json FROM runtime_meta WHERE key=?")
    .get(key) as unknown as { value_json: string } | undefined;
  return row ? parseJson<T>(row.value_json, fallback) : fallback;
}

function setRuntimeValue(
  context: EngineContext,
  key: string,
  value: unknown,
): void {
  context.store.runtime((now) => {
    context.store.db
      .prepare(
        `INSERT INTO runtime_meta(key, value_json, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET
           value_json=excluded.value_json,
           updated_at=excluded.updated_at`,
      )
      .run(key, canonicalJson(value), now);
  });
}

function setBackupState(
  context: EngineContext,
  state: StorageStatus["state"],
  error: string | null,
): void {
  context.store.runtime((now) => {
    const statement = context.store.db.prepare(
      `INSERT INTO runtime_meta(key, value_json, updated_at)
       VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET
         value_json=excluded.value_json,
         updated_at=excluded.updated_at`,
    );
    statement.run("backup_state", canonicalJson(state), now);
    statement.run("backup_error", canonicalJson(error), now);
  });
}
