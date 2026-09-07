/**
 * Row-level tag comparisons shared by the write and transfer paths, so
 * "this write would change nothing" means the same thing in both.
 */

import type { DatabaseSync } from "@dolthub/doltlite";

import { tagIdentity, type NormalizedTag, type TagFacet } from "./tag-values.js";

/** Match SQLite's BINARY ordering, including astral Unicode code points. */
export function compareTags(
  left: { facet: TagFacet; key: string },
  right: { facet: TagFacet; key: string },
): number {
  if (left.facet !== right.facet) return left.facet < right.facet ? -1 : 1;
  return Buffer.compare(Buffer.from(left.key), Buffer.from(right.key));
}

interface StoredTagRow {
  facet: TagFacet;
  tag_key: string;
  label: string;
  entity_id: string | null;
}

interface StoredSnapshotRow {
  artifact_id: string;
  source_hash: string;
  generator: string;
  model: string | null;
  extractor_version: string;
  tag_count: number;
  generation: number;
  analyzed_at: number;
}

export function storedSnapshot(
  db: DatabaseSync,
  artifactId: string,
): StoredSnapshotRow | undefined {
  return db
    .prepare(
      `SELECT artifact_id, source_hash, generator, model, extractor_version,
              tag_count, generation, analyzed_at
       FROM artifact_tag_snapshots
       WHERE artifact_id=?`,
    )
    .get(artifactId) as unknown as StoredSnapshotRow | undefined;
}

/** Whether the stored automatic set is exactly `tags`, labels included. */
export function automaticTagsMatch(
  db: DatabaseSync,
  artifactId: string,
  tags: readonly NormalizedTag[],
): boolean {
  const rows = db
    .prepare(
      `SELECT facet, tag_key, label, entity_id
       FROM artifact_tags
       WHERE artifact_id=? AND origin='automatic'
       ORDER BY facet, tag_key`,
    )
    .all(artifactId) as unknown as StoredTagRow[];
  if (rows.length !== tags.length) return false;
  const byIdentity = new Map(rows.map((row) => [tagIdentity(row.facet, row.tag_key), row]));
  return tags.every((tag) => {
    const row = byIdentity.get(tagIdentity(tag.facet, tag.key));
    return (
      row !== undefined &&
      row.facet === tag.facet &&
      row.tag_key === tag.key &&
      row.label === tag.label &&
      (row.entity_id ?? undefined) === tag.entityId
    );
  });
}

/** Whether a stored snapshot already records exactly this analysis run. */
export function snapshotMatches(
  current: StoredSnapshotRow | undefined,
  analysis: {
    sourceHash: string;
    generator: string;
    model?: string;
    extractorVersion: string;
  },
): boolean {
  return (
    current !== undefined &&
    current.source_hash === analysis.sourceHash &&
    current.generator === analysis.generator &&
    (current.model ?? undefined) === (analysis.model || undefined) &&
    current.extractor_version === analysis.extractorVersion
  );
}
