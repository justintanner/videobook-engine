import { mkdir, mkdtemp, open, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ObjectStore } from "../src/cas.js";

describe("ObjectStore", () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) =>
      rm(root, { recursive: true, force: true })
    ));
  });

  it("atomically replaces a materialized file without mutating open readers", async () => {
    const root = await mkdtemp(join(tmpdir(), "videobook-engine-cas-"));
    roots.push(root);
    const store = new ObjectStore(join(root, "objects"));
    const original = await store.put("original bytes");
    const replacement = await store.put("replacement bytes");
    const destination = join(root, "workspace", "original.mp4");
    await store.materialize(original.hash, destination);

    const reader = await open(destination, "r");
    try {
      await store.materialize(replacement.hash, destination);

      expect(await reader.readFile({ encoding: "utf8" })).toBe("original bytes");
      expect(await readFile(destination, "utf8")).toBe("replacement bytes");
      expect(await readdir(join(root, "workspace"))).toEqual(["original.mp4"]);
    } finally {
      await reader.close();
    }
  });

  it("cleans the temporary copy when replacement fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "videobook-engine-cas-"));
    roots.push(root);
    const store = new ObjectStore(join(root, "objects"));
    const object = await store.put("replacement bytes");
    const workspace = join(root, "workspace");
    const destination = join(workspace, "original.mp4");
    await mkdir(destination, { recursive: true });

    await expect(store.materialize(object.hash, destination)).rejects.toThrow();
    expect(await readdir(workspace)).toEqual(["original.mp4"]);
  });
});
