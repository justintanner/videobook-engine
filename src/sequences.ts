import type {
  EngineError,
  Result,
} from "./engine-types.js";
import { ok } from "./engine-types.js";
import type {
  AudioTrack,
  CaptionCue,
  CaptionTrack,
  ClipAudio,
  ClipTransform,
  CreateSequenceTrackInput,
  CreateSequenceInput,
  Sequence,
  SequenceClip,
  SequenceTrack,
  SequenceTransition,
  TranscriptSelection,
  UpdateSequenceTrackInput,
  VideoTrack,
} from "./mvp-contracts.js";
import {
  EngineContext,
  resultOf,
  syncResultOf,
} from "./context.js";
import { assertUuidV7, newUuidV7 } from "./ids.js";
import {
  initialOrderKeys,
  orderKeyAfter,
  orderKeyBetween,
} from "./order-keys.js";
import {
  normalizeRational,
  normalizeSourceRange,
} from "./mvp-time.js";
import { canonicalJson, parseJson } from "./store.js";
import { EngineFault } from "./store.js";

interface SequenceRow {
  sequence_id: string;
  name: string;
  is_primary: number;
  width: number;
  height: number;
  pixel_aspect_numerator: number;
  pixel_aspect_denominator: number;
  frame_rate_numerator: number;
  frame_rate_denominator: number;
  audio_sample_rate_hz: number;
  audio_channel_layout: string;
  background_rgba_json: string;
  created_at: number;
}

interface TrackRow {
  track_id: string;
  sequence_id: string;
  kind: "video" | "audio" | "caption";
  order_key: string;
  name: string;
  enabled: number;
  locked: number;
  muted: number | null;
  solo: number | null;
  blend_mode: string | null;
}

interface ClipRow {
  clip_id: string;
  track_id: string;
  source_kind: "still" | "timed";
  artifact_id: string;
  source_path: string | null;
  stream_id: string | null;
  object_hash: string;
  source_start_tick: number | null;
  source_duration_ticks: number | null;
  time_base_numerator: number | null;
  time_base_denominator: number | null;
  timeline_start_frame: number;
  duration_frames: number;
  speed_numerator: number | null;
  speed_denominator: number | null;
  reverse: number | null;
  audio_policy: "preserve-pitch" | "resample" | "mute" | null;
  gain_db: number | null;
  audio_muted: number | null;
  fade_in_frames: number | null;
  fade_out_frames: number | null;
  enabled: number;
}

interface TransformRow {
  clip_id: string;
  fit: "fit" | "fill" | "crop";
  position_x: number;
  position_y: number;
  scale_x: number;
  scale_y: number;
  anchor_x: number;
  anchor_y: number;
  rotation_degrees: number;
  crop_top: number;
  crop_right: number;
  crop_bottom: number;
  crop_left: number;
  opacity: number;
  blend_mode: "normal";
}

interface TransitionRow {
  transition_id: string;
  track_id: string;
  outgoing_clip_id: string;
  incoming_clip_id: string;
  kind: "cut" | "dissolve";
  duration_frames: number;
  alignment: "start" | "center" | "end";
}

interface CaptionRow {
  cue_id: string;
  track_id: string;
  timeline_start_frame: number;
  duration_frames: number;
  text: string;
  speaker: string | null;
  style_id: string;
  transcript_id: string | null;
  transcript_revision: string | null;
  start_word_id: string | null;
  end_word_id: string | null;
  source_range_json: string | null;
}

export function createSequencesApi(context: EngineContext) {
  return {
    create: (
      input: CreateSequenceInput,
    ): Promise<Result<Sequence, EngineError>> =>
      createSequence(context, input),
    list: (): Sequence[] => listSequences(context),
    get: (sequenceId: string): Result<Sequence, EngineError> =>
      syncResultOf(() => requiredSequence(context, sequenceId)),
    getPrimary: (): Sequence => primarySequence(context),
    getAtRevision: (
      sequenceId: string,
      revision: string,
    ): Result<Sequence, EngineError> =>
      syncResultOf(() => requiredSequence(context, sequenceId, revision)),
    rename: (
      sequenceId: string,
      name: string,
    ): Promise<Result<Sequence, EngineError>> =>
      renameSequence(context, sequenceId, name),
    updateTrack: (
      trackId: string,
      input: UpdateSequenceTrackInput,
    ): Promise<Result<Sequence, EngineError>> =>
      updateTrack(context, trackId, input),
    addTrack: (
      sequenceId: string,
      input: CreateSequenceTrackInput,
    ): Promise<Result<Sequence, EngineError>> =>
      addTrack(context, sequenceId, input),
    moveTrack: (
      trackId: string,
      toOrdinal: number,
    ): Promise<Result<Sequence, EngineError>> =>
      moveTrack(context, trackId, toOrdinal),
    removeTrack: (
      trackId: string,
    ): Promise<Result<Sequence, EngineError>> =>
      removeTrack(context, trackId),
    delete: (
      sequenceId: string,
    ): Promise<Result<{ sequenceId: string }, EngineError>> =>
      deleteSequence(context, sequenceId),
  };
}

async function addTrack(
  context: EngineContext,
  sequenceId: string,
  input: CreateSequenceTrackInput,
): Promise<Result<Sequence, EngineError>> {
  return resultOf(async () => {
    assertUuidV7(sequenceId, "Sequence ID");
    requiredSequenceRow(context, sequenceId);
    const siblings = context.store.db
      .prepare(
        `SELECT order_key FROM sequence_tracks
         WHERE sequence_id=? AND kind=?
         ORDER BY order_key, track_id`,
      )
      .all(sequenceId, input.kind) as unknown as Array<{ order_key: string }>;
    const trackId = newUuidV7();
    const ordinal = siblings.length;
    const orderKey = orderKeyAfter(
      siblings.length > 0 ? siblings[siblings.length - 1]!.order_key : null,
    );
    const name = input.name === undefined
      ? input.kind === "caption"
        ? `Captions ${ordinal + 1}`
        : `${input.kind === "video" ? "Video" : "Audio"} ${ordinal + 1}`
      : requiredText(input.name, "Track name");
    const common = {
      trackId,
      sequenceId,
      ordinal,
      name,
      enabled: true,
      locked: false,
    };
    const track: SequenceTrack = input.kind === "video"
      ? { ...common, kind: "video", blendMode: "normal" }
      : input.kind === "audio"
        ? { ...common, kind: "audio", muted: false, solo: false }
        : { ...common, kind: "caption" };
    const mutation = await context.store.semantic(
      {
        operation: "add_sequence_track",
        details: { sequenceId, trackId, kind: input.kind, ordinal },
        writeSet: [`sequence:${sequenceId}`, `track:${trackId}`],
      },
      () => insertTracks(context, [{ track, orderKey }]),
    );
    return ok(
      requiredSequence(context, sequenceId, mutation.revision),
      mutation.revision,
    );
  });
}

async function moveTrack(
  context: EngineContext,
  trackId: string,
  toOrdinal: number,
): Promise<Result<Sequence, EngineError>> {
  return resultOf(async () => {
    assertUuidV7(trackId, "Track ID");
    if (!Number.isInteger(toOrdinal)) {
      throw new Error("Track ordinal must be an integer");
    }
    const row = requiredTrackRow(context, trackId);
    const siblings = context.store.db
      .prepare(
        `SELECT track_id, order_key FROM sequence_tracks
         WHERE sequence_id=? AND kind=?
         ORDER BY order_key, track_id`,
      )
      .all(row.sequence_id, row.kind) as unknown as Array<{
        track_id: string;
        order_key: string;
      }>;
    const currentOrdinal = siblings.findIndex(
      (candidate) => candidate.track_id === trackId,
    );
    const others = siblings.filter((candidate) => candidate.track_id !== trackId);
    const target = Math.max(0, Math.min(toOrdinal, others.length));
    if (target === currentOrdinal) {
      return requiredSequence(context, row.sequence_id);
    }
    const orderKey = target === others.length
      ? orderKeyAfter(others.length > 0 ? others[others.length - 1]!.order_key : null)
      : orderKeyBetween(
        target > 0 ? others[target - 1]!.order_key : null,
        others[target]!.order_key,
      );
    const mutation = await context.store.semantic(
      {
        operation: "move_sequence_track",
        details: {
          sequenceId: row.sequence_id,
          trackId,
          kind: row.kind,
          fromOrdinal: currentOrdinal,
          toOrdinal: target,
        },
        writeSet: [`sequence:${row.sequence_id}`, `track:${trackId}`],
      },
      () => {
        context.store.db
          .prepare("UPDATE sequence_tracks SET order_key=? WHERE track_id=?")
          .run(orderKey, trackId);
      },
    );
    return ok(
      requiredSequence(context, row.sequence_id, mutation.revision),
      mutation.revision,
    );
  });
}

async function removeTrack(
  context: EngineContext,
  trackId: string,
): Promise<Result<Sequence, EngineError>> {
  return resultOf(async () => {
    const row = requiredTrackRow(context, trackId);
    const clipCount = context.store.db
      .prepare("SELECT COUNT(*) AS count FROM sequence_clips WHERE track_id=?")
      .get(trackId) as { count: number };
    const captionCount = context.store.db
      .prepare("SELECT COUNT(*) AS count FROM caption_cues WHERE track_id=?")
      .get(trackId) as { count: number };
    if (clipCount.count > 0 || captionCount.count > 0) {
      throw new EngineFault({
        code: "IN_USE",
        message: "A non-empty sequence track cannot be removed",
        ownerId: trackId,
      });
    }
    const kindCount = context.store.db
      .prepare(
        "SELECT COUNT(*) AS count FROM sequence_tracks WHERE sequence_id=? AND kind=?",
      )
      .get(row.sequence_id, row.kind) as { count: number };
    if (kindCount.count <= 1) {
      throw new EngineFault({
        code: "IN_USE",
        message: `The final ${row.kind} track cannot be removed`,
        ownerId: trackId,
      });
    }
    const ordinal = trackOrdinal(context, row);
    const mutation = await context.store.semantic(
      {
        operation: "remove_sequence_track",
        details: {
          sequenceId: row.sequence_id,
          trackId,
          kind: row.kind,
          ordinal,
        },
        writeSet: [`sequence:${row.sequence_id}`, `track:${trackId}`],
      },
      () => {
        context.store.db
          .prepare("DELETE FROM sequence_tracks WHERE track_id=?")
          .run(trackId);
      },
    );
    return ok(
      requiredSequence(context, row.sequence_id, mutation.revision),
      mutation.revision,
    );
  });
}

async function updateTrack(
  context: EngineContext,
  trackId: string,
  input: UpdateSequenceTrackInput,
): Promise<Result<Sequence, EngineError>> {
  return resultOf(async () => {
    const row = requiredTrackRow(context, trackId);
    if (row.kind !== "audio" && (input.muted !== undefined || input.solo !== undefined)) {
      throw new EngineFault({
        code: "INVALID_INPUT",
        message: "Muted and solo are only valid for audio tracks",
      });
    }
    const name = input.name === undefined
      ? row.name
      : requiredText(input.name, "Track name");
    const mutation = await context.store.semantic(
      {
        operation: "update_sequence_track",
        details: { trackId, sequenceId: row.sequence_id },
        writeSet: [`sequence:${row.sequence_id}`, `track:${trackId}`],
      },
      () => {
        context.store.db
          .prepare(
            `UPDATE sequence_tracks
             SET name=?, enabled=?, locked=?, muted=?, solo=?
             WHERE track_id=?`,
          )
          .run(
            name,
            (input.enabled ?? row.enabled === 1) ? 1 : 0,
            (input.locked ?? row.locked === 1) ? 1 : 0,
            row.kind === "audio"
              ? ((input.muted ?? row.muted === 1) ? 1 : 0)
              : null,
            row.kind === "audio"
              ? ((input.solo ?? row.solo === 1) ? 1 : 0)
              : null,
            trackId,
          );
      },
    );
    return ok(
      requiredSequence(context, row.sequence_id, mutation.revision),
      mutation.revision,
    );
  });
}

async function createSequence(
  context: EngineContext,
  input: CreateSequenceInput,
): Promise<Result<Sequence, EngineError>> {
  return resultOf(async () => {
    const sequenceId = input.sequenceId ?? newUuidV7();
    assertUuidV7(sequenceId, "Sequence ID");
    const normalized = normalizeCreateInput(input);
    const bookId = context.bookRow().book_id;
    const tracks = defaultTracks(
      sequenceId,
      normalized.videoTrackCount,
      normalized.audioTrackCount,
      normalized.captionTrackCount,
    );
    const mutation = await context.store.semantic(
      {
        operation: "create_sequence",
        details: {
          sequenceId,
          name: normalized.name,
          width: normalized.width,
          height: normalized.height,
          frameRate: normalized.frameRate,
          trackCount: tracks.length,
        },
        writeSet: [
          `sequence:${sequenceId}`,
          ...tracks.map(({ track }) => `track:${track.trackId}`),
        ],
      },
      (_operationId, now) => {
        insertSequence(context, sequenceId, bookId, normalized, now);
        insertTracks(context, tracks);
      },    );
    return ok(
      requiredSequence(context, sequenceId, mutation.revision),
      mutation.revision,
    );
  });
}

async function renameSequence(
  context: EngineContext,
  sequenceId: string,
  requestedName: string,
): Promise<Result<Sequence, EngineError>> {
  return resultOf(async () => {
    const current = requiredSequence(context, sequenceId);
    const name = requiredText(requestedName, "Sequence name");
    if (name === current.name) return current;
    const mutation = await context.store.semantic(
      {
        operation: "rename_sequence",
        details: { sequenceId, oldName: current.name, newName: name },
        writeSet: [`sequence:${sequenceId}`],
      },
      () => {
        context.store.db
          .prepare("UPDATE sequences SET name=? WHERE sequence_id=?")
          .run(name, sequenceId);
      },
    );
    return ok(
      requiredSequence(context, sequenceId, mutation.revision),
      mutation.revision,
    );
  });
}

async function deleteSequence(
  context: EngineContext,
  sequenceId: string,
): Promise<Result<{ sequenceId: string }, EngineError>> {
  return resultOf(async () => {
    assertUuidV7(sequenceId, "Sequence ID");
    const row = requiredSequenceRow(context, sequenceId);
    if (row.is_primary === 1) {
      throw new EngineFault({
        code: "IN_USE",
        message: "The primary sequence cannot be deleted",
        ownerId: sequenceId,
      });
    }
    const references = context.store.db
      .prepare(
        `SELECT notebook_id, cell_id, reference_id
         FROM cell_references
         WHERE kind='sequence' AND target_id=?
         ORDER BY notebook_id, cell_id, reference_id`,
      )
      .all(sequenceId) as unknown as Array<{
      notebook_id: string;
      cell_id: string;
      reference_id: string;
    }>;
    if (references.length > 0) {
      throw new EngineFault({
        code: "IN_USE",
        message: `Sequence is still referenced: ${sequenceId}`,
        ownerId: sequenceId,
        details: { references },
      });
    }
    const mutation = await context.store.semantic(
      {
        operation: "delete_sequence",
        details: { sequenceId },
        writeSet: [`sequence:${sequenceId}`],
      },
      () => {
        context.store.db
          .prepare("DELETE FROM sequences WHERE sequence_id=?")
          .run(sequenceId);
      },
    );
    return ok({ sequenceId }, mutation.revision);
  });
}

function listSequences(context: EngineContext): Sequence[] {
  const rows = context.store.db
    .prepare(`${SEQUENCE_SELECT} FROM sequences ORDER BY is_primary DESC, created_at, sequence_id`)
    .all() as unknown as SequenceRow[];
  return rows.map((row) => sequenceFromRow(context, row));
}

function primarySequence(context: EngineContext): Sequence {
  const row = context.store.db
    .prepare(`${SEQUENCE_SELECT} FROM sequences WHERE is_primary=1`)
    .get() as unknown as SequenceRow | undefined;
  if (!row) {
    throw new EngineFault({
      code: "SCHEMA_INCOMPATIBLE",
      message: "Book is missing its primary sequence",
    });
  }
  return sequenceFromRow(context, row);
}

function requiredSequence(
  context: EngineContext,
  sequenceId: string,
  revision?: string,
): Sequence {
  const row = requiredSequenceRow(context, sequenceId, revision);
  return sequenceFromRow(context, row, revision);
}

function requiredSequenceRow(
  context: EngineContext,
  sequenceId: string,
  revision?: string,
): SequenceRow {
  assertUuidV7(sequenceId, "Sequence ID");
  const source = semanticSource("sequences", revision);
  const row = context.store.db
    .prepare(`${SEQUENCE_SELECT} FROM ${source} WHERE sequence_id=?`)
    .get(...revisionParams(revision, sequenceId)) as unknown as
    | SequenceRow
    | undefined;
  if (!row) {
    throw new EngineFault({
      code: "NOT_FOUND",
      message: revision
        ? `Sequence not found at revision: ${sequenceId}`
        : `Sequence not found: ${sequenceId}`,
    });
  }
  return row;
}

function sequenceFromRow(
  context: EngineContext,
  row: SequenceRow,
  revision?: string,
): Sequence {
  const trackRows = queryRows<TrackRow>(
    context,
    `${TRACK_SELECT} FROM ${semanticSource("sequence_tracks", revision)}
     WHERE sequence_id=? ORDER BY kind, order_key, track_id`,
    revision,
    row.sequence_id,
  );
  const ordinalsByKind = new Map<string, number>();
  const tracks = trackRows.map((trackRow) => {
    const ordinal = ordinalsByKind.get(trackRow.kind) ?? 0;
    ordinalsByKind.set(trackRow.kind, ordinal + 1);
    return trackFromRow(trackRow, ordinal);
  });
  const trackIds = tracks.map((track) => track.trackId);
  const clips = trackIds.length === 0
    ? []
    : readClips(context, trackIds, revision);
  const transitions = trackIds.length === 0
    ? []
    : readTransitions(context, trackIds, revision);
  const captions = trackIds.length === 0
    ? []
    : readCaptions(context, trackIds, revision);
  const background = parseJson<unknown>(row.background_rgba_json, [0, 0, 0, 1]);
  if (!isRgba(background)) {
    throw new EngineFault({
      code: "SCHEMA_INCOMPATIBLE",
      message: `Sequence has invalid background RGBA: ${row.sequence_id}`,
    });
  }
  return {
    sequenceId: row.sequence_id,
    name: row.name,
    width: row.width,
    height: row.height,
    pixelAspect: {
      numerator: row.pixel_aspect_numerator,
      denominator: row.pixel_aspect_denominator,
    },
    frameRate: {
      numerator: row.frame_rate_numerator,
      denominator: row.frame_rate_denominator,
    },
    audioSampleRateHz: row.audio_sample_rate_hz,
    audioChannelLayout: row.audio_channel_layout,
    backgroundRgba: background,
    revision: revision ?? context.store.head,
    tracks,
    clips,
    transitions,
    captions,
    createdAt: row.created_at,
  };
}

function readClips(
  context: EngineContext,
  trackIds: string[],
  revision?: string,
): SequenceClip[] {
  const placeholders = trackIds.map(() => "?").join(",");
  const clips = queryRows<ClipRow>(
    context,
    `${CLIP_SELECT} FROM ${semanticSource("sequence_clips", revision)}
     WHERE track_id IN (${placeholders})
     ORDER BY track_id, timeline_start_frame, clip_id`,
    revision,
    ...trackIds,
  );
  const clipIds = clips.map((clip) => clip.clip_id);
  if (clipIds.length === 0) return [];
  const clipPlaceholders = clipIds.map(() => "?").join(",");
  const links = queryRows<{ link_group_id: string; clip_id: string }>(
    context,
    `SELECT link_group_id, clip_id
     FROM ${semanticSource("clip_links", revision)}
     WHERE clip_id IN (${clipPlaceholders})`,
    revision,
    ...clipIds,
  );
  const transforms = queryRows<TransformRow>(
    context,
    `${TRANSFORM_SELECT}
     FROM ${semanticSource("clip_transforms", revision)}
     WHERE clip_id IN (${clipPlaceholders})`,
    revision,
    ...clipIds,
  );
  const linkByClip = new Map(links.map((link) => [link.clip_id, link.link_group_id]));
  const transformByClip = new Map(
    transforms.map((transformRow) => [
      transformRow.clip_id,
      transformFromRow(transformRow),
    ]),
  );
  return clips.map((clip) =>
    clipFromRow(
      clip,
      linkByClip.get(clip.clip_id),
      transformByClip.get(clip.clip_id),
    ),
  );
}

function readTransitions(
  context: EngineContext,
  trackIds: string[],
  revision?: string,
): SequenceTransition[] {
  const placeholders = trackIds.map(() => "?").join(",");
  return queryRows<TransitionRow>(
    context,
    `${TRANSITION_SELECT}
     FROM ${semanticSource("transitions", revision)}
     WHERE track_id IN (${placeholders})
     ORDER BY track_id, outgoing_clip_id, incoming_clip_id`,
    revision,
    ...trackIds,
  ).map((row) => ({
    transitionId: row.transition_id,
    trackId: row.track_id,
    outgoingClipId: row.outgoing_clip_id,
    incomingClipId: row.incoming_clip_id,
    kind: row.kind,
    durationFrames: row.duration_frames,
    alignment: row.alignment,
  }));
}

function readCaptions(
  context: EngineContext,
  trackIds: string[],
  revision?: string,
): CaptionCue[] {
  const placeholders = trackIds.map(() => "?").join(",");
  return queryRows<CaptionRow>(
    context,
    `${CAPTION_SELECT}
     FROM ${semanticSource("caption_cues", revision)}
     WHERE track_id IN (${placeholders})
     ORDER BY track_id, timeline_start_frame, cue_id`,
    revision,
    ...trackIds,
  ).map(captionFromRow);
}

function clipFromRow(
  row: ClipRow,
  linkGroupId?: string,
  transform?: ClipTransform,
): SequenceClip {
  const common = {
    clipId: row.clip_id,
    trackId: row.track_id,
    timelineStartFrame: row.timeline_start_frame,
    durationFrames: row.duration_frames,
    enabled: row.enabled === 1,
    ...(linkGroupId ? { linkGroupId } : {}),
    ...(transform ? { transform } : {}),
    ...clipAudio(row),
  };
  if (row.source_kind === "still") {
    if (!row.source_path) {
      throw invalidClip(row.clip_id, "still source path");
    }
    return {
      ...common,
      source: {
        kind: "still",
        artifactId: row.artifact_id,
        sourcePath: row.source_path,
        objectHash: row.object_hash,
      },
    };
  }
  if (
    !row.stream_id
    || row.source_start_tick === null
    || row.source_duration_ticks === null
    || row.time_base_numerator === null
    || row.time_base_denominator === null
    || row.speed_numerator === null
    || row.speed_denominator === null
    || row.reverse === null
    || row.audio_policy === null
  ) {
    throw invalidClip(row.clip_id, "timed source mapping");
  }
  return {
    ...common,
    source: {
      kind: "timed",
      artifactId: row.artifact_id,
      range: {
        streamId: row.stream_id,
        objectHash: row.object_hash,
        startTick: row.source_start_tick,
        durationTicks: row.source_duration_ticks,
        timeBase: {
          numerator: row.time_base_numerator,
          denominator: row.time_base_denominator,
        },
      },
    },
    speed: {
      numerator: row.speed_numerator,
      denominator: row.speed_denominator,
    },
    reverse: row.reverse === 1,
    audioPolicy: row.audio_policy,
  };
}

function clipAudio(row: ClipRow): { audio?: ClipAudio } {
  const values = [
    row.gain_db,
    row.audio_muted,
    row.fade_in_frames,
    row.fade_out_frames,
  ];
  if (values.every((value) => value === null)) return {};
  if (values.some((value) => value === null)) {
    throw invalidClip(row.clip_id, "audio projection");
  }
  return {
    audio: {
      gainDb: row.gain_db!,
      muted: row.audio_muted === 1,
      fadeInFrames: row.fade_in_frames!,
      fadeOutFrames: row.fade_out_frames!,
    },
  };
}

function transformFromRow(row: TransformRow): ClipTransform {
  return {
    fit: row.fit,
    positionX: row.position_x,
    positionY: row.position_y,
    scaleX: row.scale_x,
    scaleY: row.scale_y,
    anchorX: row.anchor_x,
    anchorY: row.anchor_y,
    rotationDegrees: row.rotation_degrees,
    cropTop: row.crop_top,
    cropRight: row.crop_right,
    cropBottom: row.crop_bottom,
    cropLeft: row.crop_left,
    opacity: row.opacity,
    blendMode: row.blend_mode,
  };
}

function captionFromRow(row: CaptionRow): CaptionCue {
  const transcriptSelection = captionTranscriptSelection(row);
  return {
    cueId: row.cue_id,
    trackId: row.track_id,
    timelineStartFrame: row.timeline_start_frame,
    durationFrames: row.duration_frames,
    text: row.text,
    ...(row.speaker ? { speaker: row.speaker } : {}),
    styleId: row.style_id,
    ...(transcriptSelection ? { transcriptSelection } : {}),
  };
}

function captionTranscriptSelection(
  row: CaptionRow,
): TranscriptSelection | null {
  const values = [
    row.transcript_id,
    row.transcript_revision,
    row.start_word_id,
    row.end_word_id,
    row.source_range_json,
  ];
  if (values.every((value) => value === null)) return null;
  if (values.some((value) => value === null)) {
    throw new EngineFault({
      code: "SCHEMA_INCOMPATIBLE",
      message: `Caption has an incomplete transcript selection: ${row.cue_id}`,
    });
  }
  return {
    transcriptId: row.transcript_id!,
    transcriptRevision: row.transcript_revision!,
    startWordId: row.start_word_id!,
    endWordId: row.end_word_id!,
    range: normalizeSourceRange(
      parseJson(row.source_range_json!, {
        streamId: "",
        objectHash: "",
        startTick: 0,
        durationTicks: 0,
        timeBase: { numerator: 1, denominator: 1 },
      }),
    ),
  };
}

function trackFromRow(row: TrackRow, ordinal: number): SequenceTrack {
  const common = {
    trackId: row.track_id,
    sequenceId: row.sequence_id,
    ordinal,
    name: row.name,
    enabled: row.enabled === 1,
    locked: row.locked === 1,
  };
  if (row.kind === "video") {
    return {
      ...common,
      kind: "video",
      blendMode: "normal",
    } satisfies VideoTrack;
  }
  if (row.kind === "audio") {
    return {
      ...common,
      kind: "audio",
      muted: row.muted === 1,
      solo: row.solo === 1,
    } satisfies AudioTrack;
  }
  return {
    ...common,
    kind: "caption",
  } satisfies CaptionTrack;
}

function normalizeCreateInput(input: CreateSequenceInput) {
  const pixelAspect = normalizeRational(
    input.pixelAspect ?? { numerator: 1, denominator: 1 },
  );
  const frameRate = normalizeRational(input.frameRate);
  const backgroundRgba = input.backgroundRgba ?? [0, 0, 0, 1];
  if (!isRgba(backgroundRgba)) {
    throw new Error("Sequence background RGBA must contain four finite values");
  }
  const videoTrackCount = trackCount(input.videoTrackCount ?? 2, "Video track count");
  const audioTrackCount = trackCount(input.audioTrackCount ?? 4, "Audio track count");
  const captionTrackCount = trackCount(
    input.captionTrackCount ?? 1,
    "Caption track count",
  );
  safeIntegerAtLeast(input.width, 1, "Sequence width");
  safeIntegerAtLeast(input.height, 1, "Sequence height");
  const audioSampleRateHz = input.audioSampleRateHz ?? 48_000;
  safeIntegerAtLeast(audioSampleRateHz, 1, "Sequence audio sample rate");
  return {
    name: requiredText(input.name, "Sequence name"),
    width: input.width,
    height: input.height,
    pixelAspect,
    frameRate,
    audioSampleRateHz,
    audioChannelLayout: requiredText(
      input.audioChannelLayout ?? "stereo",
      "Sequence audio channel layout",
    ),
    backgroundRgba,
    videoTrackCount,
    audioTrackCount,
    captionTrackCount,
  };
}

function insertSequence(
  context: EngineContext,
  sequenceId: string,
  bookId: string,
  input: ReturnType<typeof normalizeCreateInput>,
  now: number,
): void {
  context.store.db
    .prepare(
      `INSERT INTO sequences(
        sequence_id, book_id, name, is_primary, width, height,
        pixel_aspect_numerator, pixel_aspect_denominator,
        frame_rate_numerator, frame_rate_denominator,
        audio_sample_rate_hz, audio_channel_layout,
        background_rgba_json, created_at
      ) VALUES (?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      sequenceId,
      bookId,
      input.name,
      input.width,
      input.height,
      input.pixelAspect.numerator,
      input.pixelAspect.denominator,
      input.frameRate.numerator,
      input.frameRate.denominator,
      input.audioSampleRateHz,
      input.audioChannelLayout,
      canonicalJson(input.backgroundRgba),
      now,
    );
}

function defaultTracks(
  sequenceId: string,
  videoCount: number,
  audioCount: number,
  captionCount: number,
): Array<{ track: SequenceTrack; orderKey: string }> {
  const tracks: Array<{ track: SequenceTrack; orderKey: string }> = [];
  const videoKeys = initialOrderKeys(videoCount);
  for (let ordinal = 0; ordinal < videoCount; ordinal += 1) {
    tracks.push({
      orderKey: videoKeys[ordinal]!,
      track: {
        trackId: newUuidV7(),
        sequenceId,
        kind: "video",
        ordinal,
        name: `Video ${ordinal + 1}`,
        enabled: true,
        locked: false,
        blendMode: "normal",
      },
    });
  }
  const audioKeys = initialOrderKeys(audioCount);
  for (let ordinal = 0; ordinal < audioCount; ordinal += 1) {
    tracks.push({
      orderKey: audioKeys[ordinal]!,
      track: {
        trackId: newUuidV7(),
        sequenceId,
        kind: "audio",
        ordinal,
        name: `Audio ${ordinal + 1}`,
        enabled: true,
        locked: false,
        muted: false,
        solo: false,
      },
    });
  }
  const captionKeys = initialOrderKeys(captionCount);
  for (let ordinal = 0; ordinal < captionCount; ordinal += 1) {
    tracks.push({
      orderKey: captionKeys[ordinal]!,
      track: {
        trackId: newUuidV7(),
        sequenceId,
        kind: "caption",
        ordinal,
        name: captionCount === 1 ? "Captions" : `Captions ${ordinal + 1}`,
        enabled: true,
        locked: false,
      },
    });
  }
  return tracks;
}

function insertTracks(
  context: EngineContext,
  tracks: Array<{ track: SequenceTrack; orderKey: string }>,
): void {
  const insert = context.store.db.prepare(
    `INSERT INTO sequence_tracks(
      track_id, sequence_id, kind, order_key, name,
      enabled, locked, muted, solo, blend_mode
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const { track, orderKey } of tracks) {
    insert.run(
      track.trackId,
      track.sequenceId,
      track.kind,
      orderKey,
      track.name,
      track.enabled ? 1 : 0,
      track.locked ? 1 : 0,
      track.kind === "audio" ? (track.muted ? 1 : 0) : null,
      track.kind === "audio" ? (track.solo ? 1 : 0) : null,
      track.kind === "video" ? track.blendMode : null,
    );
  }
}

function queryRows<T>(
  context: EngineContext,
  sql: string,
  revision: string | undefined,
  ...params: string[]
): T[] {
  return context.store.db
    .prepare(sql)
    .all(...(revision ? [revision, ...params] : params)) as unknown as T[];
}

function requiredTrackRow(context: EngineContext, trackId: string): TrackRow {
  assertUuidV7(trackId, "Track ID");
  const row = context.store.db
    .prepare(`${TRACK_SELECT} FROM sequence_tracks WHERE track_id=?`)
    .get(trackId) as unknown as TrackRow | undefined;
  if (!row) {
    throw new EngineFault({
      code: "NOT_FOUND",
      message: `Sequence track not found: ${trackId}`,
    });
  }
  return row;
}

/** Current rank of a track within its sequence and kind. */
function trackOrdinal(context: EngineContext, row: TrackRow): number {
  const siblings = context.store.db
    .prepare(
      `SELECT track_id FROM sequence_tracks
       WHERE sequence_id=? AND kind=?
       ORDER BY order_key, track_id`,
    )
    .all(row.sequence_id, row.kind) as unknown as Array<{ track_id: string }>;
  return siblings.findIndex((candidate) => candidate.track_id === row.track_id);
}

function semanticSource(table: string, revision?: string): string {
  return revision ? `dolt_at_${table}(?)` : table;
}

function revisionParams(revision: string | undefined, ...params: string[]): string[] {
  return revision ? [revision, ...params] : params;
}

function isRgba(value: unknown): value is [number, number, number, number] {
  return Array.isArray(value)
    && value.length === 4
    && value.every((channel) => Number.isFinite(channel));
}

function invalidClip(clipId: string, field: string): EngineFault {
  return new EngineFault({
    code: "SCHEMA_INCOMPATIBLE",
    message: `Clip has an invalid ${field}: ${clipId}`,
  });
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

function trackCount(value: number, label: string): number {
  safeIntegerAtLeast(value, 0, label);
  if (value > 32) throw new Error(`${label} must not exceed 32`);
  return value;
}

const SEQUENCE_SELECT = `
  SELECT sequence_id, name, is_primary, width, height,
         pixel_aspect_numerator, pixel_aspect_denominator,
         frame_rate_numerator, frame_rate_denominator,
         audio_sample_rate_hz, audio_channel_layout,
         background_rgba_json, created_at`;

const TRACK_SELECT = `
  SELECT track_id, sequence_id, kind, order_key, name,
         enabled, locked, muted, solo, blend_mode`;

const CLIP_SELECT = `
  SELECT clip_id, track_id, source_kind, artifact_id, source_path,
         stream_id, object_hash, source_start_tick, source_duration_ticks,
         time_base_numerator, time_base_denominator,
         timeline_start_frame, duration_frames, speed_numerator,
         speed_denominator, reverse, audio_policy, gain_db, audio_muted,
         fade_in_frames, fade_out_frames, enabled`;

const TRANSFORM_SELECT = `
  SELECT clip_id, fit, position_x, position_y, scale_x, scale_y,
         anchor_x, anchor_y, rotation_degrees, crop_top, crop_right,
         crop_bottom, crop_left, opacity, blend_mode`;

const TRANSITION_SELECT = `
  SELECT transition_id, track_id, outgoing_clip_id, incoming_clip_id,
         kind, duration_frames, alignment`;

const CAPTION_SELECT = `
  SELECT cue_id, track_id, timeline_start_frame, duration_frames,
         text, speaker, style_id, transcript_id, transcript_revision,
         start_word_id, end_word_id, source_range_json`;
