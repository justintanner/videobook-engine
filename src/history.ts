import { rm } from "node:fs/promises";

import type {
  ActionLogEntry,
  EngineError,
  Result,
  Revision,
} from "./engine-types.js";
import { ok } from "./engine-types.js";
import { EngineContext, resultOf, type ArtifactRow } from "./context.js";
import { artifactSlug } from "./artifacts.js";
import { materializeArtifact } from "./files.js";
import { assertUuidV7, isUuidV7, newUuidV7 } from "./ids.js";
import { SCHEMA_VERSION, SEMANTIC_TABLES } from "./schema.js";
import {
  canonicalJson,
  commitDateIso,
  type CommitOperation,
  EngineFault,
  parseCommitMessage,
} from "./store.js";

interface HistoricalArtifactRow extends ArtifactRow {}

interface MetadataSnapshotRow {
  key: string;
  value_json: string;
}

interface WaveformSnapshotRow {
  artifact_id?: string;
  peaks_json: string;
}

interface ArtifactFileSnapshotRow {
  artifact_id: string;
  path: string;
  object_hash: string;
  created_at: number;
}

interface ActiveRuntimeJobRow {
  id: number;
  artifact_id: string | null;
  type: string;
  payload_json: string;
  result_json: string | null;
  started_at: number | null;
}

export function createHistoryApi(context: EngineContext) {
  return {
    revisions: (limit = 20): Revision[] => revisionHistory(context, limit),
    artifact: (artifact: string, limit = 20): Revision[] =>
      artifactHistory(context, artifact, limit),
    resolveRevision: (revision: string): Revision | null =>
      resolveRevision(context, revision),
    recordOperation: (
      operation: string,
      artifact?: string,
      details?: Record<string, unknown>,
    ): Promise<Result<Revision, EngineError>> =>
      recordOperation(context, operation, artifact, details),
    restoreArtifact: (
      artifactId: string,
      revision: string,
      slug?: string,
    ): Promise<Result<Revision, EngineError>> =>
      restoreArtifact(context, artifactId, revision, slug),
    restore: (revision: string): Promise<Result<Revision, EngineError>> =>
      restoreBook(context, revision),
    logAction: (
      action: string,
      payload: string | Record<string, unknown>,
    ): Promise<Result<ActionLogEntry, EngineError>> =>
      logAction(context, action, payload),
    actionLog: (options?: {
      limit?: number;
      action?: string;
    }): ActionLogEntry[] => actionLog(context, options),
  };
}

function revisionForHash(context: EngineContext, hash: string): Revision {
  const commit = context.store.db
    .doltLog()
    .find((item) => item.commit_hash === hash);
  if (!commit) {
    throw new EngineFault({
      code: "NOT_FOUND",
      message: `Revision not found: ${hash}`,
    });
  }
  const parsed = parseCommitMessage(commit.message);
  if (parsed) return revisionFromCommit(context, commit, parsed);
  return {
    hash,
    message: commit.message,
    date: commitDateIso(commit.date),
    author: commit.committer,
  };
}

function revisionHistory(context: EngineContext, limit: number): Revision[] {
  return commitRevisions(context).slice(0, Math.max(0, limit));
}

function artifactHistory(
  context: EngineContext,
  artifactReference: string,
  limit: number,
): Revision[] {
  const revisions = commitRevisions(context);
  let artifactId: string;
  if (isUuidV7(artifactReference)) {
    artifactId = artifactReference;
  } else {
    try {
      artifactId = context.artifactRow(artifactReference).artifact_id;
    } catch {
      const historical = revisions.find(
        (revision) =>
          revision.artifactSlug === artifactReference ||
          revision.details?.slug === artifactReference ||
          revision.details?.oldSlug === artifactReference,
      );
      if (!historical?.artifactId) return [];
      artifactId = historical.artifactId;
    }
  }
  return revisions
    .filter((revision) => revision.artifactId === artifactId)
    .slice(0, Math.max(0, limit));
}

// History listings are direct commit-log reads: every engine commit carries
// its operation, parameters, and write set in its structured message, so no
// per-commit table diffs are needed to describe a revision.
function commitRevisions(context: EngineContext): Revision[] {
  const revisions: Revision[] = [];
  for (const commit of context.store.db.doltLog()) {
    const parsed = parseCommitMessage(commit.message);
    if (!parsed) continue;
    revisions.push(revisionFromCommit(context, commit, parsed));
  }
  return revisions;
}

function revisionFromCommit(
  context: EngineContext,
  commit: {
    commit_hash: string;
    message: string;
    date: string;
    committer: string;
  },
  parsed: CommitOperation,
): Revision {
  const artifactSlugAtRevision = parsed.artifactId
    ? artifactSlugAt(context, parsed.artifactId, commit.commit_hash)
    : undefined;
  return {
    hash: commit.commit_hash,
    message: commit.message,
    date: commitDateIso(commit.date),
    author: parsed.actor ?? commit.committer,
    operationId: parsed.operationId,
    operation: parsed.operation,
    ...(parsed.artifactId ? { artifactId: parsed.artifactId } : {}),
    ...(artifactSlugAtRevision ? { artifactSlug: artifactSlugAtRevision } : {}),
    details: {
      ...parsed.details,
      ...(parsed.writeSet.length > 0 ? { writeSet: parsed.writeSet } : {}),
      ...(parsed.baseRevision ? { baseRevision: parsed.baseRevision } : {}),
    },
  };
}

function resolveRevision(
  context: EngineContext,
  reference: string,
): Revision | null {
  const historical = commitRevisions(context).find(
    (revision) =>
      revision.hash === reference || revision.hash.startsWith(reference),
  );
  if (historical) return historical;
  const commit = context.store.db
    .doltLog()
    .find(
      (item) =>
        item.commit_hash === reference ||
        item.commit_hash.startsWith(reference),
    );
  return commit
    ? {
        hash: commit.commit_hash,
        message: commit.message,
        date: commitDateIso(commit.date),
        author: commit.committer,
      }
    : null;
}

function requiredRevision(context: EngineContext, reference: string): Revision {
  const revision = resolveRevision(context, reference);
  if (!revision) {
    throw new EngineFault({
      code: "NOT_FOUND",
      message: `Revision not found: ${reference}`,
    });
  }
  return revision;
}

async function recordOperation(
  context: EngineContext,
  operation: string,
  artifactReference?: string,
  details?: Record<string, unknown>,
): Promise<Result<Revision, EngineError>> {
  return resultOf(async () => {
    const artifact = artifactReference
      ? context.artifactRow(artifactReference)
      : null;
    const mutation = await context.store.semantic(
      {
        operation,
        ...(artifact ? { artifactId: artifact.artifact_id } : {}),
        details: {
          ...(details ?? {}),
          ...(artifact ? { artifactSlug: artifact.slug } : {}),
        },
        writeSet: artifact ? [`artifact:${artifact.artifact_id}`] : ["book"],
        // Provenance-only operations change no semantic rows; the commit
        // itself is their record, so it must be minted even when empty.
        allowEmpty: true,
      },
      () => undefined,
    );
    return ok(revisionForHash(context, mutation.revision), mutation.revision);
  });
}

async function restoreArtifact(
  context: EngineContext,
  artifactId: string,
  revisionReference: string,
  replacementSlug?: string,
): Promise<Result<Revision, EngineError>> {
  return resultOf(async () => {
    assertUuidV7(artifactId, "Artifact ID");
    const revision = requiredRevision(context, revisionReference);
    const target = context.store.db
      .prepare(
        `SELECT artifact_id, slug, kind, created_at
         FROM dolt_at_artifacts(?)
         WHERE artifact_id=?`,
      )
      .get(revision.hash, artifactId) as unknown as
      HistoricalArtifactRow | undefined;
    if (!target) {
      throw new EngineFault({
        code: "NOT_FOUND",
        message: `Artifact ${artifactId} did not exist at ${revision.hash}`,
      });
    }
    const desiredSlug = replacementSlug
      ? artifactSlug(target.kind, replacementSlug)
      : target.slug;
    const owner = context.store.db
      .prepare(
        `SELECT artifact_id FROM artifacts
         WHERE slug=? AND artifact_id<>?`,
      )
      .get(desiredSlug, artifactId) as unknown as
      { artifact_id: string } | undefined;
    if (owner) {
      throw new EngineFault({
        code: "SLUG_CONFLICT",
        message: `Slug ${desiredSlug} is owned by active artifact ${owner.artifact_id}`,
        ownerId: owner.artifact_id,
      });
    }
    const files = filesAt(context, revision.hash, artifactId);
    const metadata = context.store.db
      .prepare(
        `SELECT key, value_json
         FROM dolt_at_artifact_metadata(?) WHERE artifact_id=?`,
      )
      .all(revision.hash, artifactId) as unknown as MetadataSnapshotRow[];
    const waveform = context.store.db
      .prepare(
        `SELECT peaks_json
         FROM dolt_at_audio_waveforms(?) WHERE artifact_id=?`,
      )
      .get(revision.hash, artifactId) as unknown as
      WaveformSnapshotRow | undefined;
    const mutation = await context.store.semantic(
      {
        operation: "restore_artifact",
        artifactId,
        details: { fromRevision: revision.hash, slug: desiredSlug },
        writeSet: [`artifact:${artifactId}`, `artifact-slug:${desiredSlug}`],
      },
      (_operationId, now) => {
        context.store.db
          .prepare(
            `INSERT INTO artifacts(
              artifact_id, slug, kind, created_at
            ) VALUES (?, ?, ?, ?)
            ON CONFLICT(artifact_id) DO UPDATE SET
              slug=excluded.slug,
              kind=excluded.kind`,
          )
          .run(target.artifact_id, desiredSlug, target.kind, target.created_at);
        context.store.db
          .prepare("DELETE FROM artifact_files WHERE artifact_id=?")
          .run(artifactId);
        context.store.db
          .prepare("DELETE FROM artifact_metadata WHERE artifact_id=?")
          .run(artifactId);
        context.store.db
          .prepare("DELETE FROM audio_waveforms WHERE artifact_id=?")
          .run(artifactId);
        insertFiles(context, files);
        const insertMetadata = context.store.db.prepare(
          `INSERT INTO artifact_metadata(
            artifact_id, key, value_json
          ) VALUES (?, ?, ?)`,
        );
        for (const row of metadata) {
          insertMetadata.run(artifactId, row.key, row.value_json);
        }
        if (waveform) {
          context.store.db
            .prepare(
              `INSERT INTO audio_waveforms(artifact_id, peaks_json)
               VALUES (?, ?)`,
            )
            .run(artifactId, waveform.peaks_json);
        }
        resetArtifactRuntime(context, artifactId, now);
      },
    );
    await rm(context.artifactPath(artifactId), {
      recursive: true,
      force: true,
    });
    await materializeIgnoringForgotten(context, artifactId);
    return ok(revisionForHash(context, mutation.revision), mutation.revision);
  });
}

async function restoreBook(
  context: EngineContext,
  revisionReference: string,
): Promise<Result<Revision, EngineError>> {
  return resultOf(async () => {
    const revision = requiredRevision(context, revisionReference);
    const targetBook = context.store.db
      .prepare("SELECT book_id, slug, created_at FROM dolt_at_book(?)")
      .get(revision.hash) as unknown as
      { book_id: string; slug: string; created_at: number } | undefined;
    if (!targetBook) {
      throw new EngineFault({
        code: "NOT_FOUND",
        message: `Book did not exist at ${revision.hash}`,
      });
    }
    const currentBook = context.bookRow();
    if (targetBook.book_id !== currentBook.book_id) {
      throw new EngineFault({
        code: "SCHEMA_INCOMPATIBLE",
        message: "A restore cannot replace the catalog's stable book ID",
      });
    }
    const targetSchema = context.store.db
      .prepare("SELECT version FROM dolt_at_engine_schema(?) WHERE singleton=1")
      .get(revision.hash) as unknown as { version: number } | undefined;
    if (!targetSchema || targetSchema.version !== SCHEMA_VERSION) {
      throw new EngineFault({
        code: "SCHEMA_INCOMPATIBLE",
        message:
          `Cannot restore ${revision.hash}: it records schema version ` +
          `${targetSchema?.version ?? "unknown"}, not the current ${SCHEMA_VERSION}`,
      });
    }

    const targetArtifacts = context.store.db
      .prepare(
        `SELECT artifact_id, slug, kind, created_at
         FROM dolt_at_artifacts(?)
         ORDER BY artifact_id`,
      )
      .all(revision.hash) as unknown as HistoricalArtifactRow[];
    const targetIds = targetArtifacts.map((row) => row.artifact_id);
    const currentArtifactIds = context.store.db
      .prepare("SELECT artifact_id FROM artifacts")
      .all()
      .map((row) => (row as { artifact_id: string }).artifact_id);

    const mutation = await context.store.semantic(
      {
        operation: "restore",
        details: { fromRevision: revision.hash },
        writeSet: ["book"],
      },
      (_operationId, now) => {
        reloadSemanticTables(context, revision.hash);

        abortActiveJobs(context, now, "Book restored");
        context.store.db
          .prepare(
            `UPDATE runtime_resource_leases
             SET revoked_at=?, fence=fence+1 WHERE revoked_at IS NULL`,
          )
          .run(now);
        context.store.db
          .prepare("UPDATE runtime_workspace_entries SET invalidated_at=?")
          .run(now);
        context.store.db.prepare("DELETE FROM runtime_artifact_views").run();
        context.store.db.prepare("DELETE FROM runtime_pending_tasks").run();
        context.store.db.prepare("DELETE FROM runtime_generation_errors").run();
        context.store.db
          .prepare("DELETE FROM runtime_similarity_embeddings")
          .run();
        context.store.db
          .prepare("DELETE FROM runtime_text_similarity_documents")
          .run();
        for (const row of targetArtifacts) {
          resetArtifactRuntime(context, row.artifact_id, now);
        }
      },
    );

    for (const artifactId of new Set([...currentArtifactIds, ...targetIds])) {
      await rm(context.artifactPath(artifactId), {
        recursive: true,
        force: true,
      });
    }
    for (const artifact of targetArtifacts) {
      await materializeIgnoringForgotten(context, artifact.artifact_id);
    }
    return ok(revisionForHash(context, mutation.revision), mutation.revision);
  });
}

/**
 * Workspace materialization after a restore tolerates forgotten objects:
 * the restore commit is already durable, so a file whose bytes were
 * deliberately deleted must not fail the whole restore — reads of that file
 * surface OBJECT_UNAVAILABLE instead.
 */
async function materializeIgnoringForgotten(
  context: EngineContext,
  artifactId: string,
): Promise<void> {
  try {
    await materializeArtifact(context, artifactId);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!/object unavailable/i.test(message)) throw error;
  }
}

/**
 * Restore is mechanical: every semantic table is reloaded from its
 * `dolt_at_<table>` projection at the target revision, so the resulting
 * state is exactly the state that revision recorded and no hand-maintained
 * table list can drift. `SEMANTIC_TABLES` is ordered parent-before-child,
 * so deleting in reverse order and reinserting in forward order satisfies
 * foreign keys; columns come from `PRAGMA table_info`, not per-table code.
 * Reinserted rows identical to HEAD produce no diff, so unchanged tables
 * are never staged by the surrounding commit.
 *
 * The single deliberate exception is `objects`: its rows are permanent
 * tombstone records, so restore merges instead of wiping — rows are never
 * deleted and `forgotten_at` never rewinds (see `restoreObjectRows`).
 */
function reloadSemanticTables(context: EngineContext, revision: string): void {
  const db = context.store.db;
  const snapshots = SEMANTIC_TABLES.map((table) => {
    const columns = (
      db.prepare(`PRAGMA table_info(${table})`).all() as unknown as Array<{
        name: string;
      }>
    ).map((column) => column.name);
    const rows = db
      .prepare(`SELECT * FROM dolt_at_${table}(?)`)
      .all(revision) as unknown as Array<Record<string, unknown>>;
    return { table, columns, rows };
  });
  for (const { table } of [...snapshots].reverse()) {
    // `objects` is the one exception to the mechanical wipe: rows are never
    // deleted (a row is the permanent tombstone for every historical
    // reference) and `forgotten_at` never rewinds — see the upsert below.
    if (table === "objects") continue;
    db.prepare(`DELETE FROM ${table}`).run();
  }
  for (const { table, columns, rows } of snapshots) {
    if (rows.length === 0) continue;
    if (table === "objects") {
      restoreObjectRows(db, columns, rows);
      continue;
    }
    const insert = db.prepare(
      `INSERT INTO ${table}(${columns.join(", ")})
       VALUES (${columns.map(() => "?").join(", ")})`,
    );
    for (const row of rows) {
      insert.run(...columns.map((column) => row[column] ?? null));
    }
  }
}

/**
 * Restores `objects` with merge semantics instead of wipe-and-reload:
 * rows created after the target revision survive (object rows are never
 * deleted), and an existing forget tombstone always wins over the target
 * revision's live state (`forgotten_at` never rewinds — deleted bytes do
 * not come back because history was restored).
 */
function restoreObjectRows(
  db: EngineContext["store"]["db"],
  columns: string[],
  rows: Array<Record<string, unknown>>,
): void {
  const upsert = db.prepare(
    `INSERT INTO objects(${columns.join(", ")})
     VALUES (${columns.map(() => "?").join(", ")})
     ON CONFLICT(object_hash) DO UPDATE SET
       forgotten_at=COALESCE(objects.forgotten_at, excluded.forgotten_at)`,
  );
  for (const row of rows) {
    upsert.run(...columns.map((column) => row[column] ?? null));
  }
}

async function logAction(
  context: EngineContext,
  actionName: string,
  payload: string | Record<string, unknown>,
): Promise<Result<ActionLogEntry, EngineError>> {
  return resultOf(async () => {
    const result = await recordOperation(
      context,
      `action:${actionName}`,
      undefined,
      {
        payload,
      },
    );
    if (!result.ok) throw new EngineFault(result.error);
    return {
      hash: result.value.hash,
      action: actionName,
      payload,
      date: result.value.date,
    };
  });
}

function actionLog(
  context: EngineContext,
  options: { limit?: number; action?: string } = {},
): ActionLogEntry[] {
  return revisionHistory(context, Math.max(options.limit ?? 100, 100))
    .filter(
      (revision) =>
        revision.operation?.startsWith("action:") &&
        (!options.action || revision.operation === `action:${options.action}`),
    )
    .slice(0, options.limit ?? 100)
    .map((revision) => ({
      hash: revision.hash,
      action: revision.operation!.slice("action:".length),
      payload:
        (revision.details?.payload as
          string | Record<string, unknown> | undefined) ?? {},
      date: revision.date,
    }));
}

function resetArtifactRuntime(
  context: EngineContext,
  artifactId: string,
  now: number,
): void {
  context.store.db
    .prepare(
      `INSERT INTO runtime_artifact_views(
        artifact_id, status, meta_json, updated_at
      ) VALUES (?, 'ready', '{}', ?)
      ON CONFLICT(artifact_id) DO UPDATE SET
        status='ready', meta_json='{}', owner_id=NULL,
        owner_kind=NULL, pid=NULL, deadline_at=NULL,
        updated_at=excluded.updated_at, fence=fence+1`,
    )
    .run(artifactId, now);
  context.store.db
    .prepare(
      `INSERT INTO runtime_workspace_entries(
        artifact_id, path, invalidated_at, last_accessed_at
      ) VALUES (?, ?, ?, ?)
      ON CONFLICT(artifact_id) DO UPDATE SET
        invalidated_at=excluded.invalidated_at,
        hydrated_at=NULL,
        last_accessed_at=excluded.last_accessed_at`,
    )
    .run(artifactId, context.artifactPath(artifactId), now, now);
  context.store.db
    .prepare("DELETE FROM runtime_pending_tasks WHERE artifact_id=?")
    .run(artifactId);
  context.store.db
    .prepare("DELETE FROM runtime_generation_errors WHERE artifact_id=?")
    .run(artifactId);
  context.store.db
    .prepare(
      `UPDATE runtime_resource_leases
       SET revoked_at=?, fence=fence+1
       WHERE artifact_id=? AND revoked_at IS NULL`,
    )
    .run(now, artifactId);
}

function abortActiveJobs(
  context: EngineContext,
  now: number,
  message: string,
): void {
  const jobs = context.store.db
    .prepare(
      `SELECT id, artifact_id, type, payload_json, result_json, started_at
       FROM runtime_jobs
       WHERE state IN ('queued','running','completing')`,
    )
    .all() as unknown as ActiveRuntimeJobRow[];
  const update = context.store.db.prepare(
    `UPDATE runtime_jobs
     SET state='aborted', error_json=?, finished_at=?,
         lease_expires_at=NULL, pid=NULL, fence=fence+1
     WHERE id=?`,
  );
  const insertRun = context.store.db.prepare(
    `INSERT INTO job_runs(
      run_id, artifact_id, job_type, state,
      payload_json, result_json, error_json, started_at, finished_at
    ) VALUES (?, ?, ?, 'aborted', ?, ?, ?, ?, ?)`,
  );
  for (const job of jobs) {
    const errorJson = canonicalJson({ message });
    update.run(errorJson, now, job.id);
    insertRun.run(
      newUuidV7(),
      job.artifact_id,
      job.type,
      job.payload_json,
      job.result_json,
      errorJson,
      job.started_at,
      now,
    );
  }
}

function filesAt(
  context: EngineContext,
  revision: string,
  artifactId: string,
): ArtifactFileSnapshotRow[] {
  return context.store.db
    .prepare(
      `SELECT artifact_id, path, object_hash, created_at
       FROM dolt_at_artifact_files(?) WHERE artifact_id=? ORDER BY path`,
    )
    .all(revision, artifactId) as unknown as ArtifactFileSnapshotRow[];
}

function insertFiles(
  context: EngineContext,
  files: ArtifactFileSnapshotRow[],
): void {
  const insert = context.store.db.prepare(
    `INSERT INTO artifact_files(
      artifact_id, path, object_hash, created_at
    ) VALUES (?, ?, ?, ?)`,
  );
  for (const row of files) {
    insert.run(row.artifact_id, row.path, row.object_hash, row.created_at);
  }
}

function artifactSlugAt(
  context: EngineContext,
  artifactId: string,
  revision: string,
): string | undefined {
  const row = context.store.db
    .prepare(`SELECT slug FROM dolt_at_artifacts(?) WHERE artifact_id=?`)
    .get(revision, artifactId) as unknown as { slug: string } | undefined;
  return row?.slug;
}
