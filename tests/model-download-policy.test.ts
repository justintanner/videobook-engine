import { createServer, type Server } from "node:http";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createEngine, LocalClapTemporalProvider, LocalClipTemporalProvider } from "../src/index.js";
import { env } from "../src/transformers-runtime.js";
import { LOCAL_CLIP_MODEL_ID, LOCAL_CLIP_MODEL_REVISION, LOCAL_CLAP_MODEL_ID, LOCAL_CLAP_MODEL_REVISION } from "../src/temporal-model-manifests.js";

describe("local model download permission", () => {
  let root: string;
  let server: Server;
  let requests: string[];
  let originalHost: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "videobook-model-policy-"));
    requests = [];
    originalHost = env.remoteHost;
    server = createServer((request, response) => {
      requests.push(request.url ?? "");
      response.writeHead(404).end("Model is not installed on this fixture server");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Fixture server did not listen");
    env.remoteHost = `http://127.0.0.1:${address.port}/`;
  });

  afterEach(async () => {
    env.remoteHost = originalHost;
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await rm(root, { recursive: true, force: true });
  });

  it.each([undefined, false])("does not fetch temporal model files with permission %s", async (allowModelDownload) => {
    for (const Provider of [LocalClipTemporalProvider, LocalClapTemporalProvider]) {
      const provider = new Provider({ modelCacheDir: root, allowModelDownload });
      await expect(provider.prepare()).rejects.toMatchObject({ error: { code: "OFFLINE" } });
      await expect(provider.embedText("a red bicycle")).rejects.toThrow("Model downloads are disabled");
    }
    expect(requests).toEqual([]);
  });

  it.each([
    { Provider: LocalClipTemporalProvider, modelId: LOCAL_CLIP_MODEL_ID, revision: LOCAL_CLIP_MODEL_REVISION, file: "config.json" },
    { Provider: LocalClapTemporalProvider, modelId: LOCAL_CLAP_MODEL_ID, revision: LOCAL_CLAP_MODEL_REVISION, file: "preprocessor_config.json" },
  ])("prioritizes an active integrity check over concurrent missing files for $modelId", async ({ Provider, modelId, revision, file }) => {
    const path = join(root, modelId, revision);
    await mkdir(path, { recursive: true });
    await writeFile(join(path, file), '{"model_type":"clip"}');
    await expect(new Provider({ modelCacheDir: root }).prepare()).rejects.toMatchObject({ error: { code: "MODEL_UNAVAILABLE" } });
    expect(requests).toEqual([]);
  });

  it.each(["image", "audio", "text"] as const)("keeps compatibility %s model preparation offline by default", async (kind) => {
    const engine = createEngine({ rootDir: join(root, "book"), initialBookName: "offline",
      similarity: { modelCacheDir: join(root, "models"), audio: {}, text: {} } });
    try {
      await engine.ready;
      expect(await engine.similarity.prepare({ kind })).toMatchObject({ ok: false, error: { code: "OFFLINE" } });
      expect(requests).toEqual([]);
    } finally { engine.close(); }
  });

  it("requests pinned revisions only after explicit download permission", async () => {
    for (const Provider of [LocalClipTemporalProvider, LocalClapTemporalProvider]) {
      const provider = new Provider({ modelCacheDir: root, allowModelDownload: true });
      await expect(provider.prepare()).rejects.toMatchObject({ error: { code: "FEATURE_UNAVAILABLE" } });
    }
    expect(requests.length).toBeGreaterThan(0);
    expect(requests.every((url) => /\/resolve\/(?:d15189d7028b43f1d3e65039190477f6af591c2a|c28f2883575e590e04d3146ff0713c2448d691ba)\//u.test(url))).toBe(true);
  });
});
