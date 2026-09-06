import { guardSearchProvider } from "./search-provider-access.js";
import { createHash } from "node:crypto";
import { join } from "node:path";

import type { StatementSync } from "@dolthub/doltlite";

import type { ArtifactKind, EngineError, Result, SearchProviderConsent } from "./engine-types.js";
import type {
  CommitTemporalIndexBatchInput,
  IndexBatchResult,
  IndexCoverage,
  IndexManifest,
  IndexPhase,
  PreparedSearchFingerprint,
  PreparedSearchOptions,
  PreparedSearchReference,
  PrepareTemporalIndexOptions,
  TemporalIndexPreparation,
  SearchCoverage,
  SearchHit,
  SearchModality,
  SearchPage,
  SearchQuery,
  SearchReference,
  SearchSignal,
  TemporalIndexObservation,
  TemporalIndexPlan,
  TemporalSearchProvider,
  TemporalSearchStats,
} from "./mvp-contracts.js";
import type { SearchLocation, SourceRange } from "./mvp-time.js";
import {
  normalizeSourcePoint,
  normalizeSourceRange,
  rationalEquals,
  sourceRangeEndTick,
} from "./mvp-time.js";
import { EngineContext, resultOf, syncResultOf } from "./context.js";
import { newUuidV7 } from "./ids.js";
import { canonicalJson, EngineFault, parseJson } from "./store.js";
import { TemporalVectorIndex } from "./temporal-vector-index.js";

interface ManifestRow {
  manifest_id: string;
  provider: string;
  model_id: string;
  model_revision: string;
  license: string | null;
  embedding_space: string;
  dimensions: number;
  modalities_json: string;
  supported_languages_json: string;
  preprocessing_version: string;
  extractor_version: string;
  created_at: number;
}

interface GenerationRow {
  embedding_space: string;
  generation: string;
  manifest_id: string;
  state: "building" | "active" | "retired";
}

interface CoverageRow {
  artifact_id: string;
  object_hash: string;
  manifest_id: string;
  generation: string;
  phase: IndexPhase;
  state: IndexCoverage["state"];
  covered_ranges_json: string;
  indexed_units: number;
  total_units: number | null;
  retryable: number;
  error_json: string | null;
  cursor: string | null;
  updated_at: number;
}

interface SegmentRow {
  segment_id: string;
  artifact_id: string;
  artifact_label: string | null;
  artifact_kind: ArtifactKind;
  artifact_created_at: number;
  stream_id: string | null;
  object_hash: string;
  source_range_json: string | null;
  source_path: string | null;
  segment_kind: string;
  representative_tick: number | null;
  generation: string;
  manifest_id: string;
}

interface TextRow {
  segment_id: string;
  kind: string;
  text: string;
}

interface EmbeddingRow {
  segment_id: string;
  embedding_space: string;
  modality: Exclude<SearchModality, "auto" | "metadata">;
  dimensions: number;
  vector_blob: Uint8Array;
}

interface Candidate {
  segment: SegmentRow;
  signals: SearchSignal[];
  excerpt?: string;
  score: number;
}

interface CachedVector {
  segment: SegmentRow;
  vector: Float32Array;
  range: SourceRange | null;
}

interface RetrievalState {
  semanticVersion: number;
  generationKey: string;
  generations: Set<string>;
  segments: Map<string, SegmentRow>;
  texts?: Map<string, TextRow[]>;
  vectors: Map<string, TemporalVectorIndex<CachedVector>>;
  ordered: Map<string, Map<string, OrderedEmbedding[]>>;
  pending: Set<string>;
}

const retrievalStates = new WeakMap<EngineContext, RetrievalState>();
const VECTOR_CANDIDATES = 1_000;
const continuityPrefixes = new WeakMap<OrderedEmbedding[], Float64Array>();
const SEGMENT_SELECT = `SELECT s.segment_id, s.artifact_id, a.label AS artifact_label,
  a.kind AS artifact_kind, a.created_at AS artifact_created_at,
  s.stream_id, s.object_hash, s.source_range_json, s.source_path, s.segment_kind,
  s.representative_tick, s.generation, s.manifest_id
  FROM runtime_media_segments s JOIN artifacts a ON a.artifact_id=s.artifact_id`;

export function clearTemporalSearchCache(context: EngineContext): void {
  const state = retrievalStates.get(context);
  retrievalStates.delete(context);
  for (const index of state?.vectors.values() ?? []) {
    try { index.dispose(); } catch { /* Cache writes cannot prevent closing the catalog. */ }
  }
}

interface StreamValidationRow {
  artifact_id: string;
  object_hash: string;
  duration_ticks: number;
  time_base_numerator: number;
  time_base_denominator: number;
}

interface ObservationStatements {
  upsertSegment: StatementSync;
  deleteText: StatementSync;
  deleteEmbeddings: StatementSync;
  deleteFingerprints: StatementSync;
  insertText: StatementSync;
  insertEmbedding: StatementSync;
  insertFingerprint: StatementSync;
}

interface AcceptedInterval {
  start: number;
  end: number;
  duration: number;
  segmentId: string;
}

interface IntervalNode {
  interval: AcceptedInterval;
  priority: number;
  maxEnd: number;
  left: IntervalNode | null;
  right: IntervalNode | null;
}

const INDEX_PHASES: IndexPhase[] = [
  "probe",
  "segment",
  "transcript",
  "ocr",
  "visual",
  "audio",
  "lexical",
  "activate",
];

export function createTemporalSearchApi(context: EngineContext) {
  const providers = new Map<string, TemporalSearchProvider>();
  const registrations = new Map<string, ReturnType<typeof guardSearchProvider<TemporalSearchProvider>>>();
  return {
    providers: {
      register: (provider: TemporalSearchProvider, consent: SearchProviderConsent = {}): void => {
        const id = requiredText(provider.manifestId, "Provider manifest ID");
        const existing = registrations.get(id);
        if (existing?.matches(provider, consent)) {
          existing.validate();
          return;
        }
        let registered = false;
        const guarded = guardSearchProvider(provider, consent, (): boolean => !registered || providers.get(id) === guarded.provider);
        guarded.validate();
        providers.set(id, guarded.provider);
        registrations.set(id, guarded);
        registered = true;
      },
      list: (): string[] => [...providers.keys()].sort(),
      unregister: (manifestId: string): boolean => {
        registrations.delete(manifestId);
        return providers.delete(manifestId);
      },
    },
    manifests: {
      register: (manifest: IndexManifest): Result<IndexManifest, EngineError> =>
        syncResultOf(() => registerManifest(context, manifest)),
      list: (): IndexManifest[] => listManifests(context),
      get: (manifestId: string): Result<IndexManifest, EngineError> =>
        syncResultOf(() => requiredManifest(context, manifestId)),
    },
    plan: (
      artifact: string,
      objectHash: string,
      manifestId: string,
      generation: string,
    ): Result<TemporalIndexPlan, EngineError> =>
      syncResultOf(() =>
        indexPlan(context, artifact, objectHash, manifestId, generation),
      ),
    commitBatch: (
      input: CommitTemporalIndexBatchInput,
    ): Result<IndexBatchResult, EngineError> =>
      syncResultOf(() => commitIndexBatch(context, input)),
    activate: (
      manifestId: string,
      generation: string,
    ): Result<{ manifestId: string; generation: string }, EngineError> =>
      syncResultOf(() => activateGeneration(context, manifestId, generation)),
    coverage: (artifact?: string): Result<SearchCoverage, EngineError> =>
      syncResultOf(() => searchCoverage(context, artifact)),
    prepare: (options: PrepareTemporalIndexOptions = {}): Promise<Result<TemporalIndexPreparation, EngineError>> =>
      resultOf(() => prepareTemporalIndexes(context, options)),
    query: (
      query: SearchQuery,
    ): Promise<Result<SearchPage, EngineError>> =>
      queryTemporalIndex(context, providers, query),
    queryPrepared: (
      query: SearchQuery,
      reference: PreparedSearchReference,
      options: PreparedSearchOptions = {},
    ): Promise<Result<SearchPage, EngineError>> =>
      queryTemporalIndex(context, providers, query, { reference, options }),
    invalidate: (
      artifact: string,
      objectHash?: string,
    ): Result<number, EngineError> =>
      syncResultOf(() => invalidateCoverage(context, artifact, objectHash)),
    cleanup: (): Result<{ removedSegments: number }, EngineError> =>
      syncResultOf(() => cleanupRetired(context)),
    stats: (): TemporalSearchStats => temporalStats(context),
  };
}

function registerManifest(
  context: EngineContext,
  manifest: IndexManifest,
): IndexManifest {
  validateManifest(manifest);
  const existing = context.store.db
    .prepare("SELECT * FROM runtime_index_manifests WHERE manifest_id=?")
    .get(manifest.manifestId) as unknown as ManifestRow | undefined;
  if (existing) {
    const projected = manifestFromRow(existing);
    if (canonicalJson(projected) !== canonicalJson(manifest)) {
      throw new EngineFault({
        code: "MANIFEST_INCOMPATIBLE",
        message: `Index manifest is immutable: ${manifest.manifestId}`,
      });
    }
    return projected;
  }
  context.store.runtime(() => {
    context.store.db
      .prepare(
        `INSERT INTO runtime_index_manifests(
          manifest_id, provider, model_id, model_revision, license,
          embedding_space, dimensions, modalities_json,
          supported_languages_json, preprocessing_version,
          extractor_version, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        manifest.manifestId,
        manifest.provider,
        manifest.modelId,
        manifest.modelRevision,
        manifest.license ?? null,
        manifest.embeddingSpace,
        manifest.dimensions,
        canonicalJson(manifest.modalities),
        canonicalJson(manifest.supportedLanguages),
        manifest.preprocessingVersion,
        manifest.extractorVersion,
        manifest.createdAt,
      );
  });
  return manifest;
}

function validateManifest(manifest: IndexManifest): void {
  requiredText(manifest.manifestId, "Manifest ID");
  requiredText(manifest.provider, "Manifest provider");
  requiredText(manifest.modelId, "Manifest model ID");
  requiredText(manifest.modelRevision, "Manifest model revision");
  requiredText(manifest.embeddingSpace, "Manifest embedding space");
  safeIntegerAtLeast(manifest.dimensions, 1, "Manifest dimensions");
  if (manifest.modalities.length === 0) {
    throw new Error("Manifest must support at least one modality");
  }
  requiredText(manifest.preprocessingVersion, "Preprocessing version");
  requiredText(manifest.extractorVersion, "Extractor version");
  safeIntegerAtLeast(manifest.createdAt, 0, "Manifest createdAt");
}

function listManifests(context: EngineContext): IndexManifest[] {
  return (
    context.store.db
      .prepare(
        `SELECT * FROM runtime_index_manifests
         ORDER BY created_at, manifest_id`,
      )
      .all() as unknown as ManifestRow[]
  ).map(manifestFromRow);
}

function requiredManifest(
  context: EngineContext,
  manifestId: string,
): IndexManifest {
  const row = context.store.db
    .prepare("SELECT * FROM runtime_index_manifests WHERE manifest_id=?")
    .get(manifestId) as unknown as ManifestRow | undefined;
  if (!row) {
    throw new EngineFault({
      code: "NOT_FOUND",
      message: `Index manifest not found: ${manifestId}`,
    });
  }
  return manifestFromRow(row);
}

function manifestFromRow(row: ManifestRow): IndexManifest {
  return {
    manifestId: row.manifest_id,
    provider: row.provider,
    modelId: row.model_id,
    modelRevision: row.model_revision,
    ...(row.license ? { license: row.license } : {}),
    embeddingSpace: row.embedding_space,
    dimensions: row.dimensions,
    modalities: parseJson<IndexManifest["modalities"]>(row.modalities_json, []),
    supportedLanguages: parseJson<string[]>(row.supported_languages_json, []),
    preprocessingVersion: row.preprocessing_version,
    extractorVersion: row.extractor_version,
    createdAt: row.created_at,
  };
}

function indexPlan(
  context: EngineContext,
  artifactReference: string,
  objectHash: string,
  manifestId: string,
  generation: string,
): TemporalIndexPlan {
  const artifact = context.artifactRow(artifactReference);
  assertArtifactObject(context, artifact.artifact_id, objectHash);
  requiredManifest(context, manifestId);
  requiredText(generation, "Index generation");
  const coverage = coverageRows(
    context,
    "WHERE artifact_id=? AND object_hash=? AND manifest_id=? AND generation=?",
    [artifact.artifact_id, objectHash, manifestId, generation],
  );
  const completed = new Set(
    coverage
      .filter((item) => item.state === "ready")
      .map((item) => item.phase),
  );
  return {
    artifactId: artifact.artifact_id,
    objectHash,
    manifestId,
    generation,
    phases: INDEX_PHASES,
    pendingPhases: INDEX_PHASES.filter((phase) => !completed.has(phase)),
    coverage,
  };
}

function commitIndexBatch(
  context: EngineContext,
  input: CommitTemporalIndexBatchInput,
): IndexBatchResult {
  const artifact = context.artifactRow(input.artifactId);
  const manifest = requiredManifest(context, input.manifestId);
  if (artifact.artifact_id !== input.artifactId) {
    throw new EngineFault({
      code: "INVALID_INPUT",
      message: "Index batches require a canonical artifact ID",
    });
  }
  assertArtifactObject(context, artifact.artifact_id, input.objectHash);
  requiredText(input.generation, "Index generation");
  safeIntegerAtLeast(input.maxUnits, 1, "Index batch max units");
  if (input.observations.length > input.maxUnits) {
    throw new EngineFault({
      code: "RESOURCE_EXHAUSTED",
      message: "Index batch exceeds maxUnits",
    });
  }
  const batchKey = hashJson({
    artifactId: input.artifactId,
    objectHash: input.objectHash,
    manifestId: input.manifestId,
    generation: input.generation,
    phase: input.phase,
    cursor: input.cursor ?? null,
    observations: input.observations,
  });
  const existing = context.store.db
    .prepare("SELECT result_json FROM runtime_index_batches WHERE batch_key=?")
    .get(batchKey) as unknown as { result_json: string } | undefined;
  if (existing) {
    return parseJson<IndexBatchResult>(existing.result_json, {
      artifactId: input.artifactId,
      manifestId: input.manifestId,
      phase: input.phase,
      committedUnits: 0,
      coveredRanges: [],
      complete: false,
      generation: input.generation,
    });
  }
  const streamCache = new Map<string, StreamValidationRow | undefined>();
  const observations = input.observations.map((observation, index) =>
    normalizeObservation(
      context,
      manifest,
      input,
      observation,
      index,
      streamCache,
    ),
  );
  const coveredRanges = input.coveredRanges.map(normalizeSourceRange);
  const result: IndexBatchResult = {
    artifactId: input.artifactId,
    manifestId: input.manifestId,
    phase: input.phase,
    committedUnits: observations.length,
    coveredRanges,
    ...(input.nextCursor ? { nextCursor: input.nextCursor } : {}),
    complete: input.complete,
    generation: input.generation,
  };
  context.store.runtime((now) => {
    ensureGeneration(context, manifest, input.generation, now);
    const statements = prepareObservationStatements(context);
    const existingSegments = existingSegmentIds(context, observations);
    const writtenSegments = new Set<string>();
    for (const observation of observations) {
      upsertObservation(
        input,
        observation,
        now,
        statements,
        existingSegments.has(observation.segmentId)
          || writtenSegments.has(observation.segmentId),
      );
      writtenSegments.add(observation.segmentId);
    }
    const prior = context.store.db
      .prepare(
        `SELECT indexed_units FROM runtime_index_coverage
         WHERE artifact_id=? AND object_hash=? AND manifest_id=?
           AND generation=? AND phase=?`,
      )
      .get(
        input.artifactId,
        input.objectHash,
        input.manifestId,
        input.generation,
        input.phase,
      ) as unknown as { indexed_units: number } | undefined;
    context.store.db
      .prepare(
        `INSERT INTO runtime_index_coverage(
          artifact_id, object_hash, manifest_id, generation, phase,
          state, covered_ranges_json, indexed_units, total_units,
          retryable, error_json, cursor, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, NULL, ?, ?)
        ON CONFLICT(
          artifact_id, object_hash, manifest_id, generation, phase
        ) DO UPDATE SET
          state=excluded.state,
          covered_ranges_json=excluded.covered_ranges_json,
          indexed_units=excluded.indexed_units,
          total_units=excluded.total_units,
          retryable=1,
          error_json=NULL,
          cursor=excluded.cursor,
          updated_at=excluded.updated_at`,
      )
      .run(
        input.artifactId,
        input.objectHash,
        input.manifestId,
        input.generation,
        input.phase,
        input.complete ? "ready" : "partial",
        canonicalJson(coveredRanges),
        (prior?.indexed_units ?? 0) + observations.length,
        input.totalUnits ?? null,
        input.nextCursor ?? null,
        now,
      );
    context.store.db
      .prepare(
        `INSERT INTO runtime_index_batches(
          batch_key, artifact_id, object_hash, manifest_id, generation,
          phase, cursor, result_json, committed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        batchKey,
        input.artifactId,
        input.objectHash,
        input.manifestId,
        input.generation,
        input.phase,
        input.cursor ?? null,
        canonicalJson(result),
        now,
      );
  });
  const cache = retrievalStates.get(context);
  if (cache?.generations.has(input.generation)) {
    for (const observation of observations) cache.pending.add(observation.segmentId);
  }
  return result;
}

function normalizeObservation(
  context: EngineContext,
  manifest: IndexManifest,
  batch: CommitTemporalIndexBatchInput,
  input: TemporalIndexObservation,
  index: number,
  streamCache: Map<string, StreamValidationRow | undefined>,
): TemporalIndexObservation & { segmentId: string } {
  if (
    input.artifactId !== batch.artifactId
    || input.objectHash !== batch.objectHash
  ) {
    throw new EngineFault({
      code: "INVALID_INPUT",
      message: "Index observation source does not match its batch",
    });
  }
  const segmentId =
    input.segmentId
    ?? deterministicUuid(
      batch.generation,
      `${batch.artifactId}:${batch.phase}:${batch.cursor ?? "start"}:${index}`,
    );
  const range = input.range ? normalizeSourceRange(input.range) : undefined;
  if (range) {
    if (
      range.objectHash !== batch.objectHash
      || (input.streamId && range.streamId !== input.streamId)
    ) {
      throw new EngineFault({
        code: "INVALID_RANGE",
        message: "Observation range does not match its stream identity",
      });
    }
    let stream = streamCache.get(range.streamId);
    if (!streamCache.has(range.streamId)) {
      stream = context.store.db
        .prepare(
          `SELECT artifact_id, object_hash, duration_ticks,
                  time_base_numerator, time_base_denominator
           FROM artifact_streams WHERE stream_id=?`,
        )
        .get(range.streamId) as unknown as StreamValidationRow | undefined;
      streamCache.set(range.streamId, stream);
    }
    if (
      !stream
      || stream.artifact_id !== batch.artifactId
      || stream.object_hash !== batch.objectHash
      || sourceRangeEndTick(range) > stream.duration_ticks
      || !rationalEquals(range.timeBase, {
        numerator: stream.time_base_numerator,
        denominator: stream.time_base_denominator,
      })
    ) {
      throw new EngineFault({
        code: "INVALID_RANGE",
        message: "Observation range exceeds or mismatches its source stream",
      });
    }
  } else if (!input.sourcePath) {
    throw new EngineFault({
      code: "INVALID_INPUT",
      message: "Untimed observations require a source path",
    });
  }
  requiredText(input.segmentationVersion, "Segmentation version");
  for (const text of input.texts) {
    requiredText(text.text, "Segment text");
    if (
      text.startUtf8Byte !== undefined
      || text.endUtf8Byte !== undefined
    ) {
      safeIntegerAtLeast(text.startUtf8Byte ?? -1, 0, "Text start byte");
      safeIntegerAtLeast(text.endUtf8Byte ?? -1, 1, "Text end byte");
      if ((text.endUtf8Byte ?? 0) <= (text.startUtf8Byte ?? 0)) {
        throw new EngineFault({
          code: "INVALID_RANGE",
          message: "Text byte range must be positive and half-open",
        });
      }
    }
  }
  for (const embedding of input.embeddings) {
    if (embedding.embeddingSpace !== manifest.embeddingSpace) {
      throw new EngineFault({
        code: "MANIFEST_INCOMPATIBLE",
        message: "Observation embedding space does not match its manifest",
      });
    }
    if (embedding.vector.length !== manifest.dimensions) {
      throw new EngineFault({
        code: "MANIFEST_INCOMPATIBLE",
        message: "Observation vector dimensions do not match its manifest",
      });
    }
    if (!embedding.vector.every(Number.isFinite)) {
      throw new Error("Observation vectors must contain finite numbers");
    }
  }
  return {
    ...input,
    segmentId,
    ...(range ? { range } : {}),
  };
}

function ensureGeneration(
  context: EngineContext,
  manifest: IndexManifest,
  generation: string,
  now: number,
): void {
  const existing = context.store.db
    .prepare(
      `SELECT manifest_id FROM runtime_index_generations
       WHERE embedding_space=? AND generation=?`,
    )
    .get(manifest.embeddingSpace, generation) as unknown as
    | { manifest_id: string }
    | undefined;
  if (existing && existing.manifest_id !== manifest.manifestId) {
    throw new EngineFault({
      code: "MANIFEST_INCOMPATIBLE",
      message: "Generation is already bound to another manifest",
    });
  }
  context.store.db
    .prepare(
      `INSERT OR IGNORE INTO runtime_index_generations(
        embedding_space, generation, manifest_id, state,
        activated_at, created_at
      ) VALUES (?, ?, ?, 'building', NULL, ?)`,
    )
    .run(manifest.embeddingSpace, generation, manifest.manifestId, now);
}

function upsertObservation(
  batch: CommitTemporalIndexBatchInput,
  observation: TemporalIndexObservation & { segmentId: string },
  now: number,
  statements: ObservationStatements,
  replaceChildren: boolean,
): void {
  statements.upsertSegment.run(
    observation.segmentId,
    observation.artifactId,
    observation.streamId ?? observation.range?.streamId ?? null,
    observation.objectHash,
    observation.range ? canonicalJson(observation.range) : null,
    observation.sourcePath ?? null,
    observation.kind,
    observation.representativeTick ?? null,
    observation.segmentationVersion,
    batch.generation,
    batch.manifestId,
    now,
  );
  if (replaceChildren) {
    statements.deleteText.run(observation.segmentId);
    statements.deleteEmbeddings.run(observation.segmentId);
    statements.deleteFingerprints.run(observation.segmentId);
  }
  observation.texts.forEach((text, index) => {
    statements.insertText.run(
      text.textId ?? deterministicUuid(observation.segmentId, `text:${index}`),
      observation.segmentId,
      text.kind,
      text.language ?? null,
      text.text,
      text.startUtf8Byte ?? null,
      text.endUtf8Byte ?? null,
      text.confidence ?? null,
      canonicalJson(text.provenance ?? {}),
      batch.generation,
    );
  });
  observation.embeddings.forEach((embedding, index) => {
    statements.insertEmbedding.run(
      embedding.embeddingId
        ?? deterministicUuid(observation.segmentId, `embedding:${index}`),
      observation.segmentId,
      embedding.modality,
      embedding.embeddingSpace,
      embedding.vector.length,
      vectorToBlob(embedding.vector),
      embedding.sourceHash,
      batch.generation,
      now,
    );
  });
  observation.fingerprints.forEach((fingerprint, index) => {
    statements.insertFingerprint.run(
      fingerprint.fingerprintId
        ?? deterministicUuid(observation.segmentId, `fingerprint:${index}`),
      observation.segmentId,
      fingerprint.kind,
      fingerprint.value,
      fingerprint.extractorVersion,
      batch.generation,
    );
  });
}

function existingSegmentIds(
  context: EngineContext,
  observations: Array<TemporalIndexObservation & { segmentId: string }>,
): Set<string> {
  const existing = new Set<string>();
  for (let offset = 0; offset < observations.length; offset += 500) {
    const ids = observations
      .slice(offset, offset + 500)
      .map((observation) => observation.segmentId);
    if (ids.length === 0) continue;
    const rows = context.store.db
      .prepare(
        `SELECT segment_id FROM runtime_media_segments
         WHERE segment_id IN (${ids.map(() => "?").join(",")})`,
      )
      .all(...ids) as unknown as Array<{ segment_id: string }>;
    for (const row of rows) existing.add(row.segment_id);
  }
  return existing;
}

function prepareObservationStatements(
  context: EngineContext,
): ObservationStatements {
  return {
    upsertSegment: context.store.db.prepare(
      `INSERT INTO runtime_media_segments(
        segment_id, artifact_id, stream_id, object_hash,
        source_range_json, source_path, segment_kind,
        representative_tick, segmentation_version,
        generation, manifest_id, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(segment_id) DO UPDATE SET
        source_range_json=excluded.source_range_json,
        source_path=excluded.source_path,
        segment_kind=excluded.segment_kind,
        representative_tick=excluded.representative_tick,
        segmentation_version=excluded.segmentation_version`,
    ),
    deleteText: context.store.db.prepare(
      "DELETE FROM runtime_segment_text WHERE segment_id=?",
    ),
    deleteEmbeddings: context.store.db.prepare(
      "DELETE FROM runtime_segment_embeddings WHERE segment_id=?",
    ),
    deleteFingerprints: context.store.db.prepare(
      "DELETE FROM runtime_segment_fingerprints WHERE segment_id=?",
    ),
    insertText: context.store.db.prepare(
      `INSERT INTO runtime_segment_text(
        text_id, segment_id, kind, language, text,
        start_utf8_byte, end_utf8_byte, confidence,
        provenance_json, generation
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ),
    insertEmbedding: context.store.db.prepare(
      `INSERT INTO runtime_segment_embeddings(
        embedding_id, segment_id, modality, embedding_space,
        dimensions, vector_blob, source_hash, generation, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ),
    insertFingerprint: context.store.db.prepare(
      `INSERT INTO runtime_segment_fingerprints(
        fingerprint_id, segment_id, kind, value,
        extractor_version, generation
      ) VALUES (?, ?, ?, ?, ?, ?)`,
    ),
  };
}

function activateGeneration(
  context: EngineContext,
  manifestId: string,
  generation: string,
): { manifestId: string; generation: string } {
  const manifest = requiredManifest(context, manifestId);
  const row = context.store.db
    .prepare(
      `SELECT state FROM runtime_index_generations
       WHERE embedding_space=? AND generation=? AND manifest_id=?`,
    )
    .get(manifest.embeddingSpace, generation, manifestId) as unknown as
    | { state: GenerationRow["state"] }
    | undefined;
  if (!row) {
    throw new EngineFault({
      code: "NOT_FOUND",
      message: `Index generation not found: ${generation}`,
    });
  }
  const ready = context.store.db
    .prepare(
      `SELECT 1 AS present FROM runtime_index_coverage
       WHERE manifest_id=? AND generation=?
         AND state IN ('ready','partial') LIMIT 1`,
    )
    .get(manifestId, generation);
  if (!ready) {
    throw new EngineFault({
      code: "INDEX_INCOMPLETE",
      message: "Generation has no searchable coverage",
    });
  }
  context.store.runtime((now) => {
    context.store.db
      .prepare(
        `UPDATE runtime_index_generations
         SET state='retired'
         WHERE embedding_space=? AND state='active' AND generation<>?`,
      )
      .run(manifest.embeddingSpace, generation);
    context.store.db
      .prepare(
        `UPDATE runtime_index_generations
         SET state='active', activated_at=?
         WHERE embedding_space=? AND generation=?`,
      )
      .run(now, manifest.embeddingSpace, generation);
  });
  return { manifestId, generation };
}

async function queryTemporalIndex(
  context: EngineContext,
  providers: Map<string, TemporalSearchProvider>,
  query: SearchQuery,
  prepared?: {
    reference: PreparedSearchReference;
    options: PreparedSearchOptions;
  },
): Promise<Result<SearchPage, EngineError>> {
  return resultOf(async () => {
    validateQuery(query, prepared?.reference);
    if (prepared) validatePreparedReference(prepared.reference, prepared.options);
    const active = activeGenerations(context);
    const generationKey = hashJson(
      active.map((item) => [item.embedding_space, item.generation]),
    );
    const offset = decodeCursor(query.cursor, generationKey);
    const orderedVideo = prepared?.reference.kind === "video" || query.reference?.kind === "video";
    const segments = querySegments(context, active, orderedVideo ? { ...query, durationMs: undefined } : query);
    const candidates = new Map<string, Candidate>(
      segments.map((segment) => [
        segment.segment_id,
        { segment, signals: [], score: 0 },
      ]),
    );
    if (query.text) {
      if (allowsLexical(query.modalities)) {
        addLexicalSignals(context, candidates, query.text, active);
      }
      if (allowsSemanticVector(query.modalities)) {
        await addTextVectorSignals(
          context,
          providers,
          candidates,
          query.text,
          active,
        );
      }
    }
    if (query.reference) {
      addReferenceSignals(context, candidates, query.reference, active);
    }
    if (prepared) {
      addPreparedReferenceSignals(
        context,
        candidates,
        prepared.reference,
        prepared.options,
        active,
      );
    }
    const ranked = [...candidates.values()]
      .filter(
        (candidate) =>
          (!query.sourceArtifactIds
            || query.sourceArtifactIds.includes(candidate.segment.artifact_id))
          && (!query.artifactKinds
            || query.artifactKinds.includes(candidate.segment.artifact_kind))
          && segmentMatchesDuration(candidate.segment, query.durationMs),
      )
      .map((candidate) => ({
        ...candidate,
        signals: candidate.signals.filter((signal) =>
          allowsSignal(query.modalities, signal.kind),
        ),
      }))
      .filter((candidate) => candidate.signals.length > 0)
      .map(finalizeCandidate)
      .filter((candidate) => candidate.score >= (query.minScore ?? 0))
      .sort(compareCandidates);
    const deduplicated = collapseOverlaps(ranked);
    const limit = Math.min(query.limit ?? 20, 100);
    const page = deduplicated.slice(offset, offset + limit);
    return {
      hits: page.map(candidateToHit),
      ...(offset + limit < deduplicated.length
        ? {
            nextCursor: encodeCursor(generationKey, offset + limit),
          }
        : {}),
      coverage: searchCoverage(context),
    };
  });
}

function allowsLexical(modalities: SearchModality[] | undefined): boolean {
  return (
    !modalities
    || modalities.includes("auto")
    || modalities.some((item) =>
      item === "speech" || item === "ocr" || item === "metadata"
    )
  );
}

function allowsSemanticVector(
  modalities: SearchModality[] | undefined,
): boolean {
  return (
    !modalities
    || modalities.includes("auto")
    || modalities.some((item) =>
      item === "visual"
      || item === "audio"
      || item === "speech"
      || item === "ocr"
    )
  );
}

function allowsSignal(
  modalities: SearchModality[] | undefined,
  signal: SearchSignal["kind"],
): boolean {
  if (!modalities || modalities.includes("auto")) return true;
  if (signal === "exact" || signal === "near") return true;
  return modalities.includes(signal);
}

function activeGenerations(context: EngineContext): GenerationRow[] {
  return context.store.db
    .prepare(
      `SELECT embedding_space, generation, manifest_id, state
       FROM runtime_index_generations
       WHERE state='active'
       ORDER BY embedding_space, generation`,
    )
    .all() as unknown as GenerationRow[];
}

async function prepareTemporalIndexes(context: EngineContext, options: PrepareTemporalIndexOptions): Promise<TemporalIndexPreparation> {
  const active = activeGenerations(context);
  const selected = active.filter((generation) =>
    (!options.manifestId || generation.manifest_id === options.manifestId)
    && (!options.generation || generation.generation === options.generation));
  if ((options.manifestId || options.generation) && selected.length === 0) {
    throw new EngineFault({ code: "NOT_READY", message: "Activate a generation before preparing its search index" });
  }
  const state = retrievalState(context, active, false);
  const result: TemporalIndexPreparation = { indexes: 0, vectors: 0, updatedVectors: 0, loadedIndexes: 0, persistedIndexes: 0 };
  for (const generation of selected) {
    for (const modality of requiredManifest(context, generation.manifest_id).modalities) {
      if (modality === "metadata") continue;
      const prepared = await vectorIndex(context, generation, modality, state).prepare(options.signal, options.checkpoint === "periodic");
      result.indexes++;
      result.vectors += prepared.vectors;
      result.updatedVectors += prepared.updatedVectors;
      result.loadedIndexes += Number(prepared.loaded);
      result.persistedIndexes += Number(prepared.persisted);
    }
  }
  return result;
}

function retrievalState(context: EngineContext, active = activeGenerations(context), refreshMetadata = true): RetrievalState {
  const generationKey = canonicalJson(active.map((item) => [item.generation, item.embedding_space, item.manifest_id]));
  let state = retrievalStates.get(context);
  if (!state || state.generationKey !== generationKey) {
    const generations = [...new Set(active.map((item) => item.generation))];
    const rows = generations.length === 0 ? [] : context.store.db.prepare(
      `${SEGMENT_SELECT} WHERE s.generation IN (${generations.map(() => "?").join(",")}) ORDER BY s.segment_id`,
    ).all(...generations) as unknown as SegmentRow[];
    const segments = new Map(rows.map((row) => [row.segment_id, row]));
    const vectors = state?.vectors ?? new Map<string, TemporalVectorIndex<CachedVector>>();
    for (const [key, index] of vectors) {
      const [generation, space] = JSON.parse(key) as string[];
      if (!active.some((item) => item.generation === generation && item.embedding_space === space)) {
        try { index.dispose(); } catch { /* Retired cache persistence is optional. */ }
        vectors.delete(key);
        continue;
      }
      for (const [segmentId, entry] of index.entries) {
        const segment = segments.get(segmentId);
        if (segment) entry.value.segment = segment;
        else index.delete(segmentId);
      }
    }
    state = {
      semanticVersion: context.store.semanticVersion, generationKey, generations: new Set(generations),
      segments, vectors, ordered: new Map(), pending: state?.pending ?? new Set(),
    };
    retrievalStates.set(context, state);
  }
  if (refreshMetadata && state.semanticVersion !== context.store.semanticVersion) {
    const generations = [...state.generations];
    const rows = generations.length === 0 ? [] : context.store.db.prepare(
      `${SEGMENT_SELECT} WHERE s.generation IN (${generations.map(() => "?").join(",")}) ORDER BY s.segment_id`,
    ).all(...generations) as unknown as SegmentRow[];
    state.segments = new Map(rows.map((row) => [row.segment_id, row]));
    for (const [key, index] of state.vectors) {
      for (const [segmentId, entry] of index.entries) {
        const segment = state.segments.get(segmentId);
        if (segment) entry.value.segment = segment;
        else index.delete(segmentId);
      }
      if (index.entries.size === 0) {
        try { index.dispose(); } catch { /* Empty cache persistence is optional. */ }
        state.vectors.delete(key);
      }
    }
    state.texts = undefined;
    state.ordered.clear();
    state.semanticVersion = context.store.semanticVersion;
  }
  if (state.pending.size > 0) refreshRetrievalState(context, state);
  return state;
}

function refreshRetrievalState(context: EngineContext, state: RetrievalState): void {
  const pending = [...state.pending];
  for (let start = 0; start < pending.length; start += 400) {
    const keys = pending.slice(start, start + 400);
    const placeholders = keys.map(() => "?").join(",");
    for (const key of keys) {
      state.segments.delete(key);
      state.texts?.delete(key);
      for (const index of state.vectors.values()) index.delete(key);
    }
    const rows = context.store.db.prepare(
      `${SEGMENT_SELECT} WHERE s.segment_id IN (${placeholders}) ORDER BY s.segment_id`,
    ).all(...keys) as unknown as SegmentRow[];
    for (const row of rows) {
      if (state.generations.has(row.generation)) state.segments.set(row.segment_id, row);
    }
    if (state.texts) {
      const texts = context.store.db.prepare(
        `SELECT segment_id, kind, text FROM runtime_segment_text
         WHERE segment_id IN (${placeholders}) ORDER BY segment_id, kind, text`,
      ).all(...keys) as unknown as TextRow[];
      for (const row of texts) addCachedText(state.texts, row);
    }
    for (const [key, index] of state.vectors) {
      const [generation, embeddingSpace, modality] = JSON.parse(key) as string[];
      const vectors = context.store.db.prepare(
        `SELECT segment_id, dimensions, vector_blob FROM runtime_segment_embeddings
         WHERE generation=? AND embedding_space=? AND modality=?
           AND segment_id IN (${placeholders}) ORDER BY segment_id`,
      ).all(generation!, embeddingSpace!, modality!, ...keys) as unknown as EmbeddingRow[];
      for (const row of vectors) addCachedVector(state, index, row);
    }
  }
  state.ordered.clear();
  state.pending.clear();
}

function cachedTextRows(context: EngineContext, active: GenerationRow[]): TextRow[] {
  const state = retrievalState(context, active);
  if (!state.texts) {
    state.texts = new Map();
    const generations = [...state.generations];
    const rows = generations.length === 0 ? [] : context.store.db.prepare(
      `SELECT segment_id, kind, text FROM runtime_segment_text
       WHERE generation IN (${generations.map(() => "?").join(",")}) ORDER BY segment_id, kind, text`,
    ).all(...generations) as unknown as TextRow[];
    for (const row of rows) addCachedText(state.texts, row);
  }
  return [...state.texts.values()].flat();
}

function addCachedText(texts: Map<string, TextRow[]>, row: TextRow): void {
  const rows = texts.get(row.segment_id) ?? [];
  rows.push(row);
  texts.set(row.segment_id, rows);
}

function addCachedVector(state: RetrievalState, index: TemporalVectorIndex<CachedVector>, row: EmbeddingRow): void {
  const segment = state.segments.get(row.segment_id);
  if (!segment) return;
  if (row.dimensions !== index.dimensions) {
    throw new EngineFault({ code: "MANIFEST_INCOMPATIBLE", message: "Stored vector dimensions do not match the index manifest" });
  }
  const vector = blobToVector(row.vector_blob, row.dimensions);
  index.set(row.segment_id, vector, { segment, vector, range: segmentRange(segment) });
}

function vectorIndex(
  context: EngineContext, generation: GenerationRow,
  modality: Exclude<SearchModality, "auto" | "metadata">,
  state = retrievalState(context),
): TemporalVectorIndex<CachedVector> {
  const key = canonicalJson([generation.generation, generation.embedding_space, modality]);
  const cached = state.vectors.get(key);
  if (cached) return cached;
  const manifest = requiredManifest(context, generation.manifest_id);
  const identity = canonicalJson([key, manifest]);
  const index = new TemporalVectorIndex<CachedVector>(manifest.dimensions, {
    identity, basePath: join(context.store.dataDir, "runtime-search", hashJson(identity)),
  });
  let after = "";
  for (;;) {
    const rows = context.store.db.prepare(
      `SELECT segment_id, dimensions, vector_blob FROM runtime_segment_embeddings
       WHERE generation=? AND embedding_space=? AND modality=? AND segment_id>?
       ORDER BY segment_id LIMIT 512`,
    ).all(generation.generation, generation.embedding_space, modality, after) as unknown as EmbeddingRow[];
    for (const row of rows) addCachedVector(state, index, row);
    if (rows.length < 512) break;
    after = rows.at(-1)!.segment_id;
  }
  state.vectors.set(key, index);
  return index;
}

function orderedStreams(context: EngineContext, generation: GenerationRow): Map<string, OrderedEmbedding[]> {
  const state = retrievalState(context);
  const key = canonicalJson([generation.generation, generation.embedding_space]);
  const cached = state.ordered.get(key);
  if (cached) return cached;
  const streams = new Map<string, OrderedEmbedding[]>();
  for (const { value } of vectorIndex(context, generation, "visual").entries.values()) {
    if (!value.range) continue;
    const stream = streams.get(value.range.streamId) ?? [];
    stream.push({ segment: value.segment, vector: value.vector, range: value.range });
    streams.set(value.range.streamId, stream);
  }
  for (const stream of streams.values()) stream.sort((left, right) =>
    left.range.startTick - right.range.startTick || left.segment.segment_id.localeCompare(right.segment.segment_id));
  state.ordered.set(key, streams);
  return streams;
}

function querySegments(
  context: EngineContext,
  active: GenerationRow[],
  query: SearchQuery,
): SegmentRow[] {
  if (active.length === 0) return [];
  const rows = [...retrievalState(context, active).segments.values()];
  const labelMatches = new Map<string, boolean>();
  const orientations = new Map<string, "landscape" | "portrait" | "square">();
  const indexingStates = new Map<string, IndexCoverage["state"]>();
  return rows.filter((row) => {
    if (query.artifactKinds && !query.artifactKinds.includes(row.artifact_kind)) {
      return false;
    }
    if (
      query.sourceArtifactIds
      && !query.sourceArtifactIds.includes(row.artifact_id)
    ) {
      return false;
    }
    if (
      query.createdAfter !== undefined
      && row.artifact_created_at <= query.createdAfter
    ) {
      return false;
    }
    if (
      query.createdBefore !== undefined
      && row.artifact_created_at >= query.createdBefore
    ) {
      return false;
    }
    if (query.labels) {
      if (!labelMatches.has(row.artifact_id)) labelMatches.set(row.artifact_id, artifactHasLabels(context, row.artifact_id, query.labels));
      if (!labelMatches.get(row.artifact_id)) return false;
    }
    if (query.orientations) {
      if (!orientations.has(row.artifact_id)) orientations.set(row.artifact_id, artifactOrientation(context, row.artifact_id));
      if (!query.orientations.includes(orientations.get(row.artifact_id)!)) return false;
    }
    if (query.indexingStates) {
      const key = `${row.artifact_id}:${row.generation}`;
      if (!indexingStates.has(key)) indexingStates.set(key, artifactGenerationState(context, row.artifact_id, row.generation));
      if (!query.indexingStates.includes(indexingStates.get(key)!)) return false;
    }
    return segmentMatchesDuration(row, query.durationMs);
  });
}

function segmentMatchesDuration(segment: SegmentRow, requested: SearchQuery["durationMs"]): boolean {
  if (!requested) return true;
  const range = segmentRange(segment);
  if (!range) return true;
  const durationMs = sourceTickToMs(range.durationTicks, range);
  return (requested.min === undefined || durationMs >= requested.min)
    && (requested.max === undefined || durationMs <= requested.max);
}

function artifactHasLabels(
  context: EngineContext,
  artifactId: string,
  requested: string[],
): boolean {
  const row = context.store.db
    .prepare(
      `SELECT value_json FROM artifact_metadata
       WHERE artifact_id=? AND key='labels'`,
    )
    .get(artifactId) as unknown as { value_json: string } | undefined;
  const labels = row ? parseJson<string[]>(row.value_json, []) : [];
  return requested.every((label) => labels.includes(label));
}

function artifactOrientation(
  context: EngineContext,
  artifactId: string,
): "landscape" | "portrait" | "square" {
  const row = context.store.db
    .prepare(
      `SELECT profile_json FROM artifact_streams
       WHERE artifact_id=? AND kind='video'
       ORDER BY stream_index LIMIT 1`,
    )
    .get(artifactId) as unknown as { profile_json: string } | undefined;
  const profile = row
    ? parseJson<{ video?: { width?: number; height?: number } }>(
        row.profile_json,
        {},
      )
    : {};
  const width = profile.video?.width ?? 1;
  const height = profile.video?.height ?? 1;
  if (width === height) return "square";
  return width > height ? "landscape" : "portrait";
}

function artifactGenerationState(
  context: EngineContext,
  artifactId: string,
  generation: string,
): IndexCoverage["state"] {
  const rows = context.store.db
    .prepare(
      `SELECT state FROM runtime_index_coverage
       WHERE artifact_id=? AND generation=?`,
    )
    .all(artifactId, generation) as unknown as Array<{
    state: IndexCoverage["state"];
  }>;
  return aggregateCoverageState(rows);
}

function addLexicalSignals(
  context: EngineContext,
  candidates: Map<string, Candidate>,
  text: string,
  active: GenerationRow[],
): void {
  const generations = active.map((item) => item.generation);
  if (generations.length === 0) return;
  const rows = cachedTextRows(context, active);
  const normalized = text.trim().toLocaleLowerCase();
  const quoted = [...text.matchAll(/"([^"]+)"/g)]
    .map((match) => match[1]?.trim().toLocaleLowerCase())
    .filter((item): item is string => Boolean(item));
  const terms = normalized
    .replaceAll('"', "")
    .split(/\s+/)
    .filter((term) => term.length > 1);
  const matches = rows
    .map((row) => {
      const haystack = row.text.toLocaleLowerCase();
      const exact = quoted.some((phrase) => haystack.includes(phrase));
      const termCount = terms.filter((term) => haystack.includes(term)).length;
      return {
        row,
        exact,
        score:
          (exact ? 2 : 0)
          + (terms.length === 0 ? 0 : termCount / terms.length),
      };
    })
    .filter((item) => item.score > 0)
    .sort(
      (left, right) =>
        right.score - left.score
        || left.row.segment_id.localeCompare(right.row.segment_id),
    );
  matches.forEach((match, index) => {
    const candidate = candidates.get(match.row.segment_id);
    if (!candidate) return;
    candidate.signals.push({
      kind:
        match.row.kind === "ocr"
          ? "ocr"
          : match.row.kind === "transcript"
            ? "speech"
            : "metadata",
      rank: index + 1,
      score: match.score,
      explanation: match.exact
        ? "Exact quoted text matched this moment"
        : "Query terms matched indexed text",
    });
    if (!candidate.excerpt || match.exact) candidate.excerpt = match.row.text;
  });
}

async function addTextVectorSignals(
  context: EngineContext,
  providers: Map<string, TemporalSearchProvider>,
  candidates: Map<string, Candidate>,
  text: string,
  active: GenerationRow[],
): Promise<void> {
  for (const generation of active) {
    const provider = providers.get(generation.manifest_id);
    if (!provider) continue;
    const manifest = requiredManifest(context, generation.manifest_id);
    await provider.prepare();
    const queryVector = provider.embedText(text);
    const resolved = await queryVector;
    if (resolved.length !== manifest.dimensions) {
      throw new EngineFault({
        code: "MANIFEST_INCOMPATIBLE",
        message: "Query provider returned incompatible vector dimensions",
      });
    }
    for (const modality of manifest.modalities) {
      if (modality === "metadata") continue;
      rankVectorRows(
        context,
        candidates,
        generation,
        resolved,
        modality,
        `Text-to-${modality} semantic similarity`,
      );
    }
  }
}

function addReferenceSignals(
  context: EngineContext,
  candidates: Map<string, Candidate>,
  reference: SearchReference,
  active: GenerationRow[],
): void {
  for (const generation of active) {
    if (reference.kind === "video") {
      addOrderedVideoSignals(context, candidates, reference.range, generation);
      continue;
    }
    const queryRows = referenceEmbeddingRows(context, reference, generation);
    if (queryRows.length === 0) continue;
    const queryVector = averageVectors(
      queryRows.map((row) => blobToVector(row.vector_blob, row.dimensions)),
    );
    const modality = reference.kind === "audio" ? "audio" : "visual";
    rankVectorRows(
      context,
      candidates,
      generation,
      queryVector,
      modality,
      `${reference.kind} reference similarity`,
    );
    addFingerprintSignals(context, candidates, queryRows, generation);
  }
}

interface VectorEmbedding {
  vector: Float32Array;
  range?: SourceRange;
}

interface TimedVectorEmbedding extends VectorEmbedding {
  offsetMs: number;
}

interface OrderedEmbedding extends VectorEmbedding {
  segment: SegmentRow;
  range: SourceRange;
}

function addOrderedVideoSignals(
  context: EngineContext,
  candidates: Map<string, Candidate>,
  rangeInput: SourceRange,
  generation: GenerationRow,
): void {
  const range = normalizeSourceRange(rangeInput);
  const query = orderedEmbeddings(
    context,
    generation,
    (segmentRangeValue) =>
      segmentRangeValue.streamId === range.streamId
      && segmentRangeValue.objectHash === range.objectHash
      && rangesOverlap(
        segmentRangeValue.startTick,
        sourceRangeEndTick(segmentRangeValue),
        range.startTick,
        sourceRangeEndTick(range),
      ),
  );
  if (query.length === 0) return;
  const sample = evenlySample(query, Math.min(query.length, 16)).map((item) => ({
    ...item,
    offsetMs: sourceTickToMs(item.range.startTick - range.startTick, range),
  }));
  addOrderedVideoVectorSignals(
    context, candidates, sample, generation,
    sourceTickToMs(range.durationTicks, range),
  );
}

function addPreparedReferenceSignals(
  context: EngineContext,
  candidates: Map<string, Candidate>,
  reference: PreparedSearchReference,
  options: PreparedSearchOptions,
  active: GenerationRow[],
): void {
  for (const generation of active) {
    if (generation.embedding_space !== reference.embeddingSpace) continue;
    const manifest = requiredManifest(context, generation.manifest_id);
    if (reference.kind === "image") {
      const queryVector = preparedVector(reference.vector, manifest.dimensions);
      rankVectorRows(
        context,
        candidates,
        generation,
        queryVector,
        "visual",
        "Prepared image reference similarity",
      );
      addPreparedFingerprintSignals(
        context,
        candidates,
        reference.fingerprints ?? [],
        generation,
      );
      continue;
    }
    const samples = preparedVideoSamples(reference, options);
    const startMs = options.range?.startMs ?? 0;
    const durationMs = Math.min(
      options.range?.durationMs ?? Infinity,
      preparedVideoDuration(reference) - startMs,
    );
    for (const sample of samples) {
      preparedVector(sample.vector, manifest.dimensions);
    }
    addOrderedVideoVectorSignals(
      context,
      candidates,
      samples.map((sample) => ({
        vector: Float32Array.from(sample.vector),
        offsetMs: sample.offsetMs - startMs,
      })),
      generation,
      durationMs,
    );
  }
}

function addOrderedVideoVectorSignals(
  context: EngineContext,
  candidates: Map<string, Candidate>,
  sample: TimedVectorEmbedding[],
  generation: GenerationRow,
  durationMs: number,
): void {
  if (sample.length === 0) return;
  const byStream = orderedStreams(context, generation);
  const starts = orderedCandidateStarts(context, candidates, sample, generation, byStream);
  const queryVectors = new Map<number, Float32Array>();
  const windows: Array<{
    values: OrderedEmbedding[];
    score: number;
    coherence: number;
    durationTicks: number;
  }> = [];
  for (const [streamId, positions] of starts) {
    const values = byStream.get(streamId)!;
    for (const start of [...positions].sort((left, right) => left - right)) {
      const first = values[start]!;
      const startMs = sourceTickToMs(first.range.startTick, first.range);
      const end = orderedPosition(values, startMs + durationMs);
      const count = end - start;
      const window = Array.from({ length: Math.min(count, 16) }, (_, index) =>
        values[start + (count === 1 ? 0 : Math.round(index * (count - 1) / (Math.min(count, 16) - 1)))]!);
      const last = values[end - 1]!;
      const availableMs = Math.min(durationMs,
        sourceTickToMs(sourceRangeEndTick(last.range), last.range) - startMs);
      const timedWindow = window.map((item) => ({
        ...item,
        offsetMs: sourceTickToMs(item.range.startTick, item.range) - startMs,
      }));
      const offsets = [...new Set([...sample, ...timedWindow]
        .map((item) => item.offsetMs)
        .filter((offset) => offset >= 0 && offset < availableMs))]
        .sort((left, right) => left - right);
      if (offsets.length === 0) continue;
      const query = offsets.map((offset) => {
        let vector = queryVectors.get(offset);
        if (!vector) { vector = videoVectorAt(sample, offset); queryVectors.set(offset, vector); }
        return { vector };
      });
      const target = offsets.map((offset) => ({ vector: videoVectorAt(timedWindow, offset) }));
      const aligned = query.reduce(
        (sum, item, index) =>
          sum + cosineSimilarity(item.vector, target[index]!.vector),
        0,
      ) / query.length;
      const coherence =
        transitionCoherence(query, target) * 0.75
        + temporalContinuity(values, start, end) * 0.25;
      windows.push({
        values: window,
        score: (aligned * 0.75 + coherence * 0.25) * availableMs / durationMs,
        coherence,
        durationTicks: Math.max(1, Math.min(
          sourceRangeEndTick(last.range) - first.range.startTick,
          Math.round(availableMs * first.range.timeBase.denominator
            / (first.range.timeBase.numerator * 1_000)),
        )),
      });
    }
  }
  windows
    .sort(
      (left, right) =>
        right.score - left.score
        || left.values[0]!.segment.segment_id.localeCompare(
          right.values[0]!.segment.segment_id,
        ),
    )
    .forEach((window, index) => {
      const first = window.values[0]!;
      const last = window.values.at(-1)!;
      const combined: SourceRange = {
        ...first.range,
        durationTicks: window.durationTicks,
      };
      const segmentId = `ordered:${generation.generation}:${first.segment.segment_id}:${last.segment.segment_id}`;
      const candidate: Candidate = {
        segment: {
          ...first.segment,
          segment_id: segmentId,
          source_range_json: canonicalJson(combined),
          representative_tick:
            first.range.startTick + Math.floor(combined.durationTicks / 2),
        },
        signals: [
          ...(isExactOrderedWindow(sample, window.values)
            ? [{
                kind: "exact" as const,
                rank: 1,
                score: 1,
                explanation: "Exact source bytes and ordered range matched",
              }]
            : []),
          {
            kind: "visual",
            rank: index + 1,
            score: window.score,
            explanation: `Ordered video alignment with temporal coherence ${window.coherence.toFixed(3)}`,
          },
        ],
        score: 0,
      };
      candidates.set(segmentId, candidate);
    });
}

function orderedCandidateStarts(
  context: EngineContext, candidates: Map<string, Candidate>, sample: TimedVectorEmbedding[],
  generation: GenerationRow, streams: Map<string, OrderedEmbedding[]>,
): Map<string, Set<number>> {
  const starts = new Map<string, Set<number>>();
  const index = vectorIndex(context, generation, "visual");
  const timedCandidates = new Map([...candidates].filter(([, candidate]) => candidate.segment.source_range_json !== null));
  const seedCount = Math.max(32, Math.floor(512 / sample.length));
  for (const querySample of sample) {
    for (const { value } of index.nearest(querySample.vector, seedCount, timedCandidates)) {
      if (!value.range) continue;
      const stream = streams.get(value.range.streamId)!;
      const desiredMs = sourceTickToMs(value.range.startTick, value.range) - querySample.offsetMs;
      const low = orderedPosition(stream, desiredMs);
      const positions = starts.get(value.range.streamId) ?? new Set<number>();
      for (const position of [low - 1, low, low + 1]) {
        const item = stream[position];
        if (item && candidates.has(item.segment.segment_id)) positions.add(position);
      }
      starts.set(value.range.streamId, positions);
    }
  }
  return starts;
}

function orderedPosition(stream: OrderedEmbedding[], milliseconds: number): number {
  let low = 0;
  let high = stream.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    const item = stream[middle]!;
    if (sourceTickToMs(item.range.startTick, item.range) < milliseconds) low = middle + 1;
    else high = middle;
  }
  return low;
}

function videoVectorAt(samples: TimedVectorEmbedding[], offsetMs: number): Float32Array {
  const next = samples.findIndex((sample) => sample.offsetMs >= offsetMs);
  if (next === -1) return samples.at(-1)!.vector;
  if (next === 0 || samples[next]!.offsetMs === offsetMs) return samples[next]!.vector;
  const before = samples[next - 1]!;
  const after = samples[next]!;
  const fraction = (offsetMs - before.offsetMs) / (after.offsetMs - before.offsetMs);
  return before.vector.map((value, index) =>
    value * (1 - fraction) + after.vector[index]! * fraction);
}

function orderedEmbeddings(
  context: EngineContext,
  generation: GenerationRow,
  include: (range: SourceRange) => boolean,
): OrderedEmbedding[] {
  return [...orderedStreams(context, generation).values()]
    .flatMap((rows) => rows.filter((row) => include(row.range)));
}

function transitionCoherence(
  query: VectorEmbedding[],
  candidate: VectorEmbedding[],
): number {
  if (query.length < 2) return 1;
  let score = 0;
  for (let index = 1; index < query.length; index += 1) {
    score += cosineSimilarity(
      vectorDifference(query[index]!.vector, query[index - 1]!.vector),
      vectorDifference(
        candidate[index]!.vector,
        candidate[index - 1]!.vector,
      ),
    );
  }
  return score / (query.length - 1);
}

function temporalContinuity(candidate: OrderedEmbedding[], start: number, end: number): number {
  if (end - start < 2) return 1;
  let prefix = continuityPrefixes.get(candidate);
  if (!prefix) {
    prefix = new Float64Array(candidate.length);
    for (let index = 1; index < candidate.length; index++) {
      const previous = candidate[index - 1]!.range;
      const current = candidate[index]!.range;
      const gapMs = Math.max(0, sourceTickToMs(current.startTick, current)
        - sourceTickToMs(sourceRangeEndTick(previous), previous));
      const scaleMs = Math.max(1, (sourceTickToMs(previous.durationTicks, previous)
        + sourceTickToMs(current.durationTicks, current)) / 2);
      prefix[index] = prefix[index - 1]! + 1 / (1 + gapMs / scaleMs);
    }
    continuityPrefixes.set(candidate, prefix);
  }
  return (prefix[end - 1]! - prefix[start]!) / (end - start - 1);
}

function isExactOrderedWindow(
  query: VectorEmbedding[],
  candidate: OrderedEmbedding[],
): boolean {
  return query.length === candidate.length && query.every((item, index) => {
    const reference = item.range;
    const match = candidate[index]?.range;
    return Boolean(
      reference
      && match
      && reference.objectHash === match.objectHash
      && nearlyEqual(
        sourceTickToMs(reference.startTick, reference),
        sourceTickToMs(match.startTick, match),
      )
      && nearlyEqual(
        sourceTickToMs(reference.durationTicks, reference),
        sourceTickToMs(match.durationTicks, match),
      ),
    );
  });
}

function sourceTickToMs(tick: number, range: SourceRange): number {
  return (tick * range.timeBase.numerator * 1_000) / range.timeBase.denominator;
}

function nearlyEqual(left: number, right: number): boolean {
  return Math.abs(left - right) <= 1e-6;
}

function vectorDifference(
  left: Float32Array,
  right: Float32Array,
): Float32Array {
  const result = new Float32Array(left.length);
  for (let index = 0; index < left.length; index += 1) {
    result[index] = left[index]! - right[index]!;
  }
  return result;
}

function evenlySample<T>(values: T[], count: number): T[] {
  if (count <= 1) return values.length === 0 ? [] : [values[0]!];
  if (count >= values.length) return values;
  return Array.from({ length: count }, (_, index) => {
    const position = Math.round((index * (values.length - 1)) / (count - 1));
    return values[position]!;
  });
}

function rankVectorRows(
  context: EngineContext,
  candidates: Map<string, Candidate>,
  generation: GenerationRow,
  queryVector: Float32Array,
  modality: Exclude<SearchModality, "auto" | "metadata">,
  explanation: string,
): void {
  vectorIndex(context, generation, modality)
    .nearest(queryVector, VECTOR_CANDIDATES, candidates)
    .forEach((item, index) => {
      const candidate = candidates.get(item.key);
      if (!candidate) return;
      candidate.signals.push({ kind: modality, rank: index + 1, score: item.score, explanation });
    });
}

function referenceEmbeddingRows(
  context: EngineContext,
  reference: SearchReference,
  generation: GenerationRow,
): EmbeddingRow[] {
  const segments = referenceSegments(context, reference, generation.generation);
  if (segments.length === 0) return [];
  const placeholders = segments.map(() => "?").join(",");
  const modality = reference.kind === "audio" ? "audio" : "visual";
  return context.store.db
    .prepare(
      `SELECT segment_id, embedding_space, modality, dimensions, vector_blob
       FROM runtime_segment_embeddings
       WHERE segment_id IN (${placeholders})
         AND embedding_space=? AND modality=?
       ORDER BY segment_id`,
    )
    .all(
      ...segments,
      generation.embedding_space,
      modality,
    ) as unknown as EmbeddingRow[];
}

function referenceSegments(
  context: EngineContext,
  reference: SearchReference,
  generation: string,
): string[] {
  if (reference.kind === "image") {
    const artifact = context.artifactRow(reference.artifact);
    return (
      context.store.db
        .prepare(
          `SELECT segment_id FROM runtime_media_segments
           WHERE generation=? AND artifact_id=?
           ORDER BY segment_id`,
        )
        .all(generation, artifact.artifact_id) as unknown as Array<{
        segment_id: string;
      }>
    ).map((row) => row.segment_id);
  }
  const range =
    reference.kind === "frame"
      ? undefined
      : normalizeSourceRange(reference.range);
  const point =
    reference.kind === "frame"
      ? normalizeSourcePoint(reference.source)
      : undefined;
  const rows = context.store.db
    .prepare(
      `SELECT segment_id, source_range_json
       FROM runtime_media_segments
       WHERE generation=? AND stream_id=? AND object_hash=?
       ORDER BY representative_tick, segment_id`,
    )
    .all(
      generation,
      point?.streamId ?? range?.streamId,
      point?.objectHash ?? range?.objectHash,
    ) as unknown as Array<{
    segment_id: string;
    source_range_json: string | null;
  }>;
  return rows
    .filter((row) => {
      if (!row.source_range_json) return false;
      const candidate = parseJson<SourceRange | null>(row.source_range_json, null);
      if (!candidate) return false;
      if (point) {
        return (
          candidate.startTick <= point.tick
          && point.tick < sourceRangeEndTick(candidate)
        );
      }
      return range
        ? rangesOverlap(
            candidate.startTick,
            sourceRangeEndTick(candidate),
            range.startTick,
            sourceRangeEndTick(range),
          )
        : false;
    })
    .map((row) => row.segment_id);
}

function addFingerprintSignals(
  context: EngineContext,
  candidates: Map<string, Candidate>,
  queryRows: EmbeddingRow[],
  generation: GenerationRow,
): void {
  const segmentIds = unique(queryRows.map((row) => row.segment_id));
  if (segmentIds.length === 0) return;
  const fingerprints = context.store.db
    .prepare(
      `SELECT kind, value FROM runtime_segment_fingerprints
       WHERE segment_id IN (${segmentIds.map(() => "?").join(",")})
       ORDER BY kind, value`,
    )
    .all(...segmentIds) as unknown as Array<{ kind: string; value: string }>;
  addPreparedFingerprintSignals(
    context,
    candidates,
    fingerprints,
    generation,
  );
}

function addPreparedFingerprintSignals(
  context: EngineContext,
  candidates: Map<string, Candidate>,
  fingerprints: PreparedSearchFingerprint[],
  generation: GenerationRow,
): void {
  for (const fingerprint of fingerprints) {
    const rows = context.store.db
      .prepare(
        `SELECT segment_id FROM runtime_segment_fingerprints
         WHERE generation=? AND kind=? AND value=?
         ORDER BY segment_id`,
      )
      .all(
        generation.generation,
        fingerprint.kind,
        fingerprint.value,
      ) as unknown as Array<{ segment_id: string }>;
    rows.forEach((row, index) => {
      const candidate = candidates.get(row.segment_id);
      if (!candidate) return;
      candidate.signals.push({
        kind: fingerprint.kind === "sha256" ? "exact" : "near",
        rank: index + 1,
        score: 1,
        explanation:
          fingerprint.kind === "sha256"
            ? "Exact source fingerprint matched"
            : "Near-duplicate fingerprint matched",
      });
    });
  }
}

function finalizeCandidate(candidate: Candidate): Candidate {
  const sortedSignals = [...candidate.signals].sort(
    (left, right) =>
      signalPriority(left.kind) - signalPriority(right.kind)
      || left.rank - right.rank,
  );
  const rrf = sortedSignals.reduce(
    (sum, signal) => sum + 1 / (60 + signal.rank),
    0,
  );
  const exactBoost = sortedSignals.some((signal) => signal.kind === "exact")
    ? 1
    : sortedSignals.some((signal) => signal.kind === "near")
      ? 0.25
      : 0;
  return { ...candidate, signals: sortedSignals, score: rrf + exactBoost };
}

function compareCandidates(left: Candidate, right: Candidate): number {
  return (
    right.score - left.score
    || left.segment.artifact_id.localeCompare(right.segment.artifact_id)
    || locationKey(left.segment).localeCompare(locationKey(right.segment))
    || left.segment.segment_id.localeCompare(right.segment.segment_id)
  );
}

function collapseOverlaps(candidates: Candidate[]): Candidate[] {
  const accepted: Candidate[] = [];
  const intervals = new Map<string, IntervalNode | null>();
  for (const candidate of candidates) {
    const range = segmentRange(candidate.segment);
    if (!range) {
      accepted.push(candidate);
      continue;
    }
    const key = `${candidate.segment.artifact_id}\u0000${range.streamId}`;
    const interval: AcceptedInterval = {
      start: range.startTick,
      end: sourceRangeEndTick(range),
      duration: range.durationTicks,
      segmentId: candidate.segment.segment_id,
    };
    const root = intervals.get(key) ?? null;
    if (hasDuplicateInterval(root, interval)) continue;
    intervals.set(key, insertInterval(root, interval));
    accepted.push(candidate);
  }
  return accepted;
}

function hasDuplicateInterval(
  node: IntervalNode | null,
  candidate: AcceptedInterval,
): boolean {
  if (!node || node.maxEnd <= candidate.start) return false;
  if (
    node.left
    && node.left.maxEnd > candidate.start
    && hasDuplicateInterval(node.left, candidate)
  ) {
    return true;
  }
  const other = node.interval;
  if (other.start < candidate.end) {
    const overlap = Math.max(
      0,
      Math.min(candidate.end, other.end) - Math.max(candidate.start, other.start),
    );
    if (overlap / Math.min(candidate.duration, other.duration) >= 0.8) {
      return true;
    }
  } else {
    return false;
  }
  return hasDuplicateInterval(node.right, candidate);
}

function insertInterval(
  node: IntervalNode | null,
  interval: AcceptedInterval,
): IntervalNode {
  if (!node) {
    return {
      interval,
      priority: intervalPriority(interval),
      maxEnd: interval.end,
      left: null,
      right: null,
    };
  }
  if (compareIntervals(interval, node.interval) < 0) {
    node.left = insertInterval(node.left, interval);
    if (node.left.priority > node.priority) node = rotateIntervalRight(node);
  } else {
    node.right = insertInterval(node.right, interval);
    if (node.right.priority > node.priority) node = rotateIntervalLeft(node);
  }
  refreshMaxEnd(node);
  return node;
}

function rotateIntervalLeft(node: IntervalNode): IntervalNode {
  const pivot = node.right;
  if (!pivot) return node;
  node.right = pivot.left;
  pivot.left = node;
  refreshMaxEnd(node);
  refreshMaxEnd(pivot);
  return pivot;
}

function rotateIntervalRight(node: IntervalNode): IntervalNode {
  const pivot = node.left;
  if (!pivot) return node;
  node.left = pivot.right;
  pivot.right = node;
  refreshMaxEnd(node);
  refreshMaxEnd(pivot);
  return pivot;
}

function refreshMaxEnd(node: IntervalNode): void {
  node.maxEnd = Math.max(
    node.interval.end,
    node.left?.maxEnd ?? Number.NEGATIVE_INFINITY,
    node.right?.maxEnd ?? Number.NEGATIVE_INFINITY,
  );
}

function compareIntervals(
  left: AcceptedInterval,
  right: AcceptedInterval,
): number {
  return (
    left.start - right.start
    || left.end - right.end
    || left.segmentId.localeCompare(right.segmentId)
  );
}

function intervalPriority(interval: AcceptedInterval): number {
  let hash = 2_166_136_261;
  const key = `${interval.segmentId}:${interval.start}:${interval.end}`;
  for (let index = 0; index < key.length; index += 1) {
    hash ^= key.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return hash >>> 0;
}

function candidateToHit(candidate: Candidate): SearchHit {
  return {
    artifactId: candidate.segment.artifact_id,
    ...(candidate.segment.artifact_label
      ? { artifactLabel: candidate.segment.artifact_label }
      : {}),
    artifactKind: candidate.segment.artifact_kind,
    location: segmentLocation(candidate.segment),
    ...(candidate.segment.representative_tick === null
      ? {}
      : { representativeTick: candidate.segment.representative_tick }),
    score: candidate.score,
    signals: candidate.signals,
    ...(candidate.excerpt ? { excerpt: candidate.excerpt } : {}),
    indexManifestIds: [candidate.segment.manifest_id],
  };
}

function segmentLocation(segment: SegmentRow): SearchLocation {
  const range = segmentRange(segment);
  if (range) {
    return {
      kind: "timed",
      artifactId: segment.artifact_id,
      range,
    };
  }
  return {
    kind: segment.segment_kind === "document" ? "document" : "still",
    artifactId: segment.artifact_id,
    sourcePath: segment.source_path ?? "unknown",
    objectHash: segment.object_hash,
    ...(segment.segment_kind === "document"
      ? { startUtf8Byte: 0, endUtf8Byte: 1 }
      : {}),
  } as SearchLocation;
}

function segmentRange(segment: SegmentRow): SourceRange | null {
  return segment.source_range_json
    ? parseJson<SourceRange | null>(segment.source_range_json, null)
    : null;
}

function locationKey(segment: SegmentRow): string {
  return canonicalJson(segmentLocation(segment));
}

function searchCoverage(
  context: EngineContext,
  artifactReference?: string,
): SearchCoverage {
  const artifactId = artifactReference
    ? context.artifactRow(artifactReference).artifact_id
    : undefined;
  const active = activeGenerations(context);
  const rows = coverageRows(
    context,
    artifactId
      ? `WHERE artifact_id=? AND generation IN (${active.map(() => "?").join(",")})`
      : active.length > 0
        ? `WHERE generation IN (${active.map(() => "?").join(",")})`
        : "WHERE 1=0",
    artifactId
      ? [artifactId, ...active.map((item) => item.generation)]
      : active.map((item) => item.generation),
  );
  const allArtifacts = context.store.db
    .prepare("SELECT COUNT(*) AS count FROM artifacts")
    .get() as unknown as { count: number };
  const indexedArtifactCount = new Set(rows.map((row) => row.artifactId)).size;
  const state = aggregateCoverageState(rows);
  const generation = hashJson(
    active.map((item) => [item.embedding_space, item.generation]),
  );
  const modalities = unique(
    active.flatMap(
      (item) => requiredManifest(context, item.manifest_id).modalities,
    ),
  ).map((modality) => {
    const relevant = rows.filter((row) => phaseForModality(modality) === row.phase);
    return {
      modality,
      state: aggregateCoverageState(relevant),
      indexedUnits: relevant.reduce((sum, row) => sum + row.indexedUnits, 0),
      ...(relevant.some((row) => row.totalUnits !== undefined)
        ? {
            totalUnits: relevant.reduce(
              (sum, row) => sum + (row.totalUnits ?? 0),
              0,
            ),
          }
        : {}),
      languageCoverage:
        modality === "speech" || modality === "ocr"
          ? ("best-effort" as const)
          : ("unsupported" as const),
      manifestId: active.find((item) =>
        requiredManifest(context, item.manifest_id).modalities.includes(modality)
      )?.manifest_id,
    };
  });
  return {
    state,
    generation,
    modalities,
    indexedArtifactCount,
    totalArtifactCount: artifactId ? 1 : allArtifacts.count,
    partialResults: state !== "ready",
  };
}

function coverageRows(
  context: EngineContext,
  clause: string,
  params: string[],
): IndexCoverage[] {
  const rows = context.store.db
    .prepare(
      `SELECT artifact_id, object_hash, manifest_id, generation, phase,
              state, covered_ranges_json, indexed_units, total_units,
              retryable, error_json, cursor, updated_at
       FROM runtime_index_coverage ${clause}
       ORDER BY artifact_id, manifest_id, generation, phase`,
    )
    .all(...params) as unknown as CoverageRow[];
  return rows.map((row) => ({
    artifactId: row.artifact_id,
    objectHash: row.object_hash,
    manifestId: row.manifest_id,
    phase: row.phase,
    state: row.state,
    coveredRanges: parseJson<SourceRange[]>(row.covered_ranges_json, []),
    indexedUnits: row.indexed_units,
    ...(row.total_units === null ? {} : { totalUnits: row.total_units }),
    ...(row.cursor === null ? {} : { nextCursor: row.cursor }),
    retryable: row.retryable === 1,
    ...(row.error_json
      ? { error: parseJson<EngineError>(row.error_json, {
          code: "INTERNAL_ERROR",
          message: "Unknown index error",
        }) }
      : {}),
    updatedAt: row.updated_at,
  }));
}

function invalidateCoverage(
  context: EngineContext,
  artifactReference: string,
  objectHash?: string,
): number {
  const artifact = context.artifactRow(artifactReference);
  return context.store.runtime((now) => {
    const result = objectHash
      ? context.store.db
          .prepare(
            `UPDATE runtime_index_coverage
             SET state='stale', updated_at=?
             WHERE artifact_id=? AND object_hash=?`,
          )
          .run(now, artifact.artifact_id, objectHash)
      : context.store.db
          .prepare(
            `UPDATE runtime_index_coverage
             SET state='stale', updated_at=?
             WHERE artifact_id=?`,
          )
          .run(now, artifact.artifact_id);
    return Number(result.changes);
  });
}

function cleanupRetired(
  context: EngineContext,
): { removedSegments: number } {
  return context.store.runtime(() => {
    const retired = (
      context.store.db
        .prepare(
          `SELECT generation FROM runtime_index_generations
           WHERE state='retired'`,
        )
        .all() as unknown as Array<{ generation: string }>
    ).map((row) => row.generation);
    if (retired.length === 0) return { removedSegments: 0 };
    const placeholders = retired.map(() => "?").join(",");
    const result = context.store.db
      .prepare(
        `DELETE FROM runtime_media_segments
         WHERE generation IN (${placeholders})`,
      )
      .run(...retired);
    context.store.db
      .prepare(
        `DELETE FROM runtime_index_coverage
         WHERE generation IN (${placeholders})`,
      )
      .run(...retired);
    context.store.db
      .prepare(
        `DELETE FROM runtime_index_batches
         WHERE generation IN (${placeholders})`,
      )
      .run(...retired);
    context.store.db
      .prepare(
        `DELETE FROM runtime_index_generations
         WHERE generation IN (${placeholders})`,
      )
      .run(...retired);
    return { removedSegments: Number(result.changes) };
  });
}

function temporalStats(context: EngineContext): TemporalSearchStats {
  const count = (table: string, clause = "") =>
    (
      context.store.db
        .prepare(`SELECT COUNT(*) AS count FROM ${table} ${clause}`)
        .get() as { count: number }
    ).count;
  return {
    activeGenerations: count(
      "runtime_index_generations",
      "WHERE state='active'",
    ),
    segments: count("runtime_media_segments"),
    textObservations: count("runtime_segment_text"),
    embeddings: count("runtime_segment_embeddings"),
    fingerprints: count("runtime_segment_fingerprints"),
  };
}

function assertArtifactObject(
  context: EngineContext,
  artifactId: string,
  objectHash: string,
): void {
  const object = context.store.db
    .prepare(
      `SELECT 1 AS present FROM artifact_files
       WHERE artifact_id=? AND object_hash=? LIMIT 1`,
    )
    .get(artifactId, objectHash);
  if (!object) {
    throw new EngineFault({
      code: "OBJECT_UNAVAILABLE",
      message: "Artifact does not currently reference the requested object",
      details: { artifactId, objectHash },
    });
  }
}

function validateQuery(
  query: SearchQuery,
  prepared?: PreparedSearchReference,
): void {
  if (!query.text && !query.reference && !prepared) {
    throw new EngineFault({
      code: "INVALID_INPUT",
      message: "Search requires text, reference media, or both",
    });
  }
  if (query.reference && prepared) {
    throw new EngineFault({
      code: "INVALID_INPUT",
      message: "Search cannot combine artifact and prepared references",
    });
  }
  if (query.text !== undefined) requiredText(query.text, "Search text");
  if (query.limit !== undefined) safeIntegerAtLeast(query.limit, 1, "Search limit");
  if (query.minScore !== undefined && !Number.isFinite(query.minScore)) {
    throw new Error("Search minScore must be finite");
  }
}

function validatePreparedReference(
  reference: PreparedSearchReference,
  options: PreparedSearchOptions,
): void {
  requiredText(reference.embeddingSpace, "Prepared reference embedding space");
  if (reference.kind === "image") {
    preparedVector(reference.vector);
    if (options.range) {
      throw new EngineFault({
        code: "INVALID_INPUT",
        message: "Image references do not accept a time range",
      });
    }
    for (const fingerprint of reference.fingerprints ?? []) {
      requiredText(fingerprint.kind, "Prepared fingerprint kind");
      requiredText(fingerprint.value, "Prepared fingerprint value");
    }
    return;
  }
  if (reference.samples.length === 0 || reference.samples.length > 16) {
    throw new EngineFault({
      code: "INVALID_INPUT",
      message: "Prepared video references require between 1 and 16 samples",
    });
  }
  if (reference.durationMs !== undefined && (
    !Number.isFinite(reference.durationMs) || reference.durationMs <= 0
    || reference.samples.some((sample) => sample.offsetMs >= reference.durationMs!)
  )) {
    throw new EngineFault({
      code: "INVALID_INPUT",
      message: "Prepared video duration must be finite, positive, and contain every sample",
    });
  }
  let previousOffset = -1;
  for (const sample of reference.samples) {
    if (!Number.isFinite(sample.offsetMs) || sample.offsetMs < 0) {
      throw new EngineFault({
        code: "INVALID_INPUT",
        message: "Prepared video sample offsets must be finite and non-negative",
      });
    }
    if (sample.offsetMs <= previousOffset) {
      throw new EngineFault({
        code: "INVALID_INPUT",
        message: "Prepared video sample offsets must be strictly increasing",
      });
    }
    previousOffset = sample.offsetMs;
    preparedVector(sample.vector);
  }
  const range = options.range;
  if (range) {
    if (!Number.isFinite(range.startMs) || range.startMs < 0) {
      throw new EngineFault({
        code: "INVALID_RANGE",
        message: "Prepared video range start must be finite and non-negative",
      });
    }
    if (
      range.durationMs !== undefined
      && (!Number.isFinite(range.durationMs) || range.durationMs <= 0)
    ) {
      throw new EngineFault({
        code: "INVALID_RANGE",
        message: "Prepared video range duration must be finite and positive",
      });
    }
  }
  preparedVideoSamples(reference, options);
}

function preparedVideoSamples(
  reference: Extract<PreparedSearchReference, { kind: "video" }>,
  options: PreparedSearchOptions,
) {
  const range = options.range;
  const endMs = Math.min(preparedVideoDuration(reference),
    range?.durationMs === undefined ? Infinity : range.startMs + range.durationMs);
  const samples = range
    ? reference.samples.filter(
        (sample) =>
          sample.offsetMs >= range.startMs && sample.offsetMs < endMs,
      )
    : reference.samples;
  if (samples.length === 0) {
    throw new EngineFault({
      code: "INVALID_RANGE",
      message: "Prepared video range does not contain a sampled frame",
    });
  }
  return samples;
}

function preparedVideoDuration(
  reference: Extract<PreparedSearchReference, { kind: "video" }>,
): number {
  if (reference.durationMs !== undefined) return reference.durationMs;
  const last = reference.samples.at(-1)!;
  const intervals = reference.samples.slice(1).map((sample, index) =>
    sample.offsetMs - reference.samples[index]!.offsetMs).sort((a, b) => a - b);
  return last.offsetMs + (intervals[Math.floor(intervals.length / 2)] ?? 1);
}

function preparedVector(
  vector: number[],
  dimensions?: number,
): Float32Array {
  if (
    !Array.isArray(vector)
    || vector.length === 0
    || vector.some((value) => !Number.isFinite(value))
  ) {
    throw new EngineFault({
      code: "INVALID_INPUT",
      message: "Prepared reference vectors must contain finite values",
    });
  }
  if (dimensions !== undefined && vector.length !== dimensions) {
    throw new EngineFault({
      code: "MANIFEST_INCOMPATIBLE",
      message: "Prepared reference vector dimensions do not match the index",
    });
  }
  return Float32Array.from(vector);
}

function aggregateCoverageState(
  rows: Array<{ state: IndexCoverage["state"] }>,
): IndexCoverage["state"] {
  if (rows.length === 0) return "not-indexed";
  if (rows.some((row) => row.state === "failed")) return "failed";
  if (rows.some((row) => row.state === "stale")) return "stale";
  if (rows.every((row) => row.state === "ready")) return "ready";
  return "partial";
}

function phaseForModality(
  modality: Exclude<SearchModality, "auto">,
): IndexPhase {
  if (modality === "visual") return "visual";
  if (modality === "audio") return "audio";
  if (modality === "ocr") return "ocr";
  if (modality === "speech") return "transcript";
  return "lexical";
}

function signalPriority(kind: SearchSignal["kind"]): number {
  return ["exact", "near", "speech", "ocr", "visual", "audio", "metadata"].indexOf(
    kind,
  );
}

function vectorToBlob(vector: number[]): Buffer {
  const values = Float32Array.from(vector);
  return Buffer.from(values.buffer, values.byteOffset, values.byteLength);
}

function blobToVector(blob: Uint8Array, dimensions: number): Float32Array {
  const bytes = Buffer.from(blob);
  if (bytes.byteLength !== dimensions * Float32Array.BYTES_PER_ELEMENT) {
    throw new EngineFault({
      code: "MANIFEST_INCOMPATIBLE",
      message: "Stored vector dimensions do not match its byte length",
    });
  }
  const copy = new Uint8Array(bytes);
  return new Float32Array(copy.buffer);
}

function cosineSimilarity(left: Float32Array, right: Float32Array): number {
  if (left.length !== right.length || left.length === 0) {
    throw new EngineFault({
      code: "MANIFEST_INCOMPATIBLE",
      message: "Cannot compare incompatible vector dimensions",
    });
  }
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < left.length; index += 1) {
    const leftValue = left[index]!;
    const rightValue = right[index]!;
    dot += leftValue * rightValue;
    leftNorm += leftValue * leftValue;
    rightNorm += rightValue * rightValue;
  }
  if (leftNorm === 0 || rightNorm === 0) return 0;
  return dot / (Math.sqrt(leftNorm) * Math.sqrt(rightNorm));
}

function averageVectors(vectors: Float32Array[]): Float32Array {
  const first = vectors[0];
  if (!first) return new Float32Array();
  const result = new Float32Array(first.length);
  for (const vector of vectors) {
    if (vector.length !== result.length) {
      throw new EngineFault({
        code: "MANIFEST_INCOMPATIBLE",
        message: "Reference vectors have incompatible dimensions",
      });
    }
    vector.forEach((value, index) => {
      result[index] = result[index]! + value;
    });
  }
  for (let index = 0; index < result.length; index += 1) {
    result[index] = result[index]! / vectors.length;
  }
  return result;
}

function encodeCursor(generation: string, offset: number): string {
  return Buffer.from(canonicalJson({ generation, offset }), "utf8").toString(
    "base64url",
  );
}

function decodeCursor(cursor: string | undefined, generation: string): number {
  if (!cursor) return 0;
  const parsed = parseJson<{ generation?: string; offset?: number }>(
    Buffer.from(cursor, "base64url").toString("utf8"),
    {},
  );
  if (
    parsed.generation !== generation
    || !Number.isSafeInteger(parsed.offset)
    || (parsed.offset ?? -1) < 0
  ) {
    throw new EngineFault({
      code: "STALE_REVISION",
      message: "Search cursor belongs to another index generation",
    });
  }
  return parsed.offset!;
}

function hashJson(value: unknown): string {
  return `sha256:${createHash("sha256")
    .update(canonicalJson(value))
    .digest("hex")}`;
}

function deterministicUuid(namespace: string, value: string): string {
  const bytes = createHash("sha256")
    .update(namespace)
    .update("\0")
    .update(value)
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x70;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20),
  ].join("-");
}

function requiredText(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${label} is required`);
  return normalized;
}

function safeIntegerAtLeast(value: number, minimum: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new Error(`${label} must be a safe integer of at least ${minimum}`);
  }
}

function rangesOverlap(
  leftStart: number,
  leftEnd: number,
  rightStart: number,
  rightEnd: number,
): boolean {
  return leftStart < rightEnd && rightStart < leftEnd;
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}
