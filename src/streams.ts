import type {
  EngineError,
  Result,
} from "./engine-types.js";
import { ok } from "./engine-types.js";
import type {
  ArtifactStream,
  RegisterArtifactStreamInput,
} from "./mvp-contracts.js";
import {
  EngineContext,
  resultOf,
  syncResultOf,
} from "./context.js";
import { assertUuidV7, newUuidV7 } from "./ids.js";
import { normalizeRational } from "./mvp-time.js";
import { canonicalJson, parseJson } from "./store.js";
import { EngineFault } from "./store.js";

interface ArtifactStreamRow {
  stream_id: string;
  artifact_id: string;
  source_path: string;
  object_hash: string;
  stream_index: number;
  kind: "video" | "audio";
  time_base_numerator: number;
  time_base_denominator: number;
  duration_ticks: number;
  codec: string;
  profile_json: string;
}

interface StreamProfile {
  video?: ArtifactStream["video"];
  audio?: ArtifactStream["audio"];
}

export function createStreamsApi(context: EngineContext) {
  return {
    register: (
      input: RegisterArtifactStreamInput,
    ): Promise<Result<ArtifactStream, EngineError>> =>
      registerStream(context, input),
    get: (streamId: string): Result<ArtifactStream, EngineError> =>
      syncResultOf(() => requiredStream(context, streamId)),
    getAtRevision: (
      streamId: string,
      revision: string,
    ): Result<ArtifactStream, EngineError> =>
      syncResultOf(() => requiredStream(context, streamId, revision)),
    list: (artifact?: string): Result<ArtifactStream[], EngineError> =>
      syncResultOf(() => listStreams(context, artifact)),
  };
}

async function registerStream(
  context: EngineContext,
  input: RegisterArtifactStreamInput,
): Promise<Result<ArtifactStream, EngineError>> {
  return resultOf(async () => {
    const artifact = context.artifactRow(input.artifactId);
    const streamId = input.streamId ?? newUuidV7();
    assertUuidV7(streamId, "Stream ID");
    const sourcePath = requiredText(input.sourcePath, "Stream source path");
    const objectHash = requiredText(input.objectHash, "Stream object hash");
    const timeBase = normalizeRational(input.timeBase);
    safeIntegerAtLeast(input.streamIndex, 0, "Stream index");
    safeIntegerAtLeast(input.durationTicks, 1, "Stream duration");
    const codec = requiredText(input.codec, "Stream codec");
    validateProfile(input);
    const file = context.store.db
      .prepare(
        `SELECT object_hash FROM artifact_files
         WHERE artifact_id=? AND path=?`,
      )
      .get(artifact.artifact_id, sourcePath) as unknown as
      | { object_hash: string }
      | undefined;
    if (!file) {
      throw new EngineFault({
        code: "NOT_FOUND",
        message: `Artifact source file not found: ${artifact.artifact_id}/${sourcePath}`,
      });
    }
    if (file.object_hash !== objectHash) {
      throw new EngineFault({
        code: "OBJECT_UNAVAILABLE",
        message: "Stream object hash does not match the artifact file",
        details: {
          artifactId: artifact.artifact_id,
          sourcePath,
          expectedObjectHash: file.object_hash,
          objectHash,
        },
      });
    }
    const existing = findStreamBySource(
      context,
      artifact.artifact_id,
      sourcePath,
      objectHash,
      input.streamIndex,
    );
    if (existing) return existing;
    const profile: StreamProfile = {
      ...(input.video ? { video: input.video } : {}),
      ...(input.audio ? { audio: input.audio } : {}),
    };
    const mutation = await context.store.semantic(
      {
        operation: "register_artifact_stream",
        artifactId: artifact.artifact_id,
        details: {
          streamId,
          sourcePath,
          objectHash,
          streamIndex: input.streamIndex,
          kind: input.kind,
        },
        writeSet: [
          `artifact:${artifact.artifact_id}`,
          `stream:${streamId}`,
          `object:${objectHash}`,
        ],
      },
      (_operationId, now) => {
        context.store.db
          .prepare(
            `INSERT INTO artifact_streams(
              stream_id, artifact_id, source_path, object_hash,
              stream_index, kind, time_base_numerator,
              time_base_denominator, duration_ticks, codec,
              profile_json, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            streamId,
            artifact.artifact_id,
            sourcePath,
            objectHash,
            input.streamIndex,
            input.kind,
            timeBase.numerator,
            timeBase.denominator,
            input.durationTicks,
            codec,
            canonicalJson(profile),
            now,
          );
      },
    );
    return ok(requiredStream(context, streamId), mutation.revision);
  });
}

function requiredStream(
  context: EngineContext,
  streamId: string,
  revision?: string,
): ArtifactStream {
  assertUuidV7(streamId, "Stream ID");
  const source = revision
    ? "dolt_at_artifact_streams(?)"
    : "artifact_streams";
  const row = context.store.db
    .prepare(`${STREAM_SELECT} FROM ${source} WHERE stream_id=?`)
    .get(...(revision ? [revision, streamId] : [streamId])) as unknown as
    | ArtifactStreamRow
    | undefined;
  if (!row) {
    throw new EngineFault({
      code: "NOT_FOUND",
      message: revision
        ? `Stream not found at revision: ${streamId}`
        : `Stream not found: ${streamId}`,
    });
  }
  return streamFromRow(row);
}

function listStreams(
  context: EngineContext,
  artifact?: string,
): ArtifactStream[] {
  const artifactId = artifact
    ? context.artifactRow(artifact).artifact_id
    : undefined;
  const rows = artifactId
    ? (context.store.db
        .prepare(
          `${STREAM_SELECT} FROM artifact_streams
           WHERE artifact_id=?
           ORDER BY source_path, stream_index, stream_id`,
        )
        .all(artifactId) as unknown as ArtifactStreamRow[])
    : (context.store.db
        .prepare(
          `${STREAM_SELECT} FROM artifact_streams
           ORDER BY artifact_id, source_path, stream_index, stream_id`,
        )
        .all() as unknown as ArtifactStreamRow[]);
  return rows.map(streamFromRow);
}

function findStreamBySource(
  context: EngineContext,
  artifactId: string,
  sourcePath: string,
  objectHash: string,
  streamIndex: number,
): ArtifactStream | null {
  const row = context.store.db
    .prepare(
      `${STREAM_SELECT} FROM artifact_streams
       WHERE artifact_id=? AND source_path=? AND object_hash=? AND stream_index=?`,
    )
    .get(artifactId, sourcePath, objectHash, streamIndex) as unknown as
    | ArtifactStreamRow
    | undefined;
  return row ? streamFromRow(row) : null;
}

function streamFromRow(row: ArtifactStreamRow): ArtifactStream {
  const profile = parseJson<StreamProfile>(row.profile_json, {});
  return {
    streamId: row.stream_id,
    artifactId: row.artifact_id,
    sourcePath: row.source_path,
    objectHash: row.object_hash,
    streamIndex: row.stream_index,
    kind: row.kind,
    timeBase: {
      numerator: row.time_base_numerator,
      denominator: row.time_base_denominator,
    },
    durationTicks: row.duration_ticks,
    codec: row.codec,
    ...(profile.video ? { video: profile.video } : {}),
    ...(profile.audio ? { audio: profile.audio } : {}),
  };
}

function validateProfile(input: RegisterArtifactStreamInput): void {
  if (input.kind === "video") {
    if (!input.video || input.audio) {
      throw new Error("Video streams require only a video profile");
    }
    safeIntegerAtLeast(input.video.width, 1, "Video width");
    safeIntegerAtLeast(input.video.height, 1, "Video height");
    normalizeRational(input.video.pixelAspect);
    if (input.video.nominalFrameRate) {
      normalizeRational(input.video.nominalFrameRate);
    }
    if (input.video.averageFrameRate) {
      normalizeRational(input.video.averageFrameRate);
    }
    return;
  }
  if (!input.audio || input.video) {
    throw new Error("Audio streams require only an audio profile");
  }
  safeIntegerAtLeast(input.audio.sampleRateHz, 1, "Audio sample rate");
  safeIntegerAtLeast(input.audio.channels, 1, "Audio channels");
  requiredText(input.audio.channelLayout, "Audio channel layout");
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

const STREAM_SELECT = `
  SELECT stream_id, artifact_id, source_path, object_hash,
         stream_index, kind, time_base_numerator, time_base_denominator,
         duration_ticks, codec, profile_json`;
