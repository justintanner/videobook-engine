import type {
  EngineError,
  Result,
  Timeline,
  TimelineAudio,
  TimelineAudioInput,
  TimelineInput,
  TimelineRender,
  TimelineSlot,
  TimelineSlotInput,
} from "./engine-types.js";
import { ok } from "./engine-types.js";
import {
  EngineContext,
  resultOf,
  syncResultOf,
} from "./context.js";
import { assertUuidV7, newUuidV7 } from "./ids.js";
import { EngineFault } from "./store.js";

interface TimelineRow {
  book_id: string;
  render: TimelineRender;
}

interface TimelineSlotRow {
  slot_id: string;
  artifact_id: string;
  ordinal: number;
  volume: number | null;
  audio_fade_in: number | null;
  audio_fade_out: number | null;
}

interface TimelineAudioRow {
  audio_id: string;
  artifact_id: string;
  ordinal: number;
  start_frame: number;
  duration_frames: number;
  volume: number | null;
  fade_in: number | null;
  fade_out: number | null;
}

export function createTimelineApi(context: EngineContext) {
  return {
    get: (): Timeline => readTimeline(context),
    getAtRevision: (
      revision: string,
    ): Result<Timeline, EngineError> =>
      syncResultOf(() => readTimeline(context, revision)),
    set: (
      input: TimelineInput,
    ): Promise<Result<Timeline, EngineError>> =>
      setTimeline(context, input),
    reset: (): Promise<Result<Timeline, EngineError>> =>
      resetTimeline(context),
  };
}

async function setTimeline(
  context: EngineContext,
  input: TimelineInput,
): Promise<Result<Timeline, EngineError>> {
  return resultOf(async () => {
    validateRender(input.render);
    const slots = (input.slots ?? []).map((slot) =>
      resolveSlot(context, slot),
    );
    const audio = (input.audio ?? []).map((item) =>
      resolveAudio(context, item),
    );
    ensureUniqueIds(slots, "timeline slot");
    ensureUniqueIds(audio, "timeline audio");
    const bookId = context.bookRow().book_id;
    const mutation = await context.store.semantic(
      {
        operation: "set_timeline",
        details: {
          render: input.render,
          slots: slots.length,
          audio: audio.length,
        },
        writeSet: [
          "timeline",
          ...slots.map((slot) => `timeline-slot:${slot.id}`),
          ...audio.map((item) => `timeline-audio:${item.id}`),
        ],
      },
      ["timeline", "timeline_slots", "timeline_audio"],
      () => {
        context.store.db
          .prepare("UPDATE timeline SET render=? WHERE book_id=?")
          .run(input.render, bookId);
        synchronizeSlots(context, slots);
        synchronizeAudio(context, audio);
      },
    );
    return ok(readTimeline(context), mutation.revision);
  });
}

async function resetTimeline(
  context: EngineContext,
): Promise<Result<Timeline, EngineError>> {
  return resultOf(async () => {
    const bookId = context.bookRow().book_id;
    const mutation = await context.store.semantic(
      {
        operation: "reset_timeline",
        writeSet: ["timeline"],
      },
      ["timeline", "timeline_slots", "timeline_audio"],
      () => {
        context.store.db.prepare("DELETE FROM timeline_slots").run();
        context.store.db.prepare("DELETE FROM timeline_audio").run();
        context.store.db
          .prepare("UPDATE timeline SET render='landscape' WHERE book_id=?")
          .run(bookId);
      },
    );
    return ok(readTimeline(context), mutation.revision);
  });
}

function readTimeline(context: EngineContext, revision?: string): Timeline {
  const source = revision ? "dolt_at_timeline(?)" : "timeline";
  const params = revision ? [revision] : [];
  const row = context.store.db
    .prepare(`SELECT book_id, render FROM ${source}`)
    .get(...params) as unknown as TimelineRow | undefined;
  if (!row) {
    throw new EngineFault({
      code: "NOT_FOUND",
      message: revision
        ? `Timeline not found at revision: ${revision}`
        : "Timeline not found",
    });
  }
  const slotSource = revision
    ? "dolt_at_timeline_slots(?)"
    : "timeline_slots";
  const audioSource = revision
    ? "dolt_at_timeline_audio(?)"
    : "timeline_audio";
  const slots = context.store.db
    .prepare(
      `SELECT slot_id, artifact_id, ordinal, volume,
              audio_fade_in, audio_fade_out
       FROM ${slotSource} ORDER BY ordinal, slot_id`,
    )
    .all(...params) as unknown as TimelineSlotRow[];
  const audio = context.store.db
    .prepare(
      `SELECT audio_id, artifact_id, ordinal, start_frame,
              duration_frames, volume, fade_in, fade_out
       FROM ${audioSource} ORDER BY ordinal, audio_id`,
    )
    .all(...params) as unknown as TimelineAudioRow[];
  return {
    bookId: row.book_id,
    render: row.render,
    slots: slots.map(slotFromRow),
    audio: audio.map(audioFromRow),
  };
}

function resolveSlot(
  context: EngineContext,
  input: TimelineSlotInput,
): TimelineSlot {
  const id = input.id ?? newUuidV7();
  assertUuidV7(id, "Timeline slot ID");
  const artifactId = resolveArtifact(context, input.artifact, input.artifactId);
  optionalNonNegative(input.volume, "Timeline slot volume");
  optionalNonNegative(input.audioFadeIn, "Timeline slot audioFadeIn");
  optionalNonNegative(input.audioFadeOut, "Timeline slot audioFadeOut");
  return {
    id,
    artifactId,
    ...(input.volume === undefined ? {} : { volume: input.volume }),
    ...(input.audioFadeIn === undefined
      ? {}
      : { audioFadeIn: input.audioFadeIn }),
    ...(input.audioFadeOut === undefined
      ? {}
      : { audioFadeOut: input.audioFadeOut }),
  };
}

function resolveAudio(
  context: EngineContext,
  input: TimelineAudioInput,
): TimelineAudio {
  const id = input.id ?? newUuidV7();
  assertUuidV7(id, "Timeline audio ID");
  const artifactId = resolveArtifact(context, input.artifact, input.artifactId);
  integerAtLeast(input.startFrame, 0, "Timeline audio startFrame");
  integerAtLeast(input.durationFrames, 1, "Timeline audio durationFrames");
  optionalNonNegative(input.volume, "Timeline audio volume");
  optionalNonNegative(input.fadeIn, "Timeline audio fadeIn");
  optionalNonNegative(input.fadeOut, "Timeline audio fadeOut");
  return {
    id,
    artifactId,
    startFrame: input.startFrame,
    durationFrames: input.durationFrames,
    ...(input.volume === undefined ? {} : { volume: input.volume }),
    ...(input.fadeIn === undefined ? {} : { fadeIn: input.fadeIn }),
    ...(input.fadeOut === undefined ? {} : { fadeOut: input.fadeOut }),
  };
}

function resolveArtifact(
  context: EngineContext,
  artifact: string | undefined,
  artifactId: string | undefined,
): string {
  if (!artifact && !artifactId) {
    throw new Error("Timeline artifact reference is required");
  }
  const resolved = context.artifactRow(artifact ?? artifactId!).artifact_id;
  if (
    artifact &&
    artifactId &&
    context.artifactRow(artifactId).artifact_id !== resolved
  ) {
    throw new Error(
      "Timeline artifact and artifactId must identify the same artifact",
    );
  }
  return resolved;
}

function synchronizeSlots(
  context: EngineContext,
  slots: TimelineSlot[],
): void {
  deleteMissing(context, "timeline_slots", "slot_id", slots.map((slot) => slot.id));
  const upsert = context.store.db.prepare(
    `INSERT INTO timeline_slots(
      slot_id, artifact_id, ordinal, volume, audio_fade_in, audio_fade_out
    ) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(slot_id) DO UPDATE SET
      artifact_id=excluded.artifact_id,
      ordinal=excluded.ordinal,
      volume=excluded.volume,
      audio_fade_in=excluded.audio_fade_in,
      audio_fade_out=excluded.audio_fade_out`,
  );
  slots.forEach((slot, ordinal) => {
    upsert.run(
      slot.id,
      slot.artifactId,
      ordinal,
      slot.volume ?? null,
      slot.audioFadeIn ?? null,
      slot.audioFadeOut ?? null,
    );
  });
}

function synchronizeAudio(
  context: EngineContext,
  audio: TimelineAudio[],
): void {
  deleteMissing(
    context,
    "timeline_audio",
    "audio_id",
    audio.map((item) => item.id),
  );
  const upsert = context.store.db.prepare(
    `INSERT INTO timeline_audio(
      audio_id, artifact_id, ordinal, start_frame, duration_frames,
      volume, fade_in, fade_out
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(audio_id) DO UPDATE SET
      artifact_id=excluded.artifact_id,
      ordinal=excluded.ordinal,
      start_frame=excluded.start_frame,
      duration_frames=excluded.duration_frames,
      volume=excluded.volume,
      fade_in=excluded.fade_in,
      fade_out=excluded.fade_out`,
  );
  audio.forEach((item, ordinal) => {
    upsert.run(
      item.id,
      item.artifactId,
      ordinal,
      item.startFrame,
      item.durationFrames,
      item.volume ?? null,
      item.fadeIn ?? null,
      item.fadeOut ?? null,
    );
  });
}

function deleteMissing(
  context: EngineContext,
  table: "timeline_slots" | "timeline_audio",
  idColumn: "slot_id" | "audio_id",
  ids: string[],
): void {
  if (ids.length === 0) {
    context.store.db.prepare(`DELETE FROM ${table}`).run();
    return;
  }
  const placeholders = ids.map(() => "?").join(", ");
  context.store.db
    .prepare(`DELETE FROM ${table} WHERE ${idColumn} NOT IN (${placeholders})`)
    .run(...ids);
}

function slotFromRow(row: TimelineSlotRow): TimelineSlot {
  return {
    id: row.slot_id,
    artifactId: row.artifact_id,
    ...(row.volume === null ? {} : { volume: row.volume }),
    ...(row.audio_fade_in === null
      ? {}
      : { audioFadeIn: row.audio_fade_in }),
    ...(row.audio_fade_out === null
      ? {}
      : { audioFadeOut: row.audio_fade_out }),
  };
}

function audioFromRow(row: TimelineAudioRow): TimelineAudio {
  return {
    id: row.audio_id,
    artifactId: row.artifact_id,
    startFrame: row.start_frame,
    durationFrames: row.duration_frames,
    ...(row.volume === null ? {} : { volume: row.volume }),
    ...(row.fade_in === null ? {} : { fadeIn: row.fade_in }),
    ...(row.fade_out === null ? {} : { fadeOut: row.fade_out }),
  };
}

function ensureUniqueIds(
  items: Array<{ id: string }>,
  label: string,
): void {
  const seen = new Set<string>();
  for (const item of items) {
    if (seen.has(item.id)) throw new Error(`Duplicate ${label} ID: ${item.id}`);
    seen.add(item.id);
  }
}

function validateRender(value: string): asserts value is TimelineRender {
  if (!["landscape", "portrait", "square"].includes(value)) {
    throw new Error(`Invalid timeline render: ${value}`);
  }
}

function optionalNonNegative(value: number | undefined, label: string): void {
  if (value !== undefined && (!Number.isFinite(value) || value < 0)) {
    throw new Error(`${label} must be a non-negative finite number`);
  }
}

function integerAtLeast(value: number, minimum: number, label: string): void {
  if (!Number.isInteger(value) || value < minimum) {
    throw new Error(`${label} must be an integer >= ${minimum}`);
  }
}
