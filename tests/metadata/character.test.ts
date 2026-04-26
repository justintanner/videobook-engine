import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";

import { createFs, type ClipfirstFs } from "../../src/index.js";
import { closeAllStateDbs } from "../../src/db/client.js";
import { getMetadataDb } from "../../src/db/metadata-client.js";

interface PinRow {
  character_id: string;
  slot: string;
  position: number;
  asset_id: string;
}

describe("character metadata.sqlite migration", () => {
  let projectsDir: string;
  let cfs: ClipfirstFs;
  let projectDir: string;

  beforeEach(async () => {
    projectsDir = await fs.mkdtemp(path.join(os.tmpdir(), "cfs-char-"));
    cfs = createFs({ projectsDir });
    const created = await cfs.createProject("p");
    expect(created.ok).toBe(true);
    projectDir = path.join(projectsDir, "p");
    await cfs.createAsset("char", "alex", "p");
  });

  afterEach(async () => {
    closeAllStateDbs();
    await fs.rm(projectsDir, { recursive: true, force: true });
  });

  it("dual-writes character + pins to SQLite and sidecar", async () => {
    const character = {
      name: "Alex",
      age: "20s",
      hair: "black",
      wardrobe: ["img-jacket", "img-jeans"],
      poses: ["img-stand"],
      outfits: ["img-outfit-1"],
    };
    const r = await cfs.writeMetadata("char-alex", "character", character, "p");
    expect(r.ok).toBe(true);

    const sidecarRaw = await fs.readFile(
      path.join(projectDir, "char-alex", ".character.json"),
      "utf-8",
    );
    const sidecar = JSON.parse(sidecarRaw);
    expect(sidecar.name).toBe("Alex");

    const db = getMetadataDb(projectDir);
    const pins = db
      .prepare(
        `SELECT character_id, slot, position, asset_id
         FROM character_pins WHERE character_id = ? ORDER BY slot, position`,
      )
      .all("char-alex") as PinRow[];
    const slots = new Set(pins.map((p) => p.slot));
    expect(slots.has("wardrobe")).toBe(true);
    expect(slots.has("poses")).toBe(true);
    expect(slots.has("outfits")).toBe(true);
    expect(
      pins.filter((p) => p.slot === "wardrobe").map((p) => p.asset_id),
    ).toEqual(["img-jacket", "img-jeans"]);
  });

  it("readMetadata returns the same shape from SQLite (pins reconstructed from rows)", async () => {
    const character = {
      name: "Alex",
      hair: "black",
      wardrobe: ["img-shirt"],
      poses: ["img-pose-a", "img-pose-b"],
      outfits: [],
    };
    await cfs.writeMetadata("char-alex", "character", character, "p");

    // Delete the sidecar to ensure SQLite is the source
    await fs.rm(path.join(projectDir, "char-alex", ".character.json"), {
      force: true,
    });

    const read = await cfs.readMetadata<typeof character>(
      "char-alex",
      "character",
      "p",
    );
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.value.name).toBe("Alex");
    expect(read.value.wardrobe).toEqual(["img-shirt"]);
    expect(read.value.poses).toEqual(["img-pose-a", "img-pose-b"]);
    expect(read.value.outfits).toEqual([]);
  });

  it("preserves backdrop while storing pin arrays separately", async () => {
    const character = {
      name: "Alex",
      wardrobe: ["img-shirt"],
      poses: [],
      outfits: [],
      backdrop: ["img-room"],
    };
    await cfs.writeMetadata("char-alex", "character", character, "p");
    await fs.rm(path.join(projectDir, "char-alex", ".character.json"), {
      force: true,
    });

    const read = await cfs.readMetadata<typeof character>(
      "char-alex",
      "character",
      "p",
    );
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.value.backdrop).toEqual(["img-room"]);
  });

  it("two concurrent character writes do not lose pins", async () => {
    const baseCharacter = {
      name: "Alex",
      wardrobe: [] as string[],
      poses: [] as string[],
      outfits: [] as string[],
    };
    await cfs.writeMetadata("char-alex", "character", baseCharacter, "p");

    // Three concurrent writers each set a different wardrobe value (the race
    // we care about: the in-process git mutex guarantees only one wins, and
    // SQLite atomicity means whichever wins is consistent).
    const writes = [
      cfs.writeMetadata(
        "char-alex",
        "character",
        { ...baseCharacter, wardrobe: ["img-a"] },
        "p",
      ),
      cfs.writeMetadata(
        "char-alex",
        "character",
        { ...baseCharacter, wardrobe: ["img-b"] },
        "p",
      ),
      cfs.writeMetadata(
        "char-alex",
        "character",
        { ...baseCharacter, wardrobe: ["img-c"] },
        "p",
      ),
    ];
    const results = await Promise.all(writes);
    for (const r of results) expect(r.ok).toBe(true);

    const db = getMetadataDb(projectDir);
    const pins = db
      .prepare(
        `SELECT slot, asset_id FROM character_pins
         WHERE character_id = 'char-alex' AND slot = 'wardrobe'
         ORDER BY position`,
      )
      .all() as Array<{ slot: string; asset_id: string }>;
    expect(pins.length).toBe(1);
    expect(["img-a", "img-b", "img-c"]).toContain(pins[0].asset_id);
  });

  it("emits canonical exports for characters and pins", async () => {
    const character = {
      name: "Alex",
      wardrobe: ["img-x"],
      poses: [],
      outfits: [],
    };
    await cfs.writeMetadata("char-alex", "character", character, "p");

    const exportedChars = await fs.readFile(
      path.join(projectDir, ".clipfirst", "export", "characters.json"),
      "utf-8",
    );
    expect(exportedChars).toContain('"asset_id": "char-alex"');
    expect(exportedChars.endsWith("\n")).toBe(true);

    const exportedPins = await fs.readFile(
      path.join(projectDir, ".clipfirst", "export", "character_pins.json"),
      "utf-8",
    );
    expect(exportedPins).toContain('"slot": "wardrobe"');
    expect(exportedPins).toContain('"asset_id": "img-x"');
  });
});

describe("asset_metadata fallback for arbitrary keys", () => {
  let projectsDir: string;
  let cfs: ClipfirstFs;
  let projectDir: string;

  beforeEach(async () => {
    projectsDir = await fs.mkdtemp(path.join(os.tmpdir(), "cfs-amd-"));
    cfs = createFs({ projectsDir });
    expect((await cfs.createProject("p")).ok).toBe(true);
    projectDir = path.join(projectsDir, "p");
    await cfs.createAsset("img", "x", "p");
  });

  afterEach(async () => {
    closeAllStateDbs();
    await fs.rm(projectsDir, { recursive: true, force: true });
  });

  it("dual-writes arbitrary keys to asset_metadata + sidecar", async () => {
    await cfs.writeMetadata(
      "img-x",
      "original",
      { origin: "upload", processed_at: "now" },
      "p",
    );

    const db = getMetadataDb(projectDir);
    const row = db
      .prepare(
        `SELECT value FROM asset_metadata WHERE asset_id = ? AND meta_key = ?`,
      )
      .get("img-x", "original") as { value: string } | undefined;
    expect(row).toBeDefined();
    expect(JSON.parse(row!.value).origin).toBe("upload");
  });

  it("sidecar deletion makes the metadata disappear (sidecar is source of truth)", async () => {
    await cfs.writeMetadata("img-x", "custom-key", { a: 1, b: [2, 3] }, "p");
    // Sanity: sidecar present, read works
    const before = await cfs.readMetadata<{ a: number }>(
      "img-x",
      "custom-key",
      "p",
    );
    expect(before.ok).toBe(true);

    await fs.rm(path.join(projectDir, "img-x", ".custom-key.json"), {
      force: true,
    });

    const after = await cfs.readMetadata("img-x", "custom-key", "p");
    expect(after.ok).toBe(false);
    if (after.ok) return;
    expect(after.error.code).toBe("NOT_FOUND");
  });

  it("falls back to sidecar when SQLite is empty (legacy project)", async () => {
    // Write sidecar without going through writeMetadata
    await fs.writeFile(
      path.join(projectDir, "img-x", ".legacy-key.json"),
      JSON.stringify({ legacy: true }),
    );
    const r = await cfs.readMetadata<{ legacy: boolean }>(
      "img-x",
      "legacy-key",
      "p",
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.legacy).toBe(true);
  });
});
