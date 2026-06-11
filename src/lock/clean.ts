import type { LockData } from "../types.js";
import { getStateDb } from "../db/client.js";
import { resolveLockKey } from "./key.js";
import { type LockRow, isExpired, rowToLockData } from "./data.js";

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: unknown) {
    const e = error as NodeJS.ErrnoException;
    // EPERM means a process exists but we can't signal it (different uid).
    // Treat as alive so we don't reap a foreign-uid lock holder.
    if (e.code === "EPERM") return true;
    return false;
  }
}

function isStale(data: LockData, now: number): boolean {
  if (isExpired(data, now)) return true;
  if (typeof data.pid === "number" && !isProcessAlive(data.pid)) return true;
  return false;
}

export async function cleanStaleLock(
  projectsDir: string,
  assetDir: string,
): Promise<boolean> {
  const resolved = await resolveLockKey(projectsDir, assetDir);
  if (!resolved.ok) return false;
  const { projectDir, assetKey } = resolved.value;

  const db = getStateDb(projectDir);
  const row = db
    .prepare(
      `SELECT pid, state, created_at, timeout_at, data
       FROM locks WHERE asset_id = ?`,
    )
    .get(assetKey) as LockRow | undefined;
  if (!row) return false;

  const data = rowToLockData(row);
  if (!isStale(data, Date.now() / 1000)) return false;

  // Delete only the exact row we judged stale: an unconditional delete could
  // remove a fresh lock that a racing process inserted between our read and
  // our delete, letting both processes believe they hold the lock.
  const result = db
    .prepare(
      `DELETE FROM locks
       WHERE asset_id = ? AND pid IS ? AND created_at = ? AND timeout_at = ?`,
    )
    .run(assetKey, row.pid, row.created_at, row.timeout_at);
  return result.changes > 0;
}
