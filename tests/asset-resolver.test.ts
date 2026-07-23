import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFs } from "../src/index.js";
import type { VideocityFs } from "../src/index.js";
import { parseAssetTags, resolveAllAssets, expandSlotRefs } from "../src/asset/resolver.js";

describe("parseAssetTags", () => {
  it("parses a single @img- tag", () => {
    expect(parseAssetTags("@img-sunset")).toEqual(["img-sunset"]);
  });

  it("parses a single @vid- tag", () => {
    expect(parseAssetTags("@vid-foo")).toEqual(["vid-foo"]);
  });

  it("parses multiple tags", () => {
    const result = parseAssetTags("@vid-foo @img-bar");
    expect(result).toEqual(["vid-foo", "img-bar"]);
  });

  it("parses tags mixed with other text", () => {
    const result = parseAssetTags("trim @vid-abc from 0:00 to 1:30");
    expect(result).toEqual(["vid-abc"]);
  });

  it("returns empty array when no tags present", () => {
    expect(parseAssetTags("no tags here")).toEqual([]);
  });

  it("returns empty array for empty string", () => {
    expect(parseAssetTags("")).toEqual([]);
  });

  it("parses tags with hyphens and underscores in the name", () => {
    const result = parseAssetTags("@img-my_photo-2");
    expect(result).toEqual(["img-my_photo-2"]);
  });

  it("parses first-class entity tags", () => {
    const result = parseAssetTags("@char-astronaut @prm-moon @scn-garden");
    expect(result).toEqual(["char-astronaut", "prm-moon", "scn-garden"]);
  });

  it("deduplicates repeated tags", () => {
    const result = parseAssetTags("compare @img-sunset with @img-sunset");
    expect(result).toEqual(["img-sunset"]);
  });

  it("deduplicates while preserving order of first occurrence", () => {
    const result = parseAssetTags("@vid-a @img-b @vid-a @img-c @img-b");
    expect(result).toEqual(["vid-a", "img-b", "img-c"]);
  });
});

describe("expandSlotRefs", () => {
  it("expands @s01 with a valid slot", () => {
    const slots = [{ slug: "vid-intro" }, { slug: "img-sunset" }];
    expect(expandSlotRefs("use @s01 here", slots)).toBe("use @vid-intro here");
  });

  it("expands multiple slot refs in one string", () => {
    const slots = [{ slug: "vid-intro" }, { slug: "img-sunset" }, { slug: "aud-bgm" }];
    expect(expandSlotRefs("@s01 and @s03", slots)).toBe("@vid-intro and @aud-bgm");
  });

  it("leaves @s99 unchanged when out of range", () => {
    const slots = [{ slug: "vid-intro" }];
    expect(expandSlotRefs("ref @s99", slots)).toBe("ref @s99");
  });

  it("leaves slot ref unchanged when slug is empty", () => {
    const slots = [{ slug: "" }, { slug: "img-sunset" }];
    expect(expandSlotRefs("@s01 and @s02", slots)).toBe("@s01 and @img-sunset");
  });

  it("handles empty slots array", () => {
    expect(expandSlotRefs("@s01", [])).toBe("@s01");
  });

  it("does not touch text without slot refs", () => {
    const slots = [{ slug: "vid-intro" }];
    expect(expandSlotRefs("no refs here", slots)).toBe("no refs here");
  });
});

describe("resolveAllAssets (real fs)", () => {
  let tempDir: string;
  let fs: VideocityFs;
  const slug = "test-proj";

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "videocity-resolver-"));
    fs = createFs({ projectsDir: tempDir });
    await fs.createProject(slug);
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true, maxRetries: 3 });
  });

  it("returns empty arrays when no tags in text", async () => {
    const result = await resolveAllAssets("no tags here", fs, slug);
    expect(result.resolved).toEqual([]);
    expect(result.unresolved).toEqual([]);
  });

  it("reports unresolved tags when asset does not exist", async () => {
    const result = await resolveAllAssets("@vid-nonexistent", fs, slug);
    expect(result.unresolved).toContain("vid-nonexistent");
    expect(result.resolved).toEqual([]);
  });

  it("resolves existing image asset", async () => {
    // Create an image asset
    const createResult = await fs.createAsset("img", "sunset", slug);
    expect(createResult.ok).toBe(true);
    if (!createResult.ok) return;
    const assetId = createResult.value.assetId;

    // Write a file to the asset
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==",
      "base64",
    );
    await fs.writeFile(assetId, "original.png", png, slug);

    const result = await resolveAllAssets(`@${assetId} enhance it`, fs, slug);
    expect(result.resolved.length).toBe(1);
    expect(result.resolved[0].asset_id).toBe(assetId);
    expect(result.resolved[0].tag).toBe(`@${assetId}`);
    expect(result.resolved[0].asset_type).toBe("image");
    expect(result.resolved[0].file_path).toContain("original.png");
    expect(result.unresolved).toEqual([]);
  });

  it("resolves multiple assets", async () => {
    const img = await fs.createAsset("img", "photo", slug);
    const vid = await fs.createAsset("vid", "clip", slug);
    expect(img.ok).toBe(true);
    expect(vid.ok).toBe(true);
    if (!img.ok || !vid.ok) return;

    const text = `@${img.value.assetId} and @${vid.value.assetId}`;
    const result = await resolveAllAssets(text, fs, slug);
    expect(result.resolved.length).toBe(2);
    expect(result.unresolved).toEqual([]);
  });

  it("handles a mix of resolved and unresolved tags", async () => {
    const img = await fs.createAsset("img", "real", slug);
    expect(img.ok).toBe(true);
    if (!img.ok) return;

    const text = `@${img.value.assetId} and @vid-nonexistent`;
    const result = await resolveAllAssets(text, fs, slug);
    expect(result.resolved.length).toBe(1);
    expect(result.unresolved).toContain("vid-nonexistent");
  });
});
