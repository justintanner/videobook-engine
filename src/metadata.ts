import { v7 as uuidv7 } from "uuid";

import type {
  AudioWaveformRecord,
  EngineError,
  Result,
} from "./engine-types.js";
import { ok } from "./engine-types.js";
import { EngineContext, resultOf } from "./context.js";
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
      ): Promise<Result<T, EngineError>> => readArtifactMetadata<T>(context, artifact, key),
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
      ): Promise<Result<string, EngineError>> => writeBookMetadata(context, key, value),
      read: <T>(key: string): Promise<Result<T, EngineError>> =>
        readBookMetadata<T>(context, key),
      delete: (key: string): Promise<Result<boolean, EngineError>> =>
        deleteBookMetadata(context, key),
    },
    waveforms: {
      write: (
        artifact: string,
        peaks: number[],
      ): Promise<Result<string, EngineError>> => writeWaveform(context, artifact, peaks),
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
        artifactId: artifact.artifact_id,
        details: { key: normalizedKey },
        writeSet: [`artifact-metadata:${artifact.artifact_id}:${normalizedKey}`],
      },
      ["artifact_metadata", "artifacts"],
      (_operationId, now) => {
        context.store.db
          .prepare("DELETE FROM artifact_metadata WHERE artifact_id=? AND key=?")
          .run(artifact.artifact_id, normalizedKey);
        context.store.db
          .prepare("UPDATE artifacts SET updated_at=? WHERE artifact_id=?")
          .run(now, artifact.artifact_id);
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
    const timeline = normalizedKey === "timeline";
    await context.store.semantic(
      {
        operation: "delete_book_metadata",
        details: { key: normalizedKey },
        writeSet: [`book-metadata:${normalizedKey}`],
      },
      timeline
        ? ["book_metadata", "timelines", "timeline_slots", "timeline_audio"]
        : ["book_metadata"],
      () => {
        context.store.db
          .prepare("DELETE FROM book_metadata WHERE key=?")
          .run(normalizedKey);
        if (timeline) {
          context.store.db.prepare("DELETE FROM timelines").run();
          context.store.db.prepare("DELETE FROM timeline_slots").run();
          context.store.db.prepare("DELETE FROM timeline_audio").run();
        }
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
        artifactId: artifact.artifact_id,
        writeSet: [`waveform:${artifact.artifact_id}`],
      },
      ["audio_waveforms"],
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
        artifactId: artifact.artifact_id,
        details: { key: normalizedKey },
        writeSet: [`artifact-metadata:${artifact.artifact_id}:${normalizedKey}`],
      },
      ["artifact_metadata", "artifacts"],
      (_operationId, now) => {
        context.store.db
          .prepare(
            `INSERT INTO artifact_metadata(artifact_id, key, value_json, updated_at)
             VALUES (?, ?, ?, ?)
             ON CONFLICT(artifact_id, key) DO UPDATE SET
               value_json=excluded.value_json, updated_at=excluded.updated_at`,
          )
          .run(artifact.artifact_id, normalizedKey, canonicalJson(value), now);
        context.store.db
          .prepare("UPDATE artifacts SET updated_at=? WHERE artifact_id=?")
          .run(now, artifact.artifact_id);
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
    const artifact = context.artifactRow(artifactReference, true);
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
    const timeline = normalizedKey === "timeline";
    const mutation = await context.store.semantic(
      {
        operation: "write_book_metadata",
        details: { key: normalizedKey },
        writeSet: [`book-metadata:${normalizedKey}`],
      },
      timeline
        ? ["book_metadata", "timelines", "timeline_slots", "timeline_audio"]
        : ["book_metadata"],
      (_operationId, now) => {
        context.store.db
          .prepare(
            `INSERT INTO book_metadata(key, value_json, updated_at)
             VALUES (?, ?, ?)
             ON CONFLICT(key) DO UPDATE SET
               value_json=excluded.value_json, updated_at=excluded.updated_at`,
          )
          .run(normalizedKey, canonicalJson(value), now);
        if (timeline) replaceTimeline(context, value, now);
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
    const row = context.store.db
      .prepare("SELECT value_json FROM book_metadata WHERE key=?")
      .get(metadataKey(key)) as unknown as MetadataRow | undefined;
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
        artifactId: artifact.artifact_id,
        writeSet: [`waveform:${artifact.artifact_id}`],
      },
      ["audio_waveforms"],
      (_operationId, now) => {
        context.store.db
          .prepare(
            `INSERT INTO audio_waveforms(artifact_id, peaks_json, updated_at)
             VALUES (?, ?, ?)
             ON CONFLICT(artifact_id) DO UPDATE SET
               peaks_json=excluded.peaks_json, updated_at=excluded.updated_at`,
          )
          .run(artifact.artifact_id, canonicalJson(peaks), now);
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
      .prepare(
        `SELECT peaks_json, updated_at FROM audio_waveforms WHERE artifact_id=?`,
      )
      .get(artifact.artifact_id) as unknown as
      | { peaks_json: string; updated_at: number }
      | undefined;
    if (!row) throw new Error("Audio waveform not found");
    return {
      artifactId: artifact.artifact_id,
      peaks: parseJson<number[]>(row.peaks_json, []),
      updatedAt: row.updated_at,
    };
  });
}

function replaceTimeline(
  context: EngineContext,
  value: unknown,
  now: number,
): void {
  const config =
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : { slots: Array.isArray(value) ? value : [] };
  const slots = Array.isArray(config.slots) ? config.slots : [];
  const audio = Array.isArray(config.audio) ? config.audio : [];
  const render = typeof config.render === "string" ? config.render : "landscape";
  context.store.db
    .prepare(
      `INSERT INTO timelines(singleton, render, data_json, updated_at)
       VALUES (1, ?, ?, ?)
       ON CONFLICT(singleton) DO UPDATE SET
         render=excluded.render, data_json=excluded.data_json,
         updated_at=excluded.updated_at`,
    )
    .run(render, canonicalJson(config), now);
  context.store.db.prepare("DELETE FROM timeline_slots").run();
  context.store.db.prepare("DELETE FROM timeline_audio").run();
  const insertSlot = context.store.db.prepare(
    `INSERT INTO timeline_slots(slot_id, artifact_id, ordinal, data_json)
     VALUES (?, ?, ?, ?)`,
  );
  slots.forEach((item, ordinal) => {
    const record = asRecord(item);
    insertSlot.run(
      stringField(record, "id") ?? stringField(record, "slot") ?? `slot-${ordinal + 1}`,
      resolveOptionalArtifact(
        context,
        stringField(record, "artifactId") ??
          stringField(record, "assetId") ??
          stringField(record, "slug"),
      ),
      ordinal,
      canonicalJson(record),
    );
  });
  const insertAudio = context.store.db.prepare(
    `INSERT INTO timeline_audio(audio_id, artifact_id, ordinal, data_json)
     VALUES (?, ?, ?, ?)`,
  );
  audio.forEach((item, ordinal) => {
    const record = asRecord(item);
    insertAudio.run(
      stringField(record, "id") ?? uuidv7(),
      resolveOptionalArtifact(
        context,
        stringField(record, "artifactId") ??
          stringField(record, "assetId") ??
          stringField(record, "slug"),
      ),
      ordinal,
      canonicalJson(record),
    );
  });
}

function resolveOptionalArtifact(
  context: EngineContext,
  reference: string | undefined,
): string | null {
  if (!reference) return null;
  try {
    return context.artifactRow(reference).artifact_id;
  } catch {
    return null;
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function stringField(
  value: Record<string, unknown>,
  key: string,
): string | undefined {
  const item = value[key];
  return typeof item === "string" && item.length > 0 ? item : undefined;
}

function metadataKey(input: string): string {
  const key = input.trim();
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(key)) {
    throw new Error(`Invalid metadata key: ${input}`);
  }
  return key;
}
