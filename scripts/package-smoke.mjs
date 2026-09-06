import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);
const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const root = await mkdtemp(join(tmpdir(), "videobook-package-smoke-"));
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const installEnv = { ...process.env, npm_config_userconfig: join(root, "npmrc") };
delete installEnv.npm_config_allow_scripts;
delete installEnv.NPM_CONFIG_ALLOW_SCRIPTS;

try {
  let target = process.argv[2];
  if (!target) {
    const packed = await run(npm, ["pack", "--json", "--pack-destination", root], {
      cwd: repository, maxBuffer: 16 * 1024 * 1024,
    });
    const [{ filename }] = JSON.parse(packed.stdout);
    target = join(root, filename);
  }
  await writeFile(join(root, "package.json"), JSON.stringify({
    name: "videobook-package-smoke", private: true, type: "module",
    allowScripts: {
      "@dolthub/doltlite": true,
      "onnxruntime-node": true,
      "protobufjs": true,
      "sharp": true,
      "usearch": true,
      "videobook-engine": false,
    },
  }));
  process.stdout.write(`Installing ${target} in a clean project\n`);
  await writeFile(installEnv.npm_config_userconfig, "");
  await run(npm, ["install", "--no-audit", "--no-fund", target], {
    cwd: root, env: installEnv, maxBuffer: 16 * 1024 * 1024,
  });
  const readme = await readFile(join(root, "node_modules/videobook-engine/README.md"), "utf8");
  const example = readme.match(/## Quick start\s+```ts\n([\s\S]*?)\n```/)?.[1];
  assert.ok(example, "Installed README must contain an executable quick start");
  await writeFile(join(root, "smoke.mjs"), `
import assert from "node:assert/strict";
import { existsSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
${example}
assert.equal(book.name, "My Story");
assert.equal(script.value.label, "opening draft");
assert.ok(history.length >= 2, "Artifact creation and file write appear in history");
assert.ok(existsSync(".videobook/data/videobook.db"));
const reopened = createEngine({ rootDir: ".videobook" });
try {
  assert.equal(reopened.book.get().bookId, book.bookId);
  assert.equal(reopened.artifacts.get(script.value.artifactId).value.label, "opening draft");
} finally { reopened.close(); }
const engineRequire = createRequire(import.meta.resolve("videobook-engine"));
const transformersUrl = new URL("./transformers-runtime.js", import.meta.resolve("videobook-engine"));
const transformersRequire = createRequire(transformersUrl);
const sharpPath = engineRequire.resolve("sharp");
assert.equal(realpathSync(sharpPath), realpathSync(transformersRequire.resolve("sharp")),
  "Engine and Transformers must resolve one Sharp binary");
const { default: sharp } = await import(pathToFileURL(sharpPath));
const { RawImage } = await import(transformersUrl);
const pixels = await sharp({ create: {
  width: 16, height: 12, channels: 3, background: { r: 220, g: 20, b: 20 },
} }).png().toBuffer();
const decoded = await RawImage.fromBlob(new Blob([pixels]));
assert.equal(decoded.width, 16);
assert.equal(decoded.height, 12);
const { LocalClipTemporalProvider: OfflineClipProvider } = await import("videobook-engine");
await assert.rejects(new OfflineClipProvider({ modelCacheDir: ".missing-model-cache" }).prepare(),
  (error) => error.error?.code === "OFFLINE", "Packaged worker must start and preserve offline model policy");
const { mkdir: createModelDirectory, writeFile: writeModelFile } = await import("node:fs/promises");
const corruptModelRoot = ".corrupted-model-cache/Xenova/clip-vit-base-patch32/d15189d7028b43f1d3e65039190477f6af591c2a";
await createModelDirectory(corruptModelRoot, { recursive: true });
await writeModelFile(corruptModelRoot + "/config.json", '{"model_type":"clip"}');
await assert.rejects(new OfflineClipProvider({ modelCacheDir: ".corrupted-model-cache" }).prepare(),
  (error) => error.error?.code === "MODEL_UNAVAILABLE", "Packaged worker must reject corrupted pinned model files");
if (process.env.VIDEOBOOK_RUN_MODEL_E2E === "1") {
  const { writeFile } = await import("node:fs/promises");
  const { homedir } = await import("node:os");
  const { join } = await import("node:path");
  const { execFileSync } = await import("node:child_process");
  const { LocalClipTemporalProvider, LocalClapTemporalProvider } = await import("videobook-engine");
  const options = {
    modelCacheDir: process.env.VIDEOBOOK_E2E_MODEL_CACHE ?? join(homedir(), ".cache", "videobook", "models"),
    allowModelDownload: false,
  };
  await writeFile("reference.png", pixels);
  const clip = new LocalClipTemporalProvider(options);
  const imageVector = await clip.embedImage("reference.png");
  const textVector = await clip.embedText("a solid red image");
  execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i",
    "sine=frequency=440:duration=1:sample_rate=48000", "-y", "tone.wav"]);
  const clap = new LocalClapTemporalProvider({ ...options, ffmpegPath: "ffmpeg" });
  const audioVector = await clap.embedAudio("tone.wav", 0, 1);
  const audioText = await clap.embedText("a steady electronic tone");
  for (const vector of [imageVector, textVector, audioVector, audioText]) {
    assert.equal(vector.length, 512);
    assert.ok([...vector].every(Number.isFinite));
    assert.ok(Math.abs(Math.hypot(...vector) - 1) < 0.0001);
  }
  console.log("Packaged CLIP and CLAP image/audio/text inference passed with downloads disabled");
}
console.log("Packaged README quick start and catalog reopen passed");
`);
  const result = await run(process.execPath, [join(root, "smoke.mjs")], {
    cwd: root, maxBuffer: 16 * 1024 * 1024,
  });
  process.stdout.write(result.stdout);
  assert.doesNotMatch(result.stderr,
    /Class .+ is implemented in both|GNotificationCenterDelegate|duplicate.*libvips/i,
    "Media smoke must not load competing native image libraries");
  process.stderr.write(result.stderr);
  const resolutions = await run(npm, ["ls", "sharp", "--all", "--parseable"], {
    cwd: root, env: installEnv,
  });
  assert.equal(resolutions.stdout.trim().split(/\r?\n/).filter(Boolean).length, 1,
    "Clean installation must contain one Sharp resolution");
  process.stdout.write("Single Sharp resolution and media decode passed\n");
  const audit = await run(npm, ["audit", "--omit=dev", "--json"], {
    cwd: root, env: installEnv, maxBuffer: 16 * 1024 * 1024,
  });
  assert.equal(JSON.parse(audit.stdout).metadata.vulnerabilities.total, 0,
    "Installed runtime dependencies must pass npm audit");
} finally {
  await rm(root, { recursive: true, force: true, maxRetries: 3 });
}
