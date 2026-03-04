import type { LockData } from "../types.js";

export interface LockOptions {
  timeoutMs: number;
  data?: Record<string, unknown>;
}

export function buildLockData(
  now: number,
  pid: number,
  options: LockOptions,
): LockData {
  const timeoutAt = now + options.timeoutMs / 1000;
  return {
    created_at: now,
    timeout_at: timeoutAt,
    pid,
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
