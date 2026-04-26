import type { LockData } from "../types.js";

export interface LockOptions {
  durationMs: number;
  data?: Record<string, unknown>;
  state?: string;
}

export function buildLockData(
  now: number,
  pid: number,
  options: LockOptions,
): LockData {
  const timeoutAt = now + options.durationMs / 1000;
  return {
    created_at: now,
    timeout_at: timeoutAt,
    pid,
    ...(options.state !== undefined ? { state: options.state } : {}),
    ...options.data,
  };
}

export function parseLockContent(content: string): LockData | null {
  const trimmed = content.trim();
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      !Array.isArray(parsed)
    ) {
      return parsed as LockData;
    }
    if (typeof parsed === "number") {
      return { created_at: parsed, timeout_at: 0 };
    }
    return null;
  } catch {
    const ts = parseFloat(trimmed);
    if (!isNaN(ts)) {
      return { created_at: ts, timeout_at: 0 };
    }
    return null;
  }
}

export function isExpired(
  lock: LockData,
  now: number = Date.now() / 1000,
): boolean {
  return now >= lock.timeout_at;
}

export interface LockRow {
  pid: number;
  state: string | null;
  created_at: number;
  timeout_at: number;
  data: string | null;
}

export function rowToLockData(row: LockRow): LockData {
  const base: LockData = {
    created_at: row.created_at,
    timeout_at: row.timeout_at,
    pid: row.pid,
  };
  if (row.state) base.state = row.state;
  if (row.data) {
    try {
      const extra = JSON.parse(row.data) as Record<string, unknown>;
      Object.assign(base, extra);
    } catch {
      // tolerate corrupt JSON; keep base fields
    }
  }
  return base;
}
