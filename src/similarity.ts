import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";

import {
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
  ok,
  type EngineError,
  type Result,
  type SimilarityApi,
  type SimilarityConfig,
  type SimilarityEmbeddingProvider,
  type SimilarityIndexOptions,
  type SimilarityIndexResult,
  type SimilarityKind,
  type SimilarityMatch,
  type SimilarityQueryOptions,
  type SimilarityStats,
  type SimilarityStatus,
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

type FeaturePipeline = (
  images: RawImage | RawImage[],
) => Promise<{ data: Float32Array; dims: number[] }>;

interface EmbeddingRow {
  id: number;
  artifact_id: string;
  project_id: string;
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

interface CachedIndex {
  index: Index;
  dimensions: number;
}

interface SelectedSource extends FileRow {
  kind: SimilarityKind;
}

export function createSimilarityApi(context: EngineContext): SimilarityApi {
  if (!context.config.similarity) return disabledSimilarityApi();
  return new LocalSimilarityApi(context, context.config.similarity);
}

class LocalSimilarityApi implements SimilarityApi {
  private readonly provider: SimilarityEmbeddingProvider;
  private readonly indexes = new Map<string, CachedIndex>();

  constructor(
    private readonly context: EngineContext,
    config: SimilarityConfig,
  ) {
    this.provider = config.provider ?? new LocalClipProvider(context, config);
  }

  async prepare(): Promise<Result<{ embeddingSpace: string }, EngineError>> {
    return resultOf(async () => {
      await this.provider.prepare();
      return { embeddingSpace: this.provider.embeddingSpace };
    });
  }

  async index(
    projectReference: string,
    artifactReference: string,
    options: SimilarityIndexOptions = {},
  ): Promise<Result<SimilarityIndexResult, EngineError>> {
    return resultOf(async () => {
      const project = this.context.projectRow(projectReference);
      const artifact = this.context.artifactRow(
        project.project_id,
        artifactReference,
      );
      const kind = similarityKind(artifact);
      const source = this.sourceFor(artifact, kind);
      const existing = this.embeddingForArtifact(
        artifact.artifact_id,
        this.provider.embeddingSpace,
      );

      if (
        existing &&
        existing.object_hash === source.object_hash &&
        existing.dimensions === this.provider.dimensions &&
        !options.force
      ) {
        this.addToCachedIndex(existing, vectorFromBlob(existing));
        return this.indexResult(existing, true);
      }

      const reusable = !options.force
        ? this.embeddingForObject(
            source.object_hash,
            kind,
            this.provider.embeddingSpace,
            this.provider.dimensions,
          )
        : null;
      const embedded = reusable
        ? {
            vector: vectorFromBlob(reusable),
            frameCount: reusable.frame_count,
            reused: true,
          }
        : await this.embedSource(source);

      const row = this.context.store.runtime((now) => {
        if (existing) {
          this.context.store.db
            .prepare(
              `UPDATE runtime_similarity_embeddings
               SET project_id=?, kind=?, source_path=?, object_hash=?,
                   dimensions=?, vector_blob=?, frame_count=?, updated_at=?
               WHERE id=?`,
            )
            .run(
              project.project_id,
              kind,
              source.path,
              source.object_hash,
              this.provider.dimensions,
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
              artifact_id, project_id, kind, source_path, object_hash,
              embedding_space, dimensions, vector_blob, frame_count, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            artifact.artifact_id,
            project.project_id,
            kind,
            source.path,
            source.object_hash,
            this.provider.embeddingSpace,
            this.provider.dimensions,
            vectorToBlob(embedded.vector),
            embedded.frameCount,
            now,
          );
        return this.embeddingById(Number(result.lastInsertRowid));
      });

      this.addToCachedIndex(row, embedded.vector);
      return this.indexResult(row, embedded.reused);
    });
  }

  async rebuild(
    projectReference: string,
    options: { kind?: SimilarityKind; force?: boolean } = {},
  ): Promise<Result<SimilarityIndexResult[], EngineError>> {
    return resultOf(async () => {
      const project = this.context.projectRow(projectReference);
      const kinds = options.kind ? [options.kind] : (["image", "video"] as const);
      const artifactRows = this.context.store.db
        .prepare(
          `SELECT artifact_id, project_id, slug, kind, data_json,
                  created_at, updated_at, deleted_at
           FROM artifacts
           WHERE project_id=? AND deleted_at IS NULL
             AND kind IN (${kinds.map(() => "?").join(", ")})
           ORDER BY created_at, artifact_id`,
        )
        .all(project.project_id, ...kinds) as unknown as ArtifactRow[];
      const indexed: SimilarityIndexResult[] = [];
      for (const artifact of artifactRows) {
        const result = await this.index(project.project_id, artifact.artifact_id, {
          force: options.force,
        });
        if (!result.ok) throw new EngineFault(result.error);
        indexed.push(result.value);
      }
      return indexed;
    });
  }

  status(
    projectReference: string,
    artifactReference: string,
  ): Result<SimilarityStatus, EngineError> {
    return syncResultOf(() => {
      const project = this.context.projectRow(projectReference);
      const artifact = this.context.artifactRow(
        project.project_id,
        artifactReference,
      );
      const kind = similarityKind(artifact);
      const row = this.embeddingForArtifact(
        artifact.artifact_id,
        this.provider.embeddingSpace,
      );
      if (!row) {
        return {
          artifactId: artifact.artifact_id,
          projectId: project.project_id,
          kind,
          state: "not_indexed",
          embeddingSpace: this.provider.embeddingSpace,
        };
      }
      return {
        artifactId: artifact.artifact_id,
        projectId: project.project_id,
        kind,
        state: "ready",
        embeddingSpace: row.embedding_space,
        objectHash: row.object_hash,
        frameCount: row.frame_count,
        updatedAt: row.updated_at,
      };
    });
  }

  stats(projectReference: string): Result<SimilarityStats, EngineError> {
    return syncResultOf(() => {
      const project = this.context.projectRow(projectReference);
      const rows = this.context.store.db
        .prepare(
          `SELECT kind, COUNT(*) AS count
           FROM runtime_similarity_embeddings
           WHERE project_id=? AND embedding_space=?
           GROUP BY kind`,
        )
        .all(project.project_id, this.provider.embeddingSpace) as unknown as Array<{
        kind: SimilarityKind;
        count: number;
      }>;
      return {
        embeddingSpace: this.provider.embeddingSpace,
        imageCount: rows.find((row) => row.kind === "image")?.count ?? 0,
        videoCount: rows.find((row) => row.kind === "video")?.count ?? 0,
      };
    });
  }

  async findSimilar(
    projectReference: string,
    artifactReference: string,
    options: SimilarityQueryOptions = {},
  ): Promise<Result<SimilarityMatch[], EngineError>> {
    return resultOf(async () => {
      const project = this.context.projectRow(projectReference);
      const artifact = this.context.artifactRow(
        project.project_id,
        artifactReference,
      );
      const kind = similarityKind(artifact);
      const limit = checkedLimit(options.limit);
      const minScore = checkedMinScore(options.minScore);
      const query = this.embeddingForArtifact(
        artifact.artifact_id,
        this.provider.embeddingSpace,
      );
      if (!query) {
        throw new EngineFault({
          code: "NOT_READY",
          message: `Artifact is not indexed for similarity: ${artifact.slug}`,
          details: { artifactId: artifact.artifact_id },
        });
      }

      const index = this.indexFor(
        project.project_id,
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
        project.project_id,
        kind,
        query.object_hash,
        query.embedding_space,
      )) {
        ids.add(exact.id);
      }
      if (ids.size === 0) return [];

      const candidates = this.activeEmbeddingsByIds(
        project.project_id,
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
            projectId: candidate.project_id,
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
    });
  }

  private async embedSource(source: SelectedSource): Promise<{
    vector: Float32Array;
    frameCount: number | null;
    reused: boolean;
  }> {
    const localPath = await this.context.objects.ensureLocalPath(
      source.object_hash,
    );
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
      : "(?:mp4|mov|webm|mkv|avi)";
    const source = rows.find((row) =>
      new RegExp(`(?:^|/)original\\.${extension}$`, "i").test(row.path),
    );
    if (!source) {
      throw new EngineFault({
        code: "INVALID_INPUT",
        message: `No supported original ${kind} file for ${artifact.slug}`,
      });
    }
    return { ...source, kind };
  }

  private embeddingForArtifact(
    artifactId: string,
    embeddingSpace: string,
  ): EmbeddingRow | null {
    const row = this.context.store.db
      .prepare(
        `SELECT id, artifact_id, project_id, kind, source_path, object_hash,
                embedding_space, dimensions, vector_blob, frame_count, updated_at
         FROM runtime_similarity_embeddings
         WHERE artifact_id=? AND embedding_space=?`,
      )
      .get(artifactId, embeddingSpace) as unknown as EmbeddingRow | undefined;
    return row ?? null;
  }

  private embeddingForObject(
    objectHash: string,
    kind: SimilarityKind,
    embeddingSpace: string,
    dimensions: number,
  ): EmbeddingRow | null {
    const row = this.context.store.db
      .prepare(
        `SELECT id, artifact_id, project_id, kind, source_path, object_hash,
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
        `SELECT id, artifact_id, project_id, kind, source_path, object_hash,
                embedding_space, dimensions, vector_blob, frame_count, updated_at
         FROM runtime_similarity_embeddings WHERE id=?`,
      )
      .get(id) as unknown as EmbeddingRow | undefined;
    if (!row) throw new Error(`Similarity embedding not found: ${id}`);
    return row;
  }

  private exactObjectEmbeddings(
    projectId: string,
    kind: SimilarityKind,
    objectHash: string,
    embeddingSpace: string,
  ): EmbeddingRow[] {
    return this.context.store.db
      .prepare(
        `SELECT id, artifact_id, project_id, kind, source_path, object_hash,
                embedding_space, dimensions, vector_blob, frame_count, updated_at
         FROM runtime_similarity_embeddings
         WHERE project_id=? AND kind=? AND object_hash=? AND embedding_space=?`,
      )
      .all(projectId, kind, objectHash, embeddingSpace) as unknown as EmbeddingRow[];
  }

  private activeEmbeddingsByIds(
    projectId: string,
    kind: SimilarityKind,
    embeddingSpace: string,
    ids: number[],
  ): EmbeddingRow[] {
    if (ids.length === 0) return [];
    const placeholders = ids.map(() => "?").join(", ");
    return this.context.store.db
      .prepare(
        `SELECT e.id, e.artifact_id, e.project_id, e.kind, e.source_path,
                e.object_hash, e.embedding_space, e.dimensions, e.vector_blob,
                e.frame_count, e.updated_at, a.slug
         FROM runtime_similarity_embeddings e
         JOIN artifacts a ON a.artifact_id=e.artifact_id
         JOIN projects p ON p.project_id=e.project_id
         WHERE e.project_id=? AND e.kind=? AND e.embedding_space=?
           AND a.deleted_at IS NULL AND p.deleted_at IS NULL
           AND e.id IN (${placeholders})`,
      )
      .all(projectId, kind, embeddingSpace, ...ids) as unknown as EmbeddingRow[];
  }

  private indexFor(
    projectId: string,
    kind: SimilarityKind,
    embeddingSpace: string,
    dimensions: number,
  ): CachedIndex {
    const key = indexKey(projectId, kind, embeddingSpace);
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
        `SELECT e.id, e.artifact_id, e.project_id, e.kind, e.source_path,
                e.object_hash, e.embedding_space, e.dimensions, e.vector_blob,
                e.frame_count, e.updated_at
         FROM runtime_similarity_embeddings e
         JOIN artifacts a ON a.artifact_id=e.artifact_id
         JOIN projects p ON p.project_id=e.project_id
         WHERE e.project_id=? AND e.kind=? AND e.embedding_space=?
           AND e.dimensions=? AND a.deleted_at IS NULL AND p.deleted_at IS NULL
         ORDER BY e.id`,
      )
      .all(projectId, kind, embeddingSpace, dimensions) as unknown as EmbeddingRow[];
    for (const row of rows) {
      index.add(BigInt(row.id), vectorFromBlob(row), 0);
    }
    const cached = { index, dimensions };
    this.indexes.set(key, cached);
    return cached;
  }

  private addToCachedIndex(row: EmbeddingRow, vector: Float32Array): void {
    const cached = this.indexes.get(
      indexKey(row.project_id, row.kind, row.embedding_space),
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

  private indexResult(
    row: EmbeddingRow,
    reused: boolean,
  ): SimilarityIndexResult {
    return {
      artifactId: row.artifact_id,
      projectId: row.project_id,
      kind: row.kind,
      embeddingSpace: row.embedding_space,
      frameCount: row.frame_count,
      reused,
    };
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
      throw new Error(
        `Unexpected embedding shape: ${output.dims.join("x")}`,
      );
    }
    const vectors: Float32Array[] = [];
    for (let index = 0; index < batch; index += 1) {
      const start = index * this.dimensions;
      vectors.push(normalized(output.data.slice(start, start + this.dimensions)));
    }
    return vectors;
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
  };
}

function similarityKind(artifact: ArtifactRow): SimilarityKind {
  if (artifact.kind === "image" || artifact.kind === "video") {
    return artifact.kind;
  }
  throw new EngineFault({
    code: "INVALID_INPUT",
    message: `Similarity supports image and video artifacts, not ${artifact.kind}`,
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

function runCommand(
  command: string,
  args: string[],
): Promise<{ stdout: string; stderr: string }> {
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
        stdout: Buffer.concat(stdout).toString("utf8"),
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

function vectorFromBlob(row: Pick<EmbeddingRow, "vector_blob" | "dimensions">): Float32Array {
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

function indexKey(
  projectId: string,
  kind: SimilarityKind,
  embeddingSpace: string,
): string {
  return `${projectId}\u0000${kind}\u0000${embeddingSpace}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
