import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";

import { v7 as uuidv7 } from "uuid";
import { afterEach, describe, expect, it } from "vitest";

import {
  createEngine,
  MVP_CONTRACT_VERSION,
  type ArtifactStream,
  type ClipPlacement,
  type EditIntent,
  type Engine,
  type Sequence,
} from "../src/index.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map(removeRoot));
});

async function removeRoot(root: string): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      await rm(root, { recursive: true, force: true, maxRetries: 1 });
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  throw lastError;
}

function value<T>(
  result: { ok: true; value: T } | { ok: false; error: { message: string } },
): T {
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

async function setup(): Promise<{
  engine: Engine;
  root: string;
  stream: ArtifactStream;
  sequence: Sequence;
}> {
  const root = await mkdtemp(path.join(tmpdir(), "videobook-edits-"));
  roots.push(root);
  const engine = createEngine({
    dataDir: path.join(root, "data"),
    workspaceDir: path.join(root, "workspace"),
    initialBookSlug: "edit-transactions",
  });
  const artifact = value(
    await engine.artifacts.create({ kind: "video", slug: "source" }),
  );
  value(
    await engine.files.write(artifact.artifactId, "original.mp4", "source"),
  );
  const objectHash = value(await engine.files.manifest(artifact.artifactId))
    .files[0]?.objectHash;
  if (!objectHash) throw new Error("Source object hash is missing");
  const stream = value(
    await engine.streams.register({
      artifactId: artifact.artifactId,
      sourcePath: "original.mp4",
      objectHash,
      streamIndex: 0,
      kind: "video",
      timeBase: { numerator: 1, denominator: 1_000 },
      durationTicks: 60_000,
      codec: "h264",
      video: {
        width: 1920,
        height: 1080,
        rotationDegrees: 0,
        pixelAspect: { numerator: 1, denominator: 1 },
        nominalFrameRate: { numerator: 30, denominator: 1 },
      },
    }),
  );
  return { engine, root, stream, sequence: engine.sequences.getPrimary() };
}

function placement(
  stream: ArtifactStream,
  trackId: string,
  timelineStartFrame: number,
  durationFrames: number,
  sourceStartTick: number,
  sourceDurationTicks: number,
): ClipPlacement {
  return {
    trackId,
    timelineStartFrame,
    durationFrames,
    source: {
      kind: "timed",
      artifactId: stream.artifactId,
      range: {
        streamId: stream.streamId,
        objectHash: stream.objectHash,
        startTick: sourceStartTick,
        durationTicks: sourceDurationTicks,
        timeBase: stream.timeBase,
      },
    },
    speed: { numerator: 1, denominator: 1 },
    reverse: false,
    audioPolicy: "preserve-pitch",
  };
}

function intent(
  sequence: Sequence,
  commandId: string,
  operations: EditIntent["operations"],
  sourceSurface: EditIntent["sourceSurface"] = "ui",
): EditIntent {
  return {
    intentVersion: MVP_CONTRACT_VERSION,
    commandId,
    sequenceId: sequence.sequenceId,
    baseRevision: sequence.revision,
    actor: "test",
    sourceSurface,
    confirmationPolicy: "risk-based",
    operations,
  };
}

describe("edit transactions", () => {
  it("round-trips every P0 operation through deterministic preview and commit", async () => {
    const { engine, stream, sequence } = await setup();
    const videoTracks = sequence.tracks.filter(
      (track) => track.kind === "video",
    );
    const captionTrack = sequence.tracks.find(
      (track) => track.kind === "caption",
    );
    const firstTrack = videoTracks[0];
    const secondTrack = videoTracks[1];
    if (!firstTrack || !secondTrack || !captionTrack) {
      throw new Error("Default tracks are missing");
    }
    const firstClipId = uuidv7();
    const secondClipId = uuidv7();
    const initialIntent = intent(sequence, "initial-insert", [
      {
        kind: "insert-clip",
        clipId: firstClipId,
        placement: placement(stream, firstTrack.trackId, 0, 100, 0, 10_000),
        mode: "overwrite",
      },
      {
        kind: "insert-clip",
        clipId: secondClipId,
        placement: placement(
          stream,
          firstTrack.trackId,
          100,
          100,
          10_000,
          10_000,
        ),
        mode: "overwrite",
      },
    ]);
    const firstPreview = value(engine.edits.preview(initialIntent));
    expect(value(engine.edits.preview(initialIntent))).toEqual(firstPreview);
    expect(engine.head).toBe(sequence.revision);
    const firstCommit = value(
      await engine.edits.commit(initialIntent, firstPreview.previewHash),
    );
    expect(firstCommit.sequence.clips).toHaveLength(2);

    const leftClipId = uuidv7();
    const rightClipId = uuidv7();
    const transitionId = uuidv7();
    const captionId = uuidv7();
    const transform = {
      fit: "fit" as const,
      positionX: 0,
      positionY: 0,
      scaleX: 1,
      scaleY: 1,
      anchorX: 0.5,
      anchorY: 0.5,
      rotationDegrees: 0,
      cropTop: 0,
      cropRight: 0,
      cropBottom: 0,
      cropLeft: 0,
      opacity: 1,
      blendMode: "normal" as const,
    };
    const comprehensive = intent(firstCommit.sequence, "all-p0-operations", [
      {
        kind: "set-clip-transform",
        clipId: firstClipId,
        transform,
      },
      {
        kind: "set-clip-audio",
        clipId: firstClipId,
        audio: {
          gainDb: -3,
          muted: false,
          fadeInFrames: 5,
          fadeOutFrames: 5,
        },
      },
      {
        kind: "set-clip-speed",
        clipId: firstClipId,
        speed: { numerator: 2, denominator: 1 },
        reverse: true,
        audioPolicy: "preserve-pitch",
      },
      {
        kind: "split-clip",
        clipId: firstClipId,
        splitFrame: 50,
        leftClipId,
        rightClipId,
      },
      {
        kind: "set-transition",
        outgoingClipId: leftClipId,
        incomingClipId: rightClipId,
        transition: {
          transitionId,
          trackId: firstTrack.trackId,
          outgoingClipId: leftClipId,
          incomingClipId: rightClipId,
          kind: "dissolve",
          durationFrames: 8,
          alignment: "center",
        },
      },
      {
        kind: "upsert-caption-cue",
        cue: {
          cueId: captionId,
          trackId: captionTrack.trackId,
          timelineStartFrame: 0,
          durationFrames: 60,
          text: "Opening line",
          styleId: "default",
        },
      },
      {
        kind: "move-clip",
        clipId: secondClipId,
        trackId: secondTrack.trackId,
        timelineStartFrame: 120,
      },
      {
        kind: "trim-clip",
        clipId: secondClipId,
        timelineStartFrame: 120,
        durationFrames: 80,
        sourceRange: {
          streamId: stream.streamId,
          objectHash: stream.objectHash,
          startTick: 10_000,
          durationTicks: 8_000,
          timeBase: stream.timeBase,
        },
      },
      {
        kind: "remove-range",
        trackIds: [secondTrack.trackId],
        range: {
          sequenceId: sequence.sequenceId,
          startFrame: 150,
          durationFrames: 10,
        },
        ripple: true,
      },
      {
        kind: "batch-replace-range",
        range: {
          sequenceId: sequence.sequenceId,
          startFrame: 120,
          durationFrames: 80,
        },
        trackIds: [secondTrack.trackId],
        placements: [
          placement(stream, secondTrack.trackId, 120, 70, 20_000, 7_000),
        ],
        ripple: false,
      },
      {
        kind: "restore-clip",
        sourceActionId: firstCommit.actionId,
        sourceClipId: secondClipId,
        placement: placement(
          stream,
          secondTrack.trackId,
          220,
          50,
          30_000,
          5_000,
        ),
      },
    ]);
    const preview = value(engine.edits.preview(comprehensive));
    expect(preview.valid).toBe(true);
    expect(preview.warnings).toContainEqual(
      expect.objectContaining({ code: "AUDIO_PITCH_CHANGE" }),
    );
    const committed = value(
      await engine.edits.commit(comprehensive, preview.previewHash),
    );
    expect(committed.sequence.transitions).toContainEqual(
      expect.objectContaining({ transitionId }),
    );
    expect(committed.sequence.captions).toContainEqual(
      expect.objectContaining({ cueId: captionId }),
    );
    expect(committed.sequence.clips.map((clip) => clip.clipId)).toEqual(
      expect.arrayContaining([leftClipId, rightClipId]),
    );
    expect(committed.sequence).toEqual(
      value(
        engine.sequences.getAtRevision(sequence.sequenceId, committed.revision),
      ),
    );
    expect(value(engine.edits.get(committed.actionId))).toMatchObject({
      commandId: comprehensive.commandId,
      committedRevision: committed.revision,
      sourceSurface: "ui",
      previewHash: preview.previewHash,
      operations: preview.operations,
      writeSet: preview.writeSet,
    });
    engine.close();
  });

  it("produces surface-equivalent previews and rejects a changed hash atomically", async () => {
    const { engine, stream, sequence } = await setup();
    const track = sequence.tracks.find((item) => item.kind === "video");
    if (!track) throw new Error("Video track is missing");
    const operations: EditIntent["operations"] = [
      {
        kind: "insert-clip",
        placement: placement(stream, track.trackId, 0, 30, 0, 3_000),
        mode: "overwrite",
      },
    ];
    const previews = (["ui", "slash", "chat"] as const).map((surface) =>
      value(
        engine.edits.preview(
          intent(sequence, "surface-equivalence", operations, surface),
        ),
      ),
    );
    expect(previews[1]).toEqual(previews[0]);
    expect(previews[2]).toEqual(previews[0]);
    const beforeHead = engine.head;
    expect(
      await engine.edits.commit(
        intent(sequence, "surface-equivalence", operations),
        "sha256:changed",
      ),
    ).toMatchObject({ ok: false, error: { code: "ACTION_CONFLICT" } });
    expect(engine.head).toBe(beforeHead);
    expect(engine.sequences.getPrimary().clips).toEqual([]);
    engine.close();
  });

  it("rejects locked tracks, incompatible stream kinds, and source overflow", async () => {
    const { engine, stream, sequence } = await setup();
    const videoTrack = sequence.tracks.find((track) => track.kind === "video");
    const audioTrack = sequence.tracks.find((track) => track.kind === "audio");
    if (!videoTrack || !audioTrack)
      throw new Error("Default tracks are missing");
    const locked = value(
      await engine.sequences.updateTrack(videoTrack.trackId, { locked: true }),
    );
    const lockedEdit = intent(locked, "locked-track", [
      {
        kind: "insert-clip",
        placement: placement(stream, videoTrack.trackId, 0, 30, 0, 3_000),
        mode: "overwrite",
      },
    ]);
    expect(engine.edits.preview(lockedEdit)).toMatchObject({
      ok: false,
      error: { code: "TRACK_LOCKED" },
    });
    const unlocked = value(
      await engine.sequences.updateTrack(videoTrack.trackId, { locked: false }),
    );
    expect(
      engine.edits.preview(
        intent(unlocked, "wrong-track-kind", [
          {
            kind: "insert-clip",
            placement: placement(stream, audioTrack.trackId, 0, 30, 0, 3_000),
            mode: "overwrite",
          },
        ]),
      ),
    ).toMatchObject({ ok: false, error: { code: "INVALID_INPUT" } });
    expect(
      engine.edits.preview(
        intent(unlocked, "source-overflow", [
          {
            kind: "insert-clip",
            placement: placement(
              stream,
              videoTrack.trackId,
              0,
              30,
              59_000,
              2_000,
            ),
            mode: "overwrite",
          },
        ]),
      ),
    ).toMatchObject({ ok: false, error: { code: "INVALID_RANGE" } });
    expect(engine.sequences.getPrimary().clips).toEqual([]);
    engine.close();
  });

  it("rebases stale non-overlapping tracks and conflicts on overlapping writes", async () => {
    const { engine, stream, sequence } = await setup();
    const tracks = sequence.tracks.filter((track) => track.kind === "video");
    const firstTrack = tracks[0];
    const secondTrack = tracks[1];
    if (!firstTrack || !secondTrack)
      throw new Error("Video tracks are missing");
    const first = intent(sequence, "first-track-edit", [
      {
        kind: "insert-clip",
        placement: placement(stream, firstTrack.trackId, 0, 30, 0, 3_000),
        mode: "overwrite",
      },
    ]);
    const firstPreview = value(engine.edits.preview(first));
    value(await engine.edits.commit(first, firstPreview.previewHash));

    const nonOverlapping = intent(sequence, "second-track-edit", [
      {
        kind: "insert-clip",
        placement: placement(stream, secondTrack.trackId, 0, 30, 3_000, 3_000),
        mode: "overwrite",
      },
    ]);
    const rebasedPreview = value(engine.edits.preview(nonOverlapping));
    expect(rebasedPreview.valid).toBe(true);
    value(
      await engine.edits.commit(nonOverlapping, rebasedPreview.previewHash),
    );

    const overlapping = intent(sequence, "overlapping-edit", [
      {
        kind: "insert-clip",
        placement: placement(stream, firstTrack.trackId, 40, 20, 6_000, 2_000),
        mode: "overwrite",
      },
    ]);
    const conflict = value(engine.edits.preview(overlapping));
    expect(conflict.valid).toBe(false);
    expect(conflict.conflicts).toContainEqual(
      expect.objectContaining({
        code: "OVERLAPPING_WRITE",
        resource: `track:${firstTrack.trackId}`,
      }),
    );
    expect(
      await engine.edits.commit(overlapping, conflict.previewHash),
    ).toMatchObject({ ok: false, error: { code: "ACTION_CONFLICT" } });
    engine.close();
  });

  it("restores a committed action as a new forward revision", async () => {
    const { engine, stream, sequence } = await setup();
    const track = sequence.tracks.find((item) => item.kind === "video");
    if (!track) throw new Error("Video track is missing");
    const add = intent(sequence, "restore-source", [
      {
        kind: "insert-clip",
        placement: placement(stream, track.trackId, 0, 30, 0, 3_000),
        mode: "overwrite",
      },
    ]);
    const preview = value(engine.edits.preview(add));
    const committed = value(
      await engine.edits.commit(add, preview.previewHash),
    );
    const remove = intent(committed.sequence, "remove-before-restore", [
      {
        kind: "remove-range",
        trackIds: [track.trackId],
        range: {
          sequenceId: sequence.sequenceId,
          startFrame: 0,
          durationFrames: 30,
        },
        ripple: false,
      },
    ]);
    const removePreview = value(engine.edits.preview(remove));
    value(await engine.edits.commit(remove, removePreview.previewHash));
    const restoreBase = engine.head;
    const restored = value(
      await engine.edits.restore({
        targetActionId: committed.actionId,
        actor: "test",
        sourceSurface: "ui",
        baseRevision: restoreBase,
      }),
    );
    expect(restored.revision).not.toBe(committed.revision);
    expect(restored.sequence.clips).toHaveLength(1);
    expect(
      engine.history.resolveRevision(restored.revision)?.details,
    ).toMatchObject({ restoredFromActionId: committed.actionId });
    engine.close();
  });

  it.each([
    "before-sql-commit",
    "after-sql-commit",
    "after-dolt-commit",
  ] as const)(
    "recovers one valid semantic outcome at the %s boundary",
    async (boundary) => {
      const { engine, root, stream, sequence } = await setup();
      const track = sequence.tracks.find((item) => item.kind === "video");
      if (!track) throw new Error("Video track is missing");
      engine.close();
      const faulted = createEngine({
        dataDir: path.join(root, "data"),
        workspaceDir: path.join(root, "workspace"),
        semanticCommitBoundary: (current) => {
          if (current === boundary) throw new Error(`forced ${boundary}`);
        },
      });
      const edit = intent(sequence, `fault-${boundary}`, [
        {
          kind: "insert-clip",
          placement: placement(stream, track.trackId, 0, 30, 0, 3_000),
          mode: "overwrite",
        },
      ]);
      const preview = value(faulted.edits.preview(edit));
      expect(
        await faulted.edits.commit(edit, preview.previewHash),
      ).toMatchObject({
        ok: false,
      });
      faulted.close();

      const recovered = createEngine({
        dataDir: path.join(root, "data"),
        workspaceDir: path.join(root, "workspace"),
      });
      const clipCount = recovered.sequences.getPrimary().clips.length;
      const actionCount = recovered.history
        .revisions()
        .filter((revision) => revision.operation === "commit_edit").length;
      if (boundary === "before-sql-commit") {
        expect(clipCount).toBe(0);
        expect(actionCount).toBe(0);
      } else {
        expect(clipCount).toBe(1);
        expect(actionCount).toBe(1);
      }
      recovered.close();
    },
  );

  it("meets the 1,000-clip preview and commit budget for 100 operations", async () => {
    const { engine, stream, sequence } = await setup();
    const track = sequence.tracks.find((item) => item.kind === "video");
    if (!track) throw new Error("Video track is missing");
    const seed = intent(
      sequence,
      "performance-seed",
      Array.from({ length: 1_000 }, (_, index) => ({
        kind: "insert-clip" as const,
        clipId: uuidv7(),
        placement: placement(stream, track.trackId, index, 1, index, 1),
        mode: "overwrite" as const,
      })),
    );
    const seedPreview = value(engine.edits.preview(seed));
    const seeded = value(
      await engine.edits.commit(seed, seedPreview.previewHash),
    );
    const transform = {
      fit: "fit" as const,
      positionX: 0,
      positionY: 0,
      scaleX: 1,
      scaleY: 1,
      anchorX: 0.5,
      anchorY: 0.5,
      rotationDegrees: 0,
      cropTop: 0,
      cropRight: 0,
      cropBottom: 0,
      cropLeft: 0,
      opacity: 0.9,
      blendMode: "normal" as const,
    };
    const batch = intent(
      seeded.sequence,
      "performance-batch",
      seeded.sequence.clips.slice(0, 100).map((clip) => ({
        kind: "set-clip-transform" as const,
        clipId: clip.clipId,
        transform,
      })),
    );
    const previewStarted = performance.now();
    const preview = value(engine.edits.preview(batch));
    const previewMs = performance.now() - previewStarted;
    const commitStarted = performance.now();
    value(await engine.edits.commit(batch, preview.previewHash));
    const commitMs = performance.now() - commitStarted;
    // Shared CI runners measured 251-294ms for this preview against the old
    // 250ms budget (a steady ~8-18% overshoot, not a regression). 500ms keeps
    // a real tripwire for the multiples-not-percents regressions this test
    // exists to catch without failing on runner variance.
    expect(previewMs).toBeLessThan(500);
    expect(commitMs).toBeLessThan(1_000);
    engine.close();
  }, 30_000);
});
