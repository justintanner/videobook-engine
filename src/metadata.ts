import type {
  AudioWaveformRecord,
  EngineError,
  Result,
} from "./engine-types.js";
import { ok } from "./engine-types.js";
import {
  EngineContext,
  resultOf,
} from "./context.js";
import { canonicalJson, parseJson } from "./store.js";

interface MetadataRow {
  value_json: string;
}

export function createMetadataApi(context: EngineContext) {
  return {
    artifacts: {
      write: (
        artifact: string,
        key: string,
        value: unknown,
      ): Promise<Result<string, EngineError>> =>
        writeArtifactMetadata(context, artifact, key, value),
      read: <T>(
        artifact: string,
        key: string,
      ): Promise<Result<T, EngineError>> =>
        readArtifactMetadata<T>(context, artifact, key),
      readAtRevision: <T>(
        artifact: string,
        key: string,
        revision: string,
      ): Promise<Result<T, EngineError>> =>
        readArtifactMetadataAtRevision<T>(context, artifact, key, revision),
      delete: (
        artifact: string,
        key: string,
      ): Promise<Result<boolean, EngineError>> =>
        deleteArtifactMetadata(context, artifact, key),
    },
    book: {
      write: (
        key: string,
        value: unknown,
      ): Promise<Result<string, EngineError>> =>
        writeBookMetadata(context, key, value),
      read: <T>(key: string): Promise<Result<T, EngineError>> =>
        readBookMetadata<T>(context, key),
      delete: (key: string): Promise<Result<boolean, EngineError>> =>
        deleteBookMetadata(context, key),
    },
    waveforms: {
      write: (
        artifact: string,
        peaks: number[],
      ): Promise<Result<string, EngineError>> =>
        writeWaveform(context, artifact, peaks),
      read: (
        artifact: string,
      ): Promise<Result<AudioWaveformRecord, EngineError>> =>
        readWaveform(context, artifact),
      delete: (artifact: string): Promise<Result<boolean, EngineError>> =>
        deleteWaveform(context, artifact),
    },
  };
}

async function deleteArtifactMetadata(
  context: EngineContext,
  artifactReference: string,
  key: string,
): Promise<Result<boolean, EngineError>> {
  return resultOf(async () => {
    const artifact = context.artifactRow(artifactReference);
    const normalizedKey = metadataKey(key);
    const exists = context.store.db
      .prepare(
        `SELECT 1 AS present FROM artifact_metadata
         WHERE artifact_id=? AND key=?`,
      )
      .get(artifact.artifact_id, normalizedKey);
    if (!exists) return false;
    await context.store.semantic(
      {
        operation: "delete_artifact_metadata",
        tables: ["artifact_metadata"],
        artifactId: artifact.artifact_id,
        details: { key: normalizedKey },
        writeSet: [`artifact-metadata:${artifact.artifact_id}:${normalizedKey}`],
      },
      () => {
        context.store.db
          .prepare("DELETE FROM artifact_metadata WHERE artifact_id=? AND key=?")
          .run(artifact.artifact_id, normalizedKey);
      },
    );
    return true;
  });
}

async function deleteBookMetadata(
  context: EngineContext,
  key: string,
): Promise<Result<boolean, EngineError>> {
  return resultOf(async () => {
    const normalizedKey = metadataKey(key);
    const exists = context.store.db
      .prepare("SELECT 1 AS present FROM book_metadata WHERE key=?")
      .get(normalizedKey);
    if (!exists) return false;
    await context.store.semantic(
      {
        operation: "delete_book_metadata",
        tables: ["book_metadata"],
        details: { key: normalizedKey },
        writeSet: [`book-metadata:${normalizedKey}`],
      },
      () => {
        context.store.db
          .prepare("DELETE FROM book_metadata WHERE key=?")
          .run(normalizedKey);
      },
    );
    return true;
  });
}

async function deleteWaveform(
  context: EngineContext,
  artifactReference: string,
): Promise<Result<boolean, EngineError>> {
  return resultOf(async () => {
    const artifact = context.artifactRow(artifactReference);
    const exists = context.store.db
      .prepare("SELECT 1 AS present FROM audio_waveforms WHERE artifact_id=?")
      .get(artifact.artifact_id);
    if (!exists) return false;
    await context.store.semantic(
      {
        operation: "delete_audio_waveform",
        tables: ["audio_waveforms"],
        artifactId: artifact.artifact_id,
        writeSet: [`waveform:${artifact.artifact_id}`],
      },
      () => {
        context.store.db
          .prepare("DELETE FROM audio_waveforms WHERE artifact_id=?")
          .run(artifact.artifact_id);
      },
    );
    return true;
  });
}

async function writeArtifactMetadata(
  context: EngineContext,
  artifactReference: string,
  key: string,
  value: unknown,
): Promise<Result<string, EngineError>> {
  return resultOf(async () => {
    const artifact = context.artifactRow(artifactReference);
    const normalizedKey = metadataKey(key);
    const mutation = await context.store.semantic(
      {
        operation: "write_artifact_metadata",
        tables: ["artifact_metadata"],
        artifactId: artifact.artifact_id,
        details: { key: normalizedKey },
        writeSet: [`artifact-metadata:${artifact.artifact_id}:${normalizedKey}`],
      },
      () => {
        context.store.db
          .prepare(
            `INSERT INTO artifact_metadata(artifact_id, key, value_json)
             VALUES (?, ?, ?)
             ON CONFLICT(artifact_id, key) DO UPDATE SET
               value_json=excluded.value_json`,
          )
          .run(artifact.artifact_id, normalizedKey, canonicalJson(value));
      },
    );
    return ok(normalizedKey, mutation.revision);
  });
}

async function readArtifactMetadata<T>(
  context: EngineContext,
  artifactReference: string,
  key: string,
): Promise<Result<T, EngineError>> {
  return resultOf(async () => {
    const artifact = context.artifactRow(artifactReference);
    const row = context.store.db
      .prepare(
        `SELECT value_json FROM artifact_metadata
         WHERE artifact_id=? AND key=?`,
      )
      .get(artifact.artifact_id, metadataKey(key)) as unknown as
      | MetadataRow
      | undefined;
    if (!row) throw new Error(`Artifact metadata not found: ${key}`);
    return parseJson<T>(row.value_json, null as T);
  });
}

async function readArtifactMetadataAtRevision<T>(
  context: EngineContext,
  artifactReference: string,
  key: string,
  revision: string,
): Promise<Result<T, EngineError>> {
  return resultOf(async () => {
    const artifact = context.store.db
      .prepare(
        `SELECT artifact_id FROM dolt_at_artifacts(?)
         WHERE artifact_id=? LIMIT 1`,
      )
      .get(revision, artifactReference) as unknown as
      | { artifact_id: string }
      | undefined;
    if (!artifact) {
      throw new Error(
        `Artifact not found: ${artifactReference} at ${revision}`,
      );
    }
    const normalizedKey = metadataKey(key);
    const row = context.store.db
      .prepare(
        `SELECT value_json FROM dolt_at_artifact_metadata(?)
         WHERE artifact_id=? AND key=?`,
      )
      .get(revision, artifact.artifact_id, normalizedKey) as unknown as
      | MetadataRow
      | undefined;
    if (!row) {
      throw new Error(
        `Artifact metadata not found: ${artifactReference}/${normalizedKey} at ${revision}`,
      );
    }
    return parseJson<T>(row.value_json, null as T);
  });
}

async function writeBookMetadata(
  context: EngineContext,
  key: string,
  value: unknown,
): Promise<Result<string, EngineError>> {
  return resultOf(async () => {
    const normalizedKey = metadataKey(key);
    const mutation = await context.store.semantic(
      {
        operation: "write_book_metadata",
        tables: ["book_metadata"],
        details: { key: normalizedKey },
        writeSet: [`book-metadata:${normalizedKey}`],
      },
      () => {
        context.store.db
          .prepare(
            `INSERT INTO book_metadata(key, value_json)
             VALUES (?, ?)
             ON CONFLICT(key) DO UPDATE SET
               value_json=excluded.value_json`,
          )
          .run(normalizedKey, canonicalJson(value));
      },
    );
    return ok(normalizedKey, mutation.revision);
  });
}

async function readBookMetadata<T>(
  context: EngineContext,
  key: string,
): Promise<Result<T, EngineError>> {
  return resultOf(async () => {
    const normalizedKey = metadataKey(key);
    const row = context.store.db
      .prepare("SELECT value_json FROM book_metadata WHERE key=?")
      .get(normalizedKey) as unknown as MetadataRow | undefined;
    if (!row) throw new Error(`Book metadata not found: ${key}`);
    return parseJson<T>(row.value_json, null as T);
  });
}

async function writeWaveform(
  context: EngineContext,
  artifactReference: string,
  peaks: number[],
): Promise<Result<string, EngineError>> {
  return resultOf(async () => {
    if (!Array.isArray(peaks) || peaks.some((peak) => !Number.isFinite(peak))) {
      throw new Error("Waveform peaks must be finite numbers");
    }
    const artifact = context.artifactRow(artifactReference);
    const mutation = await context.store.semantic(
      {
        operation: "write_audio_waveform",
        tables: ["audio_waveforms"],
        artifactId: artifact.artifact_id,
        writeSet: [`waveform:${artifact.artifact_id}`],
      },
      () => {
        context.store.db
          .prepare(
            `INSERT INTO audio_waveforms(artifact_id, peaks_json)
             VALUES (?, ?)
             ON CONFLICT(artifact_id) DO UPDATE SET
               peaks_json=excluded.peaks_json`,
          )
          .run(artifact.artifact_id, canonicalJson(peaks));
      },
    );
    return ok(artifact.artifact_id, mutation.revision);
  });
}

async function readWaveform(
  context: EngineContext,
  artifactReference: string,
): Promise<Result<AudioWaveformRecord, EngineError>> {
  return resultOf(async () => {
    const artifact = context.artifactRow(artifactReference);
    const row = context.store.db
      .prepare("SELECT peaks_json FROM audio_waveforms WHERE artifact_id=?")
      .get(artifact.artifact_id) as unknown as
      | { peaks_json: string }
      | undefined;
    if (!row) throw new Error("Audio waveform not found");
    return {
      artifactId: artifact.artifact_id,
      peaks: parseJson<number[]>(row.peaks_json, []),
    };
  });
}

function metadataKey(input: string): string {
  const key = input.trim();
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(key)) {
    throw new Error(`Invalid metadata key: ${input}`);
  }
  return key;
}
