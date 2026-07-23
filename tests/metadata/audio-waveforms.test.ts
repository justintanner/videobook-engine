import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";

import { createFs, type VideocityFs } from "../../src/index.js";
import { closeAllStateDbs } from "../../src/db/client.js";
import { getMetadataDb } from "../../src/db/metadata-client.js";

describe("audio waveform primitive", () => {
  let projectsDir: string;
  let cfs: VideocityFs;
  let projectDir: string;

  beforeEach(async () => {
    projectsDir = await fs.mkdtemp(path.join(os.tmpdir(), "cfs-wave-"));
    cfs = createFs({ projectsDir });
    expect((await cfs.createProject("p")).ok).toBe(true);
    projectDir = path.join(projectsDir, "p");
    await cfs.createAsset("vid", "alpha", "p");
  });

  afterEach(async () => {
    closeAllStateDbs();
    await fs.rm(projectsDir, { recursive: true, force: true });
  });

  it("writes waveform to SQLite and emits per-asset canonical export", async () => {
    const peaks = [0.1, 0.4, 0.9, 0.7, 0.2];
    const r = await cfs.writeAudioWaveform("vid-alpha", peaks, "p");
    expect(r.ok).toBe(true);

    const db = getMetadataDb(projectDir);
    const row = db
      .prepare(
        `SELECT asset_id, peaks_json, bar_count, generated_at
         FROM audio_waveforms WHERE asset_id = ?`,
      )
      .get("vid-alpha") as
      | {
          asset_id: string;
          peaks_json: string;
          bar_count: number;
          generated_at: number;
        }
      | undefined;
    expect(row).toBeDefined();
    expect(row!.bar_count).toBe(5);
    expect(JSON.parse(row!.peaks_json)).toEqual(peaks);

    const exported = await fs.readFile(
      path.join(
        projectDir,
        ".videocity",
        "export",
        "audio_waveforms",
        "vid-alpha.json",
      ),
      "utf-8",
    );
    expect(exported.endsWith("\n")).toBe(true);
    const parsed = JSON.parse(exported);
    expect(parsed.asset_id).toBe("vid-alpha");
    expect(parsed.peaks).toEqual(peaks);
    expect(parsed.bar_count).toBe(5);
  });

  it("readAudioWaveform round-trips after a write", async () => {
    const peaks = [0.0, 0.5, 1.0];
    await cfs.writeAudioWaveform("vid-alpha", peaks, "p");

    const r = await cfs.readAudioWaveform("vid-alpha", "p");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.peaks).toEqual(peaks);
    expect(r.value.bar_count).toBe(3);
    expect(typeof r.value.generated_at).toBe("number");
  });

  it("readAudioWaveform returns NOT_FOUND when no metadata.sqlite exists", async () => {
    // Wipe .videocity/ so metadata.sqlite is gone
    await fs.rm(path.join(projectDir, ".videocity"), {
      recursive: true,
      force: true,
    });
    const r = await cfs.readAudioWaveform("vid-alpha", "p");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe("NOT_FOUND");
    // No metadata.sqlite was created by this read
    await expect(
      fs.access(path.join(projectDir, ".videocity", "metadata.sqlite")),
    ).rejects.toBeTruthy();
  });

  it("readAudioWaveform returns NOT_FOUND for a known asset with no waveform row", async () => {
    // Asset exists, but no waveform was ever written for it
    const r = await cfs.readAudioWaveform("vid-alpha", "p");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe("NOT_FOUND");
  });

  it("rejects writes for a nonexistent asset", async () => {
    const r = await cfs.writeAudioWaveform("vid-ghost", [0.1, 0.2], "p");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe("NOT_FOUND");
  });

  it("revisions only waveform paths even when the asset workspace is dirty", async () => {
    // Drop a stray uncommitted file inside the asset dir, simulating
    // process_video's mid-job state where original_frames/ are dirty.
    const framesDir = path.join(projectDir, "vid-alpha", "original_frames");
    await fs.mkdir(framesDir, { recursive: true });
    await fs.writeFile(path.join(framesDir, "0.00.jpg"), "fake-jpeg-bytes");

    const r = await cfs.writeAudioWaveform("vid-alpha", [0.5, 0.5], "p");
    expect(r.ok).toBe(true);

    const revision = (await cfs.getProjectHistory("p", 1))[0]!;
    expect(revision.files).toContain(".videocity/metadata.sqlite");
    expect(revision.files).toContain(
      ".videocity/export/audio_waveforms/vid-alpha.json",
    );
    expect(revision.files).not.toContain("vid-alpha/original_frames/0.00.jpg");
  });

  it("deleteAsset removes the waveform row and per-asset export in the same commit", async () => {
    await cfs.writeAudioWaveform("vid-alpha", [0.1, 0.9], "p");
    const exportFile = path.join(
      projectDir,
      ".videocity",
      "export",
      "audio_waveforms",
      "vid-alpha.json",
    );
    await fs.access(exportFile); // sanity

    const del = await cfs.deleteAsset("vid-alpha", "p");
    expect(del.ok).toBe(true);

    const db = getMetadataDb(projectDir);
    const row = db
      .prepare("SELECT 1 FROM audio_waveforms WHERE asset_id = ?")
      .get("vid-alpha");
    expect(row).toBeUndefined();
    await expect(fs.access(exportFile)).rejects.toBeTruthy();
  });
});

describe("recovery rebuilds audio waveform exports", () => {
  let projectsDir: string;
  let cfs: VideocityFs;
  let projectDir: string;

  beforeEach(async () => {
    projectsDir = await fs.mkdtemp(path.join(os.tmpdir(), "cfs-wave-rec-"));
    cfs = createFs({ projectsDir });
    expect((await cfs.createProject("p")).ok).toBe(true);
    projectDir = path.join(projectsDir, "p");
    await cfs.createAsset("vid", "alpha", "p");
  });

  afterEach(async () => {
    closeAllStateDbs();
    await fs.rm(projectsDir, { recursive: true, force: true });
  });

  it("recoverIncompleteOperations rebuilds the per-asset export after it's deleted from disk", async () => {
    await cfs.writeAudioWaveform("vid-alpha", [0.2, 0.4, 0.6], "p");
    const exportFile = path.join(
      projectDir,
      ".videocity",
      "export",
      "audio_waveforms",
      "vid-alpha.json",
    );
    await fs.access(exportFile);

    // Simulate a crash that left an orphan recovery_journal row pointing at
    // a successful SQLite write but no git commit / no exports on disk.
    await fs.unlink(exportFile);
    const { getStateDb } = await import("../../src/db/client.js");
    const stateDb = getStateDb(projectDir);
    stateDb
      .prepare(
        `INSERT INTO recovery_journal
         (operation_id, intent, target, scope, status, started_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        "op-orphan-wave",
        "write_audio_waveform",
        "vid-alpha",
        "asset",
        "sqlite_done",
        1,
        1,
      );

    // Stick a fake operations row so the recovery code's
    // operationCommitted() check passes (it requires the operation to have
    // been recorded in metadata.sqlite).
    const metadataDb = getMetadataDb(projectDir);
    metadataDb
      .prepare(
        `INSERT INTO operations
         (operation_id, intent, scope, target, subject, started_at, sqlite_committed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        "op-orphan-wave",
        "write_audio_waveform",
        "asset",
        "vid-alpha",
        "fake replay",
        Date.now(),
        Date.now(),
      );

    await cfs.recoverIncompleteOperations("p");
    await fs.access(exportFile); // rebuilt
    const body = await fs.readFile(exportFile, "utf-8");
    expect(JSON.parse(body).peaks).toEqual([0.2, 0.4, 0.6]);
  });
});

describe("metadata schema downgrade guard", () => {
  let projectsDir: string;
  let cfs: VideocityFs;
  let projectDir: string;

  beforeEach(async () => {
    projectsDir = await fs.mkdtemp(path.join(os.tmpdir(), "cfs-mver-"));
    cfs = createFs({ projectsDir });
    expect((await cfs.createProject("p")).ok).toBe(true);
    projectDir = path.join(projectsDir, "p");
    // Trigger metadata.sqlite creation
    await cfs.createAsset("vid", "alpha", "p");
    await cfs.writeAudioWaveform("vid-alpha", [0.1], "p");
  });

  afterEach(async () => {
    closeAllStateDbs();
    await fs.rm(projectsDir, { recursive: true, force: true });
  });

  it("refuses to open metadata.sqlite recorded at a future schema version", async () => {
    const db = getMetadataDb(projectDir);
    db.prepare(
      `INSERT INTO schema_migrations (version, name, applied_at)
       VALUES (?, ?, ?)`,
    ).run(999, "future_metadata_migration", Date.now());

    const result = await cfs.checkSchemaVersion("p");
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("metadata.sqlite at version 999");
  });
});
