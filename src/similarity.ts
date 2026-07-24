import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";

import {
  AutoProcessor,
  ClapAudioModelWithProjection,
  pipeline,
  RawImage,
} from "@huggingface/transformers";
import sharp from "sharp";
import {
  Index,
  MetricKind,
  ScalarKind,
} from "usearch";

import {
  err,
  type ArtifactKind,
  type EngineError,
  type Result,
  type SimilarityApi,
  type SimilarityAudioConfig,
  type SimilarityAudioEmbeddingProvider,
  type SimilarityConfig,
  type SimilarityEmbeddingProvider,
  type SimilarityIndexOptions,
  type SimilarityIndexResult,
  type SimilarityKind,
  type SimilarityMatch,
  type SimilarityPrepareOptions,
  type SimilarityQueryOptions,
  type SimilarityStats,
  type SimilarityStatus,
  type SimilarityTextChunk,
  type SimilarityTextConfig,
  type SimilarityTextEmbeddingProvider,
  type SimilarityTextQueryOptions,
} from "./engine-types.js";
import {
  EngineContext,
  resultOf,
  syncResultOf,
  type ArtifactRow,
  type FileRow,
} from "./context.js";
import { EngineFault } from "./store.js";

const DEFAULT_MODEL_ID = "Xenova/clip-vit-base-patch32";
const DEFAULT_MODEL_REVISION =
  "d15189d7028b43f1d3e65039190477f6af591c2a";
const DEFAULT_EMBEDDING_SPACE =
  "clip-vit-b32-q8-d15189d7028b43f1d3e65039190477f6af591c2a-v1";
const DEFAULT_DIMENSIONS = 512;

const DEFAULT_AUDIO_MODEL_ID = "Xenova/clap-htsat-unfused";
const DEFAULT_AUDIO_MODEL_REVISION =
  "c28f2883575e590e04d3146ff0713c2448d691ba";
const DEFAULT_AUDIO_EMBEDDING_SPACE =
  "clap-htsat-unfused-q8-c28f2883575e590e04d3146ff0713c2448d691ba-audio-v1";
const DEFAULT_AUDIO_DIMENSIONS = 512;
const DEFAULT_AUDIO_SAMPLE_RATE = 48_000;
const DEFAULT_AUDIO_MAX_SAMPLES = 480_000;

const DEFAULT_TEXT_MODEL_ID = "onnx-community/all-MiniLM-L6-v2-ONNX";
const DEFAULT_TEXT_MODEL_REVISION =
  "aff7a1dc4e8a1ea593e6ea21e95c22ef0a25966f";
const DEFAULT_TEXT_EMBEDDING_SPACE =
  "all-minilm-l6-v2-q4-aff7a1dc4e8a1ea593e6ea21e95c22ef0a25966f-text-v1";
const DEFAULT_TEXT_DIMENSIONS = 384;
const DEFAULT_TEXT_MAX_BYTES = 1024 * 1024;
const DEFAULT_TEXT_MAX_CHUNKS = 256;
const TEXT_CHUNK_TOKENS = 224;
const TEXT_OVERLAP_TOKENS = 32;
const TEXT_CHUNK_CHAR_WINDOW = 1600;
const TEXT_EXCERPT_LIMIT = 480;

const TEXT_ARTIFACT_KINDS = new Set<ArtifactKind>([
  "script",
  "character",
  "prompt",
  "scene",
  "final",
]);

type FeaturePipeline = (
  images: RawImage | RawImage[],
) => Promise<{ data: Float32Array; dims: number[] }>;

interface TextTokenizer {
  encode(
    text: string,
    options?: { add_special_tokens?: boolean },
  ): number[];
}

interface TextFeaturePipeline {
  (texts: string[], options?: {
    pooling?: "mean";
    normalize?: boolean;
  }): Promise<{ data: Float32Array; dims: number[] }>;
  tokenizer: TextTokenizer;
}

interface AudioProcessor {
  (
    audio: Float32Array,
  ): Promise<Record<string, unknown>>;
  feature_extractor?: {
    config?: {
      sampling_rate?: number;
      nb_max_samples?: number;
    };
  };
}

interface AudioModel {
  (
    inputs: Record<string, unknown>,
  ): Promise<{
    audio_embeds: {
      data: Float32Array;
      dims: number[];
    };
  }>;
}

type MediaSimilarityKind = Exclude<SimilarityKind, "text">;
type MediaEmbeddingProvider =
  | SimilarityEmbeddingProvider
  | SimilarityAudioEmbeddingProvider;

interface EmbeddingRow {
  id: number;
  artifact_id: string;
  kind: SimilarityKind;
  source_path: string;
  object_hash: string;
  embedding_space: string;
  dimensions: number;
  vector_blob: Uint8Array;
  frame_count: number | null;
  updated_at: number;
  slug?: string;
}

interface TextDocumentRow {
  id: number;
  artifact_id: string;
  source_path: string;
  object_hash: string;
  content_hash: string;
  embedding_space: string;
  dimensions: number;
  chunk_count: number;
  updated_at: number;
  slug?: string;
}

interface TextChunkRow {
  id: number;
  document_id: number;
  artifact_id: string;
  embedding_space: string;
  chunk_index: number;
  start_offset: number;
  end_offset: number;
  chunk_text: string;
  dimensions: number;
  vector_blob: Uint8Array;
  updated_at: number;
  source_path?: string;
  object_hash?: string;
  content_hash?: string;
  slug?: string;
}

interface CachedIndex {
  index: Index;
  dimensions: number;
}

interface SelectedSource extends FileRow {
  kind: SimilarityKind;
}

interface NormalizedText {
  text: string;
  contentHash: string;
}

interface TextSearchPair {
  chunkId: number;
  queryChunkIndex: number;
  exactBytes?: boolean;
  exactContent?: boolean;
}

export function createSimilarityApi(context: EngineContext): SimilarityApi {
  if (!context.config.similarity) return disabledSimilarityApi();
  return new LocalSimilarityApi(context, context.config.similarity);
}

class LocalSimilarityApi implements SimilarityApi {
  private readonly provider: SimilarityEmbeddingProvider;
  private readonly audioProvider: SimilarityAudioEmbeddingProvider | null;
  private readonly textProvider: SimilarityTextEmbeddingProvider | null;
  private readonly indexes = new Map<string, CachedIndex>();

  constructor(
    private readonly context: EngineContext,
    config: SimilarityConfig,
  ) {
    this.provider = config.provider ?? new LocalClipProvider(context, config);
    this.audioProvider = config.audio
      ? config.audio.provider ??
        new LocalClapAudioProvider(context, config, config.audio)
      : null;
    this.textProvider = config.text
      ? config.text.provider ?? new LocalTextProvider(context, config, config.text)
      : null;
  }

  async prepare(
    options: SimilarityPrepareOptions = {},
  ): Promise<
    Result<
      {
        embeddingSpace: string;
        embeddingSpaces: Partial<Record<SimilarityKind, string>>;
      },
      EngineError
    >
  > {
    return resultOf(async () => {
      const kinds = options.kind
        ? [options.kind]
        : ([
            "image",
            "video",
            ...(this.audioProvider ? ["audio"] : []),
            ...(this.textProvider ? ["text"] : []),
          ] as SimilarityKind[]);
      const spaces: Partial<Record<SimilarityKind, string>> = {};
      const preparedMedia = new Set<MediaEmbeddingProvider>();
      for (const kind of kinds) {
        if (kind === "text") {
          const provider = this.requireTextProvider();
          await provider.prepare();
          spaces.text = provider.embeddingSpace;
        } else {
          const provider = this.providerFor(kind);
          if (!preparedMedia.has(provider)) {
            await provider.prepare();
            preparedMedia.add(provider);
          }
          spaces[kind] = provider.embeddingSpace;
        }
      }
      return {
        embeddingSpace: this.provider.embeddingSpace,
        embeddingSpaces: spaces,
      };
    });
  }

  async index(
    artifactReference: string,
    options: SimilarityIndexOptions = {},
  ): Promise<Result<SimilarityIndexResult, EngineError>> {
    return resultOf(async () => {
      const artifact = this.context.artifactRow(artifactReference);
      const kind = similarityKind(artifact);
      if (kind === "text") {
        return this.indexText(artifact, options);
      }
      return this.indexMedia(artifact, kind, options);
    });
  }

  async rebuild(
    options: { kind?: SimilarityKind; force?: boolean } = {},
  ): Promise<Result<SimilarityIndexResult[], EngineError>> {
    return resultOf(async () => {
      const allowedKinds = options.kind
        ? [options.kind]
        : ([
            "image",
            "video",
            ...(this.audioProvider ? ["audio"] : []),
            ...(this.textProvider ? ["text"] : []),
          ] as SimilarityKind[]);
      const artifactKinds = allowedKinds.flatMap((kind) =>
        kind === "text" ? [...TEXT_ARTIFACT_KINDS] : [kind],
      );
      const artifactRows = this.context.store.db
        .prepare(
          `SELECT artifact_id, slug, kind, data_json,
                  created_at, updated_at, deleted_at
           FROM artifacts
           WHERE deleted_at IS NULL
             AND kind IN (${artifactKinds.map(() => "?").join(", ")})
           ORDER BY created_at, artifact_id`,
        )
        .all(...artifactKinds) as unknown as ArtifactRow[];
      const indexed: SimilarityIndexResult[] = [];
      for (const artifact of artifactRows) {
        const kind = similarityKind(artifact);
        if (!allowedKinds.includes(kind)) continue;
        if (kind === "text" && !this.hasTextSource(artifact.artifact_id)) continue;
        const result = await this.index(artifact.artifact_id, {
          force: options.force,
        });
        if (!result.ok) throw new EngineFault(result.error);
        indexed.push(result.value);
      }
      return indexed;
    });
  }

  status(
    artifactReference: string,
  ): Result<SimilarityStatus, EngineError> {
    return syncResultOf(() => {
      const artifact = this.context.artifactRow(artifactReference);
      const kind = similarityKind(artifact);
      if (kind === "text") {
        const provider = this.requireTextProvider();
        const row = this.textDocumentForArtifact(
          artifact.artifact_id,
          provider.embeddingSpace,
        );
        if (!row) {
          return {
            artifactId: artifact.artifact_id,
            kind,
            state: "not_indexed",
            embeddingSpace: provider.embeddingSpace,
          } satisfies SimilarityStatus;
        }
        return {
          artifactId: artifact.artifact_id,
          kind,
          state: "ready",
          embeddingSpace: row.embedding_space,
          objectHash: row.object_hash,
          contentHash: row.content_hash,
          chunkCount: row.chunk_count,
          updatedAt: row.updated_at,
        } satisfies SimilarityStatus;
      }
      const provider = this.providerFor(kind);
      const row = this.embeddingForArtifact(
        artifact.artifact_id,
        provider.embeddingSpace,
      );
      if (!row) {
        return {
          artifactId: artifact.artifact_id,
          kind,
          state: "not_indexed",
          embeddingSpace: provider.embeddingSpace,
        } satisfies SimilarityStatus;
      }
      return {
        artifactId: artifact.artifact_id,
        kind,
        state: "ready",
        embeddingSpace: row.embedding_space,
        objectHash: row.object_hash,
        frameCount: row.frame_count,
        updatedAt: row.updated_at,
      } satisfies SimilarityStatus;
    });
  }

  stats(): Result<SimilarityStats, EngineError> {
    return syncResultOf(() => {
      const rows = this.context.store.db
        .prepare(
          `SELECT kind, COUNT(*) AS count
           FROM runtime_similarity_embeddings
           WHERE embedding_space=?
           GROUP BY kind`,
        )
        .all(this.provider.embeddingSpace) as unknown as Array<{
        kind: SimilarityKind;
        count: number;
      }>;
      const spaces: Partial<Record<SimilarityKind, string>> = {
        image: this.provider.embeddingSpace,
        video: this.provider.embeddingSpace,
      };
      let audioCount = 0;
      if (this.audioProvider) {
        spaces.audio = this.audioProvider.embeddingSpace;
        const count = this.context.store.db
          .prepare(
            `SELECT COUNT(*) AS count
             FROM runtime_similarity_embeddings
             WHERE kind='audio' AND embedding_space=?`,
          )
          .get(this.audioProvider.embeddingSpace) as unknown as {
          count: number;
        };
        audioCount = count.count;
      }
      let textCount = 0;
      if (this.textProvider) {
        spaces.text = this.textProvider.embeddingSpace;
        const count = this.context.store.db
          .prepare(
            `SELECT COUNT(*) AS count
             FROM runtime_text_similarity_documents d
             JOIN artifacts a ON a.artifact_id=d.artifact_id
             WHERE d.embedding_space=?
               AND a.deleted_at IS NULL`,
          )
          .get(this.textProvider.embeddingSpace) as unknown as {
          count: number;
        };
        textCount = count.count;
      }
      return {
        embeddingSpace: this.provider.embeddingSpace,
        embeddingSpaces: spaces,
        imageCount: rows.find((row) => row.kind === "image")?.count ?? 0,
        videoCount: rows.find((row) => row.kind === "video")?.count ?? 0,
        audioCount,
        textCount,
      };
    });
  }

  async findSimilar(
    artifactReference: string,
    options: SimilarityQueryOptions = {},
  ): Promise<Result<SimilarityMatch[], EngineError>> {
    return resultOf(async () => {
      const artifact = this.context.artifactRow(artifactReference);
      const kind = similarityKind(artifact);
      if (kind === "text") {
        return this.findSimilarTextArtifact(artifact, options);
      }
      return this.findSimilarMedia(artifact, kind, options);
    });
  }

  async findSimilarText(
    query: string,
    options: SimilarityTextQueryOptions = {},
  ): Promise<Result<SimilarityMatch[], EngineError>> {
    return resultOf(async () => {
      const provider = this.requireTextProvider();
      const normalizedQuery = normalizePlainText(query);
      if (normalizedQuery.text.length === 0) {
        throw new EngineFault({
          code: "INVALID_INPUT",
          message: "Text similarity queries must not be empty",
        });
      }
      const maxBytes = checkedTextMaxBytes(this.context.config.similarity?.text);
      if (Buffer.byteLength(normalizedQuery.text, "utf8") > maxBytes) {
        throw new EngineFault({
          code: "INVALID_INPUT",
          message: `Text similarity queries cannot exceed ${maxBytes} bytes`,
        });
      }
      const chunks = await this.embedText(normalizedQuery.text);
      return this.searchText(
        null,
        null,
        normalizedQuery.contentHash,
        chunks,
        options,
        provider,
      );
    });
  }

  private async indexMedia(
    artifact: ArtifactRow,
    kind: MediaSimilarityKind,
    options: SimilarityIndexOptions,
  ): Promise<SimilarityIndexResult> {
    const provider = this.providerFor(kind);
    const source = this.sourceFor(artifact, kind);
    const existing = this.embeddingForArtifact(
      artifact.artifact_id,
      provider.embeddingSpace,
    );
    if (
      existing &&
      existing.object_hash === source.object_hash &&
      existing.dimensions === provider.dimensions &&
      !options.force
    ) {
      this.addToCachedIndex(existing, vectorFromBlob(existing));
      return this.indexResult(existing, true);
    }
    const reusable = !options.force
      ? this.embeddingForObject(
          source.object_hash,
          kind,
          provider.embeddingSpace,
          provider.dimensions,
        )
      : null;
    const embedded = reusable
      ? {
          vector: vectorFromBlob(reusable),
          frameCount: reusable.frame_count,
          reused: true,
        }
      : await this.embedMediaSource(source);
    const row = this.context.store.runtime((now) => {
      if (existing) {
        this.context.store.db
          .prepare(
            `UPDATE runtime_similarity_embeddings
             SET kind=?, source_path=?, object_hash=?,
                 dimensions=?, vector_blob=?, frame_count=?, updated_at=?
             WHERE id=?`,
          )
          .run(
            kind,
            source.path,
            source.object_hash,
            provider.dimensions,
            vectorToBlob(embedded.vector),
            embedded.frameCount,
            now,
            existing.id,
          );
        return this.embeddingById(existing.id);
      }
      const result = this.context.store.db
        .prepare(
          `INSERT INTO runtime_similarity_embeddings(
            artifact_id, kind, source_path, object_hash,
            embedding_space, dimensions, vector_blob, frame_count, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          artifact.artifact_id,
          kind,
          source.path,
          source.object_hash,
          provider.embeddingSpace,
          provider.dimensions,
          vectorToBlob(embedded.vector),
          embedded.frameCount,
          now,
        );
      return this.embeddingById(Number(result.lastInsertRowid));
    });
    this.addToCachedIndex(row, embedded.vector);
    return this.indexResult(row, embedded.reused);
  }

  private async indexText(
    artifact: ArtifactRow,
    options: SimilarityIndexOptions,
  ): Promise<SimilarityIndexResult> {
    const provider = this.requireTextProvider();
    const source = this.sourceFor(artifact, "text");
    const normalizedSource = await this.readNormalizedText(source);
    const existing = this.textDocumentForArtifact(
      artifact.artifact_id,
      provider.embeddingSpace,
    );
    if (
      existing &&
      existing.object_hash === source.object_hash &&
      existing.content_hash === normalizedSource.contentHash &&
      existing.dimensions === provider.dimensions &&
      !options.force
    ) {
      return this.textIndexResult(existing, true);
    }
    const reusable = !options.force
      ? this.textDocumentForObjectOrContent(
          source.object_hash,
          normalizedSource.contentHash,
          provider.embeddingSpace,
          provider.dimensions,
        )
      : null;
    const embeddedChunks = reusable
      ? this.textChunksForDocument(reusable.id).map((chunk) => ({
          startOffset: chunk.start_offset,
          endOffset: chunk.end_offset,
          vector: vectorFromBlob(chunk),
        }))
      : await this.embedText(normalizedSource.text);
    const maxChunks = checkedTextMaxChunks(this.context.config.similarity?.text);
    if (embeddedChunks.length > maxChunks) {
      throw new EngineFault({
        code: "INVALID_INPUT",
        message: `Text source produces more than ${maxChunks} chunks`,
      });
    }
    this.validateTextChunks(
      normalizedSource.text,
      embeddedChunks,
      provider.dimensions,
    );
    this.indexes.delete(indexKey("text", provider.embeddingSpace));
    const row = this.context.store.runtime((now) => {
      let documentId: number;
      if (existing) {
        documentId = existing.id;
        this.context.store.db
          .prepare(
            `UPDATE runtime_text_similarity_documents
             SET source_path=?, object_hash=?, content_hash=?,
                 dimensions=?, chunk_count=?, updated_at=?
             WHERE id=?`,
          )
          .run(
            source.path,
            source.object_hash,
            normalizedSource.contentHash,
            provider.dimensions,
            embeddedChunks.length,
            now,
            documentId,
          );
        this.context.store.db
          .prepare(
            "DELETE FROM runtime_text_similarity_chunks WHERE document_id=?",
          )
          .run(documentId);
      } else {
        const result = this.context.store.db
          .prepare(
            `INSERT INTO runtime_text_similarity_documents(
              artifact_id, source_path, object_hash, content_hash,
              embedding_space, dimensions, chunk_count, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            artifact.artifact_id,
            source.path,
            source.object_hash,
            normalizedSource.contentHash,
            provider.embeddingSpace,
            provider.dimensions,
            embeddedChunks.length,
            now,
          );
        documentId = Number(result.lastInsertRowid);
      }
      const insertChunk = this.context.store.db.prepare(
        `INSERT INTO runtime_text_similarity_chunks(
          document_id, artifact_id, embedding_space, chunk_index,
          start_offset, end_offset, chunk_text, dimensions, vector_blob, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      embeddedChunks.forEach((chunk, index) => {
        insertChunk.run(
          documentId,
          artifact.artifact_id,
          provider.embeddingSpace,
          index,
          chunk.startOffset,
          chunk.endOffset,
          normalizedSource.text.slice(chunk.startOffset, chunk.endOffset),
          provider.dimensions,
          vectorToBlob(normalized(chunk.vector)),
          now,
        );
      });
      return this.textDocumentById(documentId);
    });
    return this.textIndexResult(row, Boolean(reusable));
  }

  private async findSimilarTextArtifact(
    artifact: ArtifactRow,
    options: SimilarityQueryOptions,
  ): Promise<SimilarityMatch[]> {
    const provider = this.requireTextProvider();
    const query = this.textDocumentForArtifact(
      artifact.artifact_id,
      provider.embeddingSpace,
    );
    if (!query) {
      throw new EngineFault({
        code: "NOT_READY",
        message: `Artifact is not indexed for similarity: ${artifact.slug}`,
        details: { artifactId: artifact.artifact_id },
      });
    }
    const queryChunks = this.textChunksForDocument(query.id).map((chunk) => ({
      startOffset: chunk.start_offset,
      endOffset: chunk.end_offset,
      vector: vectorFromBlob(chunk),
    }));
    return this.searchText(
      artifact.artifact_id,
      query.object_hash,
      query.content_hash,
      queryChunks,
      options,
      provider,
    );
  }

  private async findSimilarMedia(
    artifact: ArtifactRow,
    kind: MediaSimilarityKind,
    options: SimilarityQueryOptions,
  ): Promise<SimilarityMatch[]> {
    const limit = checkedLimit(options.limit);
    const minScore = checkedMinScore(options.minScore);
    const provider = this.providerFor(kind);
    const query = this.embeddingForArtifact(
      artifact.artifact_id,
      provider.embeddingSpace,
    );
    if (!query) {
      throw new EngineFault({
        code: "NOT_READY",
        message: `Artifact is not indexed for similarity: ${artifact.slug}`,
        details: { artifactId: artifact.artifact_id },
      });
    }
    const index = this.indexFor(
      kind,
      query.embedding_space,
      query.dimensions,
    );
    if (index.index.size() === 0) return [];
    const candidateCount = Math.min(
      index.index.size(),
      Math.max(20, limit * 5),
    );
    const nearest = index.index.search(
      vectorFromBlob(query),
      candidateCount,
      0,
    );
    const ids = new Set<number>();
    for (const key of nearest.keys) ids.add(Number(key));
    for (const exact of this.exactObjectEmbeddings(
      kind,
      query.object_hash,
      query.embedding_space,
    )) {
      ids.add(exact.id);
    }
    const candidates = this.activeEmbeddingsByIds(
      kind,
      query.embedding_space,
      [...ids],
    );
    const queryVector = vectorFromBlob(query);
    return candidates
      .filter(
        (candidate) =>
          options.includeSelf === true ||
          candidate.artifact_id !== artifact.artifact_id,
      )
      .map((candidate) => {
        const exactBytes = candidate.object_hash === query.object_hash;
        const global = exactBytes
          ? 1
          : cosine(queryVector, vectorFromBlob(candidate));
        return {
          artifactId: candidate.artifact_id,
          slug: candidate.slug ?? candidate.artifact_id,
          kind: candidate.kind,
          score: global,
          exactBytes,
          embeddingSpace: candidate.embedding_space,
          signals: { global },
        } satisfies SimilarityMatch;
      })
      .filter((match) => minScore === undefined || match.score >= minScore)
      .sort(
        (left, right) =>
          right.score - left.score ||
          left.artifactId.localeCompare(right.artifactId),
      )
      .slice(0, limit);
  }

  private searchText(
    queryArtifactId: string | null,
    queryObjectHash: string | null,
    queryContentHash: string,
    queryChunks: SimilarityTextChunk[],
    options: SimilarityQueryOptions,
    provider: SimilarityTextEmbeddingProvider,
  ): SimilarityMatch[] {
    const limit = checkedLimit(options.limit);
    const minScore = checkedMinScore(options.minScore);
    if (queryChunks.length === 0) return [];
    const index = this.textIndexFor(
      provider.embeddingSpace,
      provider.dimensions,
    );
    if (index.index.size() === 0) return [];
    const candidateCount = Math.min(
      index.index.size(),
      Math.max(50, limit * 10),
    );
    const nearest = index.index.search(
      queryChunks.map((chunk) => normalized(chunk.vector)),
      candidateCount,
      0,
    );
    const pairs = new Map<number, TextSearchPair[]>();
    for (let queryIndex = 0; queryIndex < queryChunks.length; queryIndex += 1) {
      const matches = queryChunks.length === 1
        ? nearest
        : nearest.get(queryIndex);
      for (const key of matches.keys) {
        const chunkId = Number(key);
        const current = pairs.get(chunkId) ?? [];
        current.push({ chunkId, queryChunkIndex: queryIndex });
        pairs.set(chunkId, current);
      }
    }
    const exactDocuments = new Map<number, {
      exactBytes: boolean;
      exactContent: boolean;
    }>();
    if (queryObjectHash) {
      for (const document of this.textDocumentsForHash(
        "object_hash",
        queryObjectHash,
        provider,
      )) {
        exactDocuments.set(document.id, {
          exactBytes: true,
          exactContent: document.content_hash === queryContentHash,
        });
      }
    }
    for (const document of this.textDocumentsForHash(
      "content_hash",
      queryContentHash,
      provider,
    )) {
      const current = exactDocuments.get(document.id);
      exactDocuments.set(document.id, {
        exactBytes: current?.exactBytes ?? false,
        exactContent: true,
      });
    }
    for (const document of exactDocuments.keys()) {
      const first = this.textChunksForDocument(document)[0];
      if (first) {
        const current = pairs.get(first.id) ?? [];
        current.push({
          chunkId: first.id,
          queryChunkIndex: 0,
          exactBytes: exactDocuments.get(document)?.exactBytes,
          exactContent: exactDocuments.get(document)?.exactContent,
        });
        pairs.set(first.id, current);
      }
    }
    const chunks = this.activeTextChunksByIds(
      provider.embeddingSpace,
      provider.dimensions,
      [...pairs.keys()],
    );
    const best = new Map<number, {
      chunk: TextChunkRow;
      queryChunkIndex: number;
      score: number;
      exactBytes: boolean;
      exactContent: boolean;
    }>();
    for (const chunk of chunks) {
      for (const pair of pairs.get(chunk.id) ?? []) {
        const queryChunk = queryChunks[pair.queryChunkIndex];
        if (!queryChunk) continue;
        const exactBytes = pair.exactBytes === true ||
          chunk.object_hash === queryObjectHash;
        const exactContent = pair.exactContent === true ||
          chunk.content_hash === queryContentHash;
        const score = exactBytes || exactContent
          ? 1
          : cosine(normalized(queryChunk.vector), vectorFromBlob(chunk));
        const current = best.get(chunk.document_id);
        if (!current || score > current.score) {
          best.set(chunk.document_id, {
            chunk,
            queryChunkIndex: pair.queryChunkIndex,
            score,
            exactBytes,
            exactContent,
          });
        }
      }
    }
    return [...best.entries()]
      .filter(([, match]) =>
        options.includeSelf === true ||
        queryArtifactId === null || match.chunk.artifact_id !== queryArtifactId,
      )
      .map(([, match]) => {
        const queryChunk = queryChunks[match.queryChunkIndex];
        return {
          artifactId: match.chunk.artifact_id,
          slug: match.chunk.slug ?? match.chunk.artifact_id,
          kind: "text" as const,
          score: match.score,
          exactBytes: match.exactBytes,
          exactContent: match.exactContent,
          embeddingSpace: match.chunk.embedding_space,
          text: {
            sourcePath: match.chunk.source_path ?? "original.txt",
            chunkIndex: match.chunk.chunk_index,
            startOffset: match.chunk.start_offset,
            endOffset: match.chunk.end_offset,
            excerpt: excerpt(match.chunk.chunk_text),
            ...(queryChunk
              ? {
                  queryStartOffset: queryChunk.startOffset,
                  queryEndOffset: queryChunk.endOffset,
                }
              : {}),
          },
          signals: { global: match.score },
        } satisfies SimilarityMatch;
      })
      .filter((match) => minScore === undefined || match.score >= minScore)
      .sort(
        (left, right) =>
          right.score - left.score ||
          left.artifactId.localeCompare(right.artifactId),
      )
      .slice(0, limit);
  }

  private async embedMediaSource(source: SelectedSource): Promise<{
    vector: Float32Array;
    frameCount: number | null;
    reused: boolean;
  }> {
    const localPath = await this.context.objects.ensureLocalPath(
      source.object_hash,
    );
    if (source.kind === "audio") {
      const provider = this.requireAudioProvider();
      await provider.prepare();
      return {
        vector: normalized(await provider.embedAudio(localPath)),
        frameCount: null,
        reused: false,
      };
    }
    await this.provider.prepare();
    if (source.kind === "image") {
      return {
        vector: normalized(await this.provider.embedImage(localPath)),
        frameCount: null,
        reused: false,
      };
    }
    const video = await this.provider.embedVideo(localPath);
    return {
      vector: normalized(video.vector),
      frameCount: video.frameCount,
      reused: false,
    };
  }

  private async embedText(text: string): Promise<SimilarityTextChunk[]> {
    const provider = this.requireTextProvider();
    await provider.prepare();
    const chunks = await provider.embedText(text);
    this.validateTextChunks(text, chunks, provider.dimensions);
    const maxChunks = checkedTextMaxChunks(this.context.config.similarity?.text);
    if (chunks.length > maxChunks) {
      throw new EngineFault({
        code: "INVALID_INPUT",
        message: `Text source produces more than ${maxChunks} chunks`,
      });
    }
    return chunks.map((chunk) => ({
      ...chunk,
      vector: normalized(chunk.vector),
    }));
  }

  private async readNormalizedText(source: SelectedSource): Promise<NormalizedText> {
    const maxBytes = checkedTextMaxBytes(this.context.config.similarity?.text);
    const localPath = await this.context.objects.ensureLocalPath(source.object_hash);
    const bytes = await readFile(localPath);
    if (bytes.byteLength > maxBytes) {
      throw new EngineFault({
        code: "INVALID_INPUT",
        message: `Text source exceeds the ${maxBytes}-byte similarity limit`,
      });
    }
    let raw: string;
    try {
      raw = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      throw new EngineFault({
        code: "INVALID_INPUT",
        message: `Text source is not valid UTF-8: ${source.path}`,
      });
    }
    const extension = path.extname(source.path).toLowerCase();
    const normalizedText = extension === ".json"
      ? normalizeJsonText(raw, source.path)
      : normalizePlainText(raw);
    if (normalizedText.text.length === 0) {
      throw new EngineFault({
        code: "INVALID_INPUT",
        message: `Text source is empty: ${source.path}`,
      });
    }
    return normalizedText;
  }

  private validateTextChunks(
    text: string,
    chunks: SimilarityTextChunk[],
    dimensions: number,
  ): void {
    if (chunks.length === 0) {
      throw new EngineFault({
        code: "INVALID_INPUT",
        message: "Text provider returned no chunks",
      });
    }
    let previousStart = -1;
    for (const chunk of chunks) {
      if (
        !Number.isInteger(chunk.startOffset) ||
        !Number.isInteger(chunk.endOffset) ||
        chunk.startOffset < 0 ||
        chunk.endOffset <= chunk.startOffset ||
        chunk.endOffset > text.length ||
        chunk.startOffset < previousStart
      ) {
        throw new EngineFault({
          code: "INVALID_INPUT",
          message: "Text provider returned invalid chunk offsets",
        });
      }
      if (chunk.vector.length !== dimensions) {
        throw new EngineFault({
          code: "INVALID_INPUT",
          message: `Text provider returned ${chunk.vector.length} dimensions; expected ${dimensions}`,
        });
      }
      normalized(chunk.vector);
      previousStart = chunk.startOffset;
    }
  }

  private sourceFor(
    artifact: ArtifactRow,
    kind: SimilarityKind,
  ): SelectedSource {
    const rows = this.context.store.db
      .prepare(
        `SELECT artifact_id, path, object_hash, size_bytes, mime_type,
                mtime_ms, created_at
         FROM artifact_files
         WHERE artifact_id=?
         ORDER BY path`,
      )
      .all(artifact.artifact_id) as unknown as FileRow[];
    const extension = kind === "image"
      ? "(?:png|jpe?g|webp)"
      : kind === "video"
        ? "(?:mp4|mov|webm|mkv|avi)"
        : kind === "audio"
          ? "(?:mp3|wav|ogg|flac|aac|m4a)"
          : "(?:json|md|txt)";
    const sources = rows.filter((row) =>
      new RegExp(`(?:^|/)original\\.${extension}$`, "i").test(row.path),
    );
    if (sources.length === 0) {
      throw new EngineFault({
        code: "INVALID_INPUT",
        message: `No supported original ${kind} file for ${artifact.slug}`,
      });
    }
    if (kind === "text" && sources.length > 1) {
      throw new EngineFault({
        code: "INVALID_INPUT",
        message: `Multiple supported original ${kind} files for ${artifact.slug}`,
        details: { paths: sources.map((source) => source.path) },
      });
    }
    return { ...sources[0]!, kind };
  }

  private hasTextSource(artifactId: string): boolean {
    const rows = this.context.store.db
      .prepare("SELECT path FROM artifact_files WHERE artifact_id=?")
      .all(artifactId) as unknown as Array<{ path: string }>;
    return rows.some((row) => /(?:^|\/)original\.(?:json|md|txt)$/i.test(row.path));
  }

  private embeddingForArtifact(
    artifactId: string,
    embeddingSpace: string,
  ): EmbeddingRow | null {
    const row = this.context.store.db
      .prepare(
        `SELECT id, artifact_id, kind, source_path, object_hash,
                embedding_space, dimensions, vector_blob, frame_count, updated_at
         FROM runtime_similarity_embeddings
         WHERE artifact_id=? AND embedding_space=?`,
      )
      .get(artifactId, embeddingSpace) as unknown as EmbeddingRow | undefined;
    return row ?? null;
  }

  private embeddingForObject(
    objectHash: string,
    kind: MediaSimilarityKind,
    embeddingSpace: string,
    dimensions: number,
  ): EmbeddingRow | null {
    const row = this.context.store.db
      .prepare(
        `SELECT id, artifact_id, kind, source_path, object_hash,
                embedding_space, dimensions, vector_blob, frame_count, updated_at
         FROM runtime_similarity_embeddings
         WHERE object_hash=? AND kind=? AND embedding_space=? AND dimensions=?
         ORDER BY updated_at DESC, id DESC LIMIT 1`,
      )
      .get(objectHash, kind, embeddingSpace, dimensions) as unknown as
      | EmbeddingRow
      | undefined;
    return row ?? null;
  }

  private embeddingById(id: number): EmbeddingRow {
    const row = this.context.store.db
      .prepare(
        `SELECT id, artifact_id, kind, source_path, object_hash,
                embedding_space, dimensions, vector_blob, frame_count, updated_at
         FROM runtime_similarity_embeddings WHERE id=?`,
      )
      .get(id) as unknown as EmbeddingRow | undefined;
    if (!row) throw new Error(`Similarity embedding not found: ${id}`);
    return row;
  }

  private exactObjectEmbeddings(
    kind: MediaSimilarityKind,
    objectHash: string,
    embeddingSpace: string,
  ): EmbeddingRow[] {
    return this.context.store.db
      .prepare(
        `SELECT id, artifact_id, kind, source_path, object_hash,
                embedding_space, dimensions, vector_blob, frame_count, updated_at
         FROM runtime_similarity_embeddings
         WHERE kind=? AND object_hash=? AND embedding_space=?`,
      )
      .all(kind, objectHash, embeddingSpace) as unknown as EmbeddingRow[];
  }

  private activeEmbeddingsByIds(
    kind: MediaSimilarityKind,
    embeddingSpace: string,
    ids: number[],
  ): EmbeddingRow[] {
    if (ids.length === 0) return [];
    const placeholders = ids.map(() => "?").join(", ");
    return this.context.store.db
      .prepare(
        `SELECT e.id, e.artifact_id, e.kind, e.source_path,
                e.object_hash, e.embedding_space, e.dimensions, e.vector_blob,
                e.frame_count, e.updated_at, a.slug
         FROM runtime_similarity_embeddings e
         JOIN artifacts a ON a.artifact_id=e.artifact_id
         WHERE e.kind=? AND e.embedding_space=?
           AND a.deleted_at IS NULL
           AND e.id IN (${placeholders})`,
      )
      .all(kind, embeddingSpace, ...ids) as unknown as EmbeddingRow[];
  }

  private indexFor(
    kind: MediaSimilarityKind,
    embeddingSpace: string,
    dimensions: number,
  ): CachedIndex {
    return this.cachedIndex(
      kind,
      embeddingSpace,
      dimensions,
      `SELECT e.id, e.artifact_id, e.kind, e.source_path,
              e.object_hash, e.embedding_space, e.dimensions, e.vector_blob,
              e.frame_count, e.updated_at
       FROM runtime_similarity_embeddings e
       JOIN artifacts a ON a.artifact_id=e.artifact_id
       WHERE e.kind=? AND e.embedding_space=?
         AND e.dimensions=? AND a.deleted_at IS NULL
       ORDER BY e.id`,
    );
  }

  private textIndexFor(
    embeddingSpace: string,
    dimensions: number,
  ): CachedIndex {
    const key = indexKey("text", embeddingSpace);
    const current = this.indexes.get(key);
    if (current) return current;
    const index = new Index({
      dimensions,
      metric: MetricKind.Cos,
      quantization: ScalarKind.F16,
      connectivity: 16,
      expansion_add: 128,
      expansion_search: 128,
      multi: false,
    });
    const rows = this.context.store.db
      .prepare(
        `SELECT c.id, c.document_id, c.artifact_id,
                c.embedding_space, c.chunk_index, c.start_offset,
                c.end_offset, c.chunk_text, c.dimensions, c.vector_blob,
                c.updated_at
         FROM runtime_text_similarity_chunks c
         JOIN artifacts a ON a.artifact_id=c.artifact_id
         WHERE c.embedding_space=?
           AND c.dimensions=? AND a.deleted_at IS NULL
         ORDER BY c.id`,
      )
      .all(embeddingSpace, dimensions) as unknown as TextChunkRow[];
    for (const row of rows) {
      index.add(BigInt(row.id), vectorFromBlob(row), 0);
    }
    const cached = { index, dimensions };
    this.indexes.set(key, cached);
    return cached;
  }

  private cachedIndex(
    kind: MediaSimilarityKind,
    embeddingSpace: string,
    dimensions: number,
    sql: string,
  ): CachedIndex {
    const key = indexKey(kind, embeddingSpace);
    const current = this.indexes.get(key);
    if (current) return current;
    const index = new Index({
      dimensions,
      metric: MetricKind.Cos,
      quantization: ScalarKind.F16,
      connectivity: 16,
      expansion_add: 128,
      expansion_search: 128,
      multi: false,
    });
    const rows = this.context.store.db
      .prepare(sql)
      .all(kind, embeddingSpace, dimensions) as unknown as EmbeddingRow[];
    for (const row of rows) {
      index.add(BigInt(row.id), vectorFromBlob(row), 0);
    }
    const cached = { index, dimensions };
    this.indexes.set(key, cached);
    return cached;
  }

  private addToCachedIndex(row: EmbeddingRow, vector: Float32Array): void {
    const cached = this.indexes.get(
      indexKey(row.kind, row.embedding_space),
    );
    if (!cached) return;
    if (cached.dimensions !== vector.length) {
      throw new Error("Similarity index dimension mismatch");
    }
    try {
      cached.index.remove(BigInt(row.id));
    } catch {
      // The row may not have been part of an index built before it existed.
    }
    cached.index.add(BigInt(row.id), vector, 0);
  }

  private textDocumentForArtifact(
    artifactId: string,
    embeddingSpace: string,
  ): TextDocumentRow | null {
    const row = this.context.store.db
      .prepare(
        `SELECT id, artifact_id, source_path, object_hash,
                content_hash, embedding_space, dimensions, chunk_count, updated_at
         FROM runtime_text_similarity_documents
         WHERE artifact_id=? AND embedding_space=?`,
      )
      .get(artifactId, embeddingSpace) as unknown as TextDocumentRow | undefined;
    return row ?? null;
  }

  private textDocumentById(id: number): TextDocumentRow {
    const row = this.context.store.db
      .prepare(
        `SELECT id, artifact_id, source_path, object_hash,
                content_hash, embedding_space, dimensions, chunk_count, updated_at
         FROM runtime_text_similarity_documents WHERE id=?`,
      )
      .get(id) as unknown as TextDocumentRow | undefined;
    if (!row) throw new Error(`Text similarity document not found: ${id}`);
    return row;
  }

  private textDocumentForObjectOrContent(
    objectHash: string,
    contentHash: string,
    embeddingSpace: string,
    dimensions: number,
  ): TextDocumentRow | null {
    const row = this.context.store.db
      .prepare(
        `SELECT id, artifact_id, source_path, object_hash,
                content_hash, embedding_space, dimensions, chunk_count, updated_at
         FROM runtime_text_similarity_documents
         WHERE (object_hash=? OR content_hash=?)
           AND embedding_space=? AND dimensions=?
         ORDER BY updated_at DESC, id DESC LIMIT 1`,
      )
      .get(objectHash, contentHash, embeddingSpace, dimensions) as unknown as
      | TextDocumentRow
      | undefined;
    return row ?? null;
  }

  private textDocumentsForHash(
    column: "object_hash" | "content_hash",
    hash: string,
    provider: SimilarityTextEmbeddingProvider,
  ): TextDocumentRow[] {
    return this.context.store.db
      .prepare(
        `SELECT id, artifact_id, source_path, object_hash,
                content_hash, embedding_space, dimensions, chunk_count, updated_at
         FROM runtime_text_similarity_documents
         WHERE ${column}=? AND embedding_space=?
           AND dimensions=?`,
      )
      .all(hash, provider.embeddingSpace, provider.dimensions) as unknown as
      TextDocumentRow[];
  }

  private textChunksForDocument(documentId: number): TextChunkRow[] {
    return this.context.store.db
      .prepare(
        `SELECT id, document_id, artifact_id, embedding_space,
                chunk_index, start_offset, end_offset, chunk_text, dimensions,
                vector_blob, updated_at
         FROM runtime_text_similarity_chunks
         WHERE document_id=? ORDER BY chunk_index`,
      )
      .all(documentId) as unknown as TextChunkRow[];
  }

  private activeTextChunksByIds(
    embeddingSpace: string,
    dimensions: number,
    ids: number[],
  ): TextChunkRow[] {
    if (ids.length === 0) return [];
    const placeholders = ids.map(() => "?").join(", ");
    return this.context.store.db
      .prepare(
        `SELECT c.id, c.document_id, c.artifact_id,
                c.embedding_space, c.chunk_index, c.start_offset,
                c.end_offset, c.chunk_text, c.dimensions, c.vector_blob,
                c.updated_at, d.source_path, d.object_hash, d.content_hash,
                a.slug
         FROM runtime_text_similarity_chunks c
         JOIN runtime_text_similarity_documents d ON d.id=c.document_id
         JOIN artifacts a ON a.artifact_id=c.artifact_id
         WHERE c.embedding_space=? AND c.dimensions=?
           AND a.deleted_at IS NULL
           AND c.id IN (${placeholders})`,
      )
      .all(embeddingSpace, dimensions, ...ids) as unknown as TextChunkRow[];
  }

  private indexResult(
    row: EmbeddingRow,
    reused: boolean,
  ): SimilarityIndexResult {
    return {
      artifactId: row.artifact_id,
      kind: row.kind,
      embeddingSpace: row.embedding_space,
      frameCount: row.frame_count,
      reused,
    };
  }

  private textIndexResult(
    row: TextDocumentRow,
    reused: boolean,
  ): SimilarityIndexResult {
    return {
      artifactId: row.artifact_id,
      kind: "text",
      embeddingSpace: row.embedding_space,
      frameCount: null,
      chunkCount: row.chunk_count,
      reused,
    };
  }

  private providerFor(kind: MediaSimilarityKind): MediaEmbeddingProvider {
    return kind === "audio" ? this.requireAudioProvider() : this.provider;
  }

  private requireAudioProvider(): SimilarityAudioEmbeddingProvider {
    if (!this.audioProvider) {
      throw new EngineFault({
        code: "FEATURE_UNAVAILABLE",
        message: "Audio similarity is disabled; configure EngineConfig.similarity.audio",
      });
    }
    return this.audioProvider;
  }

  private requireTextProvider(): SimilarityTextEmbeddingProvider {
    if (!this.textProvider) {
      throw new EngineFault({
        code: "FEATURE_UNAVAILABLE",
        message: "Text similarity is disabled; configure EngineConfig.similarity.text",
      });
    }
    return this.textProvider;
  }
}

class LocalClipProvider implements SimilarityEmbeddingProvider {
  readonly embeddingSpace = DEFAULT_EMBEDDING_SPACE;
  readonly dimensions = DEFAULT_DIMENSIONS;
  private embedder: FeaturePipeline | null = null;

  constructor(
    private readonly context: EngineContext,
    private readonly config: SimilarityConfig,
  ) {}

  async prepare(): Promise<void> {
    await this.loadEmbedder();
  }

  async embedImage(sourcePath: string): Promise<Float32Array> {
    const vectors = await this.embedImages([sourcePath]);
    const vector = vectors[0];
    if (!vector) throw new Error("Image embedder returned no vector");
    return vector;
  }

  async embedVideo(sourcePath: string): Promise<{
    vector: Float32Array;
    frameCount: number;
  }> {
    const duration = await probeDuration(
      this.config.ffprobePath ?? "ffprobe",
      sourcePath,
    );
    const frameCount = Math.min(120, Math.max(1, Math.ceil(duration / 2)));
    const framesDir = await mkdtemp(path.join(tmpdir(), "videobook-sim-"));
    try {
      const fps = `${frameCount}/${Math.max(duration, 0.001)}`;
      await runCommand(this.config.ffmpegPath ?? "ffmpeg", [
        "-hide_banner",
        "-loglevel",
        "error",
        "-i",
        sourcePath,
        "-an",
        "-vf",
        `fps=${fps},scale=224:224:force_original_aspect_ratio=increase,crop=224:224`,
        "-frames:v",
        String(frameCount),
        path.join(framesDir, "frame-%04d.png"),
      ]);
      const frames = (await readdir(framesDir))
        .filter((name) => name.endsWith(".png"))
        .sort()
        .map((name) => path.join(framesDir, name));
      if (frames.length === 0) {
        throw new EngineFault({
          code: "INVALID_INPUT",
          message: `No video frames could be decoded from ${sourcePath}`,
        });
      }
      const vectors: Float32Array[] = [];
      for (let offset = 0; offset < frames.length; offset += 8) {
        vectors.push(...(await this.embedImages(frames.slice(offset, offset + 8))));
      }
      return { vector: normalizedCentroid(vectors), frameCount: vectors.length };
    } finally {
      await rm(framesDir, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  private async loadEmbedder(): Promise<FeaturePipeline> {
    if (this.embedder) return this.embedder;
    const dataDir = this.context.config.dataDir;
    if (!dataDir) throw new Error("Similarity requires a configured dataDir");
    const cacheDir = this.config.modelCacheDir ?? path.join(
      dataDir,
      "similarity-models",
    );
    await mkdir(cacheDir, { recursive: true });
    const modelId = this.config.modelId ?? DEFAULT_MODEL_ID;
    try {
      this.embedder = await pipeline("image-feature-extraction", modelId, {
        dtype: "q8",
        cache_dir: cacheDir,
        local_files_only: this.config.allowModelDownload === false,
        ...(modelId === DEFAULT_MODEL_ID
          ? { revision: DEFAULT_MODEL_REVISION }
          : {}),
      }) as unknown as FeaturePipeline;
      return this.embedder;
    } catch (error) {
      throw new EngineFault({
        code: this.config.allowModelDownload === false ? "OFFLINE" : "FEATURE_UNAVAILABLE",
        message: `Unable to load local similarity model: ${errorMessage(error)}`,
      });
    }
  }

  private async embedImages(sourcePaths: string[]): Promise<Float32Array[]> {
    const embedder = await this.loadEmbedder();
    const images = await Promise.all(sourcePaths.map(readNormalizedImage));
    const output = await embedder(images);
    const batch = output.dims[0];
    const dimensions = output.dims[1];
    if (batch !== sourcePaths.length || dimensions !== this.dimensions) {
      throw new Error(`Unexpected embedding shape: ${output.dims.join("x")}`);
    }
    const vectors: Float32Array[] = [];
    for (let index = 0; index < batch; index += 1) {
      const start = index * this.dimensions;
      vectors.push(normalized(output.data.slice(start, start + this.dimensions)));
    }
    return vectors;
  }
}

class LocalClapAudioProvider implements SimilarityAudioEmbeddingProvider {
  readonly embeddingSpace: string;
  readonly dimensions = DEFAULT_AUDIO_DIMENSIONS;
  private processor: AudioProcessor | null = null;
  private model: AudioModel | null = null;
  private sampleRate = DEFAULT_AUDIO_SAMPLE_RATE;
  private maxSamples = DEFAULT_AUDIO_MAX_SAMPLES;

  constructor(
    private readonly context: EngineContext,
    private readonly sharedConfig: SimilarityConfig,
    private readonly config: SimilarityAudioConfig,
  ) {
    this.embeddingSpace =
      config.modelId && config.modelId !== DEFAULT_AUDIO_MODEL_ID
        ? `audio-${config.modelId.replace(/[^a-zA-Z0-9]+/g, "-")}-v1`
        : DEFAULT_AUDIO_EMBEDDING_SPACE;
  }

  async prepare(): Promise<void> {
    await this.loadModel();
  }

  async embedAudio(sourcePath: string): Promise<Float32Array> {
    const { processor, model } = await this.loadModel();
    const audio = await decodeAudioToMono(
      this.config.ffmpegPath ?? this.sharedConfig.ffmpegPath ?? "ffmpeg",
      sourcePath,
      this.sampleRate,
      this.maxSamples,
    );
    const inputs = await processor(audio);
    const output = await model(inputs);
    const dimensions = output.audio_embeds.dims;
    if (
      dimensions.length !== 2 ||
      dimensions[0] !== 1 ||
      dimensions[1] !== this.dimensions ||
      output.audio_embeds.data.length !== this.dimensions
    ) {
      throw new Error(
        `Unexpected audio embedding shape: ${dimensions.join("x")}`,
      );
    }
    return output.audio_embeds.data.slice();
  }

  private async loadModel(): Promise<{
    processor: AudioProcessor;
    model: AudioModel;
  }> {
    if (this.processor && this.model) {
      return { processor: this.processor, model: this.model };
    }
    const dataDir = this.context.config.dataDir;
    if (!dataDir) throw new Error("Audio similarity requires a configured dataDir");
    const cacheDir = this.config.modelCacheDir ??
      this.sharedConfig.modelCacheDir ??
      path.join(dataDir, "similarity-models");
    await mkdir(cacheDir, { recursive: true });
    const modelId = this.config.modelId ?? DEFAULT_AUDIO_MODEL_ID;
    const allowDownload = this.config.allowModelDownload ??
      this.sharedConfig.allowModelDownload;
    const pinned = modelId === DEFAULT_AUDIO_MODEL_ID
      ? { revision: DEFAULT_AUDIO_MODEL_REVISION }
      : {};
    try {
      const processor = await AutoProcessor.from_pretrained(modelId, {
        cache_dir: cacheDir,
        local_files_only: allowDownload === false,
        ...pinned,
      }) as unknown as AudioProcessor;
      const model = await ClapAudioModelWithProjection.from_pretrained(
        modelId,
        {
          dtype: "q8",
          cache_dir: cacheDir,
          local_files_only: allowDownload === false,
          ...pinned,
        },
      ) as unknown as AudioModel;
      const featureConfig = processor.feature_extractor?.config;
      this.sampleRate = checkedAudioSampleRate(
        featureConfig?.sampling_rate,
      );
      this.maxSamples = checkedAudioMaxSamples(
        featureConfig?.nb_max_samples,
        this.sampleRate,
      );
      this.processor = processor;
      this.model = model;
      return { processor, model };
    } catch (error) {
      throw new EngineFault({
        code: allowDownload === false ? "OFFLINE" : "FEATURE_UNAVAILABLE",
        message: `Unable to load local audio similarity model: ${errorMessage(error)}`,
      });
    }
  }
}

class LocalTextProvider implements SimilarityTextEmbeddingProvider {
  readonly embeddingSpace: string;
  readonly dimensions = DEFAULT_TEXT_DIMENSIONS;
  private embedder: TextFeaturePipeline | null = null;

  constructor(
    private readonly context: EngineContext,
    private readonly sharedConfig: SimilarityConfig,
    private readonly config: SimilarityTextConfig,
  ) {
    this.embeddingSpace = config.modelId && config.modelId !== DEFAULT_TEXT_MODEL_ID
      ? `text-${config.modelId.replace(/[^a-zA-Z0-9]+/g, "-")}-v1`
      : DEFAULT_TEXT_EMBEDDING_SPACE;
  }

  async prepare(): Promise<void> {
    await this.loadEmbedder();
  }

  async embedText(text: string): Promise<SimilarityTextChunk[]> {
    const embedder = await this.loadEmbedder();
    const ranges = makeTextRanges(text, embedder.tokenizer);
    const chunks: SimilarityTextChunk[] = [];
    for (let offset = 0; offset < ranges.length; offset += 32) {
      const batchRanges = ranges.slice(offset, offset + 32);
      const output = await embedder(
        batchRanges.map((range) => text.slice(range.startOffset, range.endOffset)),
        { pooling: "mean", normalize: true },
      );
      const batch = output.dims[0];
      const dimensions = output.dims[1];
      if (batch !== batchRanges.length || dimensions !== this.dimensions) {
        throw new Error(`Unexpected text embedding shape: ${output.dims.join("x")}`);
      }
      for (let index = 0; index < batch; index += 1) {
        const start = index * this.dimensions;
        chunks.push({
          startOffset: batchRanges[index]!.startOffset,
          endOffset: batchRanges[index]!.endOffset,
          vector: normalized(output.data.slice(start, start + this.dimensions)),
        });
      }
    }
    return chunks;
  }

  private async loadEmbedder(): Promise<TextFeaturePipeline> {
    if (this.embedder) return this.embedder;
    const dataDir = this.context.config.dataDir;
    if (!dataDir) throw new Error("Text similarity requires a configured dataDir");
    const cacheDir = this.config.modelCacheDir ??
      this.sharedConfig.modelCacheDir ??
      path.join(dataDir, "similarity-models");
    await mkdir(cacheDir, { recursive: true });
    const modelId = this.config.modelId ?? DEFAULT_TEXT_MODEL_ID;
    const allowDownload = this.config.allowModelDownload ??
      this.sharedConfig.allowModelDownload;
    try {
      this.embedder = await pipeline("feature-extraction", modelId, {
        dtype: "q4",
        cache_dir: cacheDir,
        local_files_only: allowDownload === false,
        ...(modelId === DEFAULT_TEXT_MODEL_ID
          ? { revision: DEFAULT_TEXT_MODEL_REVISION }
          : {}),
      }) as unknown as TextFeaturePipeline;
      return this.embedder;
    } catch (error) {
      throw new EngineFault({
        code: allowDownload === false ? "OFFLINE" : "FEATURE_UNAVAILABLE",
        message: `Unable to load local text similarity model: ${errorMessage(error)}`,
      });
    }
  }
}

function disabledSimilarityApi(): SimilarityApi {
  const unavailable = (): Result<never, EngineError> =>
    err({
      code: "FEATURE_UNAVAILABLE",
      message: "Similarity is disabled; configure EngineConfig.similarity to enable it",
    });
  return {
    prepare: async () => unavailable(),
    index: async () => unavailable(),
    rebuild: async () => unavailable(),
    status: () => unavailable(),
    stats: () => unavailable(),
    findSimilar: async () => unavailable(),
    findSimilarText: async () => unavailable(),
  };
}

function similarityKind(artifact: ArtifactRow): SimilarityKind {
  if (
    artifact.kind === "image" ||
    artifact.kind === "video" ||
    artifact.kind === "audio"
  ) {
    return artifact.kind;
  }
  if (TEXT_ARTIFACT_KINDS.has(artifact.kind)) return "text";
  throw new EngineFault({
    code: "INVALID_INPUT",
    message: `Similarity supports image, video, audio, and text artifacts, not ${artifact.kind}`,
  });
}

async function readNormalizedImage(sourcePath: string): Promise<RawImage> {
  const decoded = await sharp(sourcePath, { animated: false })
    .rotate()
    .toColourspace("srgb")
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  if (decoded.info.width <= 0 || decoded.info.height <= 0) {
    throw new Error(`Invalid image dimensions: ${sourcePath}`);
  }
  if (decoded.info.channels !== 3) {
    throw new Error(`Expected RGB image after conversion: ${sourcePath}`);
  }
  return new RawImage(decoded.data, decoded.info.width, decoded.info.height, 3);
}

async function probeDuration(
  ffprobePath: string,
  sourcePath: string,
): Promise<number> {
  const result = await runCommand(ffprobePath, [
    "-v",
    "error",
    "-show_entries",
    "format=duration",
    "-of",
    "default=noprint_wrappers=1:nokey=1",
    sourcePath,
  ]);
  const duration = Number.parseFloat(result.stdout.trim());
  if (!Number.isFinite(duration) || duration <= 0) {
    throw new EngineFault({
      code: "INVALID_INPUT",
      message: `Unable to determine a positive duration for ${sourcePath}`,
    });
  }
  return duration;
}

async function decodeAudioToMono(
  ffmpegPath: string,
  sourcePath: string,
  sampleRate: number,
  maxSamples: number,
): Promise<Float32Array> {
  const output = await runBinaryCommand(ffmpegPath, [
    "-hide_banner",
    "-loglevel",
    "error",
    "-nostdin",
    "-i",
    sourcePath,
    "-map",
    "0:a:0",
    "-vn",
    "-ac",
    "1",
    "-ar",
    String(sampleRate),
    "-t",
    String(maxSamples / sampleRate),
    "-f",
    "f32le",
    "-acodec",
    "pcm_f32le",
    "pipe:1",
  ]);
  if (output.stdout.byteLength === 0) {
    throw new EngineFault({
      code: "INVALID_INPUT",
      message: `No audio samples could be decoded from ${sourcePath}`,
    });
  }
  if (output.stdout.byteLength % Float32Array.BYTES_PER_ELEMENT !== 0) {
    throw new Error("FFmpeg returned an invalid PCM byte length");
  }
  const bytes = new Uint8Array(output.stdout.byteLength);
  bytes.set(output.stdout);
  const decoded = new Float32Array(bytes.buffer);
  return decoded.length > maxSamples
    ? decoded.slice(0, maxSamples)
    : decoded;
}

async function runCommand(
  command: string,
  args: string[],
): Promise<{ stdout: string; stderr: string }> {
  const output = await runBinaryCommand(command, args);
  return {
    stdout: output.stdout.toString("utf8"),
    stderr: output.stderr,
  };
}

function runBinaryCommand(
  command: string,
  args: string[],
): Promise<{ stdout: Buffer; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.once("error", (error) => {
      reject(
        new EngineFault({
          code: "FEATURE_UNAVAILABLE",
          message: `Unable to start ${command}: ${errorMessage(error)}`,
        }),
      );
    });
    child.once("close", (code) => {
      const output = {
        stdout: Buffer.concat(stdout),
        stderr: Buffer.concat(stderr).toString("utf8"),
      };
      if (code === 0) {
        resolve(output);
        return;
      }
      reject(
        new EngineFault({
          code: "INVALID_INPUT",
          message: `${command} exited with code ${code}: ${output.stderr.trim()}`,
        }),
      );
    });
  });
}

function normalizePlainText(raw: string): NormalizedText {
  const text = raw
    .replace(/^\uFEFF/, "")
    .normalize("NFC")
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return { text, contentHash: hashText(text) };
}

function normalizeJsonText(raw: string, sourcePath: string): NormalizedText {
  let value: unknown;
  try {
    value = JSON.parse(raw.replace(/^\uFEFF/, ""));
  } catch (error) {
    throw new EngineFault({
      code: "INVALID_INPUT",
      message: `Invalid JSON source ${sourcePath}: ${errorMessage(error)}`,
    });
  }
  const lines: string[] = [];
  appendJsonLines(lines, "$", value, 0);
  return normalizePlainText(lines.join("\n"));
}

function appendJsonLines(
  lines: string[],
  jsonPath: string,
  value: unknown,
  depth: number,
): void {
  if (depth > 100) {
    throw new EngineFault({
      code: "INVALID_INPUT",
      message: "JSON source exceeds the maximum nesting depth",
    });
  }
  if (Array.isArray(value)) {
    if (value.length === 0) {
      lines.push(`${jsonPath}: []`);
      return;
    }
    value.forEach((item, index) => appendJsonLines(
      lines,
      `${jsonPath}[${index}]`,
      item,
      depth + 1,
    ));
    return;
  }
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value).sort(([left], [right]) =>
      left < right ? -1 : left > right ? 1 : 0,
    );
    if (entries.length === 0) {
      lines.push(`${jsonPath}: {}`);
      return;
    }
    for (const [key, item] of entries) {
      appendJsonLines(lines, `${jsonPath}.${key}`, item, depth + 1);
    }
    return;
  }
  lines.push(`${jsonPath}: ${JSON.stringify(value)}`);
}

function makeTextRanges(
  text: string,
  tokenizer: TextTokenizer,
): Array<{ startOffset: number; endOffset: number }> {
  const ranges: Array<{ startOffset: number; endOffset: number }> = [];
  let startOffset = 0;
  while (startOffset < text.length) {
    let upper = Math.min(text.length, startOffset + TEXT_CHUNK_CHAR_WINDOW);
    let low = startOffset + 1;
    let high = upper;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      if (tokenCount(tokenizer, text.slice(startOffset, middle)) <= TEXT_CHUNK_TOKENS) {
        low = middle;
      } else {
        high = middle - 1;
      }
    }
    upper = low;
    const boundary = preferredBoundary(text, startOffset, upper);
    if (boundary > startOffset &&
        tokenCount(tokenizer, text.slice(startOffset, boundary)) <= TEXT_CHUNK_TOKENS) {
      upper = boundary;
    }
    ranges.push({ startOffset, endOffset: upper });
    if (upper >= text.length) break;
    const overlapStart = findOverlapStart(tokenizer, text, startOffset, upper);
    startOffset = overlapStart <= startOffset
      ? upper
      : Math.max(startOffset + 1, Math.min(overlapStart, upper - 1));
  }
  return ranges;
}

function tokenCount(tokenizer: TextTokenizer, text: string): number {
  return tokenizer.encode(text, { add_special_tokens: false }).length;
}

function preferredBoundary(text: string, start: number, end: number): number {
  const floor = Math.max(start + 1, end - 180);
  for (let index = end; index >= floor; index -= 1) {
    const character = text[index - 1];
    if (character === "\n" || character === " " || character === "\t") {
      return index;
    }
  }
  return end;
}

function findOverlapStart(
  tokenizer: TextTokenizer,
  text: string,
  start: number,
  end: number,
): number {
  let low = start;
  let high = end - 1;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (tokenCount(tokenizer, text.slice(middle, end)) > TEXT_OVERLAP_TOKENS) {
      low = middle + 1;
    } else {
      high = middle;
    }
  }
  const boundary = preferredBoundary(text, low, end);
  return boundary > start && boundary < end ? boundary : low;
}

function hashText(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function normalized(vector: Float32Array): Float32Array {
  const norm = Math.hypot(...vector);
  if (!Number.isFinite(norm) || norm === 0) {
    throw new Error("Embedding vector must have a finite non-zero norm");
  }
  const result = new Float32Array(vector.length);
  for (let index = 0; index < vector.length; index += 1) {
    result[index] = vector[index]! / norm;
  }
  return result;
}

function normalizedCentroid(vectors: Float32Array[]): Float32Array {
  const first = vectors[0];
  if (!first) throw new Error("Cannot pool an empty vector collection");
  const centroid = new Float32Array(first.length);
  for (const vector of vectors) {
    if (vector.length !== centroid.length) {
      throw new Error("Video frame embedding dimensions do not match");
    }
    for (let index = 0; index < vector.length; index += 1) {
      centroid[index] = (centroid[index] ?? 0) + vector[index]!;
    }
  }
  return normalized(centroid);
}

function vectorToBlob(vector: Float32Array): Buffer {
  return Buffer.from(
    new Uint8Array(vector.buffer, vector.byteOffset, vector.byteLength),
  );
}

function vectorFromBlob(
  row: Pick<EmbeddingRow, "vector_blob" | "dimensions"> | Pick<TextChunkRow, "vector_blob" | "dimensions">,
): Float32Array {
  const bytes = row.vector_blob;
  if (bytes.byteLength !== row.dimensions * Float32Array.BYTES_PER_ELEMENT) {
    throw new Error("Stored similarity vector has an invalid byte length");
  }
  const copied = new Uint8Array(bytes.byteLength);
  copied.set(bytes);
  return new Float32Array(copied.buffer);
}

function cosine(left: Float32Array, right: Float32Array): number {
  if (left.length !== right.length) {
    throw new Error("Cannot compare vectors with different dimensions");
  }
  let score = 0;
  for (let index = 0; index < left.length; index += 1) {
    score += left[index]! * right[index]!;
  }
  return Math.max(-1, Math.min(1, score));
}

function excerpt(text: string): string {
  return text.length <= TEXT_EXCERPT_LIMIT
    ? text
    : `${text.slice(0, TEXT_EXCERPT_LIMIT - 1)}…`;
}

function checkedLimit(value: number | undefined): number {
  const limit = value ?? 20;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new EngineFault({
      code: "INVALID_INPUT",
      message: "Similarity limit must be an integer between 1 and 100",
    });
  }
  return limit;
}

function checkedMinScore(value: number | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isFinite(value) || value < -1 || value > 1) {
    throw new EngineFault({
      code: "INVALID_INPUT",
      message: "Similarity minScore must be between -1 and 1",
    });
  }
  return value;
}

function checkedAudioSampleRate(value: number | undefined): number {
  const sampleRate = value ?? DEFAULT_AUDIO_SAMPLE_RATE;
  if (
    !Number.isInteger(sampleRate) ||
    sampleRate < 8_000 ||
    sampleRate > 192_000
  ) {
    throw new Error(
      "Audio model sampling rate must be an integer between 8000 and 192000",
    );
  }
  return sampleRate;
}

function checkedAudioMaxSamples(
  value: number | undefined,
  sampleRate: number,
): number {
  const maxSamples = value ?? DEFAULT_AUDIO_MAX_SAMPLES;
  if (
    !Number.isInteger(maxSamples) ||
    maxSamples < sampleRate ||
    maxSamples > sampleRate * 60
  ) {
    throw new Error(
      "Audio model window must be between 1 and 60 seconds",
    );
  }
  return maxSamples;
}

function checkedTextMaxBytes(config: SimilarityTextConfig | undefined): number {
  const value = config?.maxSourceBytes ?? DEFAULT_TEXT_MAX_BYTES;
  if (!Number.isInteger(value) || value < 1 || value > 64 * 1024 * 1024) {
    throw new EngineFault({
      code: "INVALID_INPUT",
      message: "Text maxSourceBytes must be an integer between 1 and 67108864",
    });
  }
  return value;
}

function checkedTextMaxChunks(config: SimilarityTextConfig | undefined): number {
  const value = config?.maxChunks ?? DEFAULT_TEXT_MAX_CHUNKS;
  if (!Number.isInteger(value) || value < 1 || value > 2048) {
    throw new EngineFault({
      code: "INVALID_INPUT",
      message: "Text maxChunks must be an integer between 1 and 2048",
    });
  }
  return value;
}

function indexKey(
  kind: SimilarityKind,
  embeddingSpace: string,
): string {
  return `${kind}\u0000${embeddingSpace}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
