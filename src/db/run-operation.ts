import * as fs from "node:fs/promises";
import * as path from "node:path";
import { v7 as uuidv7 } from "uuid";

import type { Database as DatabaseType } from "better-sqlite3";

import { VIDEOCITY_DIR, getStateDb } from "./client.js";
import { getMetadataDb } from "./metadata-client.js";
import { commitOperation } from "../git/commit.js";

export const EXPORT_DIR = "export";

export type OperationScope = "project" | "asset" | "file" | "schema";

export interface OperationContext {
  operationId: string;
  intent: string;
  scope: OperationScope;
  target: string | null;
  subject: string;
  metadataDb: DatabaseType;
  appendEvent: (event: AssetEvent) => void;
}

export interface AssetEvent {
  subjectType: "asset" | "character" | "timeline" | "project" | "render";
  subjectId: string;
  kind: string;
  detail?: unknown;
}

export interface RunOperationOptions {
  intent: string;
  scope: OperationScope;
  target?: string | null;
  subject: string;
  /** Application work — runs INSIDE the BEGIN IMMEDIATE / COMMIT block. */
  work: (ctx: OperationContext) => void | Promise<void>;
  /** Files under .videocity/export/ that this operation touches. The runner
   *  rewrites each one from current SQLite state and stages it for commit. */
  exports?: ReadonlyArray<{
    path: string; // relative to .videocity/export/
    rebuild: (db: DatabaseType) => string;
  }>;
}

interface JournalUpdate {
  operationId: string;
  status: "pending" | "sqlite_done" | "git_done" | "complete" | "aborted";
  gitHash?: string;
  error?: string;
}

function writeJournal(
  projectDir: string,
  upd: JournalUpdate,
  intent?: string,
  target?: string | null,
  scope?: OperationScope,
): void {
  const db = getStateDb(projectDir);
  const now = Date.now();
  if (intent && scope) {
    db.prepare(
      `INSERT OR REPLACE INTO recovery_journal
       (operation_id, intent, target, scope, status, git_hash, started_at, updated_at, error)
       VALUES (?, ?, ?, ?, ?, ?,
         COALESCE((SELECT started_at FROM recovery_journal WHERE operation_id = ?), ?),
         ?, ?)`,
    ).run(
      upd.operationId,
      intent,
      target ?? null,
      scope,
      upd.status,
      upd.gitHash ?? null,
      upd.operationId,
      now,
      now,
      upd.error ?? null,
    );
  } else {
    db.prepare(
      `UPDATE recovery_journal
       SET    status = ?, git_hash = ?, updated_at = ?, error = ?
       WHERE  operation_id = ?`,
    ).run(
      upd.status,
      upd.gitHash ?? null,
      now,
      upd.error ?? null,
      upd.operationId,
    );
  }
}

export interface OperationResult {
  operationId: string;
  /** Files rebuilt under .videocity/export/ relative to projectDir. */
  exportFilesWritten: string[];
}

/**
 * Run a single mutation lifecycle:
 *   1. Allocate operation_id (UUID v7)
 *   2. recovery_journal: status=pending
 *   3. BEGIN IMMEDIATE → work() → INSERT operations row → COMMIT
 *   4. recovery_journal: status=sqlite_done
 *   5. Rebuild affected canonical exports (write to disk, returned paths
 *      are also returned so the caller can `git add` them).
 *   6. recovery_journal: status=complete (the caller is responsible for the
 *      paired git commit; pass git_hash via finalizeOperation()).
 *
 * The returned paths are relative to projectDir.
 */
export async function runOperation(
  projectDir: string,
  opts: RunOperationOptions,
): Promise<OperationResult> {
  const operationId = uuidv7();
  const target = opts.target ?? null;

  writeJournal(
    projectDir,
    { operationId, status: "pending" },
    opts.intent,
    target,
    opts.scope,
  );

  const metadataDb = getMetadataDb(projectDir);

  const eventsToInsert: AssetEvent[] = [];

  const ctx: OperationContext = {
    operationId,
    intent: opts.intent,
    scope: opts.scope,
    target,
    subject: opts.subject,
    metadataDb,
    appendEvent: (e) => eventsToInsert.push(e),
  };

  try {
    metadataDb.prepare("BEGIN IMMEDIATE").run();
    try {
      await opts.work(ctx);

      const now = Date.now();
      metadataDb
        .prepare(
          `INSERT INTO operations (operation_id, intent, scope, target, subject, started_at, sqlite_committed_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          operationId,
          opts.intent,
          opts.scope,
          target,
          opts.subject,
          now,
          now,
        );

      const insertEvent = metadataDb.prepare(
        `INSERT INTO asset_events
         (operation_id, subject_type, subject_id, kind, detail, occurred_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      );
      for (const e of eventsToInsert) {
        insertEvent.run(
          operationId,
          e.subjectType,
          e.subjectId,
          e.kind,
          e.detail === undefined ? null : JSON.stringify(e.detail),
          now,
        );
      }
      metadataDb.prepare("COMMIT").run();
    } catch (txError) {
      try {
        metadataDb.prepare("ROLLBACK").run();
      } catch {
        // ignore — already rolled back
      }
      throw txError;
    }

    writeJournal(projectDir, { operationId, status: "sqlite_done" });

    const written: string[] = [];
    if (opts.exports) {
      const exportRoot = path.join(projectDir, VIDEOCITY_DIR, EXPORT_DIR);
      await fs.mkdir(exportRoot, { recursive: true });
      for (const e of opts.exports) {
        const full = path.join(exportRoot, e.path);
        await fs.mkdir(path.dirname(full), { recursive: true });
        const body = e.rebuild(metadataDb);
        await fs.writeFile(full, body);
        written.push(path.join(VIDEOCITY_DIR, EXPORT_DIR, e.path));
      }
    }

    return { operationId, exportFilesWritten: written };
  } catch (error: unknown) {
    writeJournal(projectDir, {
      operationId,
      status: "aborted",
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

/**
 * Mark an operation as fully complete (typically called by the caller after
 * the paired git commit succeeds). Pass git_hash if you have it.
 */
export function finalizeOperation(
  projectDir: string,
  operationId: string,
  gitHash?: string,
): void {
  writeJournal(projectDir, {
    operationId,
    status: "complete",
    gitHash,
  });
}

export interface CommitOperationResultOptions {
  operation: string;
  assetId?: string;
  details?: Record<string, unknown>;
  gitPath?: string;
  paths?: string[];
}

function uniquePaths(paths: string[]): string[] {
  return [...new Set(paths)];
}

export async function commitAndFinalizeOperation(
  projectDir: string,
  result: OperationResult,
  options: CommitOperationResultOptions,
): Promise<string | null> {
  const paths = uniquePaths([
    path.join(VIDEOCITY_DIR, "metadata.sqlite"),
    ...result.exportFilesWritten,
    ...(options.paths ?? []),
  ]);
  const hash = await commitOperation(
    projectDir,
    options.operation,
    options.assetId,
    { ...(options.details ?? {}), "op-id": result.operationId },
    options.gitPath,
    false,
    paths,
  );
  if (hash) {
    finalizeOperation(projectDir, result.operationId, hash);
  }
  return hash;
}
