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
    expect(scanNotebookMentions("Use @A2, @h64. Keep @vid-yt-3h3i_td5kce whole.")).toEqual([
      { raw: "@A2", reference: "a2", index: 4, end: 7 },
      { raw: "@h64", reference: "h64", index: 9, end: 13 },
    ]);
    // Word and hyphen continuations are not grid mentions.
    expect(scanNotebookMentions("@a2-set @a65 @aa1 @i1")).toEqual([]);
  });

  it("accepts only in-bounds grid addresses", () => {
    expect(isNotebookGridAddress("@a1")).toBe(true);
    expect(isNotebookGridAddress("H64")).toBe(true);
    expect(isNotebookGridAddress(" @A2 ")).toBe(true);
    expect(isNotebookGridAddress("a65")).toBe(false);
    expect(isNotebookGridAddress("i1")).toBe(false);
    expect(isNotebookGridAddress("aa1")).toBe(false);
    expect(isNotebookGridAddress("a0")).toBe(false);
    expect(isNotebookGridAddress("@img-foo")).toBe(false);
  });

  it("reports the active mention prefix at the end of the input", () => {
    expect(notebookMentionPrefixAtEnd("combine @a")).toBe("a");
    expect(notebookMentionPrefixAtEnd("combine @H64")).toBe("h64");
    expect(notebookMentionPrefixAtEnd("combine @")).toBe("");
    expect(notebookMentionPrefixAtEnd("no mention")).toBeUndefined();
  });

  it("replaces exact grid mentions longest-first without prefix collisions", () => {
    expect(replaceNotebookMentions(
      "Blend @a1 with @H64.",
      [
        { reference: "a1", replacement: "the sketch" },
        { reference: "@h64", replacement: "the render" },
      ],
    )).toBe("Blend the sketch with the render.");
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
