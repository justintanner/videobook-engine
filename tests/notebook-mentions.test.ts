import { describe, expect, it } from "vitest";

import {
  isNotebookGridAddress,
  notebookMentionPrefixAtEnd,
  replaceNotebookMentions,
  scanNotebookMentions,
  stripNotebookMentions,
} from "../src/index.js";

describe("notebook mention grammar", () => {
  it("scans only bounded grid addresses; slug-style tokens are inert text", () => {
    expect(scanNotebookMentions("@a2 likes @img-foo")).toEqual([
      { raw: "@a2", reference: "a2", index: 0, end: 3 },
    ]);
    expect(scanNotebookMentions("Use @A2, @bl8. Keep @vid-yt-3h3i_td5kce whole.")).toEqual([
      { raw: "@A2", reference: "a2", index: 4, end: 7 },
      { raw: "@bl8", reference: "bl8", index: 9, end: 13 },
    ]);
    expect(scanNotebookMentions("@aa1 then @Z8")).toEqual([
      { raw: "@aa1", reference: "aa1", index: 0, end: 4 },
      { raw: "@Z8", reference: "z8", index: 10, end: 13 },
    ]);
    // Word and hyphen continuations are not grid mentions, nor are columns
    // past 8 or rows past bl.
    expect(scanNotebookMentions("@a2-set @a9 @a10 @bm1 @aaa1")).toEqual([]);
  });

  it("accepts only in-bounds grid addresses", () => {
    expect(isNotebookGridAddress("@a1")).toBe(true);
    expect(isNotebookGridAddress("BL8")).toBe(true);
    expect(isNotebookGridAddress(" @A2 ")).toBe(true);
    expect(isNotebookGridAddress("aa1")).toBe(true);
    expect(isNotebookGridAddress("a9")).toBe(false);
    expect(isNotebookGridAddress("a64")).toBe(false);
    expect(isNotebookGridAddress("bm1")).toBe(false);
    expect(isNotebookGridAddress("a0")).toBe(false);
    expect(isNotebookGridAddress("@img-foo")).toBe(false);
  });

  it("reports the active mention prefix at the end of the input", () => {
    expect(notebookMentionPrefixAtEnd("combine @a")).toBe("a");
    expect(notebookMentionPrefixAtEnd("combine @BL8")).toBe("bl8");
    expect(notebookMentionPrefixAtEnd("combine @")).toBe("");
    expect(notebookMentionPrefixAtEnd("no mention")).toBeUndefined();
  });

  it("replaces exact grid mentions longest-first without prefix collisions", () => {
    expect(replaceNotebookMentions(
      "Blend @a1 with @BL8 and @aa1.",
      [
        { reference: "a1", replacement: "the sketch" },
        { reference: "@bl8", replacement: "the render" },
        { reference: "aa1", replacement: "the cut" },
      ],
    )).toBe("Blend the sketch with the render and the cut.");
  });

  it("strips exact grid mentions without leaving a middle double-space", () => {
    expect(stripNotebookMentions(
      "zoom into @b7 suddenly",
      ["b7"],
    )).toBe("zoom into suddenly");
    expect(stripNotebookMentions(
      "@b7 but slower",
      ["b7"],
    )).toBe(" but slower");
  });
});
