import type {
  EngineError,
  Result,
  Timeline,
  TimelineAudio,
  TimelineAudioInput,
  TimelineAudioPatch,
  TimelineInput,
  TimelinePosition,
  TimelineRender,
  TimelineSlot,
  TimelineSlotInput,
  TimelineSlotPatch,
} from "./engine-types.js";
import { ok } from "./engine-types.js";
import {
  EngineContext,
  resultOf,
  syncResultOf,
} from "./context.js";
import { assertUuidV7, newUuidV7 } from "./ids.js";
import { orderKeyAfter, orderKeyBetween, reconcileOrderKeys } from "./order-keys.js";
import { EngineFault } from "./store.js";

interface TimelineRow {
  book_id: string;
  render: TimelineRender;
}

interface TimelineSlotRow {
  slot_id: string;
  artifact_id: string;
  order_key: string;
  volume: number | null;
  audio_fade_in: number | null;
  audio_fade_out: number | null;
}

interface TimelineAudioRow {
  audio_id: string;
  artifact_id: string;
  order_key: string;
  start_frame: number;
  duration_frames: number;
  volume: number | null;
  fade_in: number | null;
  fade_out: number | null;
}

interface OrderedRow {
  id: string;
  key: string;
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
    insertSlot: (
      slot: TimelineSlotInput,
      position?: TimelinePosition,
    ): Promise<Result<Timeline, EngineError>> =>
      insertSlot(context, slot, position),
    updateSlot: (
      slotId: string,
      patch: TimelineSlotPatch,
    ): Promise<Result<Timeline, EngineError>> =>
      updateSlot(context, slotId, patch),
    moveSlot: (
      slotId: string,
      position?: TimelinePosition,
    ): Promise<Result<Timeline, EngineError>> =>
      moveRow(context, "timeline_slots", "slot_id", "Timeline slot", slotId, position),
    removeSlot: (
      slotId: string,
    ): Promise<Result<Timeline, EngineError>> =>
      removeRow(context, "timeline_slots", "slot_id", "Timeline slot", slotId),
    insertAudio: (
      item: TimelineAudioInput,
      position?: TimelinePosition,
    ): Promise<Result<Timeline, EngineError>> =>
      insertAudio(context, item, position),
    updateAudio: (
      audioId: string,
      patch: TimelineAudioPatch,
    ): Promise<Result<Timeline, EngineError>> =>
      updateAudio(context, audioId, patch),
    moveAudio: (
      audioId: string,
      position?: TimelinePosition,
    ): Promise<Result<Timeline, EngineError>> =>
      moveRow(context, "timeline_audio", "audio_id", "Timeline audio", audioId, position),
    removeAudio: (
      audioId: string,
    ): Promise<Result<Timeline, EngineError>> =>
      removeRow(context, "timeline_audio", "audio_id", "Timeline audio", audioId),
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

async function insertSlot(
  context: EngineContext,
  input: TimelineSlotInput,
  position: TimelinePosition | undefined,
): Promise<Result<Timeline, EngineError>> {
  return resultOf(async () => {
    const slot = resolveSlot(context, input);
    if (rowExists(context, "timeline_slots", "slot_id", slot.id)) {
      throw new Error(`Timeline slot already exists: ${slot.id}`);
    }
    const mutation = await context.store.semantic(
      {
        operation: "insert_timeline_slot",
        details: { slotId: slot.id, artifactId: slot.artifactId },
        writeSet: ["timeline", `timeline-slot:${slot.id}`],
      },
      () => {
        const key = keyForPosition(context, "timeline_slots", "slot_id", position);
        context.store.db
          .prepare(
            `INSERT INTO timeline_slots(
              slot_id, artifact_id, order_key, volume, audio_fade_in, audio_fade_out
            ) VALUES (?, ?, ?, ?, ?, ?)`,
          )
          .run(
            slot.id,
            slot.artifactId,
            key,
            slot.volume ?? null,
            slot.audioFadeIn ?? null,
            slot.audioFadeOut ?? null,
          );
      },
    );
    return ok(readTimeline(context), mutation.revision);
  });
}

async function updateSlot(
  context: EngineContext,
  slotId: string,
  patch: TimelineSlotPatch,
): Promise<Result<Timeline, EngineError>> {
  return resultOf(async () => {
    const row = requiredSlotRow(context, slotId);
    const artifactId = patch.artifact === undefined && patch.artifactId === undefined
      ? row.artifact_id
      : resolveArtifact(context, patch.artifact, patch.artifactId);
    optionalPatch(patch.volume, "Timeline slot volume");
    optionalPatch(patch.audioFadeIn, "Timeline slot audioFadeIn");
    optionalPatch(patch.audioFadeOut, "Timeline slot audioFadeOut");
    const mutation = await context.store.semantic(
      {
        operation: "update_timeline_slot",
        details: { slotId },
        writeSet: ["timeline", `timeline-slot:${slotId}`],
      },
      () => {
        context.store.db
          .prepare(
            `UPDATE timeline_slots
             SET artifact_id=?, volume=?, audio_fade_in=?, audio_fade_out=?
             WHERE slot_id=?`,
          )
          .run(
            artifactId,
            patchField(patch.volume, row.volume),
            patchField(patch.audioFadeIn, row.audio_fade_in),
            patchField(patch.audioFadeOut, row.audio_fade_out),
            slotId,
          );
      },
    );
    return ok(readTimeline(context), mutation.revision);
  });
}

async function insertAudio(
  context: EngineContext,
  input: TimelineAudioInput,
  position: TimelinePosition | undefined,
): Promise<Result<Timeline, EngineError>> {
  return resultOf(async () => {
    const item = resolveAudio(context, input);
    if (rowExists(context, "timeline_audio", "audio_id", item.id)) {
      throw new Error(`Timeline audio already exists: ${item.id}`);
    }
    const mutation = await context.store.semantic(
      {
        operation: "insert_timeline_audio",
        details: { audioId: item.id, artifactId: item.artifactId },
        writeSet: ["timeline", `timeline-audio:${item.id}`],
      },
      () => {
        const key = keyForPosition(context, "timeline_audio", "audio_id", position);
        context.store.db
          .prepare(
            `INSERT INTO timeline_audio(
              audio_id, artifact_id, order_key, start_frame, duration_frames,
              volume, fade_in, fade_out
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            item.id,
            item.artifactId,
            key,
            item.startFrame,
            item.durationFrames,
            item.volume ?? null,
            item.fadeIn ?? null,
            item.fadeOut ?? null,
          );
      },
    );
    return ok(readTimeline(context), mutation.revision);
  });
}

async function updateAudio(
  context: EngineContext,
  audioId: string,
  patch: TimelineAudioPatch,
): Promise<Result<Timeline, EngineError>> {
  return resultOf(async () => {
    const row = requiredAudioRow(context, audioId);
    const artifactId = patch.artifact === undefined && patch.artifactId === undefined
      ? row.artifact_id
      : resolveArtifact(context, patch.artifact, patch.artifactId);
    const startFrame = patch.startFrame ?? row.start_frame;
    const durationFrames = patch.durationFrames ?? row.duration_frames;
    integerAtLeast(startFrame, 0, "Timeline audio startFrame");
    integerAtLeast(durationFrames, 1, "Timeline audio durationFrames");
    optionalPatch(patch.volume, "Timeline audio volume");
    optionalPatch(patch.fadeIn, "Timeline audio fadeIn");
    optionalPatch(patch.fadeOut, "Timeline audio fadeOut");
    const mutation = await context.store.semantic(
      {
        operation: "update_timeline_audio",
        details: { audioId },
        writeSet: ["timeline", `timeline-audio:${audioId}`],
      },
      () => {
        context.store.db
          .prepare(
            `UPDATE timeline_audio
             SET artifact_id=?, start_frame=?, duration_frames=?,
                 volume=?, fade_in=?, fade_out=?
             WHERE audio_id=?`,
          )
          .run(
            artifactId,
            startFrame,
            durationFrames,
            patchField(patch.volume, row.volume),
            patchField(patch.fadeIn, row.fade_in),
            patchField(patch.fadeOut, row.fade_out),
            audioId,
          );
      },
    );
    return ok(readTimeline(context), mutation.revision);
  });
}

async function moveRow(
  context: EngineContext,
  table: "timeline_slots" | "timeline_audio",
  idColumn: "slot_id" | "audio_id",
  label: string,
  id: string,
  position: TimelinePosition | undefined,
): Promise<Result<Timeline, EngineError>> {
  return resultOf(async () => {
    assertUuidV7(id, `${label} ID`);
    if (!rowExists(context, table, idColumn, id)) {
      throw new EngineFault({
        code: "NOT_FOUND",
        message: `${label} not found: ${id}`,
      });
    }
    const mutation = await context.store.semantic(
      {
        operation: table === "timeline_slots"
          ? "move_timeline_slot"
          : "move_timeline_audio",
        details: { id },
        writeSet: ["timeline", `timeline-${idColumn === "slot_id" ? "slot" : "audio"}:${id}`],
      },
      () => {
        const key = keyForPosition(context, table, idColumn, position, id);
        context.store.db
          .prepare(`UPDATE ${table} SET order_key=? WHERE ${idColumn}=?`)
          .run(key, id);
      },
    );
    return ok(readTimeline(context), mutation.revision);
  });
}

async function removeRow(
  context: EngineContext,
  table: "timeline_slots" | "timeline_audio",
  idColumn: "slot_id" | "audio_id",
  label: string,
  id: string,
): Promise<Result<Timeline, EngineError>> {
  return resultOf(async () => {
    assertUuidV7(id, `${label} ID`);
    if (!rowExists(context, table, idColumn, id)) {
      throw new EngineFault({
        code: "NOT_FOUND",
        message: `${label} not found: ${id}`,
      });
    }
    const mutation = await context.store.semantic(
      {
        operation: table === "timeline_slots"
          ? "remove_timeline_slot"
          : "remove_timeline_audio",
        details: { id },
        writeSet: ["timeline", `timeline-${idColumn === "slot_id" ? "slot" : "audio"}:${id}`],
      },
      () => {
        context.store.db
          .prepare(`DELETE FROM ${table} WHERE ${idColumn}=?`)
          .run(id);
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
      `SELECT slot_id, artifact_id, order_key, volume,
              audio_fade_in, audio_fade_out
       FROM ${slotSource} ORDER BY order_key, slot_id`,
    )
    .all(...params) as unknown as TimelineSlotRow[];
  const audio = context.store.db
    .prepare(
      `SELECT audio_id, artifact_id, order_key, start_frame,
              duration_frames, volume, fade_in, fade_out
       FROM ${audioSource} ORDER BY order_key, audio_id`,
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
  const existing = orderedRows(context, "timeline_slots", "slot_id");
  const keys = reconcileOrderKeys(
    slots.map((slot) => slot.id),
    new Map(existing.map((row) => [row.id, row.key])),
  );
  const upsert = context.store.db.prepare(
    `INSERT INTO timeline_slots(
      slot_id, artifact_id, order_key, volume, audio_fade_in, audio_fade_out
    ) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(slot_id) DO UPDATE SET
      artifact_id=excluded.artifact_id,
      order_key=excluded.order_key,
      volume=excluded.volume,
      audio_fade_in=excluded.audio_fade_in,
      audio_fade_out=excluded.audio_fade_out`,
  );
  for (const slot of slots) {
    upsert.run(
      slot.id,
      slot.artifactId,
      keys.get(slot.id)!,
      slot.volume ?? null,
      slot.audioFadeIn ?? null,
      slot.audioFadeOut ?? null,
    );
  }
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
  const existing = orderedRows(context, "timeline_audio", "audio_id");
  const keys = reconcileOrderKeys(
    audio.map((item) => item.id),
    new Map(existing.map((row) => [row.id, row.key])),
  );
  const upsert = context.store.db.prepare(
    `INSERT INTO timeline_audio(
      audio_id, artifact_id, order_key, start_frame, duration_frames,
      volume, fade_in, fade_out
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(audio_id) DO UPDATE SET
      artifact_id=excluded.artifact_id,
      order_key=excluded.order_key,
      start_frame=excluded.start_frame,
      duration_frames=excluded.duration_frames,
      volume=excluded.volume,
      fade_in=excluded.fade_in,
      fade_out=excluded.fade_out`,
  );
  for (const item of audio) {
    upsert.run(
      item.id,
      item.artifactId,
      keys.get(item.id)!,
      item.startFrame,
      item.durationFrames,
      item.volume ?? null,
      item.fadeIn ?? null,
      item.fadeOut ?? null,
    );
  }
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

function orderedRows(
  context: EngineContext,
  table: "timeline_slots" | "timeline_audio",
  idColumn: "slot_id" | "audio_id",
): OrderedRow[] {
  return context.store.db
    .prepare(`SELECT ${idColumn} AS id, order_key AS key FROM ${table} ORDER BY order_key, ${idColumn}`)
    .all() as unknown as OrderedRow[];
}

function rowExists(
  context: EngineContext,
  table: "timeline_slots" | "timeline_audio",
  idColumn: "slot_id" | "audio_id",
  id: string,
): boolean {
  return Boolean(
    context.store.db
      .prepare(`SELECT 1 AS present FROM ${table} WHERE ${idColumn}=?`)
      .get(id),
  );
}

function requiredSlotRow(context: EngineContext, slotId: string): TimelineSlotRow {
  assertUuidV7(slotId, "Timeline slot ID");
  const row = context.store.db
    .prepare(
      `SELECT slot_id, artifact_id, order_key, volume,
              audio_fade_in, audio_fade_out
       FROM timeline_slots WHERE slot_id=?`,
    )
    .get(slotId) as unknown as TimelineSlotRow | undefined;
  if (!row) {
    throw new EngineFault({
      code: "NOT_FOUND",
      message: `Timeline slot not found: ${slotId}`,
    });
  }
  return row;
}

function requiredAudioRow(context: EngineContext, audioId: string): TimelineAudioRow {
  assertUuidV7(audioId, "Timeline audio ID");
  const row = context.store.db
    .prepare(
      `SELECT audio_id, artifact_id, order_key, start_frame,
              duration_frames, volume, fade_in, fade_out
       FROM timeline_audio WHERE audio_id=?`,
    )
    .get(audioId) as unknown as TimelineAudioRow | undefined;
  if (!row) {
    throw new EngineFault({
      code: "NOT_FOUND",
      message: `Timeline audio not found: ${audioId}`,
    });
  }
  return row;
}

/**
 * Mints the order key for a row inserted at `position`. When `excludeId` is
 * given (a move), that row is ignored while locating the neighbors.
 */
function keyForPosition(
  context: EngineContext,
  table: "timeline_slots" | "timeline_audio",
  idColumn: "slot_id" | "audio_id",
  position: TimelinePosition | undefined,
  excludeId?: string,
): string {
  const rows = orderedRows(context, table, idColumn)
    .filter((row) => row.id !== excludeId);
  if (!position || (position.beforeId === undefined && position.afterId === undefined)) {
    return orderKeyAfter(rows.length > 0 ? rows[rows.length - 1]!.key : null);
  }
  const beforeIndex = position.beforeId === undefined
    ? -1
    : rows.findIndex((row) => row.id === position.beforeId);
  if (position.beforeId !== undefined && beforeIndex < 0) {
    throw new EngineFault({
      code: "NOT_FOUND",
      message: `Timeline position row not found: ${position.beforeId}`,
    });
  }
  const afterIndex = position.afterId === undefined
    ? -1
    : rows.findIndex((row) => row.id === position.afterId);
  if (position.afterId !== undefined && afterIndex < 0) {
    throw new EngineFault({
      code: "NOT_FOUND",
      message: `Timeline position row not found: ${position.afterId}`,
    });
  }
  if (beforeIndex >= 0 && afterIndex >= 0 && afterIndex >= beforeIndex) {
    throw new Error(
      "Timeline position afterId must sort before beforeId",
    );
  }
  if (beforeIndex >= 0 && afterIndex >= 0) {
    return orderKeyBetween(rows[afterIndex]!.key, rows[beforeIndex]!.key);
  }
  if (afterIndex >= 0) {
    const next = afterIndex + 1 < rows.length ? rows[afterIndex + 1]!.key : null;
    return orderKeyBetween(rows[afterIndex]!.key, next);
  }
  const previous = beforeIndex > 0 ? rows[beforeIndex - 1]!.key : null;
  return orderKeyBetween(previous, rows[beforeIndex]!.key);
}

function patchField(
  patch: number | null | undefined,
  current: number | null,
): number | null {
  return patch === undefined ? current : patch;
}

function optionalPatch(value: number | null | undefined, label: string): void {
  if (value !== undefined && value !== null) optionalNonNegative(value, label);
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
