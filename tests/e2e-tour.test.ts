import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";

import { createSandbox, type Sandbox } from "./helpers/sandbox.js";

// Minimal valid JPEG: SOI + APP0 JFIF marker + minimal frame + EOI
const MINIMAL_JPEG = Buffer.from([
  0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01,
  0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00, 0xff, 0xdb, 0x00, 0x43, 0x00, 0x08,
  0x06, 0x06, 0x07, 0x06, 0x05, 0x08, 0x07, 0x07, 0x07, 0x09, 0x09, 0x08, 0x0a,
  0x0c, 0x14, 0x0d, 0x0c, 0x0b, 0x0b, 0x0c, 0x19, 0x12, 0x13, 0x0f, 0x14, 0x1d,
  0x1a, 0x1f, 0x1e, 0x1d, 0x1a, 0x1c, 0x1c, 0x20, 0x24, 0x2e, 0x27, 0x20, 0x22,
  0x2c, 0x23, 0x1c, 0x1c, 0x28, 0x37, 0x29, 0x2c, 0x30, 0x31, 0x34, 0x34, 0x34,
  0x1f, 0x27, 0x39, 0x3d, 0x38, 0x32, 0x3c, 0x2e, 0x33, 0x34, 0x32, 0xff, 0xc0,
  0x00, 0x0b, 0x08, 0x00, 0x01, 0x00, 0x01, 0x01, 0x01, 0x11, 0x00, 0xff, 0xc4,
  0x00, 0x1f, 0x00, 0x00, 0x01, 0x05, 0x01, 0x01, 0x01, 0x01, 0x01, 0x01, 0x00,
  0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06,
  0x07, 0x08, 0x09, 0x0a, 0x0b, 0xff, 0xc4, 0x00, 0xb5, 0x10, 0x00, 0x02, 0x01,
  0x03, 0x03, 0x02, 0x04, 0x03, 0x05, 0x05, 0x04, 0x04, 0x00, 0x00, 0x01, 0x7d,
  0x01, 0x02, 0x03, 0x00, 0x04, 0x11, 0x05, 0x12, 0x21, 0x31, 0x41, 0x06, 0x13,
  0x51, 0x61, 0x07, 0x22, 0x71, 0x14, 0x32, 0x81, 0x91, 0xa1, 0x08, 0x23, 0x42,
  0xb1, 0xc1, 0x15, 0x52, 0xd1, 0xf0, 0x24, 0x33, 0x62, 0x72, 0x82, 0x09, 0x0a,
  0x16, 0x17, 0x18, 0x19, 0x1a, 0x25, 0x26, 0x27, 0x28, 0x29, 0x2a, 0x34, 0x35,
  0x36, 0x37, 0x38, 0x39, 0x3a, 0x43, 0x44, 0x45, 0x46, 0x47, 0x48, 0x49, 0x4a,
  0x53, 0x54, 0x55, 0x56, 0x57, 0x58, 0x59, 0x5a, 0x63, 0x64, 0x65, 0x66, 0x67,
  0x68, 0x69, 0x6a, 0x73, 0x74, 0x75, 0x76, 0x77, 0x78, 0x79, 0x7a, 0x83, 0x84,
  0x85, 0x86, 0x87, 0x88, 0x89, 0x8a, 0x92, 0x93, 0x94, 0x95, 0x96, 0x97, 0x98,
  0x99, 0x9a, 0xa2, 0xa3, 0xa4, 0xa5, 0xa6, 0xa7, 0xa8, 0xa9, 0xaa, 0xb2, 0xb3,
  0xb4, 0xb5, 0xb6, 0xb7, 0xb8, 0xb9, 0xba, 0xc2, 0xc3, 0xc4, 0xc5, 0xc6, 0xc7,
  0xc8, 0xc9, 0xca, 0xd2, 0xd3, 0xd4, 0xd5, 0xd6, 0xd7, 0xd8, 0xd9, 0xda, 0xe1,
  0xe2, 0xe3, 0xe4, 0xe5, 0xe6, 0xe7, 0xe8, 0xe9, 0xea, 0xf1, 0xf2, 0xf3, 0xf4,
  0xf5, 0xf6, 0xf7, 0xf8, 0xf9, 0xfa, 0xff, 0xda, 0x00, 0x08, 0x01, 0x01, 0x00,
  0x00, 0x3f, 0x00, 0x7b, 0x94, 0x11, 0x00, 0x00, 0x00, 0x00, 0xff, 0xd9,
]);

// Minimal valid MP4: ftyp box + mdat box
const MINIMAL_MP4 = Buffer.concat([
  Buffer.from([
    0x00, 0x00, 0x00, 0x14, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d,
    0x00, 0x00, 0x02, 0x00, 0x69, 0x73, 0x6f, 0x6d,
  ]),
  Buffer.from([
    0x00, 0x00, 0x00, 0x10, 0x6d, 0x64, 0x61, 0x74, 0x00, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00,
  ]),
]);

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("e2e full API tour", () => {
  let sandbox: Sandbox;

  beforeEach(async () => {
    sandbox = await createSandbox();
  });

  afterEach(async () => {
    await sandbox.cleanup();
  });

  it("walks all 21 public methods in one happy-path flow", async () => {
    const cfs = sandbox.fs;

    // ── Phase 1: Projects ──

    // 1. createProject('alpha-project')
    const alpha = await cfs.createProject("alpha-project");
    expect(alpha.ok).toBe(true);
    if (!alpha.ok) return;
    expect(alpha.value.is_default).toBe(true);
    const alphaSlug = alpha.value.slug;

    await delay(50);

    // 2. createProject('beta-project')
    const beta = await cfs.createProject("beta-project");
    expect(beta.ok).toBe(true);
    if (!beta.ok) return;
    expect(beta.value.is_default).toBe(false);

    // 3. listProjects()
    const projects = await cfs.listProjects();
    expect(projects.length).toBe(2);
    const slugs = projects.map((p) => p.slug);
    expect(slugs).toContain("alpha-project");
    expect(slugs).toContain("beta-project");

    // 4. getProject('alpha-project')
    const getAlpha = await cfs.getProject("alpha-project");
    expect(getAlpha.ok).toBe(true);
    if (!getAlpha.ok) return;
    expect(getAlpha.value.metadata.slug).toBe("alpha-project");
    expect(getAlpha.value.path).toBeTruthy();

    // 5. switchProject('beta-project')
    const switchBeta = await cfs.switchProject("beta-project");
    expect(switchBeta.ok).toBe(true);
    const defaultFile = path.join(sandbox.outputDir, ".default-project");
    const defaultContent = await fs.readFile(defaultFile, "utf-8");
    expect(defaultContent).toBe("beta-project");

    // 6. switchProject('alpha-project') — switch back
    const switchAlpha = await cfs.switchProject("alpha-project");
    expect(switchAlpha.ok).toBe(true);

    // ── Phase 2: Asset + File I/O ──

    // 7. createAsset
    const create = await cfs.createAsset("vid", "sunset beach", alphaSlug);
    expect(create.ok).toBe(true);
    if (!create.ok) return;
    const assetId = create.value.assetId;
    const assetDir = create.value.path;
    expect(assetId).toMatch(/^vid-sunset-beach/);

    // 8. writeFile
    const writeResult = await cfs.writeFile(
      assetId,
      "original.mp4",
      MINIMAL_MP4,
      alphaSlug,
    );
    expect(writeResult.ok).toBe(true);

    // 9. readFile — binary roundtrip
    const readResult = await cfs.readFile(assetId, "original.mp4", alphaSlug);
    expect(readResult.ok).toBe(true);
    if (!readResult.ok) return;
    expect(Buffer.compare(readResult.value, MINIMAL_MP4)).toBe(0);

    // 10. listAssets
    const assets = await cfs.listAssets(alphaSlug);
    expect(assets.length).toBe(1);
    expect(assets[0].type).toBe("video");

    // 11. getManifest
    const manifest = await cfs.getManifest(assetId, alphaSlug);
    expect(manifest.ok).toBe(true);
    if (!manifest.ok) return;
    const fileNames = manifest.value.files.map((f) => f.name);
    expect(fileNames).toContain("original.mp4");

    // ── Phase 3: Locks ──

    // 12. acquireLock
    const lock = await cfs.acquireLock(assetDir, {
      timeoutMs: 60_000,
      data: { task_id: "test-123" },
    });
    expect(lock.ok).toBe(true);
    if (!lock.ok) return;
    expect(lock.value.pid).toBeDefined();
    expect(lock.value.task_id).toBe("test-123");

    // 13. isLocked
    const locked = await cfs.isLocked(assetDir);
    expect(locked).toBe(true);

    // 14. getLockData
    const lockData = await cfs.getLockData(assetDir);
    expect(lockData).not.toBeNull();
    expect(lockData!.task_id).toBe("test-123");

    // 15. releaseLock
    const released = await cfs.releaseLock(assetDir);
    expect(released.ok).toBe(true);
    if (!released.ok) return;
    expect(released.value).toBe(true);
    const lockedAfter = await cfs.isLocked(assetDir);
    expect(lockedAfter).toBe(false);

    // 16. cleanStaleLock — write a stale lock with dead PID
    const staleLockPath = path.join(assetDir, ".lock");
    const staleLockData = JSON.stringify({
      created_at: Date.now() / 1000,
      timeout_at: Date.now() / 1000 + 3600,
      pid: 999999,
      task_id: "stale",
    });
    await fs.writeFile(staleLockPath, staleLockData);
    const cleaned = await cfs.cleanStaleLock(assetDir);
    expect(cleaned).toBe(true);

    // ── Phase 4: Git operations ──

    // 17. commitOperation — write a file bypassing auto-commit, then commit manually
    const notesPath = path.join(assetDir, "notes.txt");
    await fs.writeFile(notesPath, "some annotation");
    const commitHash = await cfs.commitOperation(
      "annotate",
      assetId,
      { note: "added notes" },
      alphaSlug,
    );
    expect(commitHash).toBeTruthy();
    expect(typeof commitHash).toBe("string");

    // 18. Overwrite original.mp4 with v2 data
    const V2_MP4 = Buffer.concat([
      MINIMAL_MP4,
      Buffer.from([0xde, 0xad, 0xbe, 0xef]),
    ]);
    const writeV2 = await cfs.writeFile(
      assetId,
      "original.mp4",
      V2_MP4,
      alphaSlug,
    );
    expect(writeV2.ok).toBe(true);

    // 19. getHistory
    const history = await cfs.getHistory(alphaSlug);
    expect(history.length).toBeGreaterThanOrEqual(4);

    // 20. getAssetHistory
    const assetHistory = await cfs.getAssetHistory(assetId, alphaSlug);
    expect(assetHistory.length).toBeGreaterThanOrEqual(3);

    // 21. restoreAsset — history is newest-first; pick a commit before the v2 write
    expect(assetHistory.length).toBeGreaterThanOrEqual(3);
    const preV2Hash = assetHistory[2].hash;
    const restoreHash = await cfs.restoreAsset(assetId, preV2Hash, alphaSlug);
    expect(restoreHash).toBeTruthy();

    // Verify restored file is the original v1
    const restored = await cfs.readFile(assetId, "original.mp4", alphaSlug);
    expect(restored.ok).toBe(true);
    if (!restored.ok) return;
    expect(Buffer.compare(restored.value, MINIMAL_MP4)).toBe(0);

    // ── Phase 5: Rename + Delete ──

    // 22. renameAsset
    const rename = await cfs.renameAsset(assetId, "dawn coast", alphaSlug);
    expect(rename.ok).toBe(true);
    if (!rename.ok) return;
    const renamedId = rename.value.new_asset_id;
    expect(renamedId).toMatch(/^vid-dawn-coast/);

    // Files survive the rename
    const readRenamed = await cfs.readFile(
      renamedId,
      "original.mp4",
      alphaSlug,
    );
    expect(readRenamed.ok).toBe(true);

    // 23. deleteAsset
    const del = await cfs.deleteAsset(renamedId, alphaSlug);
    expect(del.ok).toBe(true);
    if (!del.ok) return;
    expect(del.value.deleted_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    const assetsAfterDelete = await cfs.listAssets(alphaSlug);
    expect(assetsAfterDelete.length).toBe(0);

    // ── Phase 6: Query ──

    // 24. slugTaken — the original assetId was used historically
    const taken = await cfs.slugTaken(assetId, alphaSlug);
    expect(taken).toBe(true);

    // 25. slugTaken — never-used slug
    const notTaken = await cfs.slugTaken("vid-never-used", alphaSlug);
    expect(notTaken).toBe(false);
  }, 60_000);
});
