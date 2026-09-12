import { describe, expect, it } from "vitest";
import { normalizeBookSlug } from "../src/book-slug.js";

describe("project slug policy", () => {
  it.each([
    ["my-project-2", "my-project-2"],
    ["  My New Project  ", "my-new-project"],
    ["Café__déjà---vu!", "cafe-deja-vu"],
    ["Ｆｕｌｌｗｉｄｔｈ １２", "fullwidth-12"],
    ["Renamed 猫", "renamed"],
    ["---猫🐈___", ""],
  ])("normalizes %s to %s", (input, expected) => {
    expect(normalizeBookSlug(input)).toBe(expected);
    expect(normalizeBookSlug(expected)).toBe(expected);
  });
});
