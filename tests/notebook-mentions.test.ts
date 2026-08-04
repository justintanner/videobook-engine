import { describe, expect, it } from "vitest";

import {
  classifyNotebookReference,
  notebookMentionPrefixAtEnd,
  parseArtifactTags,
  replaceNotebookMentions,
  scanNotebookMentions,
  stripNotebookMentions,
} from "../src/index.js";

describe("notebook mention grammar", () => {
  it("scans bounded grid addresses and underscore-safe slugs", () => {
    expect(scanNotebookMentions(
      "Use @A2, @z13. Keep @vid-yt-3h3i_td5kce whole.",
    )).toMatchObject([
      { raw: "@A2", reference: "a2", kind: "grid" },
      { raw: "@z13", reference: "z13", kind: "grid" },
      {
        raw: "@vid-yt-3h3i_td5kce",
        reference: "vid-yt-3h3i_td5kce",
        kind: "asset-slug",
      },
    ]);
  });

  it("classifies only in-bounds grid addresses as grid references", () => {
    expect(classifyNotebookReference("@a1")).toBe("grid");
    expect(classifyNotebookReference("Z13")).toBe("grid");
    expect(classifyNotebookReference("a14")).toBe("cell-slug/id-prefix");
    expect(classifyNotebookReference("aa1")).toBe("cell-slug/id-prefix");
    expect(classifyNotebookReference("@img-main_view")).toBe("asset-slug");
  });

  it("replaces exact mentions longest-first without prefix collisions", () => {
    expect(replaceNotebookMentions(
      "Use @img-da-set, then @IMG-DA.",
      [
        { reference: "img-da", replacement: "short" },
        { reference: "img-da-set", replacement: "long" },
      ],
    )).toBe("Use long, then short.");
  });

  it("shares active-prefix and artifact-tag parsing", () => {
    expect(notebookMentionPrefixAtEnd("combine @Vid-YT_3")).toBe("vid-yt_3");
    expect(parseArtifactTags(
      "@vid-yt-3h3i_td5kce @a2 @a14 @vid-yt-3h3i_td5kce",
    )).toEqual(["vid-yt-3h3i_td5kce"]);
  });

  it("strips exact mentions without leaving a middle double-space", () => {
    expect(stripNotebookMentions(
      "zoom into @vid-motion suddenly",
      ["vid-motion"],
    )).toBe("zoom into suddenly");
    expect(stripNotebookMentions(
      "@vid-motion but slower",
      ["vid-motion"],
    )).toBe(" but slower");
  });
});
