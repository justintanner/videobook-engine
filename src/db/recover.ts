import * as fs from "node:fs/promises";
import * as path from "node:path";

import type { Database as DatabaseType } from "better-sqlite3";

import { commitOperation } from "../git/commit.js";
import { gitExecSafe } from "../git/exec.js";
import { withGitLock } from "../git/mutex.js";
import { exportAssetMetadata, readAssetMetadata } from "./asset-metadata.js";
import { exportAssetEvents } from "./asset-events.js";
import {
  audioWaveformExportPath,
  exportAudioWaveform,
  listAudioWaveformAssetIds,
} from "./audio-waveforms.js";
import { VIDEOCITY_DIR, getStateDb } from "./client.js";
import { getMetadataDb } from "./metadata-client.js";
import { exportTimeline, readTimeline } from "./timeline.js";

interface RecoveryResult {
  inspected: number;
  aborted: number;
  completed: number;
  failed: number;
}

interface JournalRow {
  operation_id: string;
  intent: string;
  target: string | null;
  scope: "project" | "asset" | "file" | "schema";
  status: "pending" | "sqlite_done" | "git_done";
}

interface EventDetailRow {
  detail: string | null;
}

function incompleteRows(stateDb: DatabaseType): JournalRow[] {
  return stateDb
    .prepare(
      `SELECT operation_id, intent, target, scope, status
       FROM recovery_journal
       WHERE status IN ('pending','sqlite_done','git_done')
       ORDER BY started_at`,
    )
    .all() as JournalRow[];
}

async function findGitHash(
  projectDir: string,
  operationId: string,
): Promise<string | null> {
  const result = await gitExecSafe(
    [
      "log",
      "--format=%H",
      "--fixed-strings",
      "--grep",
      `op-id: ${operationId}`,
      "-1",
    ],
    { cwd: projectDir },
  );
  if (result.exitCode !== 0) return null;
  const hash = result.stdout.trim().split("\n")[0];
  return hash || null;
}

function markComplete(
  stateDb: DatabaseType,
  operationId: string,
  gitHash: string | null,
): void {
  stateDb
    .prepare(
      `UPDATE recovery_journal
       SET status = 'complete', git_hash = ?, updated_at = ?, error = NULL
       WHERE operation_id = ?`,
    )
    .run(gitHash, Date.now(), operationId);
}

function markAborted(
  stateDb: DatabaseType,
  operationId: string,
  message: string,
): void {
  stateDb
    .prepare(
      `UPDATE recovery_journal
       SET status = 'aborted', updated_at = ?, error = ?
       WHERE operation_id = ?`,
    )
    .run(Date.now(), JSON.stringify({ message }), operationId);
}

function markFailed(
  stateDb: DatabaseType,
  operationId: string,
  message: string,
): void {
  stateDb
    .prepare(
      `UPDATE recovery_journal
       SET updated_at = ?, error = ?
       WHERE operation_id = ?`,
    )
    .run(Date.now(), JSON.stringify({ message }), operationId);
}

function promoteSqliteDone(stateDb: DatabaseType, operationId: string): void {
  stateDb
    .prepare(
      `UPDATE recovery_journal
       SET status = 'sqlite_done', updated_at = ?, error = NULL
       WHERE operation_id = ?`,
    )
    .run(Date.now(), operationId);
}

function operationCommitted(
  metadataDb: DatabaseType,
  operationId: string,
): boolean {
  const row = metadataDb
    .prepare("SELECT 1 FROM operations WHERE operation_id = ?")
    .get(operationId);
  return Boolean(row);
}

async function rebuildKnownExports(projectDir: string): Promise<string[]> {
  const db = getMetadataDb(projectDir);
  const exportRoot = path.join(projectDir, VIDEOCITY_DIR, "export");
  const exports: Array<{ rel: string; body: string }> = [
    { rel: "asset_events.json", body: exportAssetEvents(db) },
    { rel: "asset_metadata.json", body: exportAssetMetadata(db) },
    { rel: "timeline.json", body: exportTimeline(db) },
  ];
  for (const assetId of listAudioWaveformAssetIds(db)) {
    exports.push({
      rel: audioWaveformExportPath(assetId),
      body: exportAudioWaveform(db, assetId),
    });
  }
  const written: string[] = [];
  await fs.mkdir(exportRoot, { recursive: true });
  for (const e of exports) {
    const full = path.join(exportRoot, e.rel);
    await fs.mkdir(path.dirname(full), { recursive: true });
    await fs.writeFile(full, e.body);
    written.push(path.join(VIDEOCITY_DIR, "export", e.rel));
  }
  return written;
}

function operationDetail(
  metadataDb: DatabaseType,
  operationId: string,
): Record<string, unknown> {
  const row = metadataDb
    .prepare(
      `SELECT detail FROM asset_events
       WHERE operation_id = ? AND detail IS NOT NULL
       ORDER BY id
       LIMIT 1`,
    )
    .get(operationId) as EventDetailRow | undefined;
  if (!row?.detail) return {};
  try {
    const parsed = JSON.parse(row.detail) as unknown;
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      !Array.isArray(parsed)
    ) {
      return parsed as Record<string, unknown>;
    }
  } catch {}
  return {};
}

async function writeJsonSidecar(
  projectDir: string,
  relativePath: string,
  value: unknown,
): Promise<string | null> {
  const fullPath = path.join(projectDir, relativePath);
  try {
    await fs.mkdir(path.dirname(fullPath), { recursive: true });
    await fs.writeFile(fullPath, JSON.stringify(value, null, 2));
    return relativePath;
  } catch {
    return null;
  }
}

async function rebuildSidecarsForOperation(
  projectDir: string,
  metadataDb: DatabaseType,
  row: JournalRow,
): Promise<string[]> {
  const written: string[] = [];
  if (row.intent === "write_asset_metadata" && row.target) {
    const detail = operationDetail(metadataDb, row.operation_id);
    const key = detail.key;
    if (typeof key === "string") {
      const value = readAssetMetadata(metadataDb, row.target, key);
      if (value !== null) {
        const rel = await writeJsonSidecar(
          projectDir,
          path.join(row.target, `.${key}.json`),
          value,
        );
        if (rel) written.push(rel);
      }
    }
  }
  if (row.intent === "write_project_meta" && row.target === "timeline") {
    const timeline = readTimeline(metadataDb);
    if (timeline) {
      const rel = await writeJsonSidecar(
        projectDir,
        ".timeline.json",
        timeline,
      );
      if (rel) written.push(rel);
    }
  }
  return written;
}

async function recoverSqliteDone(
  projectDir: string,
  stateDb: DatabaseType,
  row: JournalRow,
): Promise<"completed" | "failed"> {
  const exportPaths = await rebuildKnownExports(projectDir);
  const sidecarPaths = await rebuildSidecarsForOperation(
    projectDir,
    getMetadataDb(projectDir),
    row,
  );
  const commit = await commitOperation(
    projectDir,
    "recover",
    row.scope === "asset" ? (row.target ?? undefined) : undefined,
    {
      intent: row.intent,
      ...(row.target ? { target: row.target } : {}),
      "op-id": row.operation_id,
    },
    undefined,
    false,
    [
      path.join(VIDEOCITY_DIR, "metadata.sqlite"),
      ...exportPaths,
      ...sidecarPaths,
    ],
  );
  if (commit.status === "failed") {
    markFailed(stateDb, row.operation_id, "recovery commit failed");
    return "failed";
  }
  // `clean` means the rebuilt state already matches HEAD (e.g. crash landed
  // after the original commit but before journal finalize) — that IS recovered.
  markComplete(
    stateDb,
    row.operation_id,
    commit.status === "committed" ? commit.hash : null,
  );
  return "completed";
}

async function recoverOnStartupLocked(
  projectDir: string,
): Promise<RecoveryResult> {
  const stateDb = getStateDb(projectDir);
  if (!stateDb.open) {
    return { inspected: 0, aborted: 0, completed: 0, failed: 0 };
  }
  const rows = incompleteRows(stateDb);
  const result: RecoveryResult = {
    inspected: rows.length,
    aborted: 0,
    completed: 0,
    failed: 0,
  };
  if (rows.length === 0) return result;

  const metadataDb = getMetadataDb(projectDir);
  for (const row of rows) {
    const existingHash = await findGitHash(projectDir, row.operation_id);
    if (existingHash) {
      markComplete(stateDb, row.operation_id, existingHash);
      result.completed++;
      continue;
    }

    let status = row.status;
    if (status === "pending") {
      if (!operationCommitted(metadataDb, row.operation_id)) {
        markAborted(
          stateDb,
          row.operation_id,
          "operation did not commit to SQLite",
        );
        result.aborted++;
        continue;
      }
      promoteSqliteDone(stateDb, row.operation_id);
      status = "sqlite_done";
    }

    if (status === "sqlite_done") {
      if (!operationCommitted(metadataDb, row.operation_id)) {
        markAborted(
          stateDb,
          row.operation_id,
          "sqlite_done missing operations row",
        );
        result.aborted++;
        continue;
      }
      const recovered = await recoverSqliteDone(projectDir, stateDb, row);
      if (recovered === "completed") result.completed++;
      else result.failed++;
      continue;
    }

    markFailed(
      stateDb,
      row.operation_id,
      "git_done without matching git commit",
    );
    result.failed++;
  }
  return result;
}

export async function recoverOnStartup(
  projectDir: string,
): Promise<RecoveryResult> {
  return withGitLock(projectDir, () => recoverOnStartupLocked(projectDir));
}
