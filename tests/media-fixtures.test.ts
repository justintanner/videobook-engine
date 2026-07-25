import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

const fixtures = [
  {
    name: "vancat.mp4",
    sha256: "f109188354d5e65210a51126d271bbddba4d522b13fc1cbe2b2e274cc9b7c8d1",
  },
  {
    name: "vancat_profile.jpg",
    sha256: "eb09e75fe9507afa34e96d3380a07fd86a431f9d91bd3f5c6b5365e4ed31f885",
  },
] as const;

describe("media fixtures", () => {
  it.each(fixtures)("pins $name by content hash", async ({ name, sha256 }) => {
    const bytes = await readFile(
      new URL(`../fixtures/media/${name}`, import.meta.url),
    );

    expect(createHash("sha256").update(bytes).digest("hex")).toBe(sha256);
  });

  it("contains an MP4 video and JPEG profile image", async () => {
    const video = await readFile(
      new URL("../fixtures/media/vancat.mp4", import.meta.url),
    );
    const image = await readFile(
      new URL("../fixtures/media/vancat_profile.jpg", import.meta.url),
    );

    expect(video.subarray(4, 8).toString("ascii")).toBe("ftyp");
    expect(Array.from(image.subarray(0, 2))).toEqual([0xff, 0xd8]);
    expect(Array.from(image.subarray(-2))).toEqual([0xff, 0xd9]);
  });
});
