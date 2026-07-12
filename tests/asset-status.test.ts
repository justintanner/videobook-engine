import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";

import {
  createFs,
  type VideocityFs,
  computeAssetStatus,
} from "../src/index.js";
import { closeAllStateDbs } from "../src/db/client.js";

describe("asset status derivation", () => {
  let projectsDir: string;
  let cfs: VideocityFs;

  beforeEach(async () => {
    projectsDir = await fs.mkdtemp(path.join(os.tmpdir(), "cfs-status-"));
    cfs = createFs({ projectsDir });
    await cfs.createProject("p");
  });

  afterEach(async () => {
    closeAllStateDbs();
    await fs.rm(projectsDir, { recursive: true, force: true });
  });

  async function makeAsset(
    slug: string,
    files: Record<string, string>,
  ): Promise<{ assetId: string; assetDir: string }> {
    const created = await cfs.createAsset("vid", slug, "p");
    if (!created.ok) throw new Error("createAsset failed");
    for (const [name, body] of Object.entries(files)) {
      await fs.writeFile(path.join(created.value.path, name), body);
    }
    return { assetId: created.value.assetId, assetDir: created.value.path };
  }

  it("ready: vid- with original.mp4, .original.json, .original.analysis.json", async () => {
    const { assetId } = await makeAsset("ready", {
      "original.mp4": "x",
      ".original.json": "{}",
      ".original.analysis.json": "{}",
    });
    const r = await cfs.getAssetStatus(assetId, "p");
    expect(r.ok && r.value).toBe("ready");
  });

  it("processing: vid- with original.mp4 but no .original.json", async () => {
    const { assetId } = await makeAsset("proc", { "original.mp4": "x" });
    const r = await cfs.getAssetStatus(assetId, "p");
    expect(r.ok && r.value).toBe("processing");
  });

  it("loading: freshly created asset with no media reads as loading, not orphan error", async () => {
    // createAsset co-writes a pending row with a 5-minute deadline; until a
    // job enqueue stamps meta.kind (or media lands), status is "loading".
    const { assetId } = await makeAsset("fresh", {});
    const r = await cfs.getAssetStatus(assetId, "p");
    expect(r.ok && r.value).toBe("loading");
  });

  it("ready: vid- with original.mp4 + .original.json but no analysis (analysis is lazy)", async () => {
    const { assetId } = await makeAsset("anlyz", {
      "original.mp4": "x",
      ".original.json": "{}",
    });
    const r = await cfs.getAssetStatus(assetId, "p");
    expect(r.ok && r.value).toBe("ready");
  });

  it("processing: legacy .processing.json marker wins over file-only state", async () => {
    const { assetId } = await makeAsset("legacyproc", {
      "original.mp4": "x",
      ".original.json": "{}",
      ".processing.json": "{}",
    });
    const r = await cfs.getAssetStatus(assetId, "p");
    expect(r.ok && r.value).toBe("processing");
  });

  it("error: vid- with .part file and only an image thumbnail (failed download)", async () => {
    const { assetId } = await makeAsset("partfail", {
      "original.jpg": "x",
      "original.mp4.part": "x",
    });
    const r = await cfs.getAssetStatus(assetId, "p");
    expect(r.ok && r.value).toBe("error");
  });

  async function writePendingViaLease(
    assetId: string,
    assetDir: string,
    taskId: string,
    taskType: import("../src/index.js").TaskType,
  ): Promise<void> {
    const begin = await cfs.assetWork.begin("p", assetId, {
      kind: "generate",
      ownerKind: "job",
      durationMs: 60_000,
    });
    if (!begin) throw new Error("beginAssetWork returned null");
    const written = await cfs.pendingTasks.write(
      "p",
      { assetId, taskId, taskType, assetDir },
      begin.ownerId,
    );
    if (!written.ok || !written.value) {
      throw new Error("pendingTasks.write returned null");
    }
  }

  it("generating: pending task in sqlite drives status (no taskType-specific override)", async () => {
    const { assetId, assetDir } = await makeAsset("gen", {});
    await writePendingViaLease(assetId, assetDir, "t1", "fal_nano_banana");
    const r = await cfs.getAssetStatus(assetId, "p");
    expect(r.ok && r.value).toBe("generating");
  });

  it("transcribing: taskType=transcribe maps to its own status", async () => {
    const { assetId, assetDir } = await makeAsset("tx", {
      "original.mp4": "x",
      ".original.json": "{}",
      ".original.analysis.json": "{}",
    });
    await writePendingViaLease(assetId, assetDir, "t2", "transcribe");
    const r = await cfs.getAssetStatus(assetId, "p");
    expect(r.ok && r.value).toBe("transcribing");
  });

  it("isolating: taskType=isolate_vocals maps to its own status", async () => {
    const { assetId, assetDir } = await makeAsset("iso", {
      "original.mp4": "x",
      ".original.json": "{}",
      ".original.analysis.json": "{}",
    });
    await writePendingViaLease(assetId, assetDir, "t3", "isolate_vocals");
    const r = await cfs.getAssetStatus(assetId, "p");
    expect(r.ok && r.value).toBe("isolating");
  });

  it("active lock state overrides every file-derived status", async () => {
    const { assetId, assetDir } = await makeAsset("lock", {
      "original.mp4": "x",
      ".original.json": "{}",
      ".original.analysis.json": "{}",
    });
    const lock = await cfs.acquireLock(assetDir, {
      durationMs: 60_000,
      data: { state: "rendering-portrait" },
    });
    expect(lock.ok).toBe(true);
    const r = await cfs.getAssetStatus(assetId, "p");
    expect(r.ok && r.value).toBe("rendering-portrait");
  });

  it("expired lock falls through to file-derived status", async () => {
    const { assetId, assetDir } = await makeAsset("exp", {
      "original.mp4": "x",
      ".original.json": "{}",
      ".original.analysis.json": "{}",
    });
    // Acquire an already-expired lock by injecting via the DB directly.
    await cfs.acquireLock(assetDir, {
      durationMs: 1, // immediately expires
      data: { state: "downloading" },
    });
    await new Promise((r) => setTimeout(r, 10));
    const r = await cfs.getAssetStatus(assetId, "p");
    expect(r.ok && r.value).toBe("ready");
  });

  it("error: generation_errors row drives status to error", async () => {
    const { assetId } = await makeAsset("gerr", {
      "original.mp4": "x",
      ".original.json": "{}",
      ".original.analysis.json": "{}",
    });
    await cfs.generationErrors.write("p", assetId, { message: "bad" });
    const r = await cfs.getAssetStatus(assetId, "p");
    expect(r.ok && r.value).toBe("error");
  });

  it("clearing the generation_errors row restores ready", async () => {
    const { assetId } = await makeAsset("clr", {
      "original.mp4": "x",
      ".original.json": "{}",
      ".original.analysis.json": "{}",
    });
    await cfs.generationErrors.write("p", assetId, { message: "bad" });
    await cfs.generationErrors.clear("p", assetId);
    const r = await cfs.getAssetStatus(assetId, "p");
    expect(r.ok && r.value).toBe("ready");
  });

  it("computeAssetStatus is exported and pure (no fs roundtrip)", () => {
    expect(
      computeAssetStatus({
        assetId: "vid-pure",
        fileNames: new Set(["original.mp4", ".original.json"]),
        primaryMediaName: "original.mp4",
        hasPartFile: false,
        lockData: null,
        pendingTask: null,
        generationError: null,
        assetRow: null,
      }),
    ).toBe("ready");
  });

  describe("assets-row precedence", () => {
    function pureCall(
      partial: Partial<Parameters<typeof computeAssetStatus>[0]>,
    ): ReturnType<typeof computeAssetStatus> {
      return computeAssetStatus({
        assetId: "vid-x",
        fileNames: new Set(),
        primaryMediaName: null,
        hasPartFile: false,
        lockData: null,
        pendingTask: null,
        generationError: null,
        assetRow: null,
        ...partial,
      });
    }

    it("generating: pending row with kind=generate (the queued-window bug)", () => {
      expect(
        pureCall({
          assetRow: {
            status: "pending",
            meta: { kind: "generate", queued: true },
          },
        }),
      ).toBe("generating");
    });

    it("render-queued-landscape: pending row with kind=render + landscape", () => {
      expect(
        pureCall({
          assetRow: {
            status: "pending",
            meta: { kind: "render", orientation: "landscape", queued: true },
          },
        }),
      ).toBe("render-queued-landscape");
    });

    it("rendering-portrait: working row with kind=render + portrait", () => {
      expect(
        pureCall({
          assetRow: {
            status: "working",
            meta: { kind: "render", orientation: "portrait", queued: false },
          },
        }),
      ).toBe("rendering-portrait");
    });

    it("render-queued: pending row with kind=render and no orientation", () => {
      expect(
        pureCall({
          assetRow: {
            status: "pending",
            meta: { kind: "render", queued: true },
          },
        }),
      ).toBe("render-queued");
    });

    it("trimming: working row with kind=trim", () => {
      expect(
        pureCall({
          assetRow: {
            status: "working",
            meta: { kind: "trim", queued: false },
          },
        }),
      ).toBe("trimming");
    });

    it("changing-speed: working row with kind=change_speed", () => {
      expect(
        pureCall({
          assetRow: {
            status: "working",
            meta: { kind: "change_speed", queued: false },
          },
        }),
      ).toBe("changing-speed");
    });

    it("replacing-audio: working row with kind=replace_audio", () => {
      expect(
        pureCall({
          assetRow: {
            status: "working",
            meta: { kind: "replace_audio", queued: false },
          },
        }),
      ).toBe("replacing-audio");
    });

    it("error: row.status=error wins over meta.kind", () => {
      expect(
        pureCall({
          assetRow: { status: "error", meta: { kind: "generate" } },
        }),
      ).toBe("error");
    });

    it("orphan error: pending row with no kind and no deadline falls through to file rules (no media)", () => {
      // No kind → mapKindToStatus returns null → falls through. With no files
      // and no live deadline, the orphan rule returns "error". A row without a
      // kind is just "I exist" and the file rules take over.
      expect(
        pureCall({
          assetRow: { status: "pending", meta: {} },
        }),
      ).toBe("error");
    });

    it("loading: kindless pending row with live deadline and no media (createAsset→enqueue window)", () => {
      expect(
        pureCall({
          assetRow: {
            status: "pending",
            meta: {},
            deadlineAt: Date.now() / 1000 + 60,
          },
        }),
      ).toBe("loading");
    });

    it("orphan error: kindless pending row with expired deadline and no media", () => {
      expect(
        pureCall({
          assetRow: {
            status: "pending",
            meta: {},
            deadlineAt: Date.now() / 1000 - 60,
          },
        }),
      ).toBe("error");
    });

    it("file rules beat the kindless-pending loading rescue (media present → ready)", () => {
      expect(
        pureCall({
          assetId: "vid-files",
          fileNames: new Set([
            "original.mp4",
            ".original.json",
            ".original.analysis.json",
          ]),
          primaryMediaName: "original.mp4",
          assetRow: {
            status: "pending",
            meta: {},
            deadlineAt: Date.now() / 1000 + 60,
          },
        }),
      ).toBe("ready");
    });

    it("part-file error beats the kindless-pending loading rescue", () => {
      expect(
        pureCall({
          fileNames: new Set(["original.mp4.part"]),
          hasPartFile: true,
          assetRow: {
            status: "pending",
            meta: {},
            deadlineAt: Date.now() / 1000 + 60,
          },
        }),
      ).toBe("error");
    });

    it.each(["char-x", "nb-x"])(
      "ready: free-form asset %s has no required primary media",
      (assetId) => {
        expect(pureCall({ assetId })).toBe("ready");
      },
    );

    it.each(["char-x", "nb-x"])(
      "error: partial download beats free-form ready fallback for %s",
      (assetId) => {
        expect(
          pureCall({
            assetId,
            fileNames: new Set(["original.mp4.part"]),
            hasPartFile: true,
          }),
        ).toBe("error");
      },
    );

    it.each(["char-x", "nb-x"])(
      "error: recorded generation failure beats free-form ready fallback for %s",
      (assetId) => {
        expect(
          pureCall({
            assetId,
            generationError: {
              assetId,
              message: "provider failed",
              failedAt: Date.now() / 1000,
            },
          }),
        ).toBe("error");
      },
    );

    it("file-derived ready: pending row without kind, with all media files", () => {
      // The file-based cascade still runs when meta.kind is missing — important
      // for assets created by createAsset and then populated directly (e.g. the
      // test scenario for expired-lock fall-through).
      expect(
        pureCall({
          assetId: "vid-files",
          fileNames: new Set([
            "original.mp4",
            ".original.json",
            ".original.analysis.json",
          ]),
          primaryMediaName: "original.mp4",
          assetRow: { status: "pending", meta: {} },
        }),
      ).toBe("ready");
    });

    it("active lock beats assets row precedence", () => {
      expect(
        pureCall({
          lockData: {
            owner_id: "x",
            acquired_at: Date.now() / 1000 - 1,
            timeout_at: Date.now() / 1000 + 60,
            state: "rendering-square",
          } as never,
          assetRow: {
            status: "pending",
            meta: { kind: "generate", queued: true },
          },
        }),
      ).toBe("rendering-square");
    });

    it("isolating: working row with kind=isolate", () => {
      expect(
        pureCall({
          assetRow: {
            status: "working",
            meta: { kind: "isolate", queued: false },
          },
        }),
      ).toBe("isolating");
    });

    it("downloading: pending row with kind=download", () => {
      expect(
        pureCall({
          assetRow: {
            status: "pending",
            meta: { kind: "download", queued: true },
          },
        }),
      ).toBe("downloading");
    });

    it("archiving: pending row with kind=archive", () => {
      expect(
        pureCall({
          assetRow: {
            status: "pending",
            meta: { kind: "archive", queued: true },
          },
        }),
      ).toBe("archiving");
    });
  });
});
