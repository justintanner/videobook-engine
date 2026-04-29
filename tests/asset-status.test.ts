import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";

import { createFs, type ClipfirstFs, computeAssetStatus } from "../src/index.js";
import { closeAllStateDbs } from "../src/db/client.js";

describe("asset status derivation", () => {
  let projectsDir: string;
  let cfs: ClipfirstFs;

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

  it("analyzing: vid- with original.mp4 + .original.json but no analysis", async () => {
    const { assetId } = await makeAsset("anlyz", {
      "original.mp4": "x",
      ".original.json": "{}",
    });
    const r = await cfs.getAssetStatus(assetId, "p");
    expect(r.ok && r.value).toBe("analyzing");
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

  it("generating: pending task in sqlite drives status (no taskType-specific override)", async () => {
    const { assetId, assetDir } = await makeAsset("gen", {});
    await cfs.pendingTasks.write("p", {
      assetId,
      taskId: "t1",
      taskType: "fal_nano_banana",
      assetDir,
    });
    const r = await cfs.getAssetStatus(assetId, "p");
    expect(r.ok && r.value).toBe("generating");
  });

  it("transcribing: taskType=transcribe maps to its own status", async () => {
    const { assetId, assetDir } = await makeAsset("tx", {
      "original.mp4": "x",
      ".original.json": "{}",
      ".original.analysis.json": "{}",
    });
    await cfs.pendingTasks.write("p", {
      assetId,
      taskId: "t2",
      taskType: "transcribe",
      assetDir,
    });
    const r = await cfs.getAssetStatus(assetId, "p");
    expect(r.ok && r.value).toBe("transcribing");
  });

  it("isolating: taskType=isolate_vocals maps to its own status", async () => {
    const { assetId, assetDir } = await makeAsset("iso", {
      "original.mp4": "x",
      ".original.json": "{}",
      ".original.analysis.json": "{}",
    });
    await cfs.pendingTasks.write("p", {
      assetId,
      taskId: "t3",
      taskType: "isolate_vocals",
      assetDir,
    });
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
      }),
    ).toBe("analyzing");
  });
});
