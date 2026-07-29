import { stat } from "node:fs/promises";

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

/**
 * Minimum age before a stray local file (bytes without an `objects` row) is
 * swept, so an import that has written its bytes but not yet committed its
 * row cannot lose them to a concurrent GC.
 */
const STRAY_GRACE_MS = 600_000;

export function createStorageApi(context: EngineContext) {
  return {
    status: (): StorageStatus => storageStatus(context),
    backup: (): Promise<Result<StorageStatus, EngineError>> => backup(context),
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
  const recordedState = runtimeValue<StorageStatus["state"] | null>(
    context,
    "backup_state",
    null,
  );
  const lastError = runtimeValue<string | null>(context, "backup_error", null);
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
          await context.objects.publish(object.object_hash, object.size_bytes);
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
      setRuntimeValue(context, "last_backup_head", context.store.head);
      setBackupState(context, "backed_up", null);
      return ok(storageStatus(context));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
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
        `SELECT object_hash, size_bytes, forgotten_at FROM objects
         WHERE object_hash=?`,
      )
      .get(hash) as unknown as
      (PendingObjectRow & { forgotten_at: number | null }) | undefined;
    if (!row) {
      throw new EngineFault({
        code: "NOT_FOUND",
        message: `Object not found: ${hash}`,
      });
    }
    // Retrying an already-forgotten object skips the tombstone commit and
    // just finishes byte removal — an earlier attempt may have failed after
    // the commit but before the local or remote delete completed.
    const alreadyForgotten = row.forgotten_at !== null;
    const severed: ObjectReference[] = [];
    let revision: string | undefined;
    if (!alreadyForgotten) {
      // The reference scan runs inside the serialized semantic section so no
      // concurrent commit can add a reference between the IN_USE check and
      // the tombstone. `details` is filled by the mutation and read at
      // commit-message time, which happens after the mutation ran.
      const details: Record<string, unknown> = {
        hash: row.object_hash,
        sizeBytes: row.size_bytes,
        forced: options.force === true,
      };
      const mutation = await context.store.semantic(
        {
          operation: "delete_object",
          details,
          writeSet: [`object:${row.object_hash}`],
        },
        (_operationId, now) => {
          const references = objectReferences(context, hash);
          if (references.length > 0 && !options.force) {
            throw new EngineFault({
              code: "IN_USE",
              message:
                `Object ${hash} is referenced at HEAD by ` +
                `${references.length} row(s)`,
              details: { references },
            });
          }
          severed.push(...references);
          details.severedReferences = references;
          context.store.db
            .prepare("UPDATE objects SET forgotten_at=? WHERE object_hash=?")
            .run(now, row.object_hash);
        },
      );
      revision = mutation.revision;
    }
    const deletedLocal = await context.objects.deleteLocal(hash);
    let deletedRemote = false;
    // Remote deletion defaults on: a forget that leaves remote bytes
    // readable is not a forget. `unpublish` is a no-op without a remote.
    if (options.remote !== false) {
      deletedRemote = await context.objects.unpublish(hash);
      if (deletedRemote) clearPublication(context, hash);
    }
    return ok(
      {
        hash: row.object_hash,
        sizeBytes: row.size_bytes,
        deletedLocal,
        deletedRemote,
        severedReferences: severed,
        alreadyForgotten,
      },
      revision,
    );
  });
}

/**
 * Sweeps content objects that nothing references at HEAD.
 *
 * A hash is referenced when a HEAD row of a semantic table names it in a
 * first-class `object_hash`/`payload_hash` column
 * (`artifact_files`, `artifact_streams`, `pinned_search_results`,
 * `sequence_clips`, `transcripts`) or inside an engine-written JSON column
 * that embeds object hashes (`cell_references.snapshot_json`,
 * `pinned_search_results.location_json`, `caption_cues.source_range_json`).
 * Everything else — objects whose referencing rows were deleted by later
 * commits, and stray local files that never got an `objects` row — is
 * collected. Collection is recorded as one semantic commit that sets
 * `objects.forgotten_at` on every collected row: rows stay as tombstones,
 * old revisions still know the hash and size, and their reads surface
 * OBJECT_UNAVAILABLE.
 *
 * HEAD is the commit the engine last wrote; historical revisions are not
 * consulted, which is exactly what makes restoring an old revision after GC
 * a tombstone read. The reference scan runs inside the serialized semantic
 * section, and stray files younger than the grace window are left alone, so
 * GC is safe to run alongside normal engine writes.
 */
async function collectGarbage(
  context: EngineContext,
  options: CollectGarbageOptions = {},
): Promise<Result<CollectGarbageResult, EngineError>> {
  return resultOf(async () => {
    const dryRun = options.dryRun ?? false;
    if (dryRun) {
      const scan = scanCollectable(context);
      const report: CollectGarbageResult = {
        dryRun,
        scannedObjects: scan.scanned,
        referencedObjects: scan.referenced,
        collected: scan.collectable,
        reclaimedBytes: reclaimedBytes(scan.collectable),
      };
      return report;
    }
    // The local listing happens outside the serialized section — the stray
    // grace window (below) protects imports racing this listing.
    const localHashes = await context.objects.listLocal();
    let scan = emptyScan();
    // `details` and `writeSet` are filled by the mutation and read at
    // commit-message time, which happens after the mutation ran.
    const details: Record<string, unknown> = {};
    const writeSet: string[] = [];
    const mutation = await context.store.semantic(
      { operation: "gc_objects", details, writeSet },
      (_operationId, now) => {
        // Scanning inside the serialized semantic section: no concurrent
        // commit can add a reference between the scan and the tombstones.
        scan = scanCollectable(context);
        details.hashes = scan.collectable.map((object) => object.hash);
        details.reclaimedBytes = reclaimedBytes(scan.collectable);
        writeSet.push(
          ...scan.collectable.map((object) => `object:${object.hash}`),
        );
        const markForgotten = context.store.db.prepare(
          `UPDATE objects SET forgotten_at=?
           WHERE object_hash=? AND forgotten_at IS NULL`,
        );
        for (const object of scan.collectable) {
          markForgotten.run(now, object.hash);
        }
      },
    );
    const revision =
      scan.collectable.length > 0 ? mutation.revision : undefined;
    // Delete the bytes for everything collectable, plus any leftover local
    // files for objects already forgotten (for example after an interrupted
    // deleteObject).
    const deleteHashes = new Set([
      ...scan.collectable.map((object) => object.hash),
      ...[...scan.forgotten].filter((hash) => localHashes.includes(hash)),
    ]);
    for (const hash of deleteHashes) {
      await context.objects.deleteLocal(hash);
    }
    if (options.remote) {
      // The remote pass covers every forgotten hash — not just the ones
      // with local bytes or a runtime publication row — so an interrupted
      // deleteObject or a lost runtime table cannot leave remote bytes
      // readable forever. `unpublish` head-checks first, so already-absent
      // objects cost one metadata call.
      const remoteHashes = new Set([
        ...scan.collectable.map((object) => object.hash),
        ...scan.forgotten,
      ]);
      for (const hash of remoteHashes) {
        if (await context.objects.unpublish(hash)) {
          clearPublication(context, hash);
        }
      }
    }
    // Stray local files (bytes with no objects row) are swept only after
    // the grace window, so an import that has written bytes but not yet
    // committed its row cannot lose them.
    const strayCutoff = Date.now() - (options.strayGraceMs ?? STRAY_GRACE_MS);
    const stray = localHashes.filter(
      (hash) => !scan.known.has(hash) && !deleteHashes.has(hash),
    );
    for (const hash of stray) {
      try {
        const fileStat = await stat(context.objects.pathFor(hash));
        if (fileStat.mtimeMs > strayCutoff) continue;
      } catch {
        continue;
      }
      await context.objects.deleteLocal(hash);
    }
    let doltGcSummary: string | undefined;
    if (options.doltGc) {
      doltGcSummary = context.store.doltGc();
    }
    const report: CollectGarbageResult = {
      dryRun,
      scannedObjects: scan.scanned,
      referencedObjects: scan.referenced,
      collected: scan.collectable,
      reclaimedBytes: reclaimedBytes(scan.collectable),
      ...(doltGcSummary !== undefined ? { doltGc: doltGcSummary } : {}),
    };
    return ok(report, revision);
  });
}

interface CollectableScan {
  scanned: number;
  referenced: number;
  collectable: CollectedObject[];
  forgotten: Set<string>;
  known: Set<string>;
}

function emptyScan(): CollectableScan {
  return {
    scanned: 0,
    referenced: 0,
    collectable: [],
    forgotten: new Set(),
    known: new Set(),
  };
}

function scanCollectable(context: EngineContext): CollectableScan {
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
  return {
    scanned: rows.length,
    referenced: referenced.size,
    collectable,
    forgotten,
    known,
  };
}

function reclaimedBytes(collectable: CollectedObject[]): number {
  return collectable.reduce((total, object) => total + object.sizeBytes, 0);
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
    const rows = context.store.db.prepare(query).all() as unknown as Array<{
      hash: string;
    }>;
    for (const row of rows) hashes.add(row.hash);
  }
  // Some engine-written JSON columns embed object hashes rather than
  // naming them in a first-class column; honor them all as loose roots.
  for (const query of JSON_ROOT_QUERIES) {
    const rows = context.store.db.prepare(query).all() as unknown as Array<{
      payload: string | null;
    }>;
    for (const row of rows) {
      if (row.payload === null) continue;
      for (const hash of jsonObjectHashes(row.payload)) hashes.add(hash);
    }
  }
  return hashes;
}

/**
 * Engine-written JSON columns that can carry `objectHash` values: notebook
 * cell reference snapshots, pinned search result locations, and caption cue
 * source ranges. Keep in sync with src/schema.ts.
 */
const JSON_ROOT_QUERIES = [
  "SELECT snapshot_json AS payload FROM cell_references",
  "SELECT location_json AS payload FROM pinned_search_results",
  "SELECT source_range_json AS payload FROM caption_cues",
] as const;

function jsonObjectHashes(snapshotJson: string): string[] {
  const snapshot = parseJson<unknown>(snapshotJson, null);
  const hashes: string[] = [];
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
    } else if (value !== null && typeof value === "object") {
      for (const [key, item] of Object.entries(value)) {
        if (
          key === "objectHash" &&
          typeof item === "string" &&
          /^[a-f0-9]{64}$/.test(item)
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
  const collect = (table: string, query: string, ...params: string[]): void => {
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
  const jsonReferenceQueries = [
    {
      table: "cell_references",
      query: `SELECT notebook_id || ':' || cell_id || ':' || reference_id AS id,
                     snapshot_json AS payload
              FROM cell_references`,
    },
    {
      table: "pinned_search_results",
      query: `SELECT notebook_id || ':' || cell_id || ':' || result_id AS id,
                     location_json AS payload
              FROM pinned_search_results`,
    },
    {
      table: "caption_cues",
      query: `SELECT cue_id AS id, source_range_json AS payload
              FROM caption_cues WHERE source_range_json IS NOT NULL`,
    },
  ];
  const seen = new Set(
    references.map((reference) => `${reference.table}:${reference.id}`),
  );
  for (const { table, query } of jsonReferenceQueries) {
    const rows = context.store.db.prepare(query).all() as unknown as Array<{
      id: string;
      payload: string | null;
    }>;
    for (const row of rows) {
      if (row.payload === null) continue;
      if (!jsonObjectHashes(row.payload).includes(hash)) continue;
      if (seen.has(`${table}:${row.id}`)) continue;
      seen.add(`${table}:${row.id}`);
      references.push({ table, id: row.id });
    }
  }
  return references;
}

function clearPublication(context: EngineContext, hash: string): void {
  context.store.runtime(() => {
    context.store.db
      .prepare("DELETE FROM runtime_object_publications WHERE object_hash=?")
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

function runtimeValue<T>(context: EngineContext, key: string, fallback: T): T {
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
