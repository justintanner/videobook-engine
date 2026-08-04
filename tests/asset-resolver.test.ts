import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createEngine, type Engine } from "../src/index.js";
import {
  expandSlotRefs,
  parseArtifactTags,
} from "../src/resolver.js";

describe("parseArtifactTags", () => {
  it("parses a single image tag", () => {
    expect(parseArtifactTags("@img-sunset")).toEqual(["img-sunset"]);
  });

  it("parses a single video tag", () => {
    expect(parseArtifactTags("@vid-foo")).toEqual(["vid-foo"]);
  });

  it("parses multiple tags", () => {
    expect(parseArtifactTags("@vid-foo @img-bar")).toEqual([
      "vid-foo",
      "img-bar",
    ]);
  });

  it("parses tags mixed with other text", () => {
    expect(parseArtifactTags("trim @vid-abc from 0:00 to 1:30"))
      .toEqual(["vid-abc"]);
  });

  it("returns no tags when none are present", () => {
    expect(parseArtifactTags("no tags here")).toEqual([]);
  });

  it("returns no tags for empty text", () => {
    expect(parseArtifactTags("")).toEqual([]);
  });

  it("parses names containing hyphens and underscores", () => {
    expect(parseArtifactTags("@img-my_photo-2"))
      .toEqual(["img-my_photo-2"]);
  });

  it("parses audio and script tags", () => {
    expect(parseArtifactTags("@aud-track1 @script-notes")).toEqual([
      "aud-track1",
      "script-notes",
    ]);
  });

  it("deduplicates repeated tags", () => {
    expect(parseArtifactTags("compare @img-sunset with @img-sunset"))
      .toEqual(["img-sunset"]);
  });

  it("deduplicates in first-occurrence order", () => {
    expect(parseArtifactTags("@vid-a @img-b @vid-a @img-c @img-b"))
      .toEqual(["vid-a", "img-b", "img-c"]);
  });
});

describe("expandSlotRefs", () => {
  it("expands a valid slot", () => {
    expect(expandSlotRefs("use @s01 here", [
      { slug: "vid-intro" },
      { slug: "img-sunset" },
    ])).toBe("use @vid-intro here");
  });

  it("expands multiple slots", () => {
    expect(expandSlotRefs("@s01 and @s03", [
      { slug: "vid-intro" },
      { slug: "img-sunset" },
      { slug: "aud-bgm" },
    ])).toBe("@vid-intro and @aud-bgm");
  });

  it("leaves an out-of-range slot unchanged", () => {
    expect(expandSlotRefs("ref @s99", [{ slug: "vid-intro" }]))
      .toBe("ref @s99");
  });

  it("leaves a slot with an empty slug unchanged", () => {
    expect(expandSlotRefs("@s01 and @s02", [
      { slug: "" },
      { slug: "img-sunset" },
    ])).toBe("@s01 and @img-sunset");
  });

  it("handles an empty slot list", () => {
    expect(expandSlotRefs("@s01", [])).toBe("@s01");
  });

  it("leaves text without slot refs unchanged", () => {
    expect(expandSlotRefs("no refs here", [{ slug: "vid-intro" }]))
      .toBe("no refs here");
  });
});

describe("resolver API", () => {
  let rootDir: string;
  let engine: Engine;

  beforeEach(async () => {
    rootDir = await mkdtemp(join(tmpdir(), "videobook-resolver-"));
    engine = createEngine({
      rootDir,
      initialBookSlug: "resolver",
    });
    await engine.ready;
  });

  afterEach(async () => {
    engine.close();
    await rm(rootDir, { recursive: true, force: true, maxRetries: 3 });
  });

  it("returns empty arrays when text has no tags", async () => {
    const result = await engine.resolver.resolveAll("no tags here");
    expect(result).toEqual({
      ok: true,
      value: { resolved: [], unresolved: [] },
    });
  });

  it("reports a missing asset", async () => {
    const result = await engine.resolver.resolveAll("@vid-nonexistent");
    expect(result).toMatchObject({
      ok: true,
      value: {
        resolved: [],
        unresolved: ["vid-nonexistent"],
      },
    });
  });

  it("resolves an existing image and its primary file", async () => {
    const created = await engine.artifacts.create("image", "sunset");
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const written = await engine.files.write(
      created.value.artifactId,
      "original.png",
      Buffer.from("image"),
    );
    expect(written.ok).toBe(true);
    const result = await engine.resolver.resolveAll(
      `@${created.value.slug} enhance it`,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.resolved).toMatchObject([{
      tag: `@${created.value.slug}`,
      artifactId: created.value.artifactId,
      artifactSlug: created.value.slug,
      artifactType: "image",
    }]);
    expect(result.value.resolved[0]?.filePath).toContain("original.png");
    expect(result.value.unresolved).toEqual([]);
  });

  it("resolves multiple assets", async () => {
    const image = await engine.artifacts.create("image", "photo");
    const video = await engine.artifacts.create("video", "clip");
    expect(image.ok && video.ok).toBe(true);
    if (!image.ok || !video.ok) return;
    const result = await engine.resolver.resolveAll(
      `@${image.value.slug} and @${video.value.slug}`,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.resolved).toHaveLength(2);
    expect(result.value.unresolved).toEqual([]);
  });

  it("returns resolved and unresolved tags together", async () => {
    const image = await engine.artifacts.create("image", "real");
    expect(image.ok).toBe(true);
    if (!image.ok) return;
    const result = await engine.resolver.resolveAll(
      `@${image.value.slug} and @vid-nonexistent`,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.resolved).toHaveLength(1);
    expect(result.value.unresolved).toEqual(["vid-nonexistent"]);
  });
});
