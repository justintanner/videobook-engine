/**
 * Tag queries: filtering, facet counts and autocomplete over effective
 * tags.
 *
 * "Effective" means exactly what `engine.tags.read` reports: every manual
 * assignment, plus automatic assignments that are neither dismissed nor
 * stale. That rule lives once in SQL here and once in TypeScript in
 * `src/tags.ts`; `tests/tag-queries.test.ts` asserts the two agree.
 *
 * Every query is one indexed statement against the catalog — never a
 * per-artifact round trip and never a JSON scan — and every result set is
 * bounded by a documented limit.
 */

import type {
  Artifact,
  ArtifactKind,
  AssetTag,
  EngineError,
  Result,
  TagFacetCount,
  TagFilter,
  TagQueryOptions,
  TagQueryPage,
  TagSuggestQuery,
  TaggedArtifact,
} from "./engine-types.js";
import { EngineContext, syncResultOf } from "./context.js";
import type { TagFacet } from "./tag-values.js";
import {
  assertTagFacet,
  normalizeTagIdentity,
  normalizeTagPrefix,
  tagIdentity,
} from "./tag-values.js";

export const TAG_QUERY_LIMIT_DEFAULT = 50;
export const TAG_QUERY_LIMIT_MAX = 500;
export const TAG_FACET_LIMIT_DEFAULT = 50;
export const TAG_FACET_LIMIT_MAX = 500;
/** Candidate IDs a single call may hand to a composing search. */
export const TAG_CANDIDATE_MAX = 5000;

type SqlValue = string | number;

/**
 * The effective-tag projection. Manual rows always count; automatic rows
 * count only while no dismissal suppresses their identity and the
 * snapshot's analyzed hash is still one of the artifact's files.
 */
const EFFECTIVE_TAGS_SQL = `
  SELECT t.artifact_id, t.facet, t.tag_key, t.label, t.origin
  FROM artifact_tags t
  WHERE t.origin='manual'
  UNION ALL
  SELECT t.artifact_id, t.facet, t.tag_key, t.label, t.origin
  FROM artifact_tags t
  JOIN artifact_tag_snapshots s ON s.artifact_id = t.artifact_id
  WHERE t.origin='automatic'
    AND NOT EXISTS (
      SELECT 1 FROM artifact_tag_dismissals d
      WHERE d.artifact_id = t.artifact_id
        AND d.facet = t.facet
        AND d.tag_key = t.tag_key
    )
    AND EXISTS (
      SELECT 1 FROM artifact_files f
      WHERE f.artifact_id = s.artifact_id
        AND f.object_hash = s.source_hash
    )
`;

interface ArtifactRow {
  artifact_id: string;
  label: string | null;
  kind: ArtifactKind;
  created_at: number;
}

interface FacetRow {
  facet: TagFacet;
  tag_key: string;
  artifacts: number;
}

interface LabelRow {
  facet: TagFacet;
  tag_key: string;
  origin: "manual" | "automatic";
  label: string;
}

interface EffectiveRow {
  artifact_id: string;
  facet: TagFacet;
  tag_key: string;
  label: string;
  origin: "manual" | "automatic";
  created_at: number;
}

interface Clause {
  sql: string;
  params: SqlValue[];
}

export function createTagQueriesApi(context: EngineContext) {
  return {
    query: (
      filter: TagFilter = {},
      options: TagQueryOptions = {},
    ): Result<TagQueryPage, EngineError> =>
      syncResultOf(() => queryTags(context, filter, options)),
    candidates: (filter: TagFilter = {}): Result<string[], EngineError> =>
      syncResultOf(() => candidateIds(context, filter)),
    facets: (
      filter: TagFilter = {},
      options: { limit?: number } = {},
    ): Result<TagFacetCount[], EngineError> =>
      syncResultOf(() => facetCounts(context, filter, options.limit)),
    suggest: (
      query: TagSuggestQuery = {},
    ): Result<TagFacetCount[], EngineError> =>
      syncResultOf(() => suggestTags(context, query)),
  };
}

// --------------------------------------------------------------- filter

/**
 * Turns a filter into the artifact-selection clause. `all` and `any` each
 * become one grouped lookup through the tag identity index, so a filter
 * costs one statement regardless of how many artifacts it spans.
 */
function filterClause(filter: TagFilter): Clause {
  const parts: string[] = [];
  const params: SqlValue[] = [];
  const kinds = filter.kinds ?? [];
  if (kinds.length > 0) {
    parts.push(`a.kind IN (${kinds.map(() => "?").join(", ")})`);
    params.push(...kinds);
  }
  const all = normalizeIdentities(filter.all);
  if (all.length > 0) {
    const pairs = identityPredicate(all);
    parts.push(
      `a.artifact_id IN (
         SELECT e.artifact_id FROM effective e
         WHERE ${pairs.sql}
         GROUP BY e.artifact_id
         HAVING COUNT(DISTINCT e.facet || ':' || e.tag_key) = ?
       )`,
    );
    params.push(...pairs.params, all.length);
  }
  const any = normalizeIdentities(filter.any);
  if (any.length > 0) {
    const pairs = identityPredicate(any);
    parts.push(
      `a.artifact_id IN (
         SELECT e.artifact_id FROM effective e WHERE ${pairs.sql}
       )`,
    );
    params.push(...pairs.params);
  }
  return {
    sql: parts.length > 0 ? parts.join("\n    AND ") : "1=1",
    params,
  };
}

function normalizeIdentities(
  inputs: TagFilter["all"],
): Array<{ facet: TagFacet; key: string }> {
  if (!inputs || inputs.length === 0) return [];
  const seen = new Set<string>();
  const identities: Array<{ facet: TagFacet; key: string }> = [];
  for (const input of inputs) {
    const { facet, key } = normalizeTagIdentity(input);
    const identity = tagIdentity(facet, key);
    if (seen.has(identity)) continue;
    seen.add(identity);
    identities.push({ facet, key });
  }
  return identities;
}

function identityPredicate(
  identities: ReadonlyArray<{ facet: TagFacet; key: string }>,
): Clause {
  return {
    sql: identities.map(() => "(e.facet = ? AND e.tag_key = ?)").join(" OR "),
    params: identities.flatMap((identity) => [identity.facet, identity.key]),
  };
}

// ---------------------------------------------------------------- pages

function queryTags(
  context: EngineContext,
  filter: TagFilter,
  options: TagQueryOptions,
): TagQueryPage {
  const limit = boundedLimit(
    options.limit,
    TAG_QUERY_LIMIT_DEFAULT,
    TAG_QUERY_LIMIT_MAX,
    "Tag query limit",
  );
  const where = filterClause(filter);
  const cursor = decodeCursor(options.cursor);
  const cursorClause = cursor
    ? " AND (a.created_at > ? OR (a.created_at = ? AND a.artifact_id > ?))"
    : "";
  const cursorParams: SqlValue[] = cursor
    ? [cursor.createdAt, cursor.createdAt, cursor.artifactId]
    : [];
  const rows = context.store.db
    .prepare(
      `WITH effective AS (${EFFECTIVE_TAGS_SQL})
       SELECT a.artifact_id, a.label, a.kind, a.created_at
       FROM artifacts a
       WHERE ${where.sql}${cursorClause}
       ORDER BY a.created_at, a.artifact_id
       LIMIT ?`,
    )
    .all(
      ...where.params,
      ...cursorParams,
      limit + 1,
    ) as unknown as ArtifactRow[];
  const page = rows.slice(0, limit);
  const total = countMatches(context, where);
  const last = page.at(-1);
  const tags = effectiveTagsFor(
    context,
    page.map((row) => row.artifact_id),
  );
  return {
    artifacts: page.map((row): TaggedArtifact => ({
      artifact: artifactOf(context, row),
      tags: tags.get(row.artifact_id) ?? [],
    })),
    total,
    ...(rows.length > limit && last
      ? { nextCursor: encodeCursor(last.created_at, last.artifact_id) }
      : {}),
  };
}

function candidateIds(context: EngineContext, filter: TagFilter): string[] {
  const where = filterClause(filter);
  const rows = context.store.db
    .prepare(
      `WITH effective AS (${EFFECTIVE_TAGS_SQL})
       SELECT a.artifact_id
       FROM artifacts a
       WHERE ${where.sql}
       ORDER BY a.created_at, a.artifact_id
       LIMIT ?`,
    )
    .all(...where.params, TAG_CANDIDATE_MAX) as unknown as Array<{
    artifact_id: string;
  }>;
  return rows.map((row) => row.artifact_id);
}

function countMatches(context: EngineContext, where: Clause): number {
  const row = context.store.db
    .prepare(
      `WITH effective AS (${EFFECTIVE_TAGS_SQL})
       SELECT COUNT(*) AS total FROM artifacts a WHERE ${where.sql}`,
    )
    .get(...where.params) as unknown as { total: number };
  return row.total;
}

function artifactOf(context: EngineContext, row: ArtifactRow): Artifact {
  return context.artifact({
    artifact_id: row.artifact_id,
    label: row.label,
    kind: row.kind,
    created_at: row.created_at,
  });
}

/** Effective tags for one page of artifacts, in one statement. */
function effectiveTagsFor(
  context: EngineContext,
  artifactIds: readonly string[],
): Map<string, AssetTag[]> {
  const tags = new Map<string, AssetTag[]>();
  if (artifactIds.length === 0) return tags;
  const placeholders = artifactIds.map(() => "?").join(", ");
  const rows = context.store.db
    .prepare(
      `WITH effective AS (${EFFECTIVE_TAGS_SQL})
       SELECT e.artifact_id, e.facet, e.tag_key, e.label, e.origin,
              t.created_at
       FROM effective e
       JOIN artifact_tags t
         ON t.artifact_id = e.artifact_id
        AND t.origin = e.origin
        AND t.facet = e.facet
        AND t.tag_key = e.tag_key
       WHERE e.artifact_id IN (${placeholders})
       ORDER BY e.artifact_id, e.facet, e.tag_key, e.origin DESC`,
    )
    .all(...artifactIds) as unknown as EffectiveRow[];
  for (const row of rows) {
    const existing = tags.get(row.artifact_id) ?? [];
    // origin DESC puts 'manual' first, so a manual assignment claims the
    // identity and the automatic duplicate is dropped, exactly as
    // engine.tags.read reports it.
    if (
      existing.some((tag) => tag.facet === row.facet && tag.key === row.tag_key)
    ) {
      continue;
    }
    existing.push({
      facet: row.facet,
      key: row.tag_key,
      label: row.label,
      origin: row.origin,
      createdAt: row.created_at,
    });
    tags.set(row.artifact_id, existing);
  }
  return tags;
}

// --------------------------------------------------------------- facets

function facetCounts(
  context: EngineContext,
  filter: TagFilter,
  requestedLimit: number | undefined,
): TagFacetCount[] {
  const limit = boundedLimit(
    requestedLimit,
    TAG_FACET_LIMIT_DEFAULT,
    TAG_FACET_LIMIT_MAX,
    "Tag facet limit",
  );
  const where = filterClause(filter);
  return countedFacets(context, where, limit, undefined);
}

function suggestTags(
  context: EngineContext,
  query: TagSuggestQuery,
): TagFacetCount[] {
  const limit = boundedLimit(
    query.limit,
    TAG_FACET_LIMIT_DEFAULT,
    TAG_FACET_LIMIT_MAX,
    "Tag suggestion limit",
  );
  const prefix = normalizeTagPrefix(query.prefix ?? "");
  const parts: string[] = [];
  const params: SqlValue[] = [];
  if (query.facet) {
    parts.push("e.facet = ?");
    params.push(assertTagFacet(query.facet));
  }
  if (prefix) {
    parts.push("e.tag_key LIKE ? ESCAPE '\\'");
    params.push(`${escapeLike(prefix)}%`);
  }
  const where = filterClause({
    ...(query.kinds ? { kinds: query.kinds } : {}),
  });
  return countedFacets(context, where, limit, {
    sql: parts.length > 0 ? parts.join(" AND ") : "1=1",
    params,
  });
}

/**
 * Distinct matching artifacts per identity — never assignment rows and
 * never only the current page — with the manual display label preferred.
 */
function countedFacets(
  context: EngineContext,
  where: Clause,
  limit: number,
  identityFilter: Clause | undefined,
): TagFacetCount[] {
  const extra = identityFilter ? ` AND (${identityFilter.sql})` : "";
  const rows = context.store.db
    .prepare(
      `WITH effective AS (${EFFECTIVE_TAGS_SQL})
       SELECT e.facet, e.tag_key, COUNT(DISTINCT e.artifact_id) AS artifacts
       FROM effective e
       JOIN artifacts a ON a.artifact_id = e.artifact_id
       WHERE ${where.sql}${extra}
       GROUP BY e.facet, e.tag_key
       ORDER BY artifacts DESC, e.facet, e.tag_key
       LIMIT ?`,
    )
    .all(
      ...where.params,
      ...(identityFilter?.params ?? []),
      limit,
    ) as unknown as FacetRow[];
  if (rows.length === 0) return [];
  const labels = preferredLabels(context, rows);
  return rows.map((row): TagFacetCount => ({
    facet: row.facet,
    key: row.tag_key,
    label: labels.get(tagIdentity(row.facet, row.tag_key)) ?? row.tag_key,
    artifacts: row.artifacts,
  }));
}

function preferredLabels(
  context: EngineContext,
  rows: readonly FacetRow[],
): Map<string, string> {
  const predicate = rows.map(() => "(facet = ? AND tag_key = ?)").join(" OR ");
  const params = rows.flatMap((row) => [row.facet, row.tag_key]);
  const labelRows = context.store.db
    .prepare(
      `SELECT facet, tag_key, origin, label FROM artifact_tags
       WHERE ${predicate}
       ORDER BY facet, tag_key, origin DESC, label`,
    )
    .all(...params) as unknown as LabelRow[];
  const labels = new Map<string, string>();
  for (const row of labelRows) {
    // origin DESC lists 'manual' first, so the user's spelling wins.
    const identity = tagIdentity(row.facet, row.tag_key);
    if (!labels.has(identity)) labels.set(identity, row.label);
  }
  return labels;
}

// -------------------------------------------------------------- helpers

function boundedLimit(
  requested: number | undefined,
  fallback: number,
  max: number,
  label: string,
): number {
  if (requested === undefined) return fallback;
  if (!Number.isInteger(requested) || requested < 1 || requested > max) {
    throw new Error(`${label} must be an integer between 1 and ${max}`);
  }
  return requested;
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/gu, (character) => `\\${character}`);
}

function encodeCursor(createdAt: number, artifactId: string): string {
  return Buffer.from(`${createdAt}:${artifactId}`, "utf8").toString(
    "base64url",
  );
}

function decodeCursor(
  cursor: string | undefined,
): { createdAt: number; artifactId: string } | undefined {
  if (cursor === undefined) return undefined;
  const decoded = Buffer.from(cursor, "base64url").toString("utf8");
  const separator = decoded.indexOf(":");
  const createdAt = Number(decoded.slice(0, separator));
  const artifactId = decoded.slice(separator + 1);
  if (separator < 0 || !Number.isInteger(createdAt) || !artifactId) {
    throw new Error("Tag query cursor is invalid");
  }
  return { createdAt, artifactId };
}
