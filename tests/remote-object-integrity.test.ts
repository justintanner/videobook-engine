import { createHash } from "node:crypto";
import { createServer, type ServerResponse } from "node:http";
import { mkdtemp, readFile, readdir, rm, stat, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createEngine, type ContentStore, type Engine } from "../src/index.js";

const GOOD = Buffer.from("expected immutable media bytes");
const BAD = Buffer.from("incorrect immutable media data");
type Mode = "valid" | "wrong" | "partial" | "held";
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function value<T>(result: { ok: true; value: T } | { ok: false; error: { message: string } }): T {
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "videobook-remote-integrity-"));
  let mode: Mode = "wrong";
  const held: ServerResponse[] = [];
  const requests: string[] = [];
  const unexpected: string[] = [];
  const server = createServer((request, response) => {
    requests.push(request.url ?? "");
    if (mode === "held") { held.push(response); return; }
    response.end(mode === "wrong" ? BAD : GOOD);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No fixture address");
  const remote: ContentStore = {
    async head() { unexpected.push("head"); return { exists: false }; },
    async uploadFile() { unexpected.push("upload"); },
    async delete() { unexpected.push("delete"); },
    async downloadFile(key, destination) {
      const response = await fetch(`http://127.0.0.1:${address.port}/${key}`);
      const bytes = Buffer.from(await response.arrayBuffer());
      if (mode === "partial") {
        await writeFile(destination, bytes.subarray(0, 5));
        throw new Error("Interrupted remote transfer");
      }
      await writeFile(destination, bytes);
    },
  };
  let engine: Engine = createEngine({ rootDir: root, initialBookName: "remote", remoteObjects: remote, objectPrefix: "fixture" });
  cleanups.push(async () => {
    for (const response of held) response.destroy();
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    engine.close();
    await rm(root, { recursive: true, force: true, maxRetries: 3 });
  });
  await engine.ready;
  const artifact = value(await engine.artifacts.create("video", "original label"));
  value(await engine.files.write(artifact.artifactId, "original.mp4", GOOD));
  const manifest = value(await engine.files.manifest(artifact.artifactId));
  const hash = manifest.files[0]!.objectHash;
  const casPath = join(root, "data", "objects", "sha256", hash.slice(0, 2), hash);
  const mediaPath = join(manifest.path, "original.mp4");
  const revisions = engine.history.revisions().map((entry) => entry.hash);
  value(await engine.workspaces.evict(artifact.artifactId));
  engine.close();
  await unlink(casPath);
  engine = createEngine({ rootDir: root, remoteObjects: remote, objectPrefix: "fixture" });
  await engine.ready;
  return {
    engine, artifactId: artifact.artifactId, hash, casPath, mediaPath, revisions, requests, unexpected,
    mode(next: Mode) { mode = next; },
    release(bytes: Buffer | Buffer[] = GOOD) { held.splice(0).forEach((response, index) => response.end(Array.isArray(bytes) ? bytes[index] : bytes)); },
    async noStaging() {
      const entries = await readdir(join(root, "data", "objects", "sha256", hash.slice(0, 2)));
      expect(entries.filter((entry) => entry.endsWith(".download"))).toEqual([]);
    },
  };
}

describe("remote object integrity", () => {
  it.each(["file", "workspace", "manifest"])("rejects same-size corrupt remote bytes on %s reads, preserves state and retries", async (operation) => {
    expect(BAD.length).toBe(GOOD.length);
    const f = await fixture();
    const read = () => operation === "file" ? f.engine.files.read(f.artifactId, "original.mp4")
      : operation === "workspace" ? f.engine.workspaces.materialize(f.artifactId)
      : f.engine.files.manifest(f.artifactId);
    const failed = await read();
    expect(failed).toMatchObject({ ok: false, error: { code: "OBJECT_UNAVAILABLE", details: { objectHash: f.hash, reason: "checksum_mismatch" } } });
    await expect(stat(f.casPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(f.mediaPath)).rejects.toMatchObject({ code: "ENOENT" });
    await f.noStaging();
    expect(f.engine.history.revisions().map((entry) => entry.hash)).toEqual(f.revisions);
    expect(value(f.engine.artifacts.get(f.artifactId)).label).toBe("original label");
    expect(f.requests).toEqual([`/fixture/${f.hash.slice(0, 2)}/${f.hash}`]);
    expect(f.unexpected).toEqual([]);
    f.mode("valid");
    expect((await read()).ok).toBe(true);
    expect(await readFile(f.casPath)).toEqual(GOOD);
    expect(await readFile(f.mediaPath)).toEqual(GOOD);
    await f.noStaging();
    const calls = f.requests.length;
    expect(value(await f.engine.files.read(f.artifactId, "original.mp4"))).toEqual(GOOD);
    expect(f.requests).toHaveLength(calls);
    expect(f.engine.history.revisions().map((entry) => entry.hash)).toEqual(f.revisions);
  });

  it("cleans partially written failed transfers and permits a correct retry", async () => {
    const f = await fixture();
    f.mode("partial");
    expect(await f.engine.files.read(f.artifactId, "original.mp4")).toMatchObject({ ok: false, error: { message: "Interrupted remote transfer" } });
    await expect(stat(f.casPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(f.mediaPath)).rejects.toMatchObject({ code: "ENOENT" });
    await f.noStaging();
    f.mode("valid");
    expect(value(await f.engine.files.read(f.artifactId, "original.mp4"))).toEqual(GOOD);
    expect(f.engine.history.revisions().map((entry) => entry.hash)).toEqual(f.revisions);
  });

  it.each([true, false])("keeps concurrent reader publication valid (corrupt=%s)", async (corrupt) => {
    const f = await fixture();
    f.mode("held");
    const reads = Array.from({ length: 4 }, () => f.engine.files.read(f.artifactId, "original.mp4"));
    await expect.poll(() => f.requests.length).toBe(4);
    await expect(stat(f.casPath)).rejects.toMatchObject({ code: "ENOENT" });
    f.release(corrupt ? BAD : GOOD);
    const results = await Promise.all(reads);
    for (const result of results) {
      if (corrupt) expect(result).toMatchObject({ ok: false, error: { code: "OBJECT_UNAVAILABLE" } });
      else expect(value(result)).toEqual(GOOD);
    }
    if (corrupt) await expect(stat(f.casPath)).rejects.toMatchObject({ code: "ENOENT" });
    else expect(createHash("sha256").update(await readFile(f.casPath)).digest("hex")).toBe(f.hash);
    await f.noStaging();
  });

  it("does not let a corrupt concurrent transfer replace or clean up a valid publication", async () => {
    const f = await fixture();
    f.mode("held");
    const reads = Array.from({ length: 4 }, () => f.engine.files.read(f.artifactId, "original.mp4"));
    await expect.poll(() => f.requests.length).toBe(4);
    f.release([BAD, GOOD, BAD, GOOD]);
    const results = await Promise.all(reads);
    expect(results.filter((result) => result.ok)).toHaveLength(2);
    for (const result of results) {
      if (result.ok) expect(result.value).toEqual(GOOD);
      else expect(result.error.code).toBe("OBJECT_UNAVAILABLE");
    }
    expect(await readFile(f.casPath)).toEqual(GOOD);
    expect(await readFile(f.mediaPath)).toEqual(GOOD);
    await f.noStaging();
  });

  it("does not resurrect an object forgotten while its download was in flight", async () => {
    const f = await fixture();
    f.mode("held");
    const pending = f.engine.files.read(f.artifactId, "original.mp4");
    await expect.poll(() => f.requests.length).toBe(1);
    value(await f.engine.storage.deleteObject(f.hash, { force: true, remote: false }));
    const revisions = f.engine.history.revisions().map((entry) => entry.hash);
    f.release();
    expect(await pending).toMatchObject({ ok: false, error: { code: "OBJECT_UNAVAILABLE" } });
    await expect(stat(f.casPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(f.mediaPath)).rejects.toMatchObject({ code: "ENOENT" });
    await f.noStaging();
    expect(await f.engine.files.read(f.artifactId, "original.mp4")).toMatchObject({ ok: false, error: { code: "OBJECT_UNAVAILABLE" } });
    expect(f.requests).toHaveLength(1);
    expect(f.engine.history.revisions().map((entry) => entry.hash)).toEqual(revisions);
  });
});
