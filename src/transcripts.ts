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
import { EngineFault } from "./store.js";

interface TranscriptRow {
  transcript_id: string;
  artifact_id: string;
  stream_id: string;
  object_hash: string;
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
  text: string;
  confidence: number | null;
  kind: TranscriptSegmentKind;
}

interface WordRow {
  word_id: string;
  segment_id: string;
  ordinal: number;
  start_tick: number;
  duration_ticks: number;
  text: string;
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

export function createTranscriptsApi(context: EngineContext) {
  return {
    import: (
      input: ImportTranscriptInput,
    ): Promise<Result<Transcript, EngineError>> =>
      importTranscript(context, input),
    get: (transcriptId: string): Result<Transcript, EngineError> =>
      syncResultOf(() => requiredTranscript(context, transcriptId)),
    getAtRevision: (
      transcriptId: string,
      revision: string,
    ): Result<Transcript, EngineError> =>
      syncResultOf(() => requiredTranscript(context, transcriptId, revision)),
    list: (artifact?: string): Result<Transcript[], EngineError> =>
      syncResultOf(() => listTranscripts(context, artifact)),
    revise: (
      input: ReviseTranscriptInput,
    ): Promise<Result<Transcript, EngineError>> =>
      reviseTranscript(context, input),
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
    const source = requiredTranscript(context, input.sourceTranscriptId);
    return importTranscript(context, {
      ...(input.transcriptId ? { transcriptId: input.transcriptId } : {}),
      artifactId: source.artifactId,
      streamId: source.streamId,
      objectHash: source.objectHash,
      language: input.language ?? source.language,
      ...(input.provider ?? source.provider
        ? { provider: input.provider ?? source.provider }
        : {}),
      ...(input.model ?? source.model
        ? { model: input.model ?? source.model }
        : {}),
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
  const transcript = requiredTranscript(context, transcriptId);
  const words = transcript.segments.flatMap((segment) => segment.words);
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
  const firstSegment = transcript.segments.find((segment) =>
    segment.words.some((word) => word.wordId === start.wordId),
  );
  if (!firstSegment) {
    throw new EngineFault({
      code: "INVALID_RANGE",
      message: "Transcript selection has no source range",
    });
  }
  return normalizeSourceRange({
    streamId: transcript.streamId,
    objectHash: transcript.objectHash,
    startTick: start.startTick,
    durationTicks: end.startTick + end.durationTicks - start.startTick,
    timeBase: firstSegment.range.timeBase,
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
    const mutation = await context.store.semantic(
      {
        operation: "import_transcript",
        artifactId: artifact.artifact_id,
        details: {
          transcriptId,
          streamId: input.streamId,
          objectHash: input.objectHash,
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
      ["transcripts", "transcript_segments", "transcript_words"],
      (_operationId, now) => {
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
              language, provider, model, state, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            transcriptId,
            artifact.artifact_id,
            input.streamId,
            input.objectHash,
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
      requiredTranscript(context, transcriptId, mutation.revision),
      mutation.revision,
    );
  });
}

function requiredTranscript(
  context: EngineContext,
  transcriptId: string,
  revision?: string,
): Transcript {
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
  return transcriptFromRow(context, row, revision);
}

function listTranscripts(
  context: EngineContext,
  artifact?: string,
): Transcript[] {
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
  return rows.map((row) => transcriptFromRow(context, row));
}

function transcriptFromRow(
  context: EngineContext,
  row: TranscriptRow,
  revision?: string,
): Transcript {
  const segmentSource = revision
    ? "dolt_at_transcript_segments(?)"
    : "transcript_segments";
  const wordSource = revision
    ? "dolt_at_transcript_words(?)"
    : "transcript_words";
  const params = revision ? [revision, row.transcript_id] : [row.transcript_id];
  const segments = context.store.db
    .prepare(
      `${SEGMENT_SELECT} FROM ${segmentSource}
       WHERE transcript_id=? ORDER BY ordinal, segment_id`,
    )
    .all(...params) as unknown as SegmentRow[];
  const wordParams = revision
    ? [revision, revision, row.transcript_id]
    : [row.transcript_id];
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
  const wordsBySegment = new Map<string, TranscriptWord[]>();
  for (const word of words) {
    const values = wordsBySegment.get(word.segment_id) ?? [];
    values.push(wordFromRow(word));
    wordsBySegment.set(word.segment_id, values);
  }
  const stream = requiredStreamRow(context, row.stream_id, revision);
  return {
    transcriptId: row.transcript_id,
    artifactId: row.artifact_id,
    streamId: row.stream_id,
    objectHash: row.object_hash,
    language: row.language,
    ...(row.provider ? { provider: row.provider } : {}),
    ...(row.model ? { model: row.model } : {}),
    revision: revision ?? context.store.head,
    segments: segments.map((segment) =>
      segmentFromRow(
        segment,
        row.stream_id,
        row.object_hash,
        stream,
        wordsBySegment.get(segment.segment_id) ?? [],
      ),
    ),
    createdAt: row.created_at,
  };
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
  const insertSegment = context.store.db.prepare(
    `INSERT INTO transcript_segments(
      segment_id, transcript_id, ordinal, start_tick, duration_ticks,
      speaker, text, confidence, kind
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const insertWord = context.store.db.prepare(
    `INSERT INTO transcript_words(
      word_id, segment_id, ordinal, start_tick, duration_ticks,
      text, confidence, corrected
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const segment of segments) {
    insertSegment.run(
      segment.segmentId,
      transcriptId,
      segment.ordinal,
      segment.startTick,
      segment.durationTicks,
      segment.speaker ?? null,
      segment.text,
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
        word.text,
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

function segmentFromRow(
  row: SegmentRow,
  streamIdValue: string,
  objectHash: string,
  stream: StreamRow,
  words: TranscriptWord[],
): TranscriptSegment {
  return {
    segmentId: row.segment_id,
    ordinal: row.ordinal,
    range: {
      streamId: streamIdValue,
      objectHash,
      startTick: row.start_tick,
      durationTicks: row.duration_ticks,
      timeBase: {
        numerator: stream.time_base_numerator,
        denominator: stream.time_base_denominator,
      },
    },
    ...(row.speaker ? { speaker: row.speaker } : {}),
    text: row.text,
    ...(row.confidence === null ? {} : { confidence: row.confidence }),
    kind: row.kind,
    words,
  };
}

function wordFromRow(row: WordRow): TranscriptWord {
  return {
    wordId: row.word_id,
    ordinal: row.ordinal,
    startTick: row.start_tick,
    durationTicks: row.duration_ticks,
    text: row.text,
    ...(row.confidence === null ? {} : { confidence: row.confidence }),
    corrected: row.corrected === 1,
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
         language, provider, model, created_at`;

const SEGMENT_SELECT = `
  SELECT segment_id, ordinal, start_tick, duration_ticks,
         speaker, text, confidence, kind`;

const WORD_SELECT = `
  SELECT word_id, segment_id, ordinal, start_tick, duration_ticks,
         text, confidence, corrected`;
