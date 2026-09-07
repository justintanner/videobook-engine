/**
 * Asset tags: durable automatic and user-managed tagging.
 *
 * The engine owns state, normalization, transactions and provenance; the
 * consumer owns inference, scheduling and vocabulary. Three rules shape
 * everything here:
 *
 * 1. Semantic identity is (facet, canonical key). Two facets carrying the
 *    same word stay distinct assignments.
 * 2. Manual intent outranks analysis. An automatic snapshot replaces only
 *    the automatic rows; it can never add, drop or relabel a manual row,
 *    and it can never clear a dismissal.
 * 3. Automatic output is fenced to the content it described. A snapshot
 *    records the analyzed source hash and a per-artifact generation, so a
 *    late result cannot overwrite a newer one and tags for replaced
 *    content drop out of the effective set instead of lying.
 */

import type {
  ArtifactTagState,
  AssetTag,
  AutomaticAssetTag,
  AutomaticTagSnapshot,
  DismissedTag,
  EngineError,
  ReplaceAutomaticTagsArgs,
  Result,
} from "./engine-types.js";
import { ok } from "./engine-types.js";
import { EngineContext, resultOf, syncResultOf } from "./context.js";
import { EngineFault } from "./store.js";
import { createTagQueriesApi } from "./tag-queries.js";
import { automaticTagsMatch, compareTags, snapshotMatches } from "./tag-rows.js";
import { createTagTransferApi } from "./tag-transfer.js";
import { normalizeAutomaticTags } from "./tag-validation.js";
import type {
  NormalizedTag,
  TagIdentityInput,
  TagInput,
} from "./tag-values.js";
import {
  MANUAL_TAGS_PER_ARTIFACT_MAX,
  TAG_DISMISSALS_PER_ARTIFACT_MAX,
  normalizeTagIdentity,
  normalizeTagList,
  tagIdentity,
} from "./tag-values.js";

/** Artifacts a single batched read may cover. */
export const TAG_READ_BATCH_MAX = 500;

const READ_CHUNK = 200;

interface TagRow {
  artifact_id: string;
  origin: "manual" | "automatic";
  facet: AssetTag["facet"];
  tag_key: string;
  label: string;
  entity_id: string | null;
  created_at: number;
}

interface DismissalRow {
  artifact_id: string;
  facet: AssetTag["facet"];
  tag_key: string;
  label: string;
  dismissed_at: number;
}

interface SnapshotRow {
  artifact_id: string;
  source_hash: string;
  generator: string;
  model: string | null;
  extractor_version: string;
  tag_count: number;
  generation: number;
  analyzed_at: number;
}

export function createTagsApi(context: EngineContext) {
  const queries = createTagQueriesApi(context);
  const transfer = createTagTransferApi(context, (artifactId) =>
    tagState(context, artifactId),
  );
  return {
    ...queries,
    ...transfer,
    read: (artifactId: string): Result<ArtifactTagState, EngineError> =>
      syncResultOf(() => readTagState(context, artifactId)),
    readMany: (
      artifactIds: readonly string[],
    ): Result<ArtifactTagState[], EngineError> =>
      syncResultOf(() => readTagStates(context, artifactIds)),
    add: (
      artifactId: string,
      tag: TagInput,
    ): Promise<Result<ArtifactTagState, EngineError>> =>
      addManualTags(context, artifactId, [tag]),
    addMany: (
      artifactId: string,
      tags: readonly TagInput[],
    ): Promise<Result<ArtifactTagState, EngineError>> =>
      addManualTags(context, artifactId, tags),
    remove: (
      artifactId: string,
      tag: TagIdentityInput,
    ): Promise<Result<ArtifactTagState, EngineError>> =>
      removeTag(context, artifactId, tag),
    restore: (
      artifactId: string,
      tag: TagIdentityInput,
    ): Promise<Result<ArtifactTagState, EngineError>> =>
      restoreTag(context, artifactId, tag),
    automatic: {
      snapshot: (
        artifactId: string,
      ): Result<AutomaticTagSnapshot | undefined, EngineError> =>
        syncResultOf(() => readSnapshot(context, artifactId)),
      replace: (
        input: ReplaceAutomaticTagsArgs,
      ): Promise<Result<ArtifactTagState, EngineError>> =>
        replaceAutomaticTags(context, input),
    },
  };
}

// ---------------------------------------------------------------- reads

function readTagState(
  context: EngineContext,
  artifactReference: string,
): ArtifactTagState {
  const artifact = context.artifactRow(artifactReference);
  return tagState(context, artifact.artifact_id);
}

function readTagStates(
  context: EngineContext,
  artifactReferences: readonly string[],
): ArtifactTagState[] {
  if (artifactReferences.length > TAG_READ_BATCH_MAX) {
    throw new Error(
      `Tag reads must cover at most ${TAG_READ_BATCH_MAX} artifacts; received ${artifactReferences.length}`,
    );
  }
  const artifactIds = artifactReferences.map(
    (reference) => context.artifactRow(reference).artifact_id,
  );
  const tags = chunkedRows<TagRow>(
    context,
    artifactIds,
    (placeholders) =>
      `SELECT artifact_id, origin, facet, tag_key, label, entity_id, created_at
       FROM artifact_tags
       WHERE artifact_id IN (${placeholders})
       ORDER BY artifact_id, facet, tag_key`,
  );
  const dismissals = chunkedRows<DismissalRow>(
    context,
    artifactIds,
    (placeholders) =>
      `SELECT artifact_id, facet, tag_key, label, dismissed_at
       FROM artifact_tag_dismissals
       WHERE artifact_id IN (${placeholders})
       ORDER BY artifact_id, facet, tag_key`,
  );
  const snapshots = chunkedRows<SnapshotRow>(
    context,
    artifactIds,
    (placeholders) =>
      `SELECT artifact_id, source_hash, generator, model, extractor_version,
              tag_count, generation, analyzed_at
       FROM artifact_tag_snapshots
       WHERE artifact_id IN (${placeholders})`,
  );
  const snapshotByArtifact = new Map(
    snapshots.map((row) => [row.artifact_id, row]),
  );
  const liveHashes = artifactFileHashes(context, artifactIds);
  return artifactIds.map((artifactId) =>
    assembleState(
      artifactId,
      tags.filter((row) => row.artifact_id === artifactId),
      dismissals.filter((row) => row.artifact_id === artifactId),
      snapshotByArtifact.get(artifactId),
      liveHashes.get(artifactId) ?? new Set<string>(),
    ),
  );
}

function tagState(
  context: EngineContext,
  artifactId: string,
): ArtifactTagState {
  const tags = context.store.db
    .prepare(
      `SELECT artifact_id, origin, facet, tag_key, label, entity_id, created_at
       FROM artifact_tags
       WHERE artifact_id=?
       ORDER BY facet, tag_key`,
    )
    .all(artifactId) as unknown as TagRow[];
  const dismissals = context.store.db
    .prepare(
      `SELECT artifact_id, facet, tag_key, label, dismissed_at
       FROM artifact_tag_dismissals
       WHERE artifact_id=?
       ORDER BY facet, tag_key`,
    )
    .all(artifactId) as unknown as DismissalRow[];
  const snapshot = snapshotRow(context, artifactId);
  return assembleState(
    artifactId,
    tags,
    dismissals,
    snapshot,
    artifactFileHashes(context, [artifactId]).get(artifactId) ??
      new Set<string>(),
  );
}

/**
 * Effective tags: every manual assignment, plus automatic assignments that
 * are neither dismissed nor stale, deduplicated on identity with the
 * manual display label and ownership preferred.
 */
function assembleState(
  artifactId: string,
  tagRows: readonly TagRow[],
  dismissalRows: readonly DismissalRow[],
  snapshotRow: SnapshotRow | undefined,
  liveHashes: ReadonlySet<string>,
): ArtifactTagState {
  const dismissed = new Set(
    dismissalRows.map((row) => tagIdentity(row.facet, row.tag_key)),
  );
  const stale =
    snapshotRow !== undefined && !liveHashes.has(snapshotRow.source_hash);
  const manual = tagRows
    .filter((row) => row.origin === "manual")
    .map((row) => assetTag(row));
  const automatic = tagRows
    .filter((row) => row.origin === "automatic")
    .map((row): AutomaticAssetTag => ({
      ...assetTag(row),
      dismissed: dismissed.has(tagIdentity(row.facet, row.tag_key)),
      stale,
    }));
  const effective: AssetTag[] = [...manual];
  const claimed = new Set(
    manual.map((tag) => tagIdentity(tag.facet, tag.key)),
  );
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
  effective.sort(compareTags);
  return {
    artifactId,
    effective,
    manual,
    automatic,
    dismissed: dismissalRows.map((row): DismissedTag => ({
      facet: row.facet,
      key: row.tag_key,
      label: row.label,
      dismissedAt: row.dismissed_at,
    })),
    ...(snapshotRow
      ? { snapshot: snapshotFromRow(snapshotRow, stale) }
      : {}),
  };
}

function assetTag(row: TagRow): AssetTag {
  return {
    facet: row.facet,
    key: row.tag_key,
    label: row.label,
    origin: row.origin,
    ...(row.entity_id ? { entityId: row.entity_id } : {}),
    createdAt: row.created_at,
  };
}

function readSnapshot(
  context: EngineContext,
  artifactReference: string,
): AutomaticTagSnapshot | undefined {
  const artifact = context.artifactRow(artifactReference);
  const row = snapshotRow(context, artifact.artifact_id);
  if (!row) return undefined;
  const hashes = artifactFileHashes(context, [artifact.artifact_id]);
  const live = hashes.get(artifact.artifact_id) ?? new Set<string>();
  return snapshotFromRow(row, !live.has(row.source_hash));
}

function snapshotRow(
  context: EngineContext,
  artifactId: string,
): SnapshotRow | undefined {
  return context.store.db
    .prepare(
      `SELECT artifact_id, source_hash, generator, model, extractor_version,
              tag_count, generation, analyzed_at
       FROM artifact_tag_snapshots
       WHERE artifact_id=?`,
    )
    .get(artifactId) as unknown as SnapshotRow | undefined;
}

function snapshotFromRow(
  row: SnapshotRow,
  stale: boolean,
): AutomaticTagSnapshot {
  return {
    artifactId: row.artifact_id,
    sourceHash: row.source_hash,
    generator: row.generator,
    ...(row.model === null ? {} : { model: row.model }),
    extractorVersion: row.extractor_version,
    tagCount: row.tag_count,
    generation: row.generation,
    analyzedAt: row.analyzed_at,
    stale,
  };
}

/**
 * Current content hashes per artifact. An automatic snapshot is stale once
 * the hash it analyzed is no longer one of the artifact's files, which is
 * how replaced originals drop their automatic tags without deleting the
 * provenance that explains them.
 */
function artifactFileHashes(
  context: EngineContext,
  artifactIds: readonly string[],
): Map<string, Set<string>> {
  const rows = chunkedRows<{ artifact_id: string; object_hash: string }>(
    context,
    artifactIds,
    (placeholders) =>
      `SELECT artifact_id, object_hash FROM artifact_files
       WHERE artifact_id IN (${placeholders})`,
  );
  const hashes = new Map<string, Set<string>>();
  for (const row of rows) {
    const existing = hashes.get(row.artifact_id);
    if (existing) existing.add(row.object_hash);
    else hashes.set(row.artifact_id, new Set([row.object_hash]));
  }
  return hashes;
}

function chunkedRows<T>(
  context: EngineContext,
  artifactIds: readonly string[],
  sql: (placeholders: string) => string,
): T[] {
  const rows: T[] = [];
  const uniqueIds = [...new Set(artifactIds)];
  for (let index = 0; index < uniqueIds.length; index += READ_CHUNK) {
    const chunk = uniqueIds.slice(index, index + READ_CHUNK);
    if (chunk.length === 0) continue;
    const placeholders = chunk.map(() => "?").join(", ");
    rows.push(
      ...(context.store.db
        .prepare(sql(placeholders))
        .all(...chunk) as unknown as T[]),
    );
  }
  return rows;
}

// --------------------------------------------------------------- writes

async function addManualTags(
  context: EngineContext,
  artifactReference: string,
  inputs: readonly TagInput[],
): Promise<Result<ArtifactTagState, EngineError>> {
  return resultOf(() => context.store.semanticOperation((commit) => {
    const artifact = context.artifactRow(artifactReference);
    const artifactId = artifact.artifact_id;
    const tags = normalizeTagList(inputs);
    if (tags.length === 0) {
      throw new Error("At least one tag is required");
    }
    for (const tag of tags) requireEntity(context, tag);
    const existing = manualRowsByIdentity(context, artifactId);
    const added = tags.filter(
      (tag) => !existing.has(tagIdentity(tag.facet, tag.key)),
    );
    const total = existing.size + added.length;
    if (total > MANUAL_TAGS_PER_ARTIFACT_MAX) {
      throw new EngineFault({
        code: "RESOURCE_EXHAUSTED",
        message:
          `Artifact ${artifactId} would carry ${total} manual tags; the limit is ` +
          `${MANUAL_TAGS_PER_ARTIFACT_MAX}`,
        details: { artifactId, requested: total, limit: MANUAL_TAGS_PER_ARTIFACT_MAX },
      });
    }
    const dismissed = dismissedIdentities(context, artifactId);
    const changed = tags.filter((tag) => {
      const identity = tagIdentity(tag.facet, tag.key);
      if (dismissed.has(identity)) return true;
      const row = existing.get(identity);
      if (!row) return true;
      return row.label !== tag.label || (row.entity_id ?? undefined) !== tag.entityId;
    });
    if (changed.length === 0) return ok(tagState(context, artifactId));
    const mutation = commit(
      {
        operation: "add_artifact_tags",
        tables: ["artifact_tags", "artifact_tag_dismissals"],
        artifactId,
        details: { artifactId, tags: changed.map(identityDetail) },
        writeSet: changed.map((tag) => writeSetKey(artifactId, tag)),
      },
      (_operationId, now) => {
        const insert = context.store.db.prepare(
          `INSERT INTO artifact_tags(
             artifact_id, origin, facet, tag_key, label, entity_id, created_at
           ) VALUES (?, 'manual', ?, ?, ?, ?, ?)
           ON CONFLICT(artifact_id, origin, facet, tag_key) DO UPDATE SET
             label=excluded.label,
             entity_id=excluded.entity_id`,
        );
        const clearDismissal = context.store.db.prepare(
          `DELETE FROM artifact_tag_dismissals
           WHERE artifact_id=? AND facet=? AND tag_key=?`,
        );
        for (const tag of changed) {
          insert.run(
            artifactId,
            tag.facet,
            tag.key,
            tag.label,
            tag.entityId ?? null,
            now,
          );
          // An explicit add is explicit consent: it clears the durable
          // suppression that a previous removal recorded.
          clearDismissal.run(artifactId, tag.facet, tag.key);
        }
      },
    );
    return ok(tagState(context, artifactId), mutation.revision);
  }));
}

async function removeTag(
  context: EngineContext,
  artifactReference: string,
  input: TagIdentityInput,
): Promise<Result<ArtifactTagState, EngineError>> {
  return resultOf(() => context.store.semanticOperation((commit) => {
    const artifact = context.artifactRow(artifactReference);
    const artifactId = artifact.artifact_id;
    const identity = normalizeTagIdentity(input);
    const manual = manualRowsByIdentity(context, artifactId).get(
      tagIdentity(identity.facet, identity.key),
    );
    const dismissal = context.store.db
      .prepare(
        `SELECT artifact_id, facet, tag_key, label, dismissed_at
         FROM artifact_tag_dismissals
         WHERE artifact_id=? AND facet=? AND tag_key=?`,
      )
      .get(artifactId, identity.facet, identity.key) as unknown as
      | DismissalRow
      | undefined;
    if (!manual && dismissal) return ok(tagState(context, artifactId));
    if (!dismissal) assertDismissalCapacity(context, artifactId);
    // The dismissal keeps the label the user actually saw, so a restored
    // suppression reads the same way it did when it was removed.
    const label = manual?.label ?? automaticLabel(context, artifactId, identity) ??
      identity.label;
    const mutation = commit(
      {
        operation: "remove_artifact_tag",
        tables: ["artifact_tags", "artifact_tag_dismissals"],
        artifactId,
        details: {
          artifactId,
          facet: identity.facet,
          key: identity.key,
        },
        writeSet: [writeSetKey(artifactId, identity)],
      },
      (_operationId, now) => {
        context.store.db
          .prepare(
            `DELETE FROM artifact_tags
             WHERE artifact_id=? AND origin='manual' AND facet=? AND tag_key=?`,
          )
          .run(artifactId, identity.facet, identity.key);
        context.store.db
          .prepare(
            `INSERT INTO artifact_tag_dismissals(
               artifact_id, facet, tag_key, label, dismissed_at
             ) VALUES (?, ?, ?, ?, ?)
             ON CONFLICT(artifact_id, facet, tag_key) DO UPDATE SET
               label=excluded.label`,
          )
          .run(artifactId, identity.facet, identity.key, label, now);
      },
    );
    return ok(tagState(context, artifactId), mutation.revision);
  }));
}

async function restoreTag(
  context: EngineContext,
  artifactReference: string,
  input: TagIdentityInput,
): Promise<Result<ArtifactTagState, EngineError>> {
  return resultOf(() => context.store.semanticOperation((commit) => {
    const artifact = context.artifactRow(artifactReference);
    const artifactId = artifact.artifact_id;
    const identity = normalizeTagIdentity(input);
    const present = context.store.db
      .prepare(
        `SELECT 1 AS present FROM artifact_tag_dismissals
         WHERE artifact_id=? AND facet=? AND tag_key=?`,
      )
      .get(artifactId, identity.facet, identity.key);
    if (!present) return ok(tagState(context, artifactId));
    const mutation = commit(
      {
        operation: "restore_artifact_tag",
        tables: ["artifact_tag_dismissals"],
        artifactId,
        details: { artifactId, facet: identity.facet, key: identity.key },
        writeSet: [writeSetKey(artifactId, identity)],
      },
      () => {
        context.store.db
          .prepare(
            `DELETE FROM artifact_tag_dismissals
             WHERE artifact_id=? AND facet=? AND tag_key=?`,
          )
          .run(artifactId, identity.facet, identity.key);
      },
    );
    return ok(tagState(context, artifactId), mutation.revision);
  }));
}

async function replaceAutomaticTags(
  context: EngineContext,
  input: ReplaceAutomaticTagsArgs,
): Promise<Result<ArtifactTagState, EngineError>> {
  return resultOf(() => context.store.semanticOperation((commit) => {
    const artifact = context.artifactRow(input.artifactId);
    const artifactId = artifact.artifact_id;
    const { sourceHash, generator, extractorVersion, model, tags } = normalizeAutomaticTags(input);
    if (input.expectedGeneration !== undefined &&
        (!Number.isSafeInteger(input.expectedGeneration) || input.expectedGeneration < 0)) {
      throw new Error("Automatic tag expectedGeneration must be a nonnegative integer");
    }
    for (const tag of tags) requireEntity(context, tag);
    const current = snapshotRow(context, artifactId);
    const generation = current?.generation ?? 0;
    if (
      input.expectedGeneration !== undefined &&
      input.expectedGeneration !== generation
    ) {
      throw new EngineFault({
        code: "STALE_REVISION",
        message:
          `Automatic tags for ${artifactId} expected generation ` +
          `${input.expectedGeneration} but the catalog is at ${generation}`,
        details: {
          artifactId,
          expectedGeneration: input.expectedGeneration,
          generation,
        },
      });
    }
    if (
      snapshotMatches(current, {
        sourceHash,
        generator,
        ...(model ? { model } : {}),
        extractorVersion,
      }) &&
      automaticTagsMatch(context.store.db, artifactId, tags)
    ) {
      // Re-running the same analyzer over the same bytes with the same
      // answer is not history; it mints no commit and does not advance
      // the fence.
      return ok(tagState(context, artifactId));
    }
    const mutation = commit(
      {
        operation: "replace_automatic_artifact_tags",
        tables: ["artifact_tags", "artifact_tag_snapshots"],
        artifactId,
        details: {
          artifactId,
          sourceHash,
          generator,
          extractorVersion,
          generation: generation + 1,
          tags: tags.map(identityDetail),
        },
        writeSet: [`artifact-tags-automatic:${artifactId}`],
      },
      (_operationId, now) => {
        context.store.db
          .prepare(
            "DELETE FROM artifact_tags WHERE artifact_id=? AND origin='automatic'",
          )
          .run(artifactId);
        const insert = context.store.db.prepare(
          `INSERT INTO artifact_tags(
             artifact_id, origin, facet, tag_key, label, entity_id, created_at
           ) VALUES (?, 'automatic', ?, ?, ?, ?, ?)`,
        );
        for (const tag of tags) {
          insert.run(
            artifactId,
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
            sourceHash,
            generator,
            model || null,
            extractorVersion,
            tags.length,
            generation + 1,
            now,
          );
      },
    );
    return ok(tagState(context, artifactId), mutation.revision);
  }));
}

// --------------------------------------------------------------- helpers

function manualRowsByIdentity(
  context: EngineContext,
  artifactId: string,
): Map<string, TagRow> {
  const rows = context.store.db
    .prepare(
      `SELECT artifact_id, origin, facet, tag_key, label, entity_id, created_at
       FROM artifact_tags
       WHERE artifact_id=? AND origin='manual'`,
    )
    .all(artifactId) as unknown as TagRow[];
  return new Map(rows.map((row) => [tagIdentity(row.facet, row.tag_key), row]));
}

function dismissedIdentities(
  context: EngineContext,
  artifactId: string,
): Set<string> {
  const rows = context.store.db
    .prepare(
      "SELECT facet, tag_key FROM artifact_tag_dismissals WHERE artifact_id=?",
    )
    .all(artifactId) as unknown as Array<{
    facet: AssetTag["facet"];
    tag_key: string;
  }>;
  return new Set(rows.map((row) => tagIdentity(row.facet, row.tag_key)));
}

function assertDismissalCapacity(
  context: EngineContext,
  artifactId: string,
): void {
  const row = context.store.db
    .prepare(
      "SELECT COUNT(*) AS total FROM artifact_tag_dismissals WHERE artifact_id=?",
    )
    .get(artifactId) as unknown as { total: number };
  if (row.total >= TAG_DISMISSALS_PER_ARTIFACT_MAX) {
    throw new EngineFault({
      code: "RESOURCE_EXHAUSTED",
      message:
        `Artifact ${artifactId} already carries ${row.total} dismissals; the limit is ` +
        `${TAG_DISMISSALS_PER_ARTIFACT_MAX}`,
      details: {
        artifactId,
        total: row.total,
        limit: TAG_DISMISSALS_PER_ARTIFACT_MAX,
      },
    });
  }
}

function automaticLabel(
  context: EngineContext,
  artifactId: string,
  identity: { facet: AssetTag["facet"]; key: string },
): string | undefined {
  const row = context.store.db
    .prepare(
      `SELECT label FROM artifact_tags
       WHERE artifact_id=? AND origin='automatic' AND facet=? AND tag_key=?`,
    )
    .get(artifactId, identity.facet, identity.key) as unknown as
    | { label: string }
    | undefined;
  return row?.label;
}

/**
 * Entity references are carried, never invented: a tag may point at an
 * entity the caller has already confirmed, and the reference must resolve.
 */
function requireEntity(context: EngineContext, tag: NormalizedTag): void {
  if (!tag.entityId) return;
  const row = context.store.db
    .prepare("SELECT 1 AS present FROM entities WHERE entity_id=?")
    .get(tag.entityId);
  if (!row) {
    throw new EngineFault({
      code: "NOT_FOUND",
      message: `Tag entity does not exist: ${tag.entityId}`,
      details: { entityId: tag.entityId },
    });
  }
}

function identityDetail(tag: {
  facet: AssetTag["facet"];
  key: string;
}): string {
  return tagIdentity(tag.facet, tag.key);
}

function writeSetKey(
  artifactId: string,
  tag: { facet: AssetTag["facet"]; key: string },
): string {
  return `artifact-tag:${artifactId}:${tagIdentity(tag.facet, tag.key)}`;
}
