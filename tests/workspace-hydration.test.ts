import { mkdtemp, readFile, rm, stat, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createEngine, type Engine } from "../src/index.js";

const roots: string[] = [];
const engines: Engine[] = [];

afterEach(async () => {
  for (const engine of engines.splice(0)) engine.close();
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true, maxRetries: 3 })),
  );
});

async function setup(): Promise<{ engine: Engine; root: string }> {
  const root = await mkdtemp(path.join(tmpdir(), "videobook-hydration-"));
  roots.push(root);
  const engine = createEngine({ rootDir: root, initialBookName: "hydration" });
  engines.push(engine);
  await engine.ready;
  return { engine, root };
}

function value<T>(
  result:
    | { ok: true; value: T; revision?: string }
    | { ok: false; error: { message: string } },
): T {
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

async function fileIdentity(file: string): Promise<{ ino: number; mtimeMs: number }> {
  const info = await stat(file);
  return { ino: info.ino, mtimeMs: info.mtimeMs };
}

describe("workspace hydration", () => {
  it("reads a hydrated workspace without copying its objects again", async () => {
    const { engine } = await setup();
    const artifact = value(await engine.artifacts.create("video", "clip"));
    value(await engine.files.write(artifact.artifactId, "original.mp4", "v1-bytes"));
    value(await engine.files.write(artifact.artifactId, "frames/0.jpg", "frame"));

    const first = value(await engine.files.manifest(artifact.artifactId));
    const original = path.join(first.path, "original.mp4");
    const frame = path.join(first.path, "frames", "0.jpg");
    const before = await Promise.all([fileIdentity(original), fileIdentity(frame)]);

    // A second read must leave the files untouched: same inode, same mtime.
    const second = value(await engine.files.manifest(artifact.artifactId));
    expect(second.files.map((file) => file.name)).toEqual(first.files.map((file) => file.name));
    expect(await Promise.all([fileIdentity(original), fileIdentity(frame)])).toEqual(before);
    expect(await readFile(original, "utf8")).toBe("v1-bytes");
  });

  it("copies back only the files missing from a hydrated workspace", async () => {
    const { engine } = await setup();
    const artifact = value(await engine.artifacts.create("video", "clip"));
    value(await engine.files.write(artifact.artifactId, "original.mp4", "v1-bytes"));
    value(await engine.files.write(artifact.artifactId, "proxy.mp4", "proxy-bytes"));
    const manifest = value(await engine.files.manifest(artifact.artifactId));
    const original = path.join(manifest.path, "original.mp4");
    const proxy = path.join(manifest.path, "proxy.mp4");
    const originalBefore = await fileIdentity(original);

    await unlink(proxy);
    value(await engine.files.manifest(artifact.artifactId));
    expect(await readFile(proxy, "utf8")).toBe("proxy-bytes");
    expect(await fileIdentity(original)).toEqual(originalBefore);
  });

  it("rehydrates after eviction and after a history restore", async () => {
    const { engine } = await setup();
    const artifact = value(await engine.artifacts.create("video", "clip"));
    const first = await engine.files.write(artifact.artifactId, "original.mp4", "v1-bytes");
    if (!first.ok || !first.revision) throw new Error("first write lacks a revision");
    const manifest = value(await engine.files.manifest(artifact.artifactId));
    const original = path.join(manifest.path, "original.mp4");

    value(await engine.workspaces.evict(artifact.artifactId));
    await expect(stat(original)).rejects.toThrow();
    value(await engine.files.manifest(artifact.artifactId));
    expect(await readFile(original, "utf8")).toBe("v1-bytes");

    // Writes place their new object directly; the workspace follows.
    value(await engine.files.write(artifact.artifactId, "original.mp4", "v2-longer-bytes"));
    expect(await readFile(original, "utf8")).toBe("v2-longer-bytes");
    value(await engine.files.manifest(artifact.artifactId));
    expect(await readFile(original, "utf8")).toBe("v2-longer-bytes");

    // A restore changes the catalog underneath the workspace and clears its
    // hydration, so the next manifest read copies the restored object back.
    value(await engine.history.restoreArtifact(artifact.artifactId, first.revision));
    value(await engine.files.manifest(artifact.artifactId));
    expect(await readFile(original, "utf8")).toBe("v1-bytes");
    engine.close();
  });

  it("reports waveform presence without decoding peaks", async () => {
    const { engine } = await setup();
    const artifact = value(await engine.artifacts.create("audio", "track"));
    expect(value(await engine.metadata.waveforms.exists(artifact.artifactId))).toBe(false);
    value(await engine.metadata.waveforms.write(artifact.artifactId, [0.2, 0.9]));
    expect(value(await engine.metadata.waveforms.exists(artifact.artifactId))).toBe(true);
    value(await engine.metadata.waveforms.delete(artifact.artifactId));
    expect(value(await engine.metadata.waveforms.exists(artifact.artifactId))).toBe(false);
    expect(await engine.metadata.waveforms.exists("missing-artifact")).toMatchObject({ ok: false });
    engine.close();
  });
});
