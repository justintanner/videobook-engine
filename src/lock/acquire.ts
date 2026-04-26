import { type LockData, type FsError, type Result, ok, err } from "../types.js";
import { getStateDb } from "../db/client.js";
import { resolveLockKey } from "./key.js";
import {
  type LockOptions,
  type LockRow,
  buildLockData,
  rowToLockData,
  isExpired,
} from "./data.js";

const RESERVED_KEYS = new Set([
  "created_at",
  "timeout_at",
  "pid",
  "state",
]);

function lockExtras(lock: LockData): Record<string, unknown> | null {
  const extras: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(lock)) {
    if (RESERVED_KEYS.has(k)) continue;
    extras[k] = v;
  }
  return Object.keys(extras).length > 0 ? extras : null;
}

function tryInsert(
  projectDir: string,
  assetKey: string,
  lock: LockData,
): Result<LockData, FsError> {
  const db = getStateDb(projectDir);
  const extras = lockExtras(lock);
  const dataJson = extras ? JSON.stringify(extras) : null;
  const stateValue = typeof lock.state === "string" ? lock.state : null;

  try {
    db.prepare(
      `INSERT INTO locks (asset_id, pid, state, created_at, timeout_at, data)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(
      assetKey,
      lock.pid ?? process.pid,
      stateValue,
      lock.created_at,
      lock.timeout_at,
      dataJson,
    );
    return ok(lock);
  } catch (error: unknown) {
    const e = error as { code?: string; message?: string };
    if (
      e.code === "SQLITE_CONSTRAINT_PRIMARYKEY" ||
      e.code === "SQLITE_CONSTRAINT_UNIQUE"
    ) {
      return err({ code: "LOCKED", message: "Lock already held" });
    }
    return err({
      code: "IO_ERROR",
      message: e.message ?? "Failed to acquire lock",
    });
  }
}

function readRow(projectDir: string, assetKey: string): LockRow | undefined {
  const db = getStateDb(projectDir);
  return db
    .prepare(
      `SELECT pid, state, created_at, timeout_at, data
       FROM locks WHERE asset_id = ?`,
    )
    .get(assetKey) as LockRow | undefined;
}

function deleteRow(projectDir: string, assetKey: string): void {
  const db = getStateDb(projectDir);
  db.prepare("DELETE FROM locks WHERE asset_id = ?").run(assetKey);
}

export async function acquireLock(
  projectsDir: string,
  assetDir: string,
  options: LockOptions,
): Promise<Result<LockData, FsError>> {
  const resolved = await resolveLockKey(projectsDir, assetDir);
  if (!resolved.ok) return resolved;
  const { projectDir, assetKey } = resolved.value;

  const now = Date.now() / 1000;
  const lock = buildLockData(now, process.pid, options);

  const first = tryInsert(projectDir, assetKey, lock);
  if (first.ok) return first;
  if (first.error.code !== "LOCKED") return first;

  const existing = readRow(projectDir, assetKey);
  if (!existing) {
    return tryInsert(projectDir, assetKey, lock);
  }
  const existingData = rowToLockData(existing);
  if (isExpired(existingData)) {
    deleteRow(projectDir, assetKey);
    return tryInsert(projectDir, assetKey, lock);
  }
  return first;
}
