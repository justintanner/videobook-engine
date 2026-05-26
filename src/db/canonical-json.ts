/**
 * Deterministic JSON serializer for canonical exports under .videocity/export/.
 *
 * Properties:
 *   - Object keys sorted alphabetically at every nesting level.
 *   - Arrays preserved in insertion order.
 *   - 2-space indent for human diff readability.
 *   - Trailing newline so the file diffs cleanly when content grows.
 */

function sortKeys(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(sortKeys);
  const obj = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(obj).sort()) out[k] = sortKeys(obj[k]);
  return out;
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value), null, 2) + "\n";
}
