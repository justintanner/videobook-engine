import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DatabaseSync } from "@dolthub/doltlite";
import { v7 as uuidv7 } from "uuid";
import { afterEach, describe, expect, it } from "vitest";

import {
  createEngine,
  MVP_CONTRACT_VERSION,
  type EditIntent,
  type Engine,
} from "../src/index.js";

const roots: string[] = [];
const engines: Engine[] = [];

afterEach(async () => {
  for (const engine of engines.splice(0)) engine.close();
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("sequence track lifecycle", () => {
  it("adds revisioned tracks and removes only empty non-final tracks", async () => {
    const root = await mkdtemp(join(tmpdir(), "videobook-tracks-"));
    roots.push(root);
    const engine = createEngine({
      dataDir: join(root, "data"),
      workspaceDir: join(root, "workspace"),
      initialBookSlug: "sequence-tracks",
    });
    engines.push(engine);
    await engine.ready;
    const original = engine.sequences.getPrimary();
    const addedVideo = await engine.sequences.addTrack(original.sequenceId, {
      kind: "video",
      name: "B-roll 3",
    });
    expect(addedVideo.ok).toBe(true);
    if (!addedVideo.ok) return;
    expect(addedVideo.value.revision).not.toBe(original.revision);
    const track = addedVideo.value.tracks.find(
      (candidate) => candidate.name === "B-roll 3",
    );
    expect(track).toMatchObject({
      kind: "video",
      ordinal: 2,
      enabled: true,
      locked: false,
    });
    if (!track) return;
    const removed = await engine.sequences.removeTrack(track.trackId);
    expect(removed.ok).toBe(true);
    if (!removed.ok) return;
    expect(
      removed.value.tracks
        .filter((candidate) => candidate.kind === "video")
        .map((candidate) => candidate.ordinal),
    ).toEqual([0, 1]);

    const addedAgain = await engine.sequences.addTrack(original.sequenceId, {
      kind: "video",
    });
    expect(addedAgain.ok).toBe(true);
    if (!addedAgain.ok) return;
    const occupiedTrack = addedAgain.value.tracks.find(
      (candidate) => candidate.kind === "video" && candidate.ordinal === 2,
    );
    expect(occupiedTrack).toBeTruthy();
    if (!occupiedTrack) return;
    const artifact = await engine.artifacts.create({
      kind: "image",
      slug: "track-fixture",
    });
    expect(artifact.ok).toBe(true);
    if (!artifact.ok) return;
    expect(
      (
        await engine.files.write(
          artifact.value.artifactId,
          "original.png",
          "image",
        )
      ).ok,
    ).toBe(true);
    const manifest = await engine.files.manifest(artifact.value.artifactId);
    expect(manifest.ok).toBe(true);
    if (!manifest.ok) return;
    const source = manifest.value.files.find(
      (file) => file.name === "original.png",
    );
    expect(source).toBeTruthy();
    if (!source) return;
    const intent: EditIntent = {
      intentVersion: MVP_CONTRACT_VERSION,
      commandId: uuidv7(),
      sequenceId: original.sequenceId,
      baseRevision: engine.head,
      actor: "track-fixture",
      sourceSurface: "ui",
      confirmationPolicy: "reversible-single-step",
      operations: [
        {
          kind: "insert-clip",
          mode: "insert",
          placement: {
            trackId: occupiedTrack.trackId,
            timelineStartFrame: 0,
            durationFrames: 30,
            source: {
              kind: "still",
              artifactId: artifact.value.artifactId,
              sourcePath: source.name,
              objectHash: source.objectHash,
            },
          },
        },
      ],
    };
    const preview = engine.edits.preview(intent);
    expect(preview.ok).toBe(true);
    if (!preview.ok) return;
    expect(
      (await engine.edits.commit(intent, preview.value.previewHash)).ok,
    ).toBe(true);
    const occupiedRemoval = await engine.sequences.removeTrack(
      occupiedTrack.trackId,
    );
    expect(occupiedRemoval.ok).toBe(false);
    if (!occupiedRemoval.ok) {
      expect(occupiedRemoval.error.code).toBe("IN_USE");
    }
    const caption = engine.sequences
      .getPrimary()
      .tracks.find((candidate) => candidate.kind === "caption");
    expect(caption).toBeTruthy();
    if (!caption) return;
    const finalKindRemoval = await engine.sequences.removeTrack(
      caption.trackId,
    );
    expect(finalKindRemoval.ok).toBe(false);
    if (!finalKindRemoval.ok) {
      expect(finalKindRemoval.error.message).toContain("final caption track");
    }
  });

  it("moves a track between merge-minted duplicate order keys", async () => {
    const root = await mkdtemp(join(tmpdir(), "videobook-track-dup-"));
    roots.push(root);
    const dataDir = join(root, "data");
    const first = createEngine({
      dataDir,
      workspaceDir: join(root, "workspace"),
      initialBookSlug: "duplicate-keys",
    });
    await first.ready;
    const audio = first.sequences
      .getPrimary()
      .tracks.filter((track) => track.kind === "audio")
      .sort((left, right) => left.ordinal - right.ordinal);
    expect(audio.length).toBe(4);
    first.close();

    // Simulate a merge that left two siblings with the same order key —
    // forks mint keys independently, and readers tie-break by track_id.
    const db = new DatabaseSync(join(dataDir, "videobook.db"));
    const firstKey = (
      db
        .prepare(
          "SELECT order_key AS key FROM sequence_tracks WHERE track_id=?",
        )
        .get(audio[0]!.trackId) as unknown as { key: string }
    ).key;
    db.prepare("UPDATE sequence_tracks SET order_key=? WHERE track_id=?").run(
      firstKey,
      audio[1]!.trackId,
    );
    db.prepare("SELECT dolt_add('sequence_tracks') AS result").get();
    db.prepare(
      "SELECT dolt_commit('-m', 'simulate merged duplicate keys') AS hash",
    ).get();
    db.close();

    // Moving the last track between the duplicates self-repairs the keys
    // instead of failing with "Order keys out of order".
    const second = createEngine({
      dataDir,
      workspaceDir: join(root, "workspace"),
    });
    engines.push(second);
    await second.ready;
    const moved = await second.sequences.moveTrack(audio[3]!.trackId, 1);
    expect(moved.ok).toBe(true);
    const reordered = second.sequences
      .getPrimary()
      .tracks.filter((track) => track.kind === "audio")
      .sort((left, right) => left.ordinal - right.ordinal)
      .map((track) => track.trackId);
    expect(reordered).toEqual([
      audio[0]!.trackId,
      audio[3]!.trackId,
      audio[1]!.trackId,
      audio[2]!.trackId,
    ]);
    const check = new DatabaseSync(join(dataDir, "videobook.db"), {
      readOnly: true,
    });
    const keys = (
      check
        .prepare(
          `SELECT order_key AS key FROM sequence_tracks
           WHERE kind='audio' ORDER BY order_key, track_id`,
        )
        .all() as unknown as Array<{ key: string }>
    ).map((row) => row.key);
    expect(new Set(keys).size).toBe(keys.length);
    check.close();
  });
});
