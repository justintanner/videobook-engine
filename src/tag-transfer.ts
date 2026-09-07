/**
 * Tag history reads and snapshot transfer.
 *
 * Two jobs the consumer cannot do for itself without touching catalogs
 * directly: reading an artifact's tag state as some revision recorded it,
 * and moving tag state between artifacts — including between separate
 * engines — as validated data rather than raw rows.
 *
 * Transfer never trusts the source's keys or references. Labels are
 * re-normalized into destination-local identities, an entity reference
 * survives only if that entity exists in the destination, and automatic
 * evidence crosses only when the destination artifact actually carries the
 * bytes that were analyzed. A modified or generated derivative therefore
 * cannot inherit automatic tags describing content it does not have.
 */

import type {
  ArtifactTagState,
  AssetTag,
  AssetTagSnapshotExport,
  AutomaticTagSnapshot,
  DismissedTag,
  EngineError,
  Result,
  TagImportResult,
} from "./engine-types.js";
import { ok } from "./engine-types.js";
import { EngineContext, resultOf, syncResultOf } from "./context.js";
import { EngineFault } from "./store.js";
import {
  automaticTagsMatch,
  snapshotMatches,
  storedSnapshot,
} from "./tag-rows.js";
import type { NormalizedTag, TagFacet } from "./tag-values.js";
import {
  MANUAL_TAGS_PER_ARTIFACT_MAX,
  TAG_DISMISSALS_PER_ARTIFACT_MAX,
  normalizeTagIdentity,
  normalizeTagList,
  tagIdentity,
} from "./tag-values.js";

/** Schema version that introduced the tag tables. */
const TAG_SCHEMA_VERSION = 25;

export const TAG_SNAPSHOT_VERSION = 1;

interface RevisionTagRow {
  origin: "manual" | "automatic";
  facet: TagFacet;
  tag_key: string;
  label: string;
  entity_id: string | null;
  created_at: number;
}

interface RevisionDismissalRow {
  facet: TagFacet;
  tag_key: string;
  label: string;
  dismissed_at: number;
}

interface RevisionSnapshotRow {
  artifact_id: string;
  source_hash: string;
  generator: string;
  model: string | null;
  extractor_version: string;
  tag_count: number;
  generation: number;
  analyzed_at: number;
}

type ReadTagState = (artifactId: string) => ArtifactTagState;

export function createTagTransferApi(
  context: EngineContext,
  tagState: ReadTagState,
) {
  return {
    readAtRevision: (
      artifactId: string,
      revision: string,
    ): Result<ArtifactTagState, EngineError> =>
      syncResultOf(() => readAtRevision(context, artifactId, revision)),
    export: (artifactId: string): Result<AssetTagSnapshotExport, EngineError> =>
      syncResultOf(() => exportTags(context, tagState, artifactId)),
    import: (
      artifactId: string,
      snapshot: AssetTagSnapshotExport,
    ): Promise<Result<TagImportResult, EngineError>> =>
      importTags(context, tagState, artifactId, snapshot),
  };
}

// -------------------------------------------------------------- history

/**
 * Tag state as `revision` recorded it. A revision written before the tag
 * schema existed has no tag state at all, which is an empty snapshot
 * rather than an error.
 */
function readAtRevision(
  context: EngineContext,
  artifactId: string,
  revision: string,
): ArtifactTagState {
  const db = context.store.db;
  const artifact = db
    .prepare(
      "SELECT artifact_id FROM dolt_at_artifacts(?) WHERE artifact_id=? LIMIT 1",
    )
    .get(revision, artifactId) as unknown as
    { artifact_id: string } | undefined;
  if (!artifact) {
    throw new EngineFault({
      code: "NOT_FOUND",
      message: `Artifact not found: ${artifactId} at ${revision}`,
    });
  }
  const schema = db
    .prepare("SELECT version FROM dolt_at_engine_schema(?) WHERE singleton=1")
    .get(revision) as unknown as { version: number } | undefined;
  if ((schema?.version ?? 0) < TAG_SCHEMA_VERSION) {
    return emptyState(artifactId);
  }
  const tags = db
    .prepare(
      `SELECT origin, facet, tag_key, label, entity_id, created_at
       FROM dolt_at_artifact_tags(?)
       WHERE artifact_id=?
       ORDER BY facet, tag_key`,
    )
    .all(revision, artifactId) as unknown as RevisionTagRow[];
  const dismissals = db
    .prepare(
      `SELECT facet, tag_key, label, dismissed_at
       FROM dolt_at_artifact_tag_dismissals(?)
       WHERE artifact_id=?
       ORDER BY facet, tag_key`,
    )
    .all(revision, artifactId) as unknown as RevisionDismissalRow[];
  const snapshot = db
    .prepare(
      `SELECT artifact_id, source_hash, generator, model, extractor_version,
              tag_count, generation, analyzed_at
       FROM dolt_at_artifact_tag_snapshots(?)
       WHERE artifact_id=?`,
    )
    .get(revision, artifactId) as unknown as RevisionSnapshotRow | undefined;
  const hashes = new Set(
    (
      db
        .prepare(
          "SELECT object_hash FROM dolt_at_artifact_files(?) WHERE artifact_id=?",
        )
        .all(revision, artifactId) as unknown as Array<{ object_hash: string }>
    ).map((row) => row.object_hash),
  );
  const stale = snapshot !== undefined && !hashes.has(snapshot.source_hash);
  const dismissed = new Set(
    dismissals.map((row) => tagIdentity(row.facet, row.tag_key)),
  );
  const manual = tags
    .filter((row) => row.origin === "manual")
    .map((row) => historicalTag(row));
  const automatic = tags
    .filter((row) => row.origin === "automatic")
    .map((row) => ({
      ...historicalTag(row),
      dismissed: dismissed.has(tagIdentity(row.facet, row.tag_key)),
      stale,
    }));
  const claimed = new Set(manual.map((tag) => tagIdentity(tag.facet, tag.key)));
  const effective: AssetTag[] = [...manual];
  for (const tag of automatic) {
    if (tag.dismissed || tag.stale) continue;
    const identity = tagIdentity(tag.facet, tag.key);
    if (claimed.has(identity)) continue;
    claimed.add(identity);
    effective.push({
      facet: tag.facet,
      key: tag.key,
      label: tag.label,
      origin: tag.origin,
      ...(tag.entityId ? { entityId: tag.entityId } : {}),
      createdAt: tag.createdAt,
    });
  }
  return {
    artifactId,
    effective,
    manual,
    automatic,
    dismissed: dismissals.map((row): DismissedTag => ({
      facet: row.facet,
      key: row.tag_key,
      label: row.label,
      dismissedAt: row.dismissed_at,
    })),
    ...(snapshot
      ? {
          snapshot: {
            artifactId,
            sourceHash: snapshot.source_hash,
            generator: snapshot.generator,
            ...(snapshot.model === null ? {} : { model: snapshot.model }),
            extractorVersion: snapshot.extractor_version,
            tagCount: snapshot.tag_count,
            generation: snapshot.generation,
            analyzedAt: snapshot.analyzed_at,
            stale,
          } satisfies AutomaticTagSnapshot,
        }
      : {}),
  };
}

function historicalTag(row: RevisionTagRow): AssetTag {
  return {
    facet: row.facet,
    key: row.tag_key,
    label: row.label,
    origin: row.origin,
    ...(row.entity_id ? { entityId: row.entity_id } : {}),
    createdAt: row.created_at,
  };
}

function emptyState(artifactId: string): ArtifactTagState {
  return {
    artifactId,
    effective: [],
    manual: [],
    automatic: [],
    dismissed: [],
  };
}

// ------------------------------------------------------------- transfer

/**
 * A portable copy of an artifact's tag state. Automatic evidence is
 * included only while it is still valid for the source, so a stale
 * snapshot is never handed on.
 */
function exportTags(
  context: EngineContext,
  tagState: ReadTagState,
  artifactReference: string,
): AssetTagSnapshotExport {
  const artifact = context.artifactRow(artifactReference);
  const state = tagState(artifact.artifact_id);
  const automatic = state.snapshot;
  return {
    version: TAG_SNAPSHOT_VERSION,
    artifactId: artifact.artifact_id,
    manual: state.manual.map((tag) => ({
      facet: tag.facet,
      label: tag.label,
      ...(tag.entityId ? { entityId: tag.entityId } : {}),
    })),
    dismissed: state.dismissed.map((tag) => ({
      facet: tag.facet,
      label: tag.label,
    })),
    ...(automatic && !automatic.stale
      ? {
          automatic: {
            sourceHash: automatic.sourceHash,
            generator: automatic.generator,
            ...(automatic.model ? { model: automatic.model } : {}),
            extractorVersion: automatic.extractorVersion,
            analyzedAt: automatic.analyzedAt,
            tags: state.automatic.map((tag) => ({
              facet: tag.facet,
              label: tag.label,
              ...(tag.entityId ? { entityId: tag.entityId } : {}),
            })),
          },
        }
      : {}),
  };
}

async function importTags(
  context: EngineContext,
  tagState: ReadTagState,
  artifactReference: string,
  snapshot: AssetTagSnapshotExport,
): Promise<Result<TagImportResult, EngineError>> {
  return resultOf(async () => {
    const artifact = context.artifactRow(artifactReference);
    const artifactId = artifact.artifact_id;
    if (snapshot?.version !== TAG_SNAPSHOT_VERSION) {
      throw new Error(
        `Tag snapshot version must be ${TAG_SNAPSHOT_VERSION}; received ${snapshot?.version ?? "none"}`,
      );
    }
    const manual = localTags(context, normalizeTagList(snapshot.manual ?? []));
    const dismissed = (snapshot.dismissed ?? []).map((entry) =>
      normalizeTagIdentity(entry),
    );
    const candidate = importableAutomatic(context, artifactId, snapshot);
    // Importing the same evidence a second time is not a new analysis.
    const current = storedSnapshot(context.store.db, artifactId);
    const automatic =
      candidate &&
      snapshotMatches(current, candidate) &&
      automaticTagsMatch(context.store.db, artifactId, candidate.tags)
        ? undefined
        : candidate;
    const existingManual = identitySet(
      context,
      artifactId,
      "SELECT facet, tag_key FROM artifact_tags WHERE artifact_id=? AND origin='manual'",
    );
    const existingDismissed = identitySet(
      context,
      artifactId,
      "SELECT facet, tag_key FROM artifact_tag_dismissals WHERE artifact_id=?",
    );
    const newManual = manual.filter(
      (tag) => !existingManual.has(tagIdentity(tag.facet, tag.key)),
    );
    const newDismissed = dismissed.filter(
      (tag) => !existingDismissed.has(tagIdentity(tag.facet, tag.key)),
    );
    assertCapacity(
      existingManual.size + newManual.length,
      MANUAL_TAGS_PER_ARTIFACT_MAX,
      `manual tags on ${artifactId}`,
    );
    assertCapacity(
      existingDismissed.size + newDismissed.length,
      TAG_DISMISSALS_PER_ARTIFACT_MAX,
      `dismissals on ${artifactId}`,
    );
    const result: Omit<TagImportResult, "state"> = {
      importedManual: newManual.length,
      importedDismissals: newDismissed.length,
      importedAutomatic: automatic ? automatic.tags.length : 0,
      skippedAutomatic:
        snapshot.automatic !== undefined && automatic === undefined,
    };
    if (
      newManual.length === 0 &&
      newDismissed.length === 0 &&
      automatic === undefined
    ) {
      return ok({ ...result, state: tagState(artifactId) });
    }
    const generation = current?.generation ?? 0;
    const mutation = await context.store.semantic(
      {
        operation: "import_artifact_tags",
        tables: [
          "artifact_tags",
          "artifact_tag_dismissals",
          "artifact_tag_snapshots",
        ],
        artifactId,
        details: {
          artifactId,
          sourceArtifactId: snapshot.artifactId,
          manual: newManual.length,
          dismissed: newDismissed.length,
          automatic: automatic?.tags.length ?? 0,
        },
        writeSet: [`artifact-tags-import:${artifactId}`],
      },
      (_operationId, now) => {
        const insertTag = context.store.db.prepare(
          `INSERT INTO artifact_tags(
             artifact_id, origin, facet, tag_key, label, entity_id, created_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(artifact_id, origin, facet, tag_key) DO UPDATE SET
             label=excluded.label,
             entity_id=excluded.entity_id`,
        );
        for (const tag of newManual) {
          insertTag.run(
            artifactId,
            "manual",
            tag.facet,
            tag.key,
            tag.label,
            tag.entityId ?? null,
            now,
          );
        }
        const insertDismissal = context.store.db.prepare(
          `INSERT INTO artifact_tag_dismissals(
             artifact_id, facet, tag_key, label, dismissed_at
           ) VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(artifact_id, facet, tag_key) DO NOTHING`,
        );
        for (const tag of newDismissed) {
          insertDismissal.run(artifactId, tag.facet, tag.key, tag.label, now);
        }
        if (!automatic) return;
        context.store.db
          .prepare(
            "DELETE FROM artifact_tags WHERE artifact_id=? AND origin='automatic'",
          )
          .run(artifactId);
        for (const tag of automatic.tags) {
          insertTag.run(
            artifactId,
            "automatic",
            tag.facet,
            tag.key,
            tag.label,
            tag.entityId ?? null,
            now,
          );
        }
        context.store.db
          .prepare(
            `INSERT INTO artifact_tag_snapshots(
               artifact_id, source_hash, generator, model, extractor_version,
               tag_count, generation, analyzed_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(artifact_id) DO UPDATE SET
               source_hash=excluded.source_hash,
               generator=excluded.generator,
               model=excluded.model,
               extractor_version=excluded.extractor_version,
               tag_count=excluded.tag_count,
               generation=excluded.generation,
               analyzed_at=excluded.analyzed_at`,
          )
          .run(
            artifactId,
            automatic.sourceHash,
            automatic.generator,
            automatic.model ?? null,
            automatic.extractorVersion,
            automatic.tags.length,
            generation + 1,
            automatic.analyzedAt,
          );
      },
    );
    return ok({ ...result, state: tagState(artifactId) }, mutation.revision);
  });
}

interface ImportableAutomatic {
  sourceHash: string;
  generator: string;
  model?: string;
  extractorVersion: string;
  analyzedAt: number;
  tags: NormalizedTag[];
}

/**
 * Automatic evidence transfers only to an artifact that carries the exact
 * bytes it describes, which is what makes a hash-identical duplicate a
 * legitimate destination and a derivative an illegitimate one.
 */
function importableAutomatic(
  context: EngineContext,
  artifactId: string,
  snapshot: AssetTagSnapshotExport,
): ImportableAutomatic | undefined {
  const automatic = snapshot.automatic;
  if (!automatic) return undefined;
  const present = context.store.db
    .prepare(
      "SELECT 1 AS present FROM artifact_files WHERE artifact_id=? AND object_hash=?",
    )
    .get(artifactId, automatic.sourceHash);
  if (!present) return undefined;
  return {
    sourceHash: automatic.sourceHash,
    generator: automatic.generator,
    ...(automatic.model ? { model: automatic.model } : {}),
    extractorVersion: automatic.extractorVersion,
    analyzedAt: automatic.analyzedAt,
    tags: localTags(context, normalizeTagList(automatic.tags ?? [])),
  };
}

/**
 * Re-points imported tags at destination-local identities: the label is
 * re-normalized here, and a source entity reference survives only when the
 * destination knows that entity.
 */
function localTags(
  context: EngineContext,
  tags: readonly NormalizedTag[],
): NormalizedTag[] {
  const resolve = context.store.db.prepare(
    "SELECT 1 AS present FROM entities WHERE entity_id=?",
  );
  return tags.map((tag) => {
    if (!tag.entityId || resolve.get(tag.entityId)) return tag;
    const { entityId: _dropped, ...local } = tag;
    return local;
  });
}

function identitySet(
  context: EngineContext,
  artifactId: string,
  sql: string,
): Set<string> {
  const rows = context.store.db
    .prepare(sql)
    .all(artifactId) as unknown as Array<{ facet: TagFacet; tag_key: string }>;
  return new Set(rows.map((row) => tagIdentity(row.facet, row.tag_key)));
}

function assertCapacity(total: number, limit: number, what: string): void {
  if (total <= limit) return;
  throw new EngineFault({
    code: "RESOURCE_EXHAUSTED",
    message: `Importing would leave ${total} ${what}; the limit is ${limit}`,
    details: { requested: total, limit },
  });
}
