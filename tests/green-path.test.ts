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
  // ftyp box (file type)
  Buffer.from([
    0x00,
    0x00,
    0x00,
    0x14, // box size: 20 bytes
    0x66,
    0x74,
    0x79,
    0x70, // 'ftyp'
    0x69,
    0x73,
    0x6f,
    0x6d, // major brand: 'isom'
    0x00,
    0x00,
    0x02,
    0x00, // minor version
    0x69,
    0x73,
    0x6f,
    0x6d, // compatible brand: 'isom'
  ]),
  // mdat box (media data) with some dummy payload
  Buffer.from([
    0x00,
    0x00,
    0x00,
    0x10, // box size: 16 bytes
    0x6d,
    0x64,
    0x61,
    0x74, // 'mdat'
    0x00,
    0x00,
    0x00,
    0x00,
    0x00,
    0x00,
    0x00,
    0x00, // 8 bytes payload
  ]),
]);

describe("green path — real binary files", () => {
  let sandbox: Sandbox;
  let projectSlug: string;

  beforeEach(async () => {
    sandbox = await createSandbox();
    const result = await sandbox.fs.createProject("green-path");
    if (!result.ok)
      throw new Error(`Failed to create project: ${result.error.message}`);
    projectSlug = result.value.slug;
  });

  afterEach(async () => {
    await sandbox.cleanup();
  });

  it("video asset: create, write mp4 + thumbnail, list, manifest", async () => {
    // Create video asset
    const create = await sandbox.fs.createAsset(
      "vid",
      "beach sunset",
      projectSlug,
    );
    expect(create.ok).toBe(true);
    if (!create.ok) return;
    const assetId = create.value.assetId;
    expect(assetId).toMatch(/^vid-beach-sunset/);

    // Write real mp4
    const writeVid = await sandbox.fs.writeFile(
      assetId,
      "original.mp4",
      MINIMAL_MP4,
      projectSlug,
    );
    expect(writeVid.ok).toBe(true);

    // Write real thumbnail jpg
    const writeThumb = await sandbox.fs.writeFile(
      assetId,
      "thumbnail.jpg",
      MINIMAL_JPEG,
      projectSlug,
    );
    expect(writeThumb.ok).toBe(true);

    // Read back mp4 — binary roundtrip
    const readVid = await sandbox.fs.readFile(
      assetId,
      "original.mp4",
      projectSlug,
    );
    expect(readVid.ok).toBe(true);
    if (!readVid.ok) return;
    expect(Buffer.compare(readVid.value, MINIMAL_MP4)).toBe(0);

    // Read back thumbnail — binary roundtrip
    const readThumb = await sandbox.fs.readFile(
      assetId,
      "thumbnail.jpg",
      projectSlug,
    );
    expect(readThumb.ok).toBe(true);
    if (!readThumb.ok) return;
    expect(Buffer.compare(readThumb.value, MINIMAL_JPEG)).toBe(0);

    // List assets — video shows up with correct type
    const assets = await sandbox.fs.listAssets(projectSlug);
    const vid = assets.find((a) => a.id === assetId);
    expect(vid).toBeDefined();
    expect(vid!.type).toBe("video");

    // Manifest includes all files
    const manifest = await sandbox.fs.getManifest(assetId, projectSlug);
    expect(manifest.ok).toBe(true);
    if (!manifest.ok) return;
    expect(manifest.value.asset_id).toBe(assetId);
    const fileNames = manifest.value.files.map((f) => f.name);
    expect(fileNames).toContain("original.mp4");
    expect(fileNames).toContain("thumbnail.jpg");

    const mp4File = manifest.value.files.find((f) => f.name === "original.mp4");
    expect(mp4File!.size_bytes).toBe(MINIMAL_MP4.length);
    expect(mp4File!.extension).toBe("mp4");

    const jpgFile = manifest.value.files.find(
      (f) => f.name === "thumbnail.jpg",
    );
    expect(jpgFile!.size_bytes).toBe(MINIMAL_JPEG.length);
    expect(jpgFile!.extension).toBe("jpg");
  });

  it("image asset: create, write jpg, verify listing", async () => {
    const create = await sandbox.fs.createAsset(
      "img",
      "hero banner",
      projectSlug,
    );
    expect(create.ok).toBe(true);
    if (!create.ok) return;
    const assetId = create.value.assetId;

    // Write real jpg as original
    const writeImg = await sandbox.fs.writeFile(
      assetId,
      "original.jpg",
      MINIMAL_JPEG,
      projectSlug,
    );
    expect(writeImg.ok).toBe(true);

    // Image shows up in listing
    const assets = await sandbox.fs.listAssets(projectSlug);
    const img = assets.find((a) => a.id === assetId);
    expect(img).toBeDefined();
    expect(img!.type).toBe("image");

    // Binary roundtrip
    const readImg = await sandbox.fs.readFile(
      assetId,
      "original.jpg",
      projectSlug,
    );
    expect(readImg.ok).toBe(true);
    if (!readImg.ok) return;
    expect(Buffer.compare(readImg.value, MINIMAL_JPEG)).toBe(0);
  });

  it("rename video asset preserves files", async () => {
    const create = await sandbox.fs.createAsset("vid", "old name", projectSlug);
    if (!create.ok) throw new Error(create.error.message);
    const assetId = create.value.assetId;

    // Write real mp4 before rename
    await sandbox.fs.writeFile(
      assetId,
      "original.mp4",
      MINIMAL_MP4,
      projectSlug,
    );

    const rename = await sandbox.fs.renameAsset(
      assetId,
      "new name",
      projectSlug,
    );
    expect(rename.ok).toBe(true);
    if (!rename.ok) return;

    const newId = rename.value.new_asset_id;
    expect(newId).toMatch(/^vid-new-name/);

    // File still readable under new asset id
    const read = await sandbox.fs.readFile(newId, "original.mp4", projectSlug);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(Buffer.compare(read.value, MINIMAL_MP4)).toBe(0);
  });

  it("git history tracks binary file writes", async () => {
    const create = await sandbox.fs.createAsset(
      "vid",
      "history test",
      projectSlug,
    );
    if (!create.ok) throw new Error(create.error.message);
    const assetId = create.value.assetId;

    await sandbox.fs.writeFile(
      assetId,
      "original.mp4",
      MINIMAL_MP4,
      projectSlug,
    );
    await sandbox.fs.writeFile(
      assetId,
      "thumbnail.jpg",
      MINIMAL_JPEG,
      projectSlug,
    );

    const history = await sandbox.fs.getAssetHistory(assetId, projectSlug);

    // At least 3 commits: asset create + mp4 write + jpg write
    expect(history.length).toBeGreaterThanOrEqual(3);
  });

  it("multiple assets in one project", async () => {
    // Create video + image + audio
    const vid = await sandbox.fs.createAsset("vid", "clip one", projectSlug);
    const img = await sandbox.fs.createAsset("img", "poster", projectSlug);
    const aud = await sandbox.fs.createAsset("aud", "voiceover", projectSlug);

    expect(vid.ok).toBe(true);
    expect(img.ok).toBe(true);
    expect(aud.ok).toBe(true);
    if (!vid.ok || !img.ok || !aud.ok) return;

    // Write real files to each
    await sandbox.fs.writeFile(
      vid.value.assetId,
      "original.mp4",
      MINIMAL_MP4,
      projectSlug,
    );
    await sandbox.fs.writeFile(
      img.value.assetId,
      "original.jpg",
      MINIMAL_JPEG,
      projectSlug,
    );
    await sandbox.fs.writeFile(
      aud.value.assetId,
      "original.mp3",
      Buffer.from("fake-mp3-data"),
      projectSlug,
    );

    const assets = await sandbox.fs.listAssets(projectSlug);
    expect(assets.length).toBe(3);

    const types = assets.map((a) => a.type).sort();
    expect(types).toEqual(["audio", "image", "video"]);
  });
});
