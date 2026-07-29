import { createHash } from "node:crypto";

import type { EngineError, Result } from "./engine-types.js";
import { ok } from "./engine-types.js";
import type {
  CaptionCue,
  ClipAudio,
  ClipPlacement,
  ClipTransform,
  EditCommit,
  EditBatchAudit,
  EditConflict,
  EditIntent,
  EditOperation,
  EditPreview,
  EditRestoreCommit,
  EditRestoreRequest,
  EditWarning,
  NormalizedEditOperation,
  Sequence,
  SequenceClip,
  SequenceDiff,
  SequenceTrack,
  SequenceTransition,
  TimedSequenceClip,
} from "./mvp-contracts.js";
import type { SequenceRange, SourceRange } from "./mvp-time.js";
import {
  normalizeRational,
  normalizeSequenceRange,
  normalizeSourceRange,
  rationalEquals,
  sourceRangeEndTick,
} from "./mvp-time.js";
import { EngineContext, resultOf, syncResultOf } from "./context.js";
import { createSequencesApi } from "./sequences.js";
import { newUuidV7 } from "./ids.js";
import {
  canonicalJson,
  type CommitOperation,
  EngineFault,
  parseCommitMessage,
} from "./store.js";

interface Projection {
  preview: EditPreview;
  sequence: Sequence;
}

interface StreamRow {
  stream_id: string;
  artifact_id: string;
  object_hash: string;
  kind: "video" | "audio";
  time_base_numerator: number;
  time_base_denominator: number;
  duration_ticks: number;
}

export function createEditsApi(context: EngineContext) {
  return {
    preview: (intent: EditIntent): Result<EditPreview, EngineError> =>
      syncResultOf(() => project(context, intent).preview),
    commit: (
      intent: EditIntent,
      previewHash: string,
    ): Promise<Result<EditCommit, EngineError>> =>
      commitEdit(context, intent, previewHash),
    restore: (
      request: EditRestoreRequest,
    ): Promise<Result<EditRestoreCommit, EngineError>> =>
      restoreEdit(context, request),
    get: (actionId: string): Result<EditBatchAudit, EngineError> =>
      syncResultOf(() => requiredEditBatch(context, actionId)),
  };
}

function project(context: EngineContext, intent: EditIntent): Projection {
  validateIntent(intent);
  const current = sequenceValue(createSequencesApi(context).get(intent.sequenceId));
  const normalized = intent.operations.map((operation, ordinal) =>
    normalizeOperation(intent.commandId, ordinal, operation),
  );
  const writeSet = editWriteSet(intent.sequenceId, normalized);
  const conflicts = revisionConflicts(context, intent, writeSet);
  const beforeHash = sequenceHash(current);
  const next = cloneSequence(current);
  const warnings: EditWarning[] = [];
  for (const operation of normalized) {
    applyOperation(context, next, operation, warnings);
  }
  validateSequenceProjection(context, next);
  const afterHash = sequenceHash(next);
  const affectedRanges = affectedSequenceRanges(intent.sequenceId, normalized);
  const diff = sequenceDiff(current, next);
  const previewHash = hashJson({
    commandId: intent.commandId,
    sequenceId: intent.sequenceId,
    operations: normalized,
    affectedRanges,
    writeSet,
    warnings,
    conflicts,
    diff,
    beforeHash,
    afterHash,
  });
  return {
    preview: {
      commandId: intent.commandId,
      sequenceId: intent.sequenceId,
      baseRevision: intent.baseRevision,
      valid: conflicts.length === 0,
      operations: normalized,
      affectedRanges,
      writeSet,
      warnings,
      conflicts,
      diff,
      beforeHash,
      afterHash,
      previewHash,
    },
    sequence: next,
  };
}

async function commitEdit(
  context: EngineContext,
  intent: EditIntent,
  suppliedPreviewHash: string,
): Promise<Result<EditCommit, EngineError>> {
  return resultOf(async () => {
    const initial = project(context, intent);
    assertCommittable(initial.preview, suppliedPreviewHash);
    const actionId = newUuidV7();
    const artifactIds = unique(
      initial.sequence.clips.map((clip) => clip.source.artifactId),
    );
    const mutation = await context.store.semantic(
      {
        operation: "commit_edit",
        details: {
          commandId: intent.commandId,
          actionId,
          sequenceId: intent.sequenceId,
          intentVersion: intent.intentVersion,
          sourceSurface: intent.sourceSurface,
          confirmationPolicy: intent.confirmationPolicy,
          actor: intent.actor,
          operations: initial.preview.operations,
          operationCount: initial.preview.operations.length,
          affectedRanges: initial.preview.affectedRanges,
          warnings: initial.preview.warnings,
          previewHash: initial.preview.previewHash,
          beforeHash: initial.preview.beforeHash,
          afterHash: initial.preview.afterHash,
        },
        baseRevision: intent.baseRevision,
        writeSet: initial.preview.writeSet,
        author: intent.actor,
      },
      (_operationId, now) => {
        const verified = project(context, intent);
        assertCommittable(verified.preview, suppliedPreviewHash);
        persistSequenceProjection(context, verified.sequence);
        invalidateEditedArtifacts(context, artifactIds, now);
      },
    );
    const sequence = sequenceValue(
      createSequencesApi(context).getAtRevision(
        intent.sequenceId,
        mutation.revision,
      ),
    );
    return ok(
      {
        commandId: intent.commandId,
        actionId,
        revision: mutation.revision,
        sequence,
        previewHash: initial.preview.previewHash,
      },
      mutation.revision,
    );
  });
}

async function restoreEdit(
  context: EngineContext,
  request: EditRestoreRequest,
): Promise<Result<EditRestoreCommit, EngineError>> {
  return resultOf(async () => {
    requiredText(request.actor, "Restore actor");
    const target = restoreTarget(context, request);
    const source = sequenceValue(
      createSequencesApi(context).getAtRevision(
        target.sequenceId,
        target.revision,
      ),
    );
    const current = sequenceValue(createSequencesApi(context).get(target.sequenceId));
    if (request.baseRevision !== context.store.head) {
      throw new EngineFault({
        code: "STALE_REVISION",
        message: "Restore base revision is stale",
        details: {
          baseRevision: request.baseRevision,
          currentRevision: context.store.head,
        },
      });
    }
    validateSequenceProjection(context, source);
    const actionId = newUuidV7();
    const writeSet = restoreWriteSet(current, source);
    const artifactIds = unique(source.clips.map((clip) => clip.source.artifactId));
    const mutation = await context.store.semantic(
      {
        operation: "restore_edit",
        details: {
          actionId,
          sequenceId: target.sequenceId,
          restoredFromRevision: target.revision,
          ...(request.targetActionId
            ? { restoredFromActionId: request.targetActionId }
            : {}),
          actor: request.actor,
          sourceSurface: request.sourceSurface,
        },
        baseRevision: request.baseRevision,
        writeSet,
        author: request.actor,
      },
      (_operationId, now) => {
        if (context.store.head !== request.baseRevision) {
          throw new EngineFault({
            code: "STALE_REVISION",
            message: "Restore base revision changed before commit",
          });
        }
        persistSequenceProjection(context, source);
        invalidateEditedArtifacts(context, artifactIds, now);
      },
    );
    return ok(
      {
        actionId,
        ...(request.targetActionId
          ? { restoredFromActionId: request.targetActionId }
          : {}),
        restoredFromRevision: target.revision,
        revision: mutation.revision,
        sequence: sequenceValue(
          createSequencesApi(context).getAtRevision(
            target.sequenceId,
            mutation.revision,
          ),
        ),
      },
      mutation.revision,
    );
  });
}

function validateIntent(intent: EditIntent): void {
  if (intent.intentVersion !== 1) {
    throw new EngineFault({
      code: "SCHEMA_INCOMPATIBLE",
      message: `Unsupported edit intent version: ${intent.intentVersion}`,
    });
  }
  requiredText(intent.commandId, "Edit command ID");
  requiredText(intent.sequenceId, "Edit sequence ID");
  requiredText(intent.baseRevision, "Edit base revision");
  requiredText(intent.actor, "Edit actor");
  if (!["ui", "slash", "chat", "system"].includes(intent.sourceSurface)) {
    throw new Error(`Invalid source surface: ${intent.sourceSurface}`);
  }
  if (
    !["always", "risk-based", "reversible-single-step"].includes(
      intent.confirmationPolicy,
    )
  ) {
    throw new Error(`Invalid confirmation policy: ${intent.confirmationPolicy}`);
  }
  if (intent.operations.length === 0) {
    throw new Error("Edit intent must contain at least one operation");
  }
  if (intent.operations.length > 1_000) {
    throw new EngineFault({
      code: "RESOURCE_EXHAUSTED",
      message: "Edit intent exceeds the 1,000-operation limit",
    });
  }
}

function normalizeOperation(
  commandId: string,
  ordinal: number,
  input: EditOperation,
): NormalizedEditOperation {
  const operationId = deterministicUuid(commandId, `operation:${ordinal}`);
  let operation: EditOperation;
  if (input.kind === "insert-clip") {
    operation = {
      ...input,
      clipId: input.clipId ?? deterministicUuid(commandId, `clip:${ordinal}`),
      placement: normalizePlacement(input.placement),
    };
  } else if (input.kind === "trim-clip") {
    operation = {
      ...input,
      ...(input.sourceRange
        ? { sourceRange: normalizeSourceRange(input.sourceRange) }
        : {}),
    };
  } else if (input.kind === "split-clip") {
    operation = {
      ...input,
      leftClipId:
        input.leftClipId ?? deterministicUuid(commandId, `split-left:${ordinal}`),
      rightClipId:
        input.rightClipId ?? deterministicUuid(commandId, `split-right:${ordinal}`),
    };
  } else if (input.kind === "restore-clip") {
    operation = { ...input, placement: normalizePlacement(input.placement) };
  } else if (input.kind === "set-clip-speed") {
    operation = { ...input, speed: normalizeRational(input.speed) };
  } else if (input.kind === "remove-range") {
    operation = { ...input, range: normalizeSequenceRange(input.range) };
  } else if (input.kind === "batch-replace-range") {
    operation = {
      ...input,
      range: normalizeSequenceRange(input.range),
      placements: input.placements.map(normalizePlacement),
    };
  } else {
    operation = structuredClone(input);
  }
  return { operationId, ordinal, operation };
}

function normalizePlacement(placement: ClipPlacement): ClipPlacement {
  safeIntegerAtLeast(placement.timelineStartFrame, 0, "Clip timeline start");
  safeIntegerAtLeast(placement.durationFrames, 1, "Clip duration");
  return {
    ...structuredClone(placement),
    source:
      placement.source.kind === "timed"
        ? {
            ...placement.source,
            range: normalizeSourceRange(placement.source.range),
          }
        : { ...placement.source },
    ...(placement.speed ? { speed: normalizeRational(placement.speed) } : {}),
  };
}

function applyOperation(
  context: EngineContext,
  sequence: Sequence,
  normalized: NormalizedEditOperation,
  warnings: EditWarning[],
): void {
  const operation = normalized.operation;
  switch (operation.kind) {
    case "insert-clip":
      applyInsert(context, sequence, operation, normalized.operationId);
      return;
    case "remove-range":
      applyRemoveRange(sequence, operation.trackIds, operation.range, operation.ripple);
      return;
    case "move-clip":
      applyMove(sequence, operation);
      return;
    case "trim-clip":
      applyTrim(context, sequence, operation);
      return;
    case "split-clip":
      applySplit(sequence, operation, warnings, normalized.operationId);
      return;
    case "restore-clip":
      applyRestore(context, sequence, operation, normalized.operationId);
      return;
    case "set-clip-transform":
      requiredClip(sequence, operation.clipId).transform =
        validateTransform(operation.transform);
      return;
    case "set-clip-audio":
      applyClipAudio(sequence, operation.clipId, operation.audio);
      return;
    case "set-clip-speed":
      applySpeed(sequence, operation, warnings, normalized.operationId);
      return;
    case "set-transition":
      applyTransition(sequence, operation);
      return;
    case "upsert-caption-cue":
      applyCaption(context, sequence, operation.cue);
      return;
    case "batch-replace-range":
      applyBatchReplace(context, sequence, operation, normalized.operationId);
      return;
  }
}

function applyInsert(
  context: EngineContext,
  sequence: Sequence,
  operation: Extract<EditOperation, { kind: "insert-clip" }>,
  operationId: string,
): void {
  const clipId = operation.clipId ?? deterministicUuid(operationId, "clip");
  if (sequence.clips.some((clip) => clip.clipId === clipId)) {
    throw new EngineFault({
      code: "ALREADY_EXISTS",
      message: `Clip already exists: ${clipId}`,
    });
  }
  const track = mutableTrack(sequence, operation.placement.trackId);
  validatePlacement(context, sequence, track, operation.placement);
  const start = operation.placement.timelineStartFrame;
  const end = start + operation.placement.durationFrames;
  const overlaps = clipsOnTrack(sequence, track.trackId).filter((clip) =>
    rangesOverlap(start, end, clipStart(clip), clipEnd(clip)),
  );
  if (operation.mode === "overwrite") {
    for (const overlap of overlaps) removeClip(sequence, overlap.clipId);
  } else {
    if (overlaps.some((clip) => clipStart(clip) < start)) {
      throw new EngineFault({
        code: "INVALID_RANGE",
        message: "Insert point intersects an existing clip",
      });
    }
    for (const clip of clipsOnTrack(sequence, track.trackId)) {
      if (clip.timelineStartFrame >= start) {
        clip.timelineStartFrame += operation.placement.durationFrames;
      }
    }
  }
  sequence.clips.push(clipFromPlacement(clipId, operation.placement));
}

function applyRemoveRange(
  sequence: Sequence,
  trackIds: string[],
  range: SequenceRange,
  ripple: boolean,
): void {
  assertSequenceRange(sequence, range);
  const uniqueTracks = unique(trackIds);
  for (const trackId of uniqueTracks) {
    mutableTrack(sequence, trackId);
    removeRangeFromTrack(sequence, trackId, range, ripple);
  }
}

function removeRangeFromTrack(
  sequence: Sequence,
  trackId: string,
  range: SequenceRange,
  ripple: boolean,
): void {
  const start = range.startFrame;
  const end = start + range.durationFrames;
  const original = clipsOnTrack(sequence, trackId);
  for (const clip of original) {
    const left = clipStart(clip);
    const right = clipEnd(clip);
    if (!rangesOverlap(start, end, left, right)) continue;
    removeClip(sequence, clip.clipId);
    if (left < start) {
      sequence.clips.push(sliceClip(clip, left, start, `${clip.clipId}:left`));
    }
    if (right > end) {
      const rightClip = sliceClip(clip, end, right, `${clip.clipId}:right`);
      if (ripple) rightClip.timelineStartFrame -= range.durationFrames;
      sequence.clips.push(rightClip);
    }
  }
  if (ripple) {
    for (const clip of clipsOnTrack(sequence, trackId)) {
      if (clip.timelineStartFrame >= end) {
        clip.timelineStartFrame -= range.durationFrames;
      }
    }
    for (const caption of sequence.captions) {
      if (caption.trackId === trackId && caption.timelineStartFrame >= end) {
        caption.timelineStartFrame -= range.durationFrames;
      }
    }
  }
}

function applyMove(
  sequence: Sequence,
  operation: Extract<EditOperation, { kind: "move-clip" }>,
): void {
  const clip = requiredClip(sequence, operation.clipId);
  const sourceTrack = mutableTrack(sequence, clip.trackId);
  const targetTrack = mutableTrack(sequence, operation.trackId);
  if (sourceTrack.kind !== targetTrack.kind) {
    throw new EngineFault({
      code: "INVALID_INPUT",
      message: "A clip cannot move between incompatible track kinds",
    });
  }
  safeIntegerAtLeast(operation.timelineStartFrame, 0, "Clip timeline start");
  clip.trackId = targetTrack.trackId;
  clip.timelineStartFrame = operation.timelineStartFrame;
  assertNoForbiddenOverlap(sequence, clip);
}

function applyTrim(
  context: EngineContext,
  sequence: Sequence,
  operation: Extract<EditOperation, { kind: "trim-clip" }>,
): void {
  const clip = requiredClip(sequence, operation.clipId);
  mutableTrack(sequence, clip.trackId);
  safeIntegerAtLeast(operation.timelineStartFrame, 0, "Trim timeline start");
  safeIntegerAtLeast(operation.durationFrames, 1, "Trim duration");
  clip.timelineStartFrame = operation.timelineStartFrame;
  clip.durationFrames = operation.durationFrames;
  if (operation.sourceRange) {
    if (clip.source.kind !== "timed") {
      throw new EngineFault({
        code: "INVALID_INPUT",
        message: "Still clips cannot accept a timed source range",
      });
    }
    validateTimedSource(context, clip.source.artifactId, operation.sourceRange);
    clip.source.range = operation.sourceRange;
  } else if (clip.source.kind === "timed") {
    clip.source.range = resizeTimedRange(clip.source.range, operation.durationFrames);
  }
  assertNoForbiddenOverlap(sequence, clip);
}

function applySplit(
  sequence: Sequence,
  operation: Extract<EditOperation, { kind: "split-clip" }>,
  warnings: EditWarning[],
  operationId: string,
): void {
  const clip = requiredClip(sequence, operation.clipId);
  mutableTrack(sequence, clip.trackId);
  if (
    operation.splitFrame <= clip.timelineStartFrame
    || operation.splitFrame >= clipEnd(clip)
  ) {
    throw new EngineFault({
      code: "INVALID_RANGE",
      message: "Split frame must be inside the clip",
    });
  }
  const leftId = operation.leftClipId ?? deterministicUuid(operationId, "left");
  const rightId = operation.rightClipId ?? deterministicUuid(operationId, "right");
  if (leftId === rightId || sequence.clips.some((item) =>
    item.clipId !== clip.clipId && (item.clipId === leftId || item.clipId === rightId)
  )) {
    throw new EngineFault({
      code: "ALREADY_EXISTS",
      message: "Split clip IDs must be unique",
    });
  }
  const leftFrames = operation.splitFrame - clip.timelineStartFrame;
  const rightFrames = clip.durationFrames - leftFrames;
  const left = { ...structuredClone(clip), clipId: leftId, durationFrames: leftFrames };
  const right = {
    ...structuredClone(clip),
    clipId: rightId,
    timelineStartFrame: operation.splitFrame,
    durationFrames: rightFrames,
  };
  if (clip.source.kind === "timed") {
    const exactTicks =
      (clip.source.range.durationTicks * leftFrames) / clip.durationFrames;
    const leftTicks = Math.floor(exactTicks);
    if (!Number.isInteger(exactTicks)) {
      warnings.push({
        code: "ROUNDING_APPLIED",
        message: "Split source tick was rounded while preserving total coverage",
        operationId,
      });
    }
    left.source = {
      ...clip.source,
      range: { ...clip.source.range, durationTicks: leftTicks },
    };
    right.source = {
      ...clip.source,
      range: {
        ...clip.source.range,
        startTick: clip.source.range.startTick + leftTicks,
        durationTicks: clip.source.range.durationTicks - leftTicks,
      },
    };
  }
  removeClip(sequence, clip.clipId);
  sequence.clips.push(left, right);
}

function applyRestore(
  context: EngineContext,
  sequence: Sequence,
  operation: Extract<EditOperation, { kind: "restore-clip" }>,
  operationId: string,
): void {
  if (!findEditBatchCommit(context, operation.sourceActionId)) {
    throw new EngineFault({
      code: "NOT_FOUND",
      message: `Source edit action not found: ${operation.sourceActionId}`,
    });
  }
  applyInsert(
    context,
    sequence,
    {
      kind: "insert-clip",
      clipId: deterministicUuid(operationId, operation.sourceClipId),
      placement: operation.placement,
      mode: "overwrite",
    },
    operationId,
  );
}

function applyClipAudio(
  sequence: Sequence,
  clipId: string,
  audio: ClipAudio,
): void {
  const clip = requiredClip(sequence, clipId);
  const track = mutableTrack(sequence, clip.trackId);
  if (track.kind === "caption") {
    throw new EngineFault({
      code: "INVALID_INPUT",
      message: "Caption clips cannot have audio settings",
    });
  }
  if (!Number.isFinite(audio.gainDb)) {
    throw new Error("Clip gainDb must be finite");
  }
  safeIntegerAtLeast(audio.fadeInFrames, 0, "Clip fade-in");
  safeIntegerAtLeast(audio.fadeOutFrames, 0, "Clip fade-out");
  if (audio.fadeInFrames + audio.fadeOutFrames > clip.durationFrames) {
    throw new EngineFault({
      code: "INVALID_RANGE",
      message: "Clip fades exceed clip duration",
    });
  }
  clip.audio = { ...audio };
}

function applySpeed(
  sequence: Sequence,
  operation: Extract<EditOperation, { kind: "set-clip-speed" }>,
  warnings: EditWarning[],
  operationId: string,
): void {
  const clip = requiredClip(sequence, operation.clipId);
  mutableTrack(sequence, clip.trackId);
  if (clip.source.kind !== "timed") {
    throw new EngineFault({
      code: "INVALID_INPUT",
      message: "Speed and reverse require a timed clip source",
    });
  }
  const timed = clip as TimedSequenceClip;
  timed.speed = normalizeRational(operation.speed);
  timed.reverse = operation.reverse;
  timed.audioPolicy = operation.audioPolicy;
  if (
    operation.audioPolicy === "preserve-pitch"
    && !rationalEquals(timed.speed, { numerator: 1, denominator: 1 })
  ) {
    warnings.push({
      code: "AUDIO_PITCH_CHANGE",
      message: "Speed adjustment requires pitch-preserving audio processing",
      operationId,
    });
  }
}

function applyTransition(
  sequence: Sequence,
  operation: Extract<EditOperation, { kind: "set-transition" }>,
): void {
  const outgoing = requiredClip(sequence, operation.outgoingClipId);
  const incoming = requiredClip(sequence, operation.incomingClipId);
  const track = mutableTrack(sequence, outgoing.trackId);
  if (track.kind !== "video" || incoming.trackId !== track.trackId) {
    throw new EngineFault({
      code: "INVALID_INPUT",
      message: "Transitions require two clips on the same video track",
    });
  }
  sequence.transitions = sequence.transitions.filter(
    (transition) =>
      transition.outgoingClipId !== outgoing.clipId
      || transition.incomingClipId !== incoming.clipId,
  );
  if (operation.transition === null) return;
  const transition = structuredClone(operation.transition);
  if (
    transition.trackId !== track.trackId
    || transition.outgoingClipId !== outgoing.clipId
    || transition.incomingClipId !== incoming.clipId
  ) {
    throw new EngineFault({
      code: "INVALID_INPUT",
      message: "Transition identity does not match its clip pair",
    });
  }
  safeIntegerAtLeast(transition.durationFrames, 1, "Transition duration");
  if (
    transition.durationFrames > outgoing.durationFrames
    || transition.durationFrames > incoming.durationFrames
    || clipEnd(outgoing) !== clipStart(incoming)
  ) {
    throw new EngineFault({
      code: "INVALID_RANGE",
      message: "Transition clips must be adjacent with sufficient handles",
    });
  }
  sequence.transitions.push(transition);
}

function applyCaption(
  context: EngineContext,
  sequence: Sequence,
  cue: CaptionCue,
): void {
  const track = mutableTrack(sequence, cue.trackId);
  if (track.kind !== "caption") {
    throw new EngineFault({
      code: "INVALID_INPUT",
      message: "Caption cues require a caption track",
    });
  }
  safeIntegerAtLeast(cue.timelineStartFrame, 0, "Caption start");
  safeIntegerAtLeast(cue.durationFrames, 1, "Caption duration");
  requiredText(cue.text, "Caption text");
  requiredText(cue.styleId, "Caption style ID");
  if (cue.transcriptSelection) {
    const transcript = context.store.db
      .prepare("SELECT 1 AS present FROM transcripts WHERE transcript_id=?")
      .get(cue.transcriptSelection.transcriptId);
    if (!transcript) {
      throw new EngineFault({
        code: "NOT_FOUND",
        message: `Caption transcript not found: ${cue.transcriptSelection.transcriptId}`,
      });
    }
    normalizeSourceRange(cue.transcriptSelection.range);
  }
  sequence.captions = sequence.captions.filter((item) => item.cueId !== cue.cueId);
  sequence.captions.push(structuredClone(cue));
}

function applyBatchReplace(
  context: EngineContext,
  sequence: Sequence,
  operation: Extract<EditOperation, { kind: "batch-replace-range" }>,
  operationId: string,
): void {
  applyRemoveRange(sequence, operation.trackIds, operation.range, operation.ripple);
  operation.placements.forEach((placement, index) => {
    applyInsert(
      context,
      sequence,
      {
        kind: "insert-clip",
        clipId: deterministicUuid(operationId, `placement:${index}`),
        placement,
        mode: "overwrite",
      },
      operationId,
    );
  });
}

function validatePlacement(
  context: EngineContext,
  sequence: Sequence,
  track: SequenceTrack,
  placement: ClipPlacement,
): void {
  if (track.kind === "caption") {
    throw new EngineFault({
      code: "INVALID_INPUT",
      message: "Media clips cannot be placed on caption tracks",
    });
  }
  safeIntegerAtLeast(placement.timelineStartFrame, 0, "Clip timeline start");
  safeIntegerAtLeast(placement.durationFrames, 1, "Clip duration");
  context.artifactRowById(placement.source.artifactId);
  if (placement.source.kind === "still") {
    if (track.kind !== "video") {
      throw new EngineFault({
        code: "INVALID_INPUT",
        message: "Still sources require a video track",
      });
    }
    requiredText(placement.source.sourcePath, "Still source path");
    assertObject(context, placement.source.objectHash);
  } else {
    const stream = validateTimedSource(
      context,
      placement.source.artifactId,
      placement.source.range,
    );
    if (stream.kind !== track.kind) {
      throw new EngineFault({
        code: "INVALID_INPUT",
        message: `${stream.kind} source cannot be placed on ${track.kind} track`,
      });
    }
    normalizeRational(placement.speed ?? { numerator: 1, denominator: 1 });
    if (!placement.audioPolicy) {
      throw new EngineFault({
        code: "INVALID_INPUT",
        message: "Timed clip placement requires an audio policy",
      });
    }
  }
  if (placement.transform) validateTransform(placement.transform);
  if (placement.audio) {
    if (!Number.isFinite(placement.audio.gainDb)) {
      throw new Error("Clip gainDb must be finite");
    }
    safeIntegerAtLeast(placement.audio.fadeInFrames, 0, "Clip fade-in");
    safeIntegerAtLeast(placement.audio.fadeOutFrames, 0, "Clip fade-out");
  }
  const end = placement.timelineStartFrame + placement.durationFrames;
  if (!Number.isSafeInteger(end)) {
    throw new EngineFault({
      code: "INVALID_RANGE",
      message: "Clip timeline range exceeds safe integer precision",
    });
  }
  if (sequence.sequenceId !== track.sequenceId) {
    throw new EngineFault({
      code: "INVALID_INPUT",
      message: "Target track belongs to another sequence",
    });
  }
}

function validateTimedSource(
  context: EngineContext,
  artifactId: string,
  rangeInput: SourceRange,
): StreamRow {
  const range = normalizeSourceRange(rangeInput);
  const row = context.store.db
    .prepare(
      `SELECT stream_id, artifact_id, object_hash, kind,
              time_base_numerator, time_base_denominator, duration_ticks
       FROM artifact_streams WHERE stream_id=?`,
    )
    .get(range.streamId) as unknown as StreamRow | undefined;
  if (!row) {
    throw new EngineFault({
      code: "NOT_FOUND",
      message: `Source stream not found: ${range.streamId}`,
    });
  }
  if (
    row.artifact_id !== artifactId
    || row.object_hash !== range.objectHash
    || !rationalEquals(range.timeBase, {
      numerator: row.time_base_numerator,
      denominator: row.time_base_denominator,
    })
  ) {
    throw new EngineFault({
      code: "SOURCE_REPLACED",
      message: "Timed source identity does not match its immutable stream",
      details: { streamId: range.streamId, objectHash: range.objectHash },
    });
  }
  if (sourceRangeEndTick(range) > row.duration_ticks) {
    throw new EngineFault({
      code: "INVALID_RANGE",
      message: "Timed source range exceeds stream duration",
    });
  }
  assertObject(context, range.objectHash);
  return row;
}

function validateTransform(transform: ClipTransform): ClipTransform {
  const finite = [
    transform.positionX,
    transform.positionY,
    transform.scaleX,
    transform.scaleY,
    transform.anchorX,
    transform.anchorY,
    transform.rotationDegrees,
    transform.cropTop,
    transform.cropRight,
    transform.cropBottom,
    transform.cropLeft,
    transform.opacity,
  ];
  if (!finite.every(Number.isFinite)) {
    throw new Error("Clip transform values must be finite");
  }
  if (transform.scaleX <= 0 || transform.scaleY <= 0) {
    throw new Error("Clip transform scale must be positive");
  }
  for (const crop of [
    transform.cropTop,
    transform.cropRight,
    transform.cropBottom,
    transform.cropLeft,
    transform.opacity,
  ]) {
    if (crop < 0 || crop > 1) {
      throw new Error("Clip crop and opacity values must be between zero and one");
    }
  }
  return structuredClone(transform);
}

function validateSequenceProjection(
  context: EngineContext,
  sequence: Sequence,
): void {
  const clipIds = new Set<string>();
  for (const clip of sequence.clips) {
    if (clipIds.has(clip.clipId)) {
      throw new EngineFault({
        code: "ALREADY_EXISTS",
        message: `Duplicate clip ID: ${clip.clipId}`,
      });
    }
    clipIds.add(clip.clipId);
    const track = requiredTrack(sequence, clip.trackId);
    if (track.kind === "caption") {
      throw new EngineFault({
        code: "INVALID_INPUT",
        message: "Media clip is assigned to a caption track",
      });
    }
    validatePlacement(context, sequence, track, placementFromClip(clip));
    assertNoForbiddenOverlap(sequence, clip);
  }
  for (const transition of sequence.transitions) {
    const outgoing = requiredClip(sequence, transition.outgoingClipId);
    const incoming = requiredClip(sequence, transition.incomingClipId);
    if (
      outgoing.trackId !== transition.trackId
      || incoming.trackId !== transition.trackId
    ) {
      throw new EngineFault({
        code: "INVALID_INPUT",
        message: `Transition has invalid track identity: ${transition.transitionId}`,
      });
    }
  }
  for (const caption of sequence.captions) {
    const track = requiredTrack(sequence, caption.trackId);
    if (track.kind !== "caption") {
      throw new EngineFault({
        code: "INVALID_INPUT",
        message: `Caption has invalid track: ${caption.cueId}`,
      });
    }
  }
}

function assertNoForbiddenOverlap(sequence: Sequence, candidate: SequenceClip): void {
  const track = requiredTrack(sequence, candidate.trackId);
  if (track.kind === "audio") return;
  const overlap = clipsOnTrack(sequence, candidate.trackId).find(
    (clip) =>
      clip.clipId !== candidate.clipId
      && rangesOverlap(
        clipStart(candidate),
        clipEnd(candidate),
        clipStart(clip),
        clipEnd(clip),
      ),
  );
  if (overlap) {
    throw new EngineFault({
      code: "INVALID_RANGE",
      message: `Clip overlaps ${overlap.clipId} on a non-overlapping track`,
    });
  }
}

function clipFromPlacement(
  clipId: string,
  placement: ClipPlacement,
): SequenceClip {
  const common = {
    clipId,
    trackId: placement.trackId,
    timelineStartFrame: placement.timelineStartFrame,
    durationFrames: placement.durationFrames,
    enabled: true,
    ...(placement.transform ? { transform: structuredClone(placement.transform) } : {}),
    ...(placement.audio ? { audio: structuredClone(placement.audio) } : {}),
  };
  if (placement.source.kind === "still") {
    return { ...common, source: structuredClone(placement.source) };
  }
  return {
    ...common,
    source: structuredClone(placement.source),
    speed: placement.speed ?? { numerator: 1, denominator: 1 },
    reverse: placement.reverse ?? false,
    audioPolicy: placement.audioPolicy ?? "preserve-pitch",
  };
}

function placementFromClip(clip: SequenceClip): ClipPlacement {
  const timed = clip.source.kind === "timed"
    ? (clip as TimedSequenceClip)
    : undefined;
  return {
    trackId: clip.trackId,
    timelineStartFrame: clip.timelineStartFrame,
    durationFrames: clip.durationFrames,
    source: structuredClone(clip.source),
    ...(timed
      ? {
          speed: timed.speed,
          reverse: timed.reverse,
          audioPolicy: timed.audioPolicy,
        }
      : {}),
    ...(clip.transform ? { transform: clip.transform } : {}),
    ...(clip.audio ? { audio: clip.audio } : {}),
  };
}

function sliceClip(
  clip: SequenceClip,
  startFrame: number,
  endFrame: number,
  seed: string,
): SequenceClip {
  const offset = startFrame - clip.timelineStartFrame;
  const durationFrames = endFrame - startFrame;
  const sliced = {
    ...structuredClone(clip),
    clipId: deterministicUuid(clip.clipId, seed),
    timelineStartFrame: startFrame,
    durationFrames,
  };
  if (clip.source.kind === "timed") {
    const startTicks = Math.floor(
      (clip.source.range.durationTicks * offset) / clip.durationFrames,
    );
    const endTicks = Math.floor(
      (clip.source.range.durationTicks * (offset + durationFrames))
      / clip.durationFrames,
    );
    sliced.source = {
      ...clip.source,
      range: {
        ...clip.source.range,
        startTick: clip.source.range.startTick + startTicks,
        durationTicks: endTicks - startTicks,
      },
    };
  }
  return sliced;
}

function resizeTimedRange(range: SourceRange, durationFrames: number): SourceRange {
  safeIntegerAtLeast(durationFrames, 1, "Trim duration");
  return {
    ...range,
    durationTicks: Math.min(range.durationTicks, durationFrames),
  };
}

function removeClip(sequence: Sequence, clipId: string): void {
  sequence.clips = sequence.clips.filter((clip) => clip.clipId !== clipId);
  sequence.transitions = sequence.transitions.filter(
    (transition) =>
      transition.outgoingClipId !== clipId && transition.incomingClipId !== clipId,
  );
}

function requiredClip(sequence: Sequence, clipId: string): SequenceClip {
  const clip = sequence.clips.find((item) => item.clipId === clipId);
  if (!clip) {
    throw new EngineFault({
      code: "NOT_FOUND",
      message: `Clip not found: ${clipId}`,
    });
  }
  return clip;
}

function requiredTrack(sequence: Sequence, trackId: string): SequenceTrack {
  const track = sequence.tracks.find((item) => item.trackId === trackId);
  if (!track) {
    throw new EngineFault({
      code: "NOT_FOUND",
      message: `Track not found: ${trackId}`,
    });
  }
  return track;
}

function mutableTrack(sequence: Sequence, trackId: string): SequenceTrack {
  const track = requiredTrack(sequence, trackId);
  if (track.locked) {
    throw new EngineFault({
      code: "TRACK_LOCKED",
      message: `Track is locked: ${trackId}`,
      ownerId: trackId,
    });
  }
  return track;
}

function clipsOnTrack(sequence: Sequence, trackId: string): SequenceClip[] {
  return sequence.clips.filter((clip) => clip.trackId === trackId);
}

function clipStart(clip: SequenceClip): number {
  return clip.timelineStartFrame;
}

function clipEnd(clip: SequenceClip): number {
  return clip.timelineStartFrame + clip.durationFrames;
}

function rangesOverlap(
  leftStart: number,
  leftEnd: number,
  rightStart: number,
  rightEnd: number,
): boolean {
  return leftStart < rightEnd && rightStart < leftEnd;
}

function assertSequenceRange(sequence: Sequence, range: SequenceRange): void {
  const normalized = normalizeSequenceRange(range);
  if (normalized.sequenceId !== sequence.sequenceId) {
    throw new EngineFault({
      code: "INVALID_RANGE",
      message: "Sequence range belongs to another sequence",
    });
  }
}

function assertObject(context: EngineContext, objectHash: string): void {
  const object = context.store.db
    .prepare("SELECT 1 AS present FROM objects WHERE object_hash=?")
    .get(objectHash);
  if (!object) {
    throw new EngineFault({
      code: "OBJECT_UNAVAILABLE",
      message: `Source object is unavailable: ${objectHash}`,
    });
  }
}

function persistSequenceProjection(
  context: EngineContext,
  sequence: Sequence,
): void {
  const trackIds = sequence.tracks.map((track) => track.trackId);
  if (trackIds.length === 0) {
    throw new EngineFault({
      code: "SCHEMA_INCOMPATIBLE",
      message: "A sequence must have at least one track",
    });
  }
  const placeholders = trackIds.map(() => "?").join(",");
  const clipIds = sequence.clips.map((clip) => clip.clipId);
  if (clipIds.length === 0) {
    context.store.db
      .prepare(
        `DELETE FROM sequence_clips WHERE track_id IN (${placeholders})`,
      )
      .run(...trackIds);
  } else {
    const clipPlaceholders = clipIds.map(() => "?").join(",");
    context.store.db
      .prepare(
        `DELETE FROM sequence_clips
         WHERE track_id IN (${placeholders})
           AND clip_id NOT IN (${clipPlaceholders})`,
      )
      .run(...trackIds, ...clipIds);
  }
  upsertClips(context, sequence.clips);
  deleteMissingForTracks(
    context,
    "transitions",
    "transition_id",
    trackIds,
    sequence.transitions.map((transition) => transition.transitionId),
  );
  upsertTransitions(context, sequence.transitions);
  deleteMissingForTracks(
    context,
    "caption_cues",
    "cue_id",
    trackIds,
    sequence.captions.map((cue) => cue.cueId),
  );
  upsertCaptions(context, sequence.captions);
}

function deleteMissingForTracks(
  context: EngineContext,
  table: "transitions" | "caption_cues",
  idColumn: "transition_id" | "cue_id",
  trackIds: string[],
  ids: string[],
): void {
  const trackPlaceholders = trackIds.map(() => "?").join(",");
  if (ids.length === 0) {
    context.store.db
      .prepare(`DELETE FROM ${table} WHERE track_id IN (${trackPlaceholders})`)
      .run(...trackIds);
    return;
  }
  const idPlaceholders = ids.map(() => "?").join(",");
  context.store.db
    .prepare(
      `DELETE FROM ${table}
       WHERE track_id IN (${trackPlaceholders})
         AND ${idColumn} NOT IN (${idPlaceholders})`,
    )
    .run(...trackIds, ...ids);
}

function upsertClips(context: EngineContext, clips: SequenceClip[]): void {
  const upsertClip = context.store.db.prepare(
    `INSERT INTO sequence_clips(
      clip_id, track_id, source_kind, artifact_id, source_path,
      stream_id, object_hash, source_start_tick, source_duration_ticks,
      time_base_numerator, time_base_denominator,
      timeline_start_frame, duration_frames, speed_numerator,
      speed_denominator, reverse, audio_policy, gain_db, audio_muted,
      fade_in_frames, fade_out_frames, enabled
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(clip_id) DO UPDATE SET
      track_id=excluded.track_id,
      source_kind=excluded.source_kind,
      artifact_id=excluded.artifact_id,
      source_path=excluded.source_path,
      stream_id=excluded.stream_id,
      object_hash=excluded.object_hash,
      source_start_tick=excluded.source_start_tick,
      source_duration_ticks=excluded.source_duration_ticks,
      time_base_numerator=excluded.time_base_numerator,
      time_base_denominator=excluded.time_base_denominator,
      timeline_start_frame=excluded.timeline_start_frame,
      duration_frames=excluded.duration_frames,
      speed_numerator=excluded.speed_numerator,
      speed_denominator=excluded.speed_denominator,
      reverse=excluded.reverse,
      audio_policy=excluded.audio_policy,
      gain_db=excluded.gain_db,
      audio_muted=excluded.audio_muted,
      fade_in_frames=excluded.fade_in_frames,
      fade_out_frames=excluded.fade_out_frames,
      enabled=excluded.enabled`,
  );
  const deleteLink = context.store.db.prepare(
    "DELETE FROM clip_links WHERE clip_id=?",
  );
  const insertLink = context.store.db.prepare(
    `INSERT INTO clip_links(link_group_id, clip_id, role)
     VALUES (?, ?, 'linked')`,
  );
  const deleteTransform = context.store.db.prepare(
    "DELETE FROM clip_transforms WHERE clip_id=?",
  );
  const insertTransform = context.store.db.prepare(
    `INSERT INTO clip_transforms(
      clip_id, fit, position_x, position_y, scale_x, scale_y,
      anchor_x, anchor_y, rotation_degrees, crop_top, crop_right,
      crop_bottom, crop_left, opacity, blend_mode
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const clip of clips) {
    const timed = clip.source.kind === "timed"
      ? (clip as TimedSequenceClip)
      : undefined;
    upsertClip.run(
      clip.clipId,
      clip.trackId,
      clip.source.kind,
      clip.source.artifactId,
      clip.source.kind === "still" ? clip.source.sourcePath : null,
      timed?.source.range.streamId ?? null,
      clip.source.kind === "still"
        ? clip.source.objectHash
        : clip.source.range.objectHash,
      timed?.source.range.startTick ?? null,
      timed?.source.range.durationTicks ?? null,
      timed?.source.range.timeBase.numerator ?? null,
      timed?.source.range.timeBase.denominator ?? null,
      clip.timelineStartFrame,
      clip.durationFrames,
      timed?.speed.numerator ?? null,
      timed?.speed.denominator ?? null,
      timed ? (timed.reverse ? 1 : 0) : null,
      timed?.audioPolicy ?? null,
      clip.audio?.gainDb ?? null,
      clip.audio ? (clip.audio.muted ? 1 : 0) : null,
      clip.audio?.fadeInFrames ?? null,
      clip.audio?.fadeOutFrames ?? null,
      clip.enabled ? 1 : 0,
    );
    deleteLink.run(clip.clipId);
    if (clip.linkGroupId) insertLink.run(clip.linkGroupId, clip.clipId);
    deleteTransform.run(clip.clipId);
    if (clip.transform) {
      const transform = clip.transform;
      insertTransform.run(
        clip.clipId,
        transform.fit,
        transform.positionX,
        transform.positionY,
        transform.scaleX,
        transform.scaleY,
        transform.anchorX,
        transform.anchorY,
        transform.rotationDegrees,
        transform.cropTop,
        transform.cropRight,
        transform.cropBottom,
        transform.cropLeft,
        transform.opacity,
        transform.blendMode,
      );
    }
  }
}

function upsertTransitions(
  context: EngineContext,
  transitions: SequenceTransition[],
): void {
  const upsert = context.store.db.prepare(
    `INSERT INTO transitions(
      transition_id, track_id, outgoing_clip_id, incoming_clip_id,
      kind, duration_frames, alignment, parameters_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, '{}')
    ON CONFLICT(transition_id) DO UPDATE SET
      track_id=excluded.track_id,
      outgoing_clip_id=excluded.outgoing_clip_id,
      incoming_clip_id=excluded.incoming_clip_id,
      kind=excluded.kind,
      duration_frames=excluded.duration_frames,
      alignment=excluded.alignment`,
  );
  for (const transition of transitions) {
    upsert.run(
      transition.transitionId,
      transition.trackId,
      transition.outgoingClipId,
      transition.incomingClipId,
      transition.kind,
      transition.durationFrames,
      transition.alignment,
    );
  }
}

function upsertCaptions(context: EngineContext, captions: CaptionCue[]): void {
  const upsert = context.store.db.prepare(
    `INSERT INTO caption_cues(
      cue_id, track_id, timeline_start_frame, duration_frames,
      text, speaker, style_id, transcript_id, transcript_revision,
      start_word_id, end_word_id, source_range_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(cue_id) DO UPDATE SET
      track_id=excluded.track_id,
      timeline_start_frame=excluded.timeline_start_frame,
      duration_frames=excluded.duration_frames,
      text=excluded.text,
      speaker=excluded.speaker,
      style_id=excluded.style_id,
      transcript_id=excluded.transcript_id,
      transcript_revision=excluded.transcript_revision,
      start_word_id=excluded.start_word_id,
      end_word_id=excluded.end_word_id,
      source_range_json=excluded.source_range_json`,
  );
  for (const cue of captions) {
    upsert.run(
      cue.cueId,
      cue.trackId,
      cue.timelineStartFrame,
      cue.durationFrames,
      cue.text,
      cue.speaker ?? null,
      cue.styleId,
      cue.transcriptSelection?.transcriptId ?? null,
      cue.transcriptSelection?.transcriptRevision ?? null,
      cue.transcriptSelection?.startWordId ?? null,
      cue.transcriptSelection?.endWordId ?? null,
      cue.transcriptSelection
        ? canonicalJson(cue.transcriptSelection.range)
        : null,
    );
  }
}

function invalidateEditedArtifacts(
  context: EngineContext,
  artifactIds: string[],
  now: number,
): void {
  const invalidate = context.store.db.prepare(
    `UPDATE runtime_workspace_entries
     SET invalidated_at=?, hydrated_at=NULL, last_accessed_at=?
     WHERE artifact_id=?`,
  );
  for (const artifactId of artifactIds) invalidate.run(now, now, artifactId);
}

function revisionConflicts(
  context: EngineContext,
  intent: EditIntent,
  writeSet: string[],
): EditConflict[] {
  if (intent.baseRevision === context.store.head) return [];
  const commits = context.store.db.doltLog();
  const baseIndex = commits.findIndex(
    (commit) =>
      commit.commit_hash === intent.baseRevision
      || commit.commit_hash.startsWith(intent.baseRevision),
  );
  if (baseIndex < 0) {
    return [
      {
        code: "STALE_REVISION",
        message: `Base revision not found: ${intent.baseRevision}`,
        resource: `sequence:${intent.sequenceId}`,
        currentRevision: context.store.head,
      },
    ];
  }
  const requested = new Set(
    writeSet.filter((resource) => !resource.startsWith("sequence:")),
  );
  const overlapping = new Set<string>();
  for (let index = 0; index < baseIndex; index += 1) {
    const parsed = parseCommitMessage(commits[index]!.message);
    if (!parsed) continue;
    for (const resource of parsed.writeSet) {
      if (requested.has(resource)) overlapping.add(resource);
    }
  }
  return [...overlapping].sort().map((resource) => ({
    code: "OVERLAPPING_WRITE",
    message: `A newer action changed ${resource}`,
    resource,
    currentRevision: context.store.head,
  }));
}

function assertCommittable(preview: EditPreview, suppliedHash: string): void {
  if (preview.conflicts.length > 0) {
    const stale = preview.conflicts.some(
      (conflict) => conflict.code === "STALE_REVISION",
    );
    throw new EngineFault({
      code: stale ? "STALE_REVISION" : "ACTION_CONFLICT",
      message: preview.conflicts.map((conflict) => conflict.message).join("; "),
      details: { conflicts: preview.conflicts },
    });
  }
  if (preview.previewHash !== suppliedHash) {
    throw new EngineFault({
      code: "ACTION_CONFLICT",
      message: "Edit preview changed before commit",
      details: {
        expectedPreviewHash: preview.previewHash,
        suppliedPreviewHash: suppliedHash,
        conflict: "PREVIEW_CHANGED",
      },
    });
  }
}

// Edit provenance lives in the structured commit messages: a committed edit
// is found by the actionId carried in its commit's details, and its revision
// is the commit hash itself.
interface ProvenanceCommit {
  hash: string;
  date: string;
  parsed: CommitOperation;
}

function editCommits(context: EngineContext): ProvenanceCommit[] {
  const commits: ProvenanceCommit[] = [];
  for (const commit of context.store.db.doltLog()) {
    const parsed = parseCommitMessage(commit.message);
    if (!parsed) continue;
    commits.push({ hash: commit.commit_hash, date: commit.date, parsed });
  }
  return commits;
}

function findEditBatchCommit(
  context: EngineContext,
  actionId: string,
): ProvenanceCommit | undefined {
  return editCommits(context).find(
    (commit) =>
      commit.parsed.operation === "commit_edit"
      && commit.parsed.details.actionId === actionId,
  );
}

function restoreTarget(
  context: EngineContext,
  request: EditRestoreRequest,
): { sequenceId: string; revision: string } {
  if (request.targetActionId) {
    const commit = findEditBatchCommit(context, request.targetActionId);
    if (!commit || typeof commit.parsed.details.sequenceId !== "string") {
      throw new EngineFault({
        code: "NOT_FOUND",
        message: `Edit action not found: ${request.targetActionId}`,
      });
    }
    return {
      sequenceId: commit.parsed.details.sequenceId,
      revision: commit.hash,
    };
  }
  if (!request.targetRevision) {
    throw new EngineFault({
      code: "INVALID_INPUT",
      message: "Restore requires a target action or revision",
    });
  }
  return {
    sequenceId: createSequencesApi(context).getPrimary().sequenceId,
    revision: request.targetRevision,
  };
}

function requiredEditBatch(
  context: EngineContext,
  actionId: string,
): EditBatchAudit {
  const commit = findEditBatchCommit(context, actionId);
  if (!commit) {
    throw new EngineFault({
      code: "NOT_FOUND",
      message: `Edit batch not found: ${actionId}`,
    });
  }
  const details = commit.parsed.details;
  return {
    actionId,
    commandId: String(details.commandId),
    intentVersion: Number(details.intentVersion),
    sourceSurface: details.sourceSurface as EditBatchAudit["sourceSurface"],
    actor: String(details.actor),
    sequenceId: String(details.sequenceId),
    baseRevision: commit.parsed.baseRevision ?? "",
    committedRevision: commit.hash,
    operations: Array.isArray(details.operations)
      ? (details.operations as NormalizedEditOperation[])
      : [],
    affectedRanges: Array.isArray(details.affectedRanges)
      ? (details.affectedRanges as SequenceRange[])
      : [],
    writeSet: commit.parsed.writeSet,
    previewHash: String(details.previewHash),
    beforeHash: String(details.beforeHash),
    afterHash: String(details.afterHash),
    confirmationPolicy:
      details.confirmationPolicy as EditBatchAudit["confirmationPolicy"],
    warnings: Array.isArray(details.warnings)
      ? (details.warnings as EditWarning[])
      : [],
    createdAt: commitDateMs(commit.date),
  };
}

// doltlite reports commit dates as "YYYY-MM-DD HH:MM:SS" in UTC.
function commitDateMs(date: string): number {
  const parsed = Date.parse(`${date.replace(" ", "T")}Z`);
  return Number.isNaN(parsed) ? 0 : parsed;
}

function editWriteSet(
  sequenceId: string,
  operations: NormalizedEditOperation[],
): string[] {
  const values = new Set<string>([`sequence:${sequenceId}`]);
  for (const item of operations) {
    const operation = item.operation;
    if ("clipId" in operation && operation.clipId) {
      values.add(`clip:${operation.clipId}`);
    }
    if (operation.kind === "insert-clip" || operation.kind === "restore-clip") {
      values.add(`track:${operation.placement.trackId}`);
    } else if (operation.kind === "remove-range") {
      operation.trackIds.forEach((trackId) => values.add(`track:${trackId}`));
    } else if (operation.kind === "move-clip") {
      values.add(`track:${operation.trackId}`);
    } else if (operation.kind === "set-transition") {
      values.add(`clip:${operation.outgoingClipId}`);
      values.add(`clip:${operation.incomingClipId}`);
      if (operation.transition) {
        values.add(`transition:${operation.transition.transitionId}`);
        values.add(`track:${operation.transition.trackId}`);
      }
    } else if (operation.kind === "upsert-caption-cue") {
      values.add(`caption:${operation.cue.cueId}`);
      values.add(`track:${operation.cue.trackId}`);
    } else if (operation.kind === "batch-replace-range") {
      operation.trackIds.forEach((trackId) => values.add(`track:${trackId}`));
      operation.placements.forEach((placement) =>
        values.add(`track:${placement.trackId}`),
      );
    }
  }
  return [...values].sort();
}

function restoreWriteSet(before: Sequence, after: Sequence): string[] {
  return unique([
    `sequence:${before.sequenceId}`,
    ...before.tracks.map((track) => `track:${track.trackId}`),
    ...after.tracks.map((track) => `track:${track.trackId}`),
    ...before.clips.map((clip) => `clip:${clip.clipId}`),
    ...after.clips.map((clip) => `clip:${clip.clipId}`),
  ]).sort();
}

function affectedSequenceRanges(
  sequenceId: string,
  operations: NormalizedEditOperation[],
): SequenceRange[] {
  const ranges: SequenceRange[] = [];
  for (const item of operations) {
    const operation = item.operation;
    if (operation.kind === "insert-clip" || operation.kind === "restore-clip") {
      ranges.push({
        sequenceId,
        startFrame: operation.placement.timelineStartFrame,
        durationFrames: operation.placement.durationFrames,
      });
    } else if (
      operation.kind === "remove-range"
      || operation.kind === "batch-replace-range"
    ) {
      ranges.push(operation.range);
    } else if (operation.kind === "move-clip") {
      ranges.push({
        sequenceId,
        startFrame: operation.timelineStartFrame,
        durationFrames: 1,
      });
    } else if (operation.kind === "trim-clip") {
      ranges.push({
        sequenceId,
        startFrame: operation.timelineStartFrame,
        durationFrames: operation.durationFrames,
      });
    } else if (operation.kind === "split-clip") {
      ranges.push({
        sequenceId,
        startFrame: operation.splitFrame,
        durationFrames: 1,
      });
    } else if (operation.kind === "upsert-caption-cue") {
      ranges.push({
        sequenceId,
        startFrame: operation.cue.timelineStartFrame,
        durationFrames: operation.cue.durationFrames,
      });
    }
  }
  if (ranges.length === 0) return [];
  const startFrame = Math.min(...ranges.map((range) => range.startFrame));
  const endFrame = Math.max(
    ...ranges.map((range) => range.startFrame + range.durationFrames),
  );
  return [{ sequenceId, startFrame, durationFrames: endFrame - startFrame }];
}

function sequenceDiff(before: Sequence, after: Sequence): SequenceDiff {
  const beforeClips = new Map(before.clips.map((clip) => [clip.clipId, clip]));
  const afterClips = new Map(after.clips.map((clip) => [clip.clipId, clip]));
  const insertedClipIds = [...afterClips.keys()]
    .filter((id) => !beforeClips.has(id))
    .sort();
  const removedClipIds = [...beforeClips.keys()]
    .filter((id) => !afterClips.has(id))
    .sort();
  const changedClipIds = [...afterClips.keys()]
    .filter(
      (id) =>
        beforeClips.has(id)
        && canonicalJson(beforeClips.get(id)) !== canonicalJson(afterClips.get(id)),
    )
    .sort();
  const beforeCaptions = new Map(
    before.captions.map((caption) => [caption.cueId, caption]),
  );
  const changedCaptionCueIds = after.captions
    .filter(
      (caption) =>
        canonicalJson(beforeCaptions.get(caption.cueId))
        !== canonicalJson(caption),
    )
    .map((caption) => caption.cueId)
    .sort();
  const changedTrackIds = unique(
    [
      ...insertedClipIds,
      ...removedClipIds,
      ...changedClipIds,
    ].flatMap((clipId) => {
      const clip = afterClips.get(clipId) ?? beforeClips.get(clipId);
      return clip ? [clip.trackId] : [];
    }),
  ).sort();
  return {
    insertedClipIds,
    removedClipIds,
    changedClipIds,
    changedTrackIds,
    changedCaptionCueIds,
    beforeDurationFrames: sequenceDuration(before),
    afterDurationFrames: sequenceDuration(after),
  };
}

function sequenceDuration(sequence: Sequence): number {
  return Math.max(
    0,
    ...sequence.clips.map(clipEnd),
    ...sequence.captions.map(
      (caption) => caption.timelineStartFrame + caption.durationFrames,
    ),
  );
}

function sequenceHash(sequence: Sequence): string {
  const { revision: _revision, ...semantic } = sequence;
  return hashJson(semantic);
}

function hashJson(value: unknown): string {
  return `sha256:${createHash("sha256")
    .update(canonicalJson(value))
    .digest("hex")}`;
}

function deterministicUuid(namespace: string, value: string): string {
  const bytes = createHash("sha256")
    .update(namespace)
    .update("\0")
    .update(value)
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x70;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20),
  ].join("-");
}

function cloneSequence(sequence: Sequence): Sequence {
  return structuredClone(sequence);
}

function sequenceValue(
  result: Result<Sequence, EngineError>,
): Sequence {
  if (!result.ok) throw new EngineFault(result.error);
  return result.value;
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

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}
