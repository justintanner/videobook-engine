import { type Job, type JobError, type JobRow } from "./types.js";

function safeParseJson<T>(text: string | null, fallback: T): T {
  if (text == null) return fallback;
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}

function parseError(text: string | null): JobError | null {
  if (text == null) return null;
  try {
    const parsed = JSON.parse(text) as JobError;
    if (typeof parsed === "object" && parsed !== null && typeof parsed.message === "string") {
      return parsed;
    }
    return { message: String(text) };
  } catch {
    return { message: text };
  }
}

export function rowToJob(row: JobRow): Job {
  return {
    id: row.id,
    operationId: row.operation_id,
    type: row.type,
    assetId: row.asset_id,
    externalTaskId: row.external_task_id,
    state: row.state,
    payload: safeParseJson<Record<string, unknown>>(row.payload, {}),
    result: row.result == null ? null : safeParseJson<unknown>(row.result, null),
    attempts: row.attempts,
    maxAttempts: row.max_attempts,
    error: parseError(row.error),
    enqueuedAt: row.enqueued_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
  };
}
