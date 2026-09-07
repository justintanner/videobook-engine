/** Cross-row tag invariants that a row-level three-way merge cannot enforce. */
import type { DatabaseSync } from "@dolthub/doltlite";

import { canonicalJson, EngineFault } from "./store.js";
import { MANUAL_TAGS_PER_ARTIFACT_MAX, TAG_DISMISSALS_PER_ARTIFACT_MAX } from "./tag-values.js";

interface IdentityRow {
  artifact_id: string;
  facet: string;
  tag_key: string;
}

interface TagMergeState {
  automatic: Map<string, string>;
  manual: Map<string, string>;
  dismissed: Map<string, string>;
}

export function assertTagMergeCompatible(
  db: DatabaseSync,
  oursRef: string,
  theirsRef: string,
  baseRef?: string,
): void {
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE name='artifact_tags' AND type='table'").get()) return;
  const base = baseRef ?? (db.prepare("SELECT dolt_merge_base(?, ?) AS hash")
    .get(oursRef, theirsRef) as { hash?: string } | undefined)?.hash;
  // Native merge reports the missing-ancestor error itself.
  if (!base) return;
  const before = stateAt(db, base);
  const ours = stateAt(db, oursRef);
  const theirs = stateAt(db, theirsRef);
  for (const artifactId of new Set([...ours.automatic.keys(), ...theirs.automatic.keys()])) {
    const b = before.automatic.get(artifactId);
    const o = ours.automatic.get(artifactId);
    const t = theirs.automatic.get(artifactId);
    if (o !== b && t !== b && o !== t) {
      throw new EngineFault({
        code: "MERGE_CONFLICT",
        message: `Automatic tag snapshots for ${artifactId} changed differently on both branches`,
        details: { artifactId, branch: theirsRef, table: "artifact_tag_snapshots" },
      });
    }
  }
  checkCapacity(before.manual, ours.manual, theirs.manual, MANUAL_TAGS_PER_ARTIFACT_MAX, "manual tags");
  checkCapacity(before.dismissed, ours.dismissed, theirs.dismissed, TAG_DISMISSALS_PER_ARTIFACT_MAX, "tag dismissals");
}

function stateAt(db: DatabaseSync, revision: string): TagMergeState {
  const state: TagMergeState = { automatic: new Map(), manual: new Map(), dismissed: new Map() };
  const version = db.prepare("SELECT version FROM dolt_at_engine_schema(?) WHERE singleton=1")
    .get(revision) as { version: number } | undefined;
  if (!version || version.version < 25) return state;
  const bundles = new Map<string, { snapshot?: Record<string, unknown>; tags: Record<string, unknown>[] }>();
  const snapshots = db.prepare(`SELECT * FROM dolt_at_artifact_tag_snapshots(?) ORDER BY artifact_id`)
    .all(revision) as Array<Record<string, unknown> & { artifact_id: string }>;
  for (const snapshot of snapshots) bundles.set(snapshot.artifact_id, { snapshot, tags: [] });
  const tags = db.prepare(`SELECT * FROM dolt_at_artifact_tags(?) ORDER BY artifact_id, facet, tag_key`)
    .all(revision) as Array<Record<string, unknown> & IdentityRow & { origin: string }>;
  for (const tag of tags) {
    if (tag.origin === "manual") {
      state.manual.set(identity(tag), tag.artifact_id);
    } else {
      const bundle = bundles.get(tag.artifact_id) ?? { tags: [] };
      bundle.tags.push(tag);
      bundles.set(tag.artifact_id, bundle);
    }
  }
  for (const [artifactId, bundle] of bundles) state.automatic.set(artifactId, canonicalJson(bundle));
  const dismissals = db.prepare("SELECT artifact_id, facet, tag_key FROM dolt_at_artifact_tag_dismissals(?)")
    .all(revision) as unknown as IdentityRow[];
  for (const row of dismissals) state.dismissed.set(identity(row), row.artifact_id);
  return state;
}

function identity(row: IdentityRow): string {
  return JSON.stringify([row.artifact_id, row.facet, row.tag_key]);
}

/** Merge membership only; conflicting labels/entities remain row conflicts. */
function checkCapacity(
  base: Map<string, string>,
  ours: Map<string, string>,
  theirs: Map<string, string>,
  limit: number,
  label: string,
): void {
  const merged = new Map(ours);
  for (const key of base.keys()) if (!theirs.has(key)) merged.delete(key);
  for (const [key, artifactId] of theirs) if (!base.has(key)) merged.set(key, artifactId);
  const counts = new Map<string, number>();
  for (const artifactId of merged.values()) {
    const count = (counts.get(artifactId) ?? 0) + 1;
    counts.set(artifactId, count);
    if (count > limit) {
      throw new EngineFault({
        code: "MERGE_VIOLATION",
        message: `Merge would exceed ${limit} ${label} on ${artifactId}`,
        details: { artifactId, limit, count },
      });
    }
  }
}
