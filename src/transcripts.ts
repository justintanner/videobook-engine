import type {
  EngineError,
  Result,
} from "./engine-types.js";
import { ok } from "./engine-types.js";
import type {
  ImportTranscriptInput,
  ImportTranscriptSegment,
  ImportTranscriptWord,
  ReviseTranscriptInput,
  Transcript,
  TranscriptSegment,
  TranscriptSegmentKind,
  TranscriptWord,
} from "./mvp-contracts.js";
import {
  EngineContext,
  resultOf,
  syncResultOf,
} from "./context.js";
import { assertUuidV7, newUuidV7 } from "./ids.js";
import {
  normalizeSourceRange,
  rationalEquals,
  sourceRangeEndTick,
} from "./mvp-time.js";
import { canonicalJson, EngineFault } from "./store.js";

interface TranscriptRow {
  transcript_id: string;
  artifact_id: string;
  stream_id: string;
  object_hash: string;
  payload_hash: string;
  language: string;
  provider: string | null;
  model: string | null;
  created_at: number;
}

interface SegmentRow {
  segment_id: string;
  ordinal: number;
  start_tick: number;
  duration_ticks: number;
  speaker: string | null;
  confidence: number | null;
  kind: TranscriptSegmentKind;
}

interface WordRow {
  word_id: string;
  segment_id: string;
  ordinal: number;
  start_tick: number;
  duration_ticks: number;
  confidence: number | null;
  corrected: number;
}

interface StreamRow {
  stream_id: string;
  artifact_id: string;
  object_hash: string;
  time_base_numerator: number;
  time_base_denominator: number;
  duration_ticks: number;
}

interface NormalizedSegment {
  segmentId: string;
  ordinal: number;
  startTick: number;
  durationTicks: number;
  speaker?: string;
  text: string;
  confidence?: number;
  kind: TranscriptSegmentKind;
  words: NormalizedWord[];
}

interface NormalizedWord {
  wordId: string;
  ordinal: number;
  startTick: number;
  durationTicks: number;
  text: string;
  confidence?: number;
  corrected: boolean;
}

/**
 * Bulk transcript text (segment and word `text`) is the forgettable part of
 * a transcript: it lives in one CAS object behind `transcripts.payload_hash`
 * instead of raw versioned columns, so object deletion or GC can forget it
 * while the structural rows (IDs, ticks, speaker, confidence, kind) remain
 * as the permanent record. Reading a transcript whose payload object was
 * deleted surfaces OBJECT_UNAVAILABLE.
 */
interface TranscriptPayload {
  version: 1;
  segments: NormalizedSegment[];
}

export function createTranscriptsApi(context: EngineContext) {
  return {
    import: (
      input: ImportTranscriptInput,
    ): Promise<Result<Transcript, EngineError>> =>
      importTranscript(context, input),
    get: (transcriptId: string): Promise<Result<Transcript, EngineError>> =>
      resultOf(() => requiredTranscript(context, transcriptId)),
    getAtRevision: (
      transcriptId: string,
      revision: string,
    ): Promise<Result<Transcript, EngineError>> =>
      resultOf(() => requiredTranscript(context, transcriptId, revision)),
    list: (artifact?: string): Promise<Result<Transcript[], EngineError>> =>
      resultOf(() => listTranscripts(context, artifact)),
    revise: (
      input: ReviseTranscriptInput,
    ): Promise<Result<Transcript, EngineError>> =>
      reviseTranscript(context, input),
    delete: (
      transcriptId: string,
    ): Promise<Result<{ transcriptId: string }, EngineError>> =>
      deleteTranscript(context, transcriptId),
    selectionRange: (
      transcriptId: string,
      startWordId: string,
      endWordId: string,
    ): Result<ReturnType<typeof normalizeSourceRange>, EngineError> =>
      syncResultOf(() =>
        transcriptSelectionRange(
          context,
          transcriptId,
          startWordId,
          endWordId,
        ),
      ),
  };
}

async function reviseTranscript(
  context: EngineContext,
  input: ReviseTranscriptInput,
): Promise<Result<Transcript, EngineError>> {
  return resultOf(async () => {
    const source = requiredTranscriptRow(context, input.sourceTranscriptId);
    const provider = input.provider ?? source.provider ?? undefined;
    const model = input.model ?? source.model ?? undefined;
    return importTranscript(context, {
      ...(input.transcriptId ? { transcriptId: input.transcriptId } : {}),
      artifactId: source.artifact_id,
      streamId: source.stream_id,
      objectHash: source.object_hash,
      language: input.language ?? source.language,
      ...(provider ? { provider } : {}),
      ...(model ? { model } : {}),
      state: "current",
      segments: input.segments,
    });
  });
}

function transcriptSelectionRange(
  context: EngineContext,
  transcriptId: string,
  startWordId: string,
  endWordId: string,
): ReturnType<typeof normalizeSourceRange> {
  // Selection ranges are structural: they are computed from versioned IDs
  // and ticks only, so they keep working after the text payload is forgotten.
  const row = requiredTranscriptRow(context, transcriptId);
  const stream = requiredStreamRow(context, row.stream_id);
  const segments = structuralSegments(context, row.transcript_id);
  const words = segments.flatMap((segment) => segment.words);
  const startIndex = words.findIndex((word) => word.wordId === startWordId);
  const endIndex = words.findIndex((word) => word.wordId === endWordId);
  if (startIndex < 0 || endIndex < startIndex) {
    throw new EngineFault({
      code: "INVALID_RANGE",
      message: "Transcript selection must identify ordered words",
    });
  }
  const start = words[startIndex]!;
  const end = words[endIndex]!;
  if (segments.length === 0) {
    throw new EngineFault({
      code: "INVALID_RANGE",
      message: "Transcript selection has no source range",
    });
  }
  return normalizeSourceRange({
    streamId: row.stream_id,
    objectHash: row.object_hash,
    startTick: start.startTick,
    durationTicks: end.startTick + end.durationTicks - start.startTick,
    timeBase: {
      numerator: stream.time_base_numerator,
      denominator: stream.time_base_denominator,
    },
  });
}

async function importTranscript(
  context: EngineContext,
  input: ImportTranscriptInput,
): Promise<Result<Transcript, EngineError>> {
  return resultOf(async () => {
    const artifact = context.artifactRow(input.artifactId);
    const transcriptId = input.transcriptId ?? newUuidV7();
    assertUuidV7(transcriptId, "Transcript ID");
    assertUuidV7(input.streamId, "Transcript stream ID");
    const stream = requiredStreamRow(context, input.streamId);
    if (
      stream.artifact_id !== artifact.artifact_id
      || stream.object_hash !== input.objectHash
    ) {
      throw new EngineFault({
        code: "INVALID_INPUT",
        message: "Transcript artifact, stream, and object hash must identify one source",
      });
    }
    const language = requiredText(input.language, "Transcript language");
    const segments = normalizeSegments(input.segments, stream);
    const state = input.state ?? "current";
    const payload = transcriptPayload(segments);
    const payloadObject = await context.objects.put(payload);
    const mutation = await context.store.semantic(
      {
        operation: "import_transcript",
        artifactId: artifact.artifact_id,
        details: {
          transcriptId,
          streamId: input.streamId,
          objectHash: input.objectHash,
          payloadHash: payloadObject.hash,
          language,
          state,
          segmentCount: segments.length,
          wordCount: segments.reduce(
            (count, segment) => count + segment.words.length,
            0,
          ),
        },
        writeSet: [
          `artifact:${artifact.artifact_id}`,
          `stream:${input.streamId}`,
          `transcript:${transcriptId}`,
        ],
      },
      (_operationId, now) => {
        context.store.db
          .prepare(
            `INSERT INTO objects(object_hash, size_bytes, created_at)
             VALUES (?, ?, ?)
             ON CONFLICT(object_hash) DO UPDATE SET forgotten_at=NULL`,
          )
          .run(payloadObject.hash, payloadObject.size, now);
        if (state === "current") {
          context.store.db
            .prepare(
              `UPDATE transcripts SET state='derived'
               WHERE artifact_id=? AND stream_id=? AND object_hash=?
                 AND state='current'`,
            )
            .run(artifact.artifact_id, input.streamId, input.objectHash);
        }
        context.store.db
          .prepare(
            `INSERT INTO transcripts(
              transcript_id, artifact_id, stream_id, object_hash,
              payload_hash, language, provider, model, state, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            transcriptId,
            artifact.artifact_id,
            input.streamId,
            input.objectHash,
            payloadObject.hash,
            language,
            input.provider ?? null,
            input.model ?? null,
            state,
            now,
          );
        insertSegments(context, transcriptId, segments);
      },
    );
    return ok(
      await requiredTranscript(context, transcriptId, mutation.revision),
      mutation.revision,
    );
  });
}

async function deleteTranscript(
  context: EngineContext,
  transcriptId: string,
): Promise<Result<{ transcriptId: string }, EngineError>> {
  return resultOf(async () => {
    assertUuidV7(transcriptId, "Transcript ID");
    const row = requiredTranscriptRow(context, transcriptId);
    // Caption cues pin a transcript for editorial selections; they must be
    // removed (or the transcript left in place) before it can be forgotten.
    const cues = context.store.db
      .prepare(
        `SELECT cue_id FROM caption_cues
         WHERE transcript_id=? ORDER BY cue_id`,
      )
      .all(row.transcript_id) as unknown as Array<{ cue_id: string }>;
    if (cues.length > 0) {
      throw new EngineFault({
        code: "IN_USE",
        message:
          `Transcript ${transcriptId} is referenced by `
          + `${cues.length} caption cue(s)`,
        details: { cueIds: cues.map((cue) => cue.cue_id) },
      });
    }
    const mutation = await context.store.semantic(
      {
        operation: "delete_transcript",
        artifactId: row.artifact_id,
        details: {
          transcriptId: row.transcript_id,
          streamId: row.stream_id,
          objectHash: row.object_hash,
          payloadHash: row.payload_hash,
        },
        writeSet: [`transcript:${row.transcript_id}`],
      },
      () => {
        // Segments and words cascade. The payload object is deliberately
        // left behind: it becomes collectable by storage.gc() once no HEAD
        // row references its hash.
        context.store.db
          .prepare("DELETE FROM transcripts WHERE transcript_id=?")
          .run(row.transcript_id);
      },
    );
    return ok({ transcriptId: row.transcript_id }, mutation.revision);
  });
}

async function requiredTranscript(
  context: EngineContext,
  transcriptId: string,
  revision?: string,
): Promise<Transcript> {
  const row = requiredTranscriptRow(context, transcriptId, revision);
  return transcriptFromRow(context, row, revision);
}

function requiredTranscriptRow(
  context: EngineContext,
  transcriptId: string,
  revision?: string,
): TranscriptRow {
  assertUuidV7(transcriptId, "Transcript ID");
  const transcriptSource = revision
    ? "dolt_at_transcripts(?)"
    : "transcripts";
  const row = context.store.db
    .prepare(`${TRANSCRIPT_SELECT} FROM ${transcriptSource} WHERE transcript_id=?`)
    .get(...(revision ? [revision, transcriptId] : [transcriptId])) as unknown as
    | TranscriptRow
    | undefined;
  if (!row) {
    throw new EngineFault({
      code: "NOT_FOUND",
      message: revision
        ? `Transcript not found at revision: ${transcriptId}`
        : `Transcript not found: ${transcriptId}`,
    });
  }
  return row;
}

async function listTranscripts(
  context: EngineContext,
  artifact?: string,
): Promise<Transcript[]> {
  const artifactId = artifact
    ? context.artifactRow(artifact).artifact_id
    : undefined;
  const rows = artifactId
    ? (context.store.db
        .prepare(
          `${TRANSCRIPT_SELECT} FROM transcripts
           WHERE artifact_id=?
           ORDER BY created_at, transcript_id`,
        )
        .all(artifactId) as unknown as TranscriptRow[])
    : (context.store.db
        .prepare(
          `${TRANSCRIPT_SELECT} FROM transcripts
           ORDER BY artifact_id, created_at, transcript_id`,
        )
        .all() as unknown as TranscriptRow[]);
  const transcripts: Transcript[] = [];
  for (const row of rows) {
    transcripts.push(await transcriptFromRow(context, row));
  }
  return transcripts;
}

async function transcriptFromRow(
  context: EngineContext,
  row: TranscriptRow,
  revision?: string,
): Promise<Transcript> {
  // A forgotten payload surfaces through the shared OBJECT_UNAVAILABLE
  // mapping ("Object unavailable: <hash>"); the row itself stays readable
  // as a tombstone of hash + size via the objects table.
  const payload = await readTranscriptPayload(context, row.payload_hash);
  const textBySegment = new Map<string, TranscriptPayload["segments"][number]>();
  const textByWord = new Map<string, { text: string }>();
  for (const segment of payload.segments) {
    textBySegment.set(segment.segmentId, segment);
    for (const word of segment.words) textByWord.set(word.wordId, word);
  }
  const segments = structuralSegments(context, row.transcript_id, revision);
  const stream = requiredStreamRow(context, row.stream_id, revision);
  return {
    transcriptId: row.transcript_id,
    artifactId: row.artifact_id,
    streamId: row.stream_id,
    objectHash: row.object_hash,
    payloadHash: row.payload_hash,
    language: row.language,
    ...(row.provider ? { provider: row.provider } : {}),
    ...(row.model ? { model: row.model } : {}),
    revision: revision ?? context.store.head,
    segments: segments.map((segment) =>
      segmentFromStructure(
        segment,
        row,
        stream,
        requiredPayloadText(textBySegment, segment.segmentId, "segment"),
        textByWord,
      ),
    ),
    createdAt: row.created_at,
  };
}

function requiredPayloadText<T extends { text: string }>(
  texts: Map<string, T>,
  id: string,
  label: string,
): T {
  const entry = texts.get(id);
  if (!entry) {
    throw new EngineFault({
      code: "STORAGE_ERROR",
      message: `Transcript payload has no text for ${label} ${id}`,
    });
  }
  return entry;
}

async function readTranscriptPayload(
  context: EngineContext,
  payloadHash: string,
): Promise<TranscriptPayload> {
  const buffer = await context.objects.read(payloadHash);
  let payload: TranscriptPayload;
  try {
    payload = JSON.parse(buffer.toString("utf8")) as TranscriptPayload;
  } catch {
    throw new EngineFault({
      code: "STORAGE_ERROR",
      message: `Transcript payload is not valid JSON: ${payloadHash}`,
    });
  }
  if (payload.version !== 1 || !Array.isArray(payload.segments)) {
    throw new EngineFault({
      code: "STORAGE_ERROR",
      message: `Transcript payload has an unsupported shape: ${payloadHash}`,
    });
  }
  return payload;
}

function transcriptPayload(segments: NormalizedSegment[]): string {
  const payload: TranscriptPayload = { version: 1, segments };
  return canonicalJson(payload);
}

interface StructuralWord {
  wordId: string;
  ordinal: number;
  startTick: number;
  durationTicks: number;
  confidence: number | null;
  corrected: boolean;
}

interface StructuralSegment {
  segmentId: string;
  ordinal: number;
  startTick: number;
  durationTicks: number;
  speaker: string | null;
  confidence: number | null;
  kind: TranscriptSegmentKind;
  words: StructuralWord[];
}

function structuralSegments(
  context: EngineContext,
  transcriptId: string,
  revision?: string,
): StructuralSegment[] {
  const segmentSource = revision
    ? "dolt_at_transcript_segments(?)"
    : "transcript_segments";
  const wordSource = revision
    ? "dolt_at_transcript_words(?)"
    : "transcript_words";
  const params = revision ? [revision, transcriptId] : [transcriptId];
  const segments = context.store.db
    .prepare(
      `${SEGMENT_SELECT} FROM ${segmentSource}
       WHERE transcript_id=? ORDER BY ordinal, segment_id`,
    )
    .all(...params) as unknown as SegmentRow[];
  const wordParams = revision
    ? [revision, revision, transcriptId]
    : [transcriptId];
  const words = context.store.db
    .prepare(
      `${WORD_SELECT} FROM ${wordSource}
       WHERE segment_id IN (
         SELECT segment_id FROM ${segmentSource}
         WHERE transcript_id=?
       )
       ORDER BY segment_id, ordinal, word_id`,
    )
    .all(...wordParams) as unknown as WordRow[];
  const wordsBySegment = new Map<string, StructuralWord[]>();
  for (const word of words) {
    const values = wordsBySegment.get(word.segment_id) ?? [];
    values.push({
      wordId: word.word_id,
      ordinal: word.ordinal,
      startTick: word.start_tick,
      durationTicks: word.duration_ticks,
      confidence: word.confidence,
      corrected: word.corrected === 1,
    });
    wordsBySegment.set(word.segment_id, values);
  }
  return segments.map((segment) => ({
    segmentId: segment.segment_id,
    ordinal: segment.ordinal,
    startTick: segment.start_tick,
    durationTicks: segment.duration_ticks,
    speaker: segment.speaker,
    confidence: segment.confidence,
    kind: segment.kind,
    words: wordsBySegment.get(segment.segment_id) ?? [],
  }));
}

function normalizeSegments(
  segments: ImportTranscriptSegment[],
  stream: StreamRow,
): NormalizedSegment[] {
  let previousEnd = 0;
  return segments.map((segment, index) => {
    if (segment.ordinal !== index) {
      throw new Error("Transcript segment ordinals must be contiguous");
    }
    const range = normalizeSourceRange(segment.range);
    if (
      range.streamId !== stream.stream_id
      || range.objectHash !== stream.object_hash
      || !rationalEquals(range.timeBase, {
        numerator: stream.time_base_numerator,
        denominator: stream.time_base_denominator,
      })
    ) {
      throw new EngineFault({
        code: "INVALID_RANGE",
        message: "Transcript segment range does not match its source stream",
      });
    }
    const end = sourceRangeEndTick(range);
    if (range.startTick < previousEnd || end > stream.duration_ticks) {
      throw new EngineFault({
        code: "INVALID_RANGE",
        message: "Transcript segments must be ordered and bounded by the source",
      });
    }
    previousEnd = end;
    return {
      segmentId: callerOrNewId(segment.segmentId, "Transcript segment ID"),
      ordinal: index,
      startTick: range.startTick,
      durationTicks: range.durationTicks,
      ...(segment.speaker ? { speaker: segment.speaker } : {}),
      text: requiredText(segment.text, "Transcript segment text"),
      ...(segment.confidence === undefined
        ? {}
        : { confidence: confidence(segment.confidence) }),
      kind: segment.kind,
      words: normalizeWords(segment.words, segment, range),
    };
  });
}

function normalizeWords(
  words: ImportTranscriptWord[],
  segment: ImportTranscriptSegment,
  range: ReturnType<typeof normalizeSourceRange>,
): NormalizedWord[] {
  let previousEnd = range.startTick;
  const rangeEnd = sourceRangeEndTick(range);
  return words.map((word, index) => {
    if (word.ordinal !== index) {
      throw new Error("Transcript word ordinals must be contiguous");
    }
    safeIntegerAtLeast(word.startTick, range.startTick, "Transcript word start");
    safeIntegerAtLeast(word.durationTicks, 1, "Transcript word duration");
    const end = word.startTick + word.durationTicks;
    if (
      !Number.isSafeInteger(end)
      || word.startTick < previousEnd
      || end > rangeEnd
    ) {
      throw new EngineFault({
        code: "INVALID_RANGE",
        message: `Transcript words must be ordered within segment ${segment.ordinal}`,
      });
    }
    previousEnd = end;
    return {
      wordId: callerOrNewId(word.wordId, "Transcript word ID"),
      ordinal: index,
      startTick: word.startTick,
      durationTicks: word.durationTicks,
      text: requiredText(word.text, "Transcript word text"),
      ...(word.confidence === undefined
        ? {}
        : { confidence: confidence(word.confidence) }),
      corrected: word.corrected,
    };
  });
}

function insertSegments(
  context: EngineContext,
  transcriptId: string,
  segments: NormalizedSegment[],
): void {
  // Only structure is versioned; segment and word text lives in the CAS
  // payload object named by transcripts.payload_hash.
  const insertSegment = context.store.db.prepare(
    `INSERT INTO transcript_segments(
      segment_id, transcript_id, ordinal, start_tick, duration_ticks,
      speaker, confidence, kind
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const insertWord = context.store.db.prepare(
    `INSERT INTO transcript_words(
      word_id, segment_id, ordinal, start_tick, duration_ticks,
      confidence, corrected
    ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const segment of segments) {
    insertSegment.run(
      segment.segmentId,
      transcriptId,
      segment.ordinal,
      segment.startTick,
      segment.durationTicks,
      segment.speaker ?? null,
      segment.confidence ?? null,
      segment.kind,
    );
    for (const word of segment.words) {
      insertWord.run(
        word.wordId,
        segment.segmentId,
        word.ordinal,
        word.startTick,
        word.durationTicks,
        word.confidence ?? null,
        word.corrected ? 1 : 0,
      );
    }
  }
}

function requiredStreamRow(
  context: EngineContext,
  streamIdValue: string,
  revision?: string,
): StreamRow {
  const source = revision
    ? "dolt_at_artifact_streams(?)"
    : "artifact_streams";
  const row = context.store.db
    .prepare(
      `SELECT stream_id, artifact_id, object_hash,
              time_base_numerator, time_base_denominator, duration_ticks
       FROM ${source} WHERE stream_id=?`,
    )
    .get(...(revision ? [revision, streamIdValue] : [streamIdValue])) as unknown as
    | StreamRow
    | undefined;
  if (!row) {
    throw new EngineFault({
      code: "NOT_FOUND",
      message: `Transcript stream not found: ${streamIdValue}`,
    });
  }
  return row;
}

function segmentFromStructure(
  structure: StructuralSegment,
  row: TranscriptRow,
  stream: StreamRow,
  payloadSegment: { text: string },
  textByWord: Map<string, { text: string }>,
): TranscriptSegment {
  return {
    segmentId: structure.segmentId,
    ordinal: structure.ordinal,
    range: {
      streamId: row.stream_id,
      objectHash: row.object_hash,
      startTick: structure.startTick,
      durationTicks: structure.durationTicks,
      timeBase: {
        numerator: stream.time_base_numerator,
        denominator: stream.time_base_denominator,
      },
    },
    ...(structure.speaker ? { speaker: structure.speaker } : {}),
    text: payloadSegment.text,
    ...(structure.confidence === null
      ? {}
      : { confidence: structure.confidence }),
    kind: structure.kind,
    words: structure.words.map((word) =>
      wordFromStructure(
        word,
        requiredPayloadText(textByWord, word.wordId, "word"),
      ),
    ),
  };
}

function wordFromStructure(
  structure: StructuralWord,
  payloadWord: { text: string },
): TranscriptWord {
  return {
    wordId: structure.wordId,
    ordinal: structure.ordinal,
    startTick: structure.startTick,
    durationTicks: structure.durationTicks,
    text: payloadWord.text,
    ...(structure.confidence === null
      ? {}
      : { confidence: structure.confidence }),
    corrected: structure.corrected,
  };
}

function callerOrNewId(id: string | undefined, label: string): string {
  const value = id ?? newUuidV7();
  assertUuidV7(value, label);
  return value;
}

function requiredText(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${label} is required`);
  return normalized;
}

function confidence(value: number): number {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error("Transcript confidence must be between 0 and 1");
  }
  return value;
}

function safeIntegerAtLeast(value: number, minimum: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new Error(`${label} must be a safe integer of at least ${minimum}`);
  }
}

const TRANSCRIPT_SELECT = `
  SELECT transcript_id, artifact_id, stream_id, object_hash,
         payload_hash, language, provider, model, created_at`;

const SEGMENT_SELECT = `
  SELECT segment_id, ordinal, start_tick, duration_ticks,
         speaker, confidence, kind`;

const WORD_SELECT = `
  SELECT word_id, segment_id, ordinal, start_tick, duration_ticks,
         confidence, corrected`;
