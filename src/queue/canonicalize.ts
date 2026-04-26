/**
 * Canonical JSON serialization for queue dedupe keys.
 *
 * Strips volatile fields that would otherwise prevent legitimate dedupe
 * matches between sentinel-queued submissions and their re-submissions.
 */

const VOLATILE_KEYS = new Set([
  "enqueuedAt",
  "submittedAt",
  "createdAt",
  "timestamp",
  "attempt",
  "lastError",
  "requestId",
  "traceId",
  "jobId",
]);

function stripVolatile(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(stripVolatile);
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (VOLATILE_KEYS.has(k)) continue;
    out[k] = stripVolatile(v);
  }
  return out;
}

function sortKeys(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(sortKeys);
  const obj = value as Record<string, unknown>;
  const sorted: Record<string, unknown> = {};
  for (const k of Object.keys(obj).sort()) {
    sorted[k] = sortKeys(obj[k]);
  }
  return sorted;
}

export function canonicalize(value: unknown): string {
  return JSON.stringify(sortKeys(stripVolatile(value)));
}

export function dedupeKey(
  assetId: string | null,
  type: string,
  payload: unknown,
): string {
  const obj = { asset_id: assetId, type, payload };
  return canonicalize(obj);
}
