import type { LockData } from "../types.js";
import { getStateDb } from "../db/client.js";
import { resolveLockKey } from "./key.js";
import { type LockRow, isExpired, rowToLockData } from "./data.js";

function readRow(projectDir: string, assetKey: string): LockRow | undefined {
  const db = getStateDb(projectDir);
  return db
    .prepare(
      `SELECT pid, state, created_at, timeout_at, data
       FROM locks WHERE asset_id = ?`,
    )
    .get(assetKey) as LockRow | undefined;
}

export async function getLockData(
  projectsDir: string,
  assetDir: string,
): Promise<LockData | null> {
  const resolved = await resolveLockKey(projectsDir, assetDir);
  if (!resolved.ok) return null;
  const { projectDir, assetKey } = resolved.value;
  const row = readRow(projectDir, assetKey);
  if (!row) return null;
  return rowToLockData(row);
}

export async function isLocked(
  projectsDir: string,
  assetDir: string,
): Promise<boolean> {
  const data = await getLockData(projectsDir, assetDir);
  if (!data) return false;
  return !isExpired(data);
}
