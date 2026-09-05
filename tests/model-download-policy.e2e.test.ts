import { createReadStream } from "node:fs";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LocalClapTemporalProvider, LocalClipTemporalProvider } from "../src/index.js";
import { env } from "../src/transformers-runtime.js";

let root: string | undefined;
afterEach(async () => { if (root) await rm(root, { recursive: true, force: true }); });

describe.runIf(process.env.VIDEOBOOK_RUN_MODEL_POLICY_E2E === "1")("pinned model transfer and offline reuse", () => {
  it("downloads only confirmed snapshots and performs cached CLIP/CLAP inference without further requests", async () => {
    root = await mkdtemp(join(tmpdir(), "videobook-model-transfer-"));
    const sourceCache = process.env.VIDEOBOOK_MODEL_FIXTURE_CACHE ?? join(homedir(), ".cache", "videobook", "models");
    const requests: string[] = [];
    let transferred = 0;
    const server = createServer((request, response) => {
      void (async () => {
        const url = request.url ?? "";
        requests.push(url);
        const match = /^\/Xenova\/(clip-vit-base-patch32|clap-htsat-unfused)\/resolve\/(d15189d7028b43f1d3e65039190477f6af591c2a|c28f2883575e590e04d3146ff0713c2448d691ba)\/(config\.json|tokenizer(?:_config)?\.json|preprocessor_config\.json|onnx\/(?:text|vision|audio)_model_quantized\.onnx)$/u.exec(url);
        if (!match) { response.writeHead(400).end(); return; }
        const path = join(sourceCache, "Xenova", match[1]!, match[2]!, match[3]!);
        const size = (await stat(path)).size;
        if (request.headers.range === "bytes=0-0") {
          response.writeHead(206, { "Content-Range": `bytes 0-0/${size}`, "Content-Length": 1 });
          createReadStream(path, { start: 0, end: 0 }).pipe(response);
        } else {
          transferred += size;
          response.writeHead(200, { "Content-Length": size, "Content-Type": path.endsWith(".json") ? "application/json" : "application/octet-stream" });
          createReadStream(path).pipe(response);
        }
      })().catch(() => response.writeHead(404).end());
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Fixture server did not listen");
    const previousHost = env.remoteHost;
    env.remoteHost = `http://127.0.0.1:${address.port}/`;
    try {
      for (const Provider of [LocalClipTemporalProvider, LocalClapTemporalProvider]) {
        const cache = join(root, Provider.name);
        const authorized = new Provider({ modelCacheDir: cache, allowModelDownload: true });
        await authorized.prepare();
        const onlineVector = await authorized.embedText("a steady electronic tone");
        expect(onlineVector).toHaveLength(512);
        const requestCount = requests.length;
        const offline = new Provider({ modelCacheDir: cache });
        await offline.prepare();
        const offlineVector = await offline.embedText("a steady electronic tone");
        expect([...offlineVector]).toEqual([...onlineVector]);
        expect(requests).toHaveLength(requestCount);
      }
      expect(transferred).toBeGreaterThan(100_000_000);
      expect(requests.every((url) => !url.includes("/main/"))).toBe(true);
      expect(requests.length).toBeLessThan(50);
      expect(await readFile(join(root, "LocalClipTemporalProvider", "Xenova", "clip-vit-base-patch32", "d15189d7028b43f1d3e65039190477f6af591c2a", "config.json"), "utf8")).toContain("clip");
    } finally {
      env.remoteHost = previousHost;
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }, 180_000);
});
