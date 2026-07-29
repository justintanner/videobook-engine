import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { EngineContext } from "../src/context.js";
import { createNotebooksApi } from "../src/domain.js";
import {
  createEngine,
  type Engine,
} from "../src/index.js";

const roots: string[] = [];
const engines: Engine[] = [];

afterEach(async () => {
  for (const engine of engines.splice(0)) engine.close();
  await Promise.all(
    roots.splice(0).map((root) =>
      rm(root, { recursive: true, force: true, maxRetries: 3 })
    ),
  );
});

function value<T>(
  result:
    | { ok: true; value: T }
    | { ok: false; error: { message: string } },
): T {
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

async function setup() {
  const root = await mkdtemp(path.join(tmpdir(), "videobook-row-writes-"));
  roots.push(root);
  const engine = createEngine({
    dataDir: path.join(root, "data"),
    workspaceDir: path.join(root, "workspace"),
    initialBookSlug: "row-writes",
  });
  engines.push(engine);
  await engine.ready;
  return engine;
}

describe("row-level timeline writes", () => {
  it("inserts, moves, updates, and removes individual slots", async () => {
    const engine = await setup();
    const first = value(
      await engine.artifacts.create({ kind: "video", slug: "vid-one" }),
    );
    const second = value(
      await engine.artifacts.create({ kind: "video", slug: "vid-two" }),
    );
    const third = value(
      await engine.artifacts.create({ kind: "video", slug: "vid-three" }),
    );

    const insertedFirst = value(
      await engine.timeline.insertSlot({ artifactId: first.artifactId }),
    );
    const firstId = insertedFirst.slots[0]!.id;
    const insertedThird = value(
      await engine.timeline.insertSlot({ artifactId: third.artifactId }),
    );
    const thirdId = insertedThird.slots[1]!.id;
    // Insert between the two without touching their stored keys.
    const headBefore = engine.head;
    const insertedSecond = value(
      await engine.timeline.insertSlot(
        { artifactId: second.artifactId },
        { afterId: firstId, beforeId: thirdId },
      ),
    );
    expect(engine.head).not.toBe(headBefore);
    expect(insertedSecond.slots.map((slot) => slot.artifactId)).toEqual([
      first.artifactId,
      second.artifactId,
      third.artifactId,
    ]);
    const secondId = insertedSecond.slots[1]!.id;

    const moved = value(
      await engine.timeline.moveSlot(thirdId, { beforeId: firstId }),
    );
    expect(moved.slots.map((slot) => slot.id)).toEqual([
      thirdId,
      firstId,
      secondId,
    ]);

    const updated = value(
      await engine.timeline.updateSlot(firstId, { volume: 0.5 }),
    );
    expect(updated.slots.find((slot) => slot.id === firstId)).toMatchObject({
      volume: 0.5,
    });
    const cleared = value(
      await engine.timeline.updateSlot(firstId, { volume: null }),
    );
    expect(
      cleared.slots.find((slot) => slot.id === firstId),
    ).not.toHaveProperty("volume");

    const removed = value(await engine.timeline.removeSlot(secondId));
    expect(removed.slots.map((slot) => slot.id)).toEqual([thirdId, firstId]);
    expect(await engine.timeline.removeSlot(secondId)).toMatchObject({
      ok: false,
      error: { code: "NOT_FOUND" },
    });
    expect(engine.timeline.get().slots).toHaveLength(2);
  });

  it("manages individual audio rows", async () => {
    const engine = await setup();
    const score = value(
      await engine.artifacts.create({ kind: "audio", slug: "aud-score" }),
    );
    const voice = value(
      await engine.artifacts.create({ kind: "audio", slug: "aud-voice" }),
    );
    const inserted = value(
      await engine.timeline.insertAudio({
        artifactId: score.artifactId,
        startFrame: 0,
        durationFrames: 48,
      }),
    );
    const scoreId = inserted.audio[0]!.id;
    const withVoice = value(
      await engine.timeline.insertAudio(
        { artifactId: voice.artifactId, startFrame: 12, durationFrames: 24 },
        { beforeId: scoreId },
      ),
    );
    const voiceId = withVoice.audio[0]!.id;
    expect(withVoice.audio.map((item) => item.id)).toEqual([voiceId, scoreId]);

    const updated = value(
      await engine.timeline.updateAudio(voiceId, { startFrame: 6, volume: 0.25 }),
    );
    expect(updated.audio[0]).toMatchObject({
      id: voiceId,
      startFrame: 6,
      volume: 0.25,
    });
    const moved = value(await engine.timeline.moveAudio(voiceId));
    expect(moved.audio.map((item) => item.id)).toEqual([scoreId, voiceId]);
    const removed = value(await engine.timeline.removeAudio(scoreId));
    expect(removed.audio.map((item) => item.id)).toEqual([voiceId]);
  });

  it("keeps untouched slot order keys stable across set calls", async () => {
    const engine = await setup();
    const first = value(
      await engine.artifacts.create({ kind: "video", slug: "vid-a" }),
    );
    const second = value(
      await engine.artifacts.create({ kind: "video", slug: "vid-b" }),
    );
    const seeded = value(
      await engine.timeline.set({
        render: "landscape",
        slots: [
          { artifactId: first.artifactId },
          { artifactId: second.artifactId },
        ],
      }),
    );
    // An identical set mints no commit at all.
    const head = engine.head;
    value(
      await engine.timeline.set({
        render: "landscape",
        slots: seeded.slots.map((slot) => ({
          id: slot.id,
          artifactId: slot.artifactId,
        })),
      }),
    );
    expect(engine.head).toBe(head);

    // Prepending one slot must not renumber the survivors; merging a fork
    // that appended elsewhere then touches no shared rows.
    const prepended = value(
      await engine.timeline.set({
        render: "landscape",
        slots: [
          { artifactId: second.artifactId },
          ...seeded.slots.map((slot) => ({
            id: slot.id,
            artifactId: slot.artifactId,
          })),
        ],
      }),
    );
    expect(prepended.slots.slice(1).map((slot) => slot.id)).toEqual(
      seeded.slots.map((slot) => slot.id),
    );
    // Another no-op set still mints no commit, proving the survivors were
    // not renumbered by the prepend.
    const headAfterPrepend = engine.head;
    value(
      await engine.timeline.set({
        render: "landscape",
        slots: prepended.slots.map((slot) => ({
          id: slot.id,
          artifactId: slot.artifactId,
        })),
      }),
    );
    expect(engine.head).toBe(headAfterPrepend);
  });
});

describe("row-level sequence track writes", () => {
  it("moves tracks without renumbering siblings", async () => {
    const engine = await setup();
    const sequence = engine.sequences.getPrimary();
    const videoTracks = sequence.tracks.filter(
      (track) => track.kind === "video",
    );
    expect(videoTracks.map((track) => track.ordinal)).toEqual([0, 1]);

    const added = value(
      await engine.sequences.addTrack(sequence.sequenceId, { kind: "video" }),
    );
    const addedTrack = added.tracks.find(
      (track) => track.kind === "video" && track.ordinal === 2,
    );
    expect(addedTrack).toBeTruthy();

    const moved = value(
      await engine.sequences.moveTrack(addedTrack!.trackId, 0),
    );
    const reordered = moved.tracks.filter((track) => track.kind === "video");
    expect(reordered.map((track) => track.trackId)).toEqual([
      addedTrack!.trackId,
      videoTracks[0]!.trackId,
      videoTracks[1]!.trackId,
    ]);
    expect(reordered.map((track) => track.ordinal)).toEqual([0, 1, 2]);

    // Moving to the current ordinal mints no commit.
    const head = engine.head;
    const unchanged = value(
      await engine.sequences.moveTrack(addedTrack!.trackId, 0),
    );
    expect(engine.head).toBe(head);
    expect(unchanged.tracks.length).toBe(moved.tracks.length);

    // Removing the moved track re-ranks the survivors at read time.
    const removed = value(
      await engine.sequences.removeTrack(addedTrack!.trackId),
    );
    expect(
      removed.tracks
        .filter((track) => track.kind === "video")
        .map((track) => track.ordinal),
    ).toEqual([0, 1]);
  });
});

describe("row-level notebook cell writes", () => {
  it("inserts, updates, moves, and removes individual cells", async () => {
    const engine = await setup();
    const notebook = value(await engine.notebooks.create("Cells"));
    const prompt = engine.notebooks.createCell({
      type: "prompt",
      slug: "prompt-one",
      slot: { row: 0, column: 0 },
    });
    value(await engine.notebooks.insertCell(notebook.id, prompt));
    const image = engine.notebooks.createCell({
      type: "image",
      slug: "img-one",
      slot: { row: 0, column: 1 },
    });
    value(await engine.notebooks.insertCell(notebook.id, image));

    expect(
      value(engine.notebooks.read(notebook.id)).cells.map((cell) => cell.slug),
    ).toEqual(["prompt-one", "img-one"]);

    // Occupied slots and duplicate slugs are rejected per row.
    const squatting = engine.notebooks.createCell({
      type: "video",
      slug: "vid-one",
      slot: { row: 0, column: 0 },
    });
    expect(await engine.notebooks.insertCell(notebook.id, squatting))
      .toMatchObject({
        ok: false,
        error: { message: "Cell slot is occupied: 0:0" },
      });
    const duplicateSlug = engine.notebooks.createCell({
      type: "image",
      slug: "img-one",
      slot: { row: 2, column: 0 },
    });
    expect(await engine.notebooks.insertCell(notebook.id, duplicateSlug))
      .toMatchObject({
        ok: false,
        error: { message: "Duplicate cell slug: img-one" },
      });

    value(
      await engine.notebooks.updateCell(notebook.id, {
        ...prompt,
        prompt: "A lighthouse at dawn",
      }),
    );
    expect(
      value(engine.notebooks.read(notebook.id)).cells.find(
        (cell) => cell.id === prompt.id,
      ),
    ).toMatchObject({ prompt: "A lighthouse at dawn" });

    value(await engine.notebooks.moveCell(notebook.id, prompt.id, {
      row: 1,
      column: 0,
    }));
    expect(
      value(engine.notebooks.read(notebook.id)).cells.map((cell) => ({
        slug: cell.slug,
        slot: cell.slot,
      })),
    ).toEqual([
      { slug: "img-one", slot: { row: 0, column: 1 } },
      { slug: "prompt-one", slot: { row: 1, column: 0 } },
    ]);

    value(await engine.notebooks.removeCell(notebook.id, image.id));
    expect(
      value(engine.notebooks.read(notebook.id)).cells.map((cell) => cell.slug),
    ).toEqual(["prompt-one"]);
    expect(await engine.notebooks.removeCell(notebook.id, image.id))
      .toMatchObject({ ok: false, error: { code: "NOT_FOUND" } });
  });

  it("repairs merge-produced slot collisions on the next write", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "videobook-cell-repair-"));
    roots.push(root);
    const context = new EngineContext({
      dataDir: path.join(root, "data"),
      workspaceDir: path.join(root, "workspace"),
      initialBookSlug: "cell-repair",
    });
    const notebooks = createNotebooksApi(context);
    const notebook = value(await notebooks.create("Repair"));
    const first = notebooks.createCell({
      type: "prompt",
      slug: "prompt-first",
      slot: { row: 0, column: 0 },
    });
    const second = notebooks.createCell({
      type: "prompt",
      slug: "prompt-second",
      slot: { row: 0, column: 0 },
    });
    // Simulate merge fallout: two cells land on the same grid slot.
    await context.store.semantic({ operation: "seed_collision" }, () => {
      const insert = context.store.db.prepare(
        `INSERT INTO cells(
          notebook_id, cell_id, type, slug, grid_row, grid_column
        ) VALUES (?, ?, ?, ?, 0, 0)`,
      );
      insert.run(notebook.id, first.id, first.type, first.slug);
      insert.run(notebook.id, second.id, second.type, second.slug);
    });

    const third = notebooks.createCell({
      type: "image",
      slug: "img-third",
      slot: { row: 1, column: 0 },
    });
    value(await notebooks.insertCell(notebook.id, third));
    const cells = value(notebooks.read(notebook.id)).cells;
    expect(cells).toHaveLength(3);
    const slots = cells.map((cell) => `${cell.slot.row}:${cell.slot.column}`);
    expect(new Set(slots).size).toBe(3);
    // The lowest cell id keeps the contested slot; the loser moves below.
    const winner = [first.id, second.id].sort()[0];
    expect(
      cells.find((cell) => cell.id === winner)?.slot,
    ).toEqual({ row: 0, column: 0 });
    context.store.close();
  });
});
