import { copyFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";

import { DatabaseSync } from "@dolthub/doltlite";
import { v7 as uuidv7 } from "uuid";

import type {
  CatalogBackupConfig,
  ContentStore,
  EngineIdentity,
} from "./engine-types.js";
import { ObjectStore } from "./cas.js";
import { createEngine, type Engine } from "./engine.js";
import {
  assertSameSchemaVersion,
  reconcileSingletonFlags,
  verifyConstraintHealth,
} from "./merge-policy.js";
import { SEMANTIC_TABLES } from "./schema.js";
import { canonicalJson, EngineFault } from "./store.js";

/**
 * Fork bootstrap and merge-back integration (ve-mim.7; see
 * docs/engine-layout.md "Forks and merge-back integration").
 *
 * A fork is, from the engine's point of view:
 *
 * 1. a platform fork — creating the hosted copy of the catalog and giving it
 *    a URL is the hosting layer's job, out of engine scope;
 * 2. a clone of the catalog into a local engine root (`bootstrapFork`);
 * 3. a public-read object store keyed by SHA-256. `ContentStore` stays the
 *    abstraction; the existing `ensureLocal` lazy fetch in src/cas.ts makes
 *    upstream objects readable to forkers on first touch. Whether the
 *    fork's store proxies to upstream's is a hosting concern — the engine
 *    only ever sees one `ContentStore` per engine root.
 *
 * The live-engine never-pulls rule stands: an open engine never fetches,
 * pulls, or merges. Integration happens in a DEDICATED merge-back flow
 * (`mergeBack`) that runs on a throwaway copy of a closed catalog database
 * in a temp directory, never on the user's open live catalog.
 *
 * DoltLite 0.50.6 fixes per-table staging and full-catalog URL cloning.
 * Previously corrupted commits remain unchanged. Native merging still
 * refuses catalogs containing ignored runtime tables (ve-wsu), including
 * a two-table reproduction with no visible semantic changes. mergeBack
 * therefore keeps its projection merge, deterministic singleton policy,
 * forget-wins object handling, and forward integration commit carrying a
 * merged-revision trailer.
 */

export interface ForkBootstrapOptions {
  dataDir: string;
  workspaceDir: string;
  /**
   * Byte snapshot of a healthy upstream catalog database (a copy of its
   * `videobook.db` taken while the upstream engine was closed). The hosting
   * layer can provide this snapshot when it creates the platform fork.
   */
  snapshotPath?: string;
  /**
   * Upstream catalog remote URL to `dolt_clone`. The cloned schema is
   * validated before the engine opens. Mutually exclusive with `snapshotPath`.
   */
  upstreamUrl?: string;
  remoteObjects?: ContentStore;
  objectPrefix?: string;
  /** Remote registration for the fork's own catalog remote (push target). */
  catalogBackup?: CatalogBackupConfig;
  identity?: EngineIdentity;
}

export interface MergeBackOptions {
  /**
   * Path to a healthy upstream catalog database file (its `videobook.db`).
   * The file is only read — it is copied into a temp workspace and all
   * merging happens there. The upstream engine must be closed (or pass a
   * snapshot taken while it was closed) so the copy is consistent.
   */
  upstreamDbPath: string;
  /**
   * Upstream catalog remote to push the integration commit to. Defaults to
   * the `origin` remote already registered in the upstream database.
   */
  upstreamRemote?: CatalogBackupConfig;
  /** Fork catalog remote to fetch the fork's commits from. */
  forkRemote: { name?: string; url: string };
  forkBranch?: string;
  /** Upstream object store: fork objects are uploaded here before push. */
  upstreamObjects?: ContentStore;
  /** Fork object store (public-read): source of the fork's new objects. */
  forkObjects?: ContentStore;
  objectPrefix?: string;
  /** Commit author for the integration commit. */
  author?: string;
  /** Directory for the throwaway merge workspace (defaults to a temp dir). */
  workDir?: string;
  /** Keep the merge workspace for inspection instead of deleting it. */
  keepWorkDir?: boolean;
}

export interface MergeBackResult {
  /** HEAD of upstream main after the flow (the integration commit). */
  integrationCommit: string;
  /** Merge base used for the three-way merge. */
  baseRevision: string;
  /** Upstream main head before the merge. */
  oursRevision: string;
  /** Integrated fork head, recorded in the commit's merged-revision trailer. */
  theirsRevision: string;
  /** True when the fork was already fully integrated (no commit minted). */
  alreadyIntegrated: boolean;
  /** Fork object hashes uploaded to the upstream object store. */
  uploadedObjects: string[];
  reconciledTranscripts: number;
  reconciledSequences: number;
  /** Merge workspace path when `keepWorkDir` was set. */
  workDir?: string;
}

interface RemoteRow {
  name: string;
  url: string;
}

interface TableShape {
  table: string;
  columns: string[];
  primaryKey: string[];
}

export interface RowConflict {
  table: string;
  key: Record<string, unknown>;
  reason: string;
}

const DEFAULT_MERGE_AUTHOR = "Videobook <videobook@localhost>";

/**
 * Bootstraps a fork: clones the upstream catalog into a new local engine
 * root and opens it as a normal engine. The fork is a full citizen from
 * there — it commits on its own main, backs up to its own catalog remote,
 * and reads upstream objects lazily through its configured `ContentStore`.
 * It never pulls; integration is the merge-back flow's job.
 */
export async function bootstrapFork(
  options: ForkBootstrapOptions,
): Promise<Engine> {
  if (
    (options.snapshotPath === undefined) ===
    (options.upstreamUrl === undefined)
  ) {
    throw new EngineFault({
      code: "INVALID_INPUT",
      message: "Exactly one of snapshotPath or upstreamUrl is required",
    });
  }
  const dataDir = path.resolve(options.dataDir);
  const databasePath = path.join(dataDir, "videobook.db");
  await mkdir(dataDir, { recursive: true });
  if (options.snapshotPath !== undefined) {
    await copyFile(options.snapshotPath, databasePath);
  } else {
    const db = new DatabaseSync(databasePath);
    try {
      db.prepare("SELECT dolt_clone(?) AS result").get(options.upstreamUrl);
      // Older commits can retain invalid index roots even after upgrading
      // DoltLite. Validate before handing the catalog to the engine.
      db.prepare("SELECT COUNT(*) AS count FROM sqlite_master").get();
      db.close();
    } catch (error) {
      try {
        db.close();
      } catch {
        // The clone is already unusable; ignore close errors.
      }
      await rm(databasePath, { force: true });
      throw new EngineFault({
        code: "FEATURE_UNAVAILABLE",
        message:
          "Could not clone a readable upstream catalog. Check the remote " +
          "or bootstrap from a healthy snapshot of the upstream database " +
          "with snapshotPath.",
        details: {
          cause: error instanceof Error ? error.message : String(error),
        },
      });
    }
  }
  return createEngine({
    dataDir,
    workspaceDir: path.resolve(options.workspaceDir),
    ...(options.remoteObjects ? { remoteObjects: options.remoteObjects } : {}),
    ...(options.objectPrefix ? { objectPrefix: options.objectPrefix } : {}),
    ...(options.catalogBackup ? { catalogBackup: options.catalogBackup } : {}),
    ...(options.identity ? { identity: options.identity } : {}),
  });
}

/**
 * Integrates a fork back into upstream main.
 *
 * Runs entirely in a throwaway copy of the upstream catalog inside a temp
 * directory: fetches the fork, merges under the engine merge policy
 * (same-schema precondition, constraint verification, deterministic
 * singleton reconcile; artifact identity is artifact_id, so there is no
 * name-conflict class to check), uploads the fork's new
 * objects to the upstream object store BEFORE the catalog ref moves — the
 * same objects-before-push ordering as engine.storage.backup — lands one
 * forward integration commit on main, and pushes it.
 *
 * The caller's open engines are never touched: the upstream database file
 * is only read (copied), and the fork is only fetched from. Conflicts and
 * violations surface as the typed MERGE_CONFLICT / MERGE_VIOLATION /
 * SCHEMA_INCOMPATIBLE errors from src/merge-policy.ts.
 */
export async function mergeBack(
  options: MergeBackOptions,
): Promise<MergeBackResult> {
  const workDir =
    options.workDir ??
    (await mkdtemp(path.join(tmpdir(), "videobook-merge-back-")));
  await mkdir(workDir, { recursive: true });
  try {
    const result = await mergeBackIn(workDir, options);
    if (options.keepWorkDir) result.workDir = workDir;
    return result;
  } finally {
    if (!options.keepWorkDir) {
      await rm(workDir, { recursive: true, force: true });
    }
  }
}

async function mergeBackIn(
  workDir: string,
  options: MergeBackOptions,
): Promise<MergeBackResult> {
  const forkRemoteName = options.forkRemote.name ?? "fork";
  const forkBranch = options.forkBranch ?? "main";
  const theirsRef = `${forkRemoteName}/${forkBranch}`;
  const localForkRef = `merge-back-${forkRemoteName}-${forkBranch}`;

  await copyFile(options.upstreamDbPath, path.join(workDir, "videobook.db"));
  const db = new DatabaseSync(path.join(workDir, "videobook.db"));
  try {
    const upstreamRemote = options.upstreamRemote ?? findRemote(db, "origin");
    if (!upstreamRemote) {
      throw new EngineFault({
        code: "INVALID_INPUT",
        message:
          "No upstream remote given and the catalog has no origin remote; " +
          "pass upstreamRemote",
      });
    }
    ensureRemote(db, upstreamRemote.name, upstreamRemote.url);
    ensureRemote(db, forkRemoteName, options.forkRemote.url);
    try {
      db.prepare("SELECT dolt_fetch(?) AS result").get(forkRemoteName);
    } catch (error) {
      throw new EngineFault({
        code: "OFFLINE",
        message:
          `Could not fetch fork remote ${forkRemoteName}: ` +
          (error instanceof Error ? error.message : String(error)),
      });
    }

    // Resolve commit hashes (doltHashOf returns content hashes, not commit
    // hashes): main's head comes from the log, and the fetched
    // remote-tracking ref gets a local branch pointer — a ref-only write
    // that materializes no working set, so it is safe under ve-wsu.
    const oursRevision = db.doltLog({ limit: 1 })[0]?.commit_hash ?? "";
    if (db.doltBranches().some((branch) => branch.name === localForkRef)) {
      db.prepare("SELECT dolt_branch('-D', ?) AS result").get(localForkRef);
    }
    db.doltBranch(localForkRef, theirsRef);
    const theirsRevision =
      db.doltBranches().find((branch) => branch.name === localForkRef)?.hash ??
      "";
    if (!oursRevision || !theirsRevision) {
      throw new EngineFault({
        code: "STORAGE_ERROR",
        message: `Could not resolve merge heads for main and ${theirsRef}`,
      });
    }
    const baseRow = db
      .prepare("SELECT dolt_merge_base(?, ?) AS hash")
      .get("main", localForkRef) as unknown as
      { hash: string | null } | undefined;
    const baseRevision = baseRow?.hash ?? null;
    if (!baseRevision) {
      throw new EngineFault({
        code: "MERGE_CONFLICT",
        message:
          `Merge-back of ${theirsRef} refused: no common ancestor with ` +
          "upstream main (not a fork of this catalog?)",
        details: { branch: theirsRef },
      });
    }

    // The fork objects upstream lacks are uploaded before the catalog ref
    // moves, whether or not a new integration commit is needed.
    const newObjects = objectsAddedByFork(db, "HEAD", localForkRef);

    let integrationCommit = oursRevision;
    let reconciled = { transcripts: 0, sequences: 0 };
    let alreadyIntegrated =
      baseRevision === theirsRevision || oursRevision === theirsRevision;
    if (!alreadyIntegrated) {
      const integration = integrate(db, localForkRef, {
        baseRevision,
        oursRevision,
        theirsRevision,
        forkRemote: `${forkRemoteName}:${options.forkRemote.url}`,
        forkBranch,
        author: options.author ?? DEFAULT_MERGE_AUTHOR,
      });
      if (integration === null) {
        alreadyIntegrated = true;
      } else {
        integrationCommit = integration.commit;
        reconciled = integration.reconciled;
      }
    }

    const uploadedObjects = await uploadForkObjects(db, newObjects, options);

    try {
      db.prepare("SELECT dolt_push(?, 'main') AS result").get(
        upstreamRemote.name,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/diverg|fast-forward|fetch first/i.test(message)) {
        throw new EngineFault({
          code: "DIVERGED",
          message:
            "Upstream moved while the merge-back was in flight; re-run " +
            `mergeBack against the moved upstream. (${message})`,
        });
      }
      throw error;
    }

    return {
      integrationCommit,
      baseRevision,
      oursRevision,
      theirsRevision,
      alreadyIntegrated,
      uploadedObjects,
      reconciledTranscripts: reconciled.transcripts,
      reconciledSequences: reconciled.sequences,
    };
  } finally {
    db.close();
  }
}

/**
 * Merges `theirsRef` into main under the engine merge policy and Dolt-
 * commits the result as one forward integration commit. The policy wrapper
 * is identical to `mergeWithPolicy` (same-schema precondition, constraint
 * verification, deterministic singleton-flag reconcile); only the merge
 * mechanism
 * differs — a projection-level three-way merge instead of `dolt_merge`,
 * which ve-wsu makes unusable on full engine catalogs (see the module
 * comment). Returns null when the fork's net changes are already present
 * on main, in which case nothing is written or committed.
 */
function integrate(
  db: DatabaseSync,
  forkRef: string,
  context: {
    baseRevision: string;
    oursRevision: string;
    theirsRevision: string;
    forkRemote: string;
    forkBranch: string;
    author: string;
  },
): {
  commit: string;
  reconciled: { transcripts: number; sequences: number };
} | null {
  assertSameSchemaVersion(db, "HEAD", forkRef);
  const merge = mergeRefs(db, "HEAD", forkRef, context.baseRevision);
  if (!merge) {
    // The fork's net changes are already present on main (for example a
    // re-run after an earlier integration commit): nothing to commit.
    return null;
  }
  const reconciled = reconcileSingletonFlags(db);
  verifyConstraintHealth(db);

  for (const table of SEMANTIC_TABLES) {
    db.prepare("SELECT dolt_add(?) AS result").get(table);
  }
  const operationId = uuidv7();
  // The write-set trailer names every resource the integration rewrote, so
  // edit conflict detection (revisionConflicts in src/edits.ts) sees
  // integrated changes exactly like locally committed ones. Oversized sets
  // degrade the same way as engine commits: an omitted marker.
  const writeSetJson = canonicalJson([...merge.writeSet].sort());
  const writeSetTrailer =
    Buffer.byteLength(writeSetJson, "utf8") <= 32_000
      ? `write-set: ${writeSetJson}`
      : `write-set-omitted: ${Buffer.byteLength(writeSetJson, "utf8")}`;
  const message = [
    "merge_back",
    "",
    `op-id: ${operationId}`,
    `base-revision: ${context.baseRevision}`,
    `merged-revision: ${context.theirsRevision}`,
    writeSetTrailer,
    `details: ${canonicalJson({
      forkRemote: context.forkRemote,
      forkBranch: context.forkBranch,
      oursRevision: context.oursRevision,
    })}`,
  ].join("\n");
  const row = db
    .prepare("SELECT dolt_commit('-m', ?, '--author', ?) AS hash")
    .get(message, context.author) as unknown as { hash: string } | undefined;
  if (!row?.hash) {
    throw new EngineFault({
      code: "STORAGE_ERROR",
      message: "Dolt commit did not return a revision hash",
    });
  }
  return { commit: row.hash, reconciled };
}

/**
 * Projection-level three-way merge: rewrites the working set of every
 * semantic table to the row-level three-way merge of `oursRef` and
 * `theirsRef` against `baseRef`. Row semantics mirror Dolt's merge: a row
 * changed on only one side takes that side's value, identical changes
 * resolve to the same row, and incompatible changes (both sides changed a
 * row differently, or one side modified a row the other deleted) are
 * conflicts and abort before anything is written. Artifact rows are keyed
 * by artifact_id (UUIDv7, collision-free across forks), so independently
 * minted artifacts never collide on identity; labels are non-unique
 * display text and merge like any other column.
 *
 * The rewrite reuses the restore idiom (src/history.ts
 * reloadSemanticTables): `SEMANTIC_TABLES` is ordered parent-before-child,
 * so deleting in reverse and reinserting in forward order satisfies foreign
 * keys, and columns come from `PRAGMA table_info`.
 *
 * Returns whether the merge changed anything relative to `oursRef`; when
 * it did not, the working set is left untouched.
 */
function mergeRefs(
  db: DatabaseSync,
  oursRef: string,
  theirsRef: string,
  baseRef: string,
): { writeSet: Set<string> } | null {
  const shapes = SEMANTIC_TABLES.map((table) => tableShape(db, table));
  const merged: Array<{
    shape: TableShape;
    rows: Array<Record<string, unknown>>;
  }> = [];
  const conflicts: RowConflict[] = [];
  const writeSet = new Set<string>();
  let changed = false;
  for (const shape of shapes) {
    const base = rowsByKey(db, shape, baseRef);
    const ours = rowsByKey(db, shape, oursRef);
    const theirs = rowsByKey(db, shape, theirsRef);
    const result = new Map<string, Record<string, unknown>>(ours);
    const keys = new Set([...base.keys(), ...theirs.keys()]);
    const applyRow = (key: string, row: Record<string, unknown>): void => {
      result.set(key, row);
      changed = true;
      resourcesFor(shape, row).forEach((resource) => writeSet.add(resource));
    };
    for (const key of keys) {
      const b = base.get(key);
      const o = ours.get(key);
      const t = theirs.get(key);
      if (t !== undefined && b === undefined) {
        // Added on theirs.
        if (o !== undefined && !rowsEqual(o, t)) {
          const resolved = resolveObjectsRow(shape, o, t);
          if (resolved) {
            if (!rowsEqual(resolved, o)) applyRow(key, resolved);
          } else {
            conflicts.push({
              table: shape.table,
              key: keyObject(shape, key),
              reason: "row added with different content on both sides",
            });
          }
        } else if (o === undefined) {
          applyRow(key, t);
        }
      } else if (t === undefined && b !== undefined) {
        // Deleted on theirs.
        if (o !== undefined && !rowsEqual(o, b)) {
          conflicts.push({
            table: shape.table,
            key: keyObject(shape, key),
            reason: "row modified on ours but deleted on theirs",
          });
        } else if (o !== undefined) {
          result.delete(key);
          changed = true;
          resourcesFor(shape, o).forEach((resource) => writeSet.add(resource));
        }
      } else if (t !== undefined && b !== undefined && !rowsEqual(t, b)) {
        // Changed on theirs.
        if (o === undefined) {
          conflicts.push({
            table: shape.table,
            key: keyObject(shape, key),
            reason: "row modified on theirs but deleted on ours",
          });
        } else if (rowsEqual(o, b) || rowsEqual(o, t)) {
          if (!rowsEqual(o, t)) applyRow(key, t);
        } else {
          const resolved = resolveObjectsRow(shape, o, t);
          if (resolved) {
            if (!rowsEqual(resolved, o)) applyRow(key, resolved);
          } else {
            conflicts.push({
              table: shape.table,
              key: keyObject(shape, key),
              reason: "row modified differently on both sides",
            });
          }
        }
      }
    }
    merged.push({ shape, rows: [...result.values()] });
  }
  if (conflicts.length > 0) {
    throw new EngineFault({
      code: "MERGE_CONFLICT",
      message:
        `Merge-back has row-level conflicts in ${conflicts.length} row(s) ` +
        `across ${new Set(conflicts.map((c) => c.table)).size} table(s): ` +
        conflicts
          .slice(0, 5)
          .map((c) => `${c.table}(${JSON.stringify(c.key)})`)
          .join(", ") +
        (conflicts.length > 5 ? ", …" : ""),
      details: { conflicts },
    });
  }
  if (!changed) return null;

  db.exec("PRAGMA foreign_keys = OFF");
  try {
    for (const { shape } of [...merged].reverse()) {
      db.prepare(`DELETE FROM ${shape.table}`).run();
    }
    for (const { shape, rows } of merged) {
      if (rows.length === 0) continue;
      const insert = db.prepare(
        `INSERT INTO ${shape.table}(${shape.columns.join(", ")})
         VALUES (${shape.columns.map(() => "?").join(", ")})`,
      );
      for (const row of rows) {
        insert.run(...shape.columns.map((column) => row[column] ?? null));
      }
    }
  } finally {
    db.exec("PRAGMA foreign_keys = ON");
  }
  return { writeSet };
}

/**
 * `objects` rows merge instead of conflicting when both sides agree on
 * everything except `forgotten_at`: a forget on either side wins (deleted
 * bytes must stay deleted on both lineages), and when both sides forgot
 * independently the earlier wall-clock stamp is kept so the same takedown
 * applied on fork and upstream cannot wedge integration. Returns null for
 * any other table or any other difference.
 */
function resolveObjectsRow(
  shape: TableShape,
  ours: Record<string, unknown>,
  theirs: Record<string, unknown>,
): Record<string, unknown> | null {
  if (shape.table !== "objects") return null;
  const keys = new Set([...Object.keys(ours), ...Object.keys(theirs)]);
  for (const key of keys) {
    if (key === "forgotten_at") continue;
    if (comparable(ours[key]) !== comparable(theirs[key])) return null;
  }
  const oursForgotten = ours["forgotten_at"] as number | null | undefined;
  const theirsForgotten = theirs["forgotten_at"] as number | null | undefined;
  const forgotten =
    oursForgotten != null && theirsForgotten != null
      ? Math.min(oursForgotten, theirsForgotten)
      : (oursForgotten ?? theirsForgotten ?? null);
  return { ...ours, forgotten_at: forgotten };
}

/**
 * Resource strings for the integration commit's write-set trailer, using
 * the same vocabulary as engine write sets (src/edits.ts editWriteSet,
 * storage/artifact operations) so overlap detection matches.
 */
function resourcesFor(
  shape: TableShape,
  row: Record<string, unknown>,
): string[] {
  const value = (column: string): string => String(row[column] ?? "");
  switch (shape.table) {
    case "sequences":
      return [`sequence:${value("sequence_id")}`];
    case "sequence_tracks":
      return [`sequence:${value("sequence_id")}`, `track:${value("track_id")}`];
    case "sequence_clips":
      return [`clip:${value("clip_id")}`, `track:${value("track_id")}`];
    case "clip_links":
    case "clip_transforms":
      return [`clip:${value("clip_id")}`];
    case "transitions":
      return [`transition:${value("transition_id")}`];
    case "caption_cues":
      return [`track:${value("track_id")}`];
    case "artifacts":
      return [`artifact:${value("artifact_id")}`];
    case "artifact_files":
    case "artifact_streams":
    case "artifact_metadata":
    case "audio_waveforms":
      return [`artifact:${value("artifact_id")}`];
    case "objects":
      return [`object:${value("object_hash")}`];
    case "transcripts":
      return [`transcript:${value("transcript_id")}`];
    case "transcript_segments":
      return [`transcript:${value("transcript_id")}`];
    case "book":
    case "book_metadata":
      return ["book"];
    case "notebooks":
    case "cells":
    case "edges":
    case "runs":
    case "cell_references":
    case "pinned_search_results":
      return [`notebook:${value("notebook_id")}`];
    default:
      return [
        `${shape.table}:${shape.primaryKey.map((column) => value(column)).join(":")}`,
      ];
  }
}

function tableShape(db: DatabaseSync, table: string): TableShape {
  const info = db
    .prepare(`PRAGMA table_info(${table})`)
    .all() as unknown as Array<{
    name: string;
    pk: number;
  }>;
  return {
    table,
    columns: info.map((column) => column.name),
    primaryKey: info
      .filter((column) => column.pk > 0)
      .sort((left, right) => left.pk - right.pk)
      .map((column) => column.name),
  };
}

function rowsByKey(
  db: DatabaseSync,
  shape: TableShape,
  ref: string,
): Map<string, Record<string, unknown>> {
  const rows = db
    .prepare(`SELECT * FROM dolt_at_${shape.table}(?)`)
    .all(ref) as unknown as Array<Record<string, unknown>>;
  return new Map(rows.map((row) => [rowKey(shape, row), row]));
}

function rowKey(shape: TableShape, row: Record<string, unknown>): string {
  return canonicalJson(
    shape.primaryKey.map((column) => comparable(row[column])),
  );
}

function keyObject(shape: TableShape, key: string): Record<string, unknown> {
  const values = JSON.parse(key) as unknown[];
  return Object.fromEntries(
    shape.primaryKey.map((column, index) => [column, values[index]]),
  );
}

function comparable(value: unknown): unknown {
  if (value instanceof Uint8Array) {
    return `blob:${Buffer.from(value).toString("hex")}`;
  }
  return value ?? null;
}

function rowsEqual(
  left: Record<string, unknown>,
  right: Record<string, unknown>,
): boolean {
  const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
  for (const key of keys) {
    const a = comparable(left[key]);
    const b = comparable(right[key]);
    if (a !== b) return false;
  }
  return true;
}

interface ObjectRow {
  object_hash: string;
  size_bytes: number;
  forgotten_at: number | null;
}

/** Live (non-forgotten) objects present at `theirsRef` but not at `oursRef`. */
function objectsAddedByFork(
  db: DatabaseSync,
  oursRef: string,
  theirsRef: string,
): ObjectRow[] {
  const ours = new Set(
    (
      db
        .prepare("SELECT object_hash FROM dolt_at_objects(?)")
        .all(oursRef) as unknown as Array<{ object_hash: string }>
    ).map((row) => row.object_hash),
  );
  const theirs = db
    .prepare(
      `SELECT object_hash, size_bytes, forgotten_at
       FROM dolt_at_objects(?) ORDER BY created_at, object_hash`,
    )
    .all(theirsRef) as unknown as ObjectRow[];
  return theirs.filter(
    (row) => row.forgotten_at === null && !ours.has(row.object_hash),
  );
}

/**
 * Moves the fork's new objects into the upstream object store. Runs after
 * the merge is verified but before the catalog ref is pushed, so the
 * catalog never points at objects upstream cannot serve — the same
 * objects-before-push ordering as engine.storage.backup.
 */
async function uploadForkObjects(
  db: DatabaseSync,
  objects: ObjectRow[],
  options: MergeBackOptions,
): Promise<string[]> {
  if (objects.length === 0) return [];
  if (!options.upstreamObjects || !options.forkObjects) {
    throw new EngineFault({
      code: "INVALID_INPUT",
      message:
        `Fork adds ${objects.length} object(s); upstreamObjects and ` +
        "forkObjects are required to move them before the catalog moves",
      details: { hashes: objects.map((row) => row.object_hash) },
    });
  }
  const prefix = options.objectPrefix;
  const downloadDir = await mkdtemp(
    path.join(tmpdir(), "videobook-merge-objects-"),
  );
  try {
    const forkStore = new ObjectStore(
      path.join(downloadDir, "fork"),
      options.forkObjects,
      prefix,
    );
    const upstreamStore = new ObjectStore(
      path.join(downloadDir, "upstream"),
      options.upstreamObjects,
      prefix,
    );
    const uploaded: string[] = [];
    for (const row of objects) {
      // ensureLocalPath lazily fetches the bytes from the fork's
      // public-read store; publish uploads and verifies the remote copy.
      const localPath = await forkStore.ensureLocalPath(row.object_hash);
      const staged = upstreamStore.pathFor(row.object_hash);
      await mkdir(path.dirname(staged), { recursive: true });
      await copyFile(localPath, staged);
      await upstreamStore.publish(row.object_hash, row.size_bytes);
      uploaded.push(row.object_hash);
    }
    return uploaded;
  } finally {
    await rm(downloadDir, { recursive: true, force: true });
  }
}

function findRemote(
  db: DatabaseSync,
  name: string,
): CatalogBackupConfig | null {
  const rows = db
    .prepare("SELECT * FROM dolt_remotes()")
    .all() as unknown as RemoteRow[];
  const remote = rows.find((row) => row.name === name);
  return remote ? { name: remote.name, url: remote.url } : null;
}

function ensureRemote(db: DatabaseSync, name: string, url: string): void {
  const existing = findRemote(db, name);
  if (existing) {
    if (existing.url !== url) {
      throw new EngineFault({
        code: "INVALID_INPUT",
        message: `Remote ${name} already points to a different URL`,
        details: { name, existing: existing.url, requested: url },
      });
    }
    return;
  }
  db.prepare("SELECT dolt_remote('add', ?, ?) AS result").get(name, url);
}
